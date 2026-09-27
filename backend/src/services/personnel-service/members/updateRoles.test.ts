import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';

const { getMemberMock, updateMemberRolesMock, cognitoSend } = vi.hoisted(() => ({
  getMemberMock: vi.fn(),
  updateMemberRolesMock: vi.fn(),
  cognitoSend: vi.fn(),
}));

vi.mock('../lib/memberRepository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/memberRepository.js')>()),
  getMember: getMemberMock,
  updateMemberRoles: updateMemberRolesMock,
}));

vi.mock('../lib/memberLogin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/memberLogin.js')>()),
  getCognitoClient: () => ({ send: cognitoSend }),
}));

const { handler } = await import('./updateRoles.js');

function buildEvent(
  memberId: string | undefined,
  body: string | undefined,
  groups: string,
  sub = 'actor-1',
): APIGatewayProxyEventV2WithLambdaAuthorizer<VerifiedAccessToken> {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/personnel/members/{memberId}/roles',
    rawPath: `/api/v1/personnel/members/${memberId ?? ''}/roles`,
    rawQueryString: '',
    headers: {},
    ...(body !== undefined ? { body } : {}),
    ...(memberId ? { pathParameters: { memberId } } : {}),
    isBase64Encoded: false,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'PUT',
        path: `/api/v1/personnel/members/${memberId ?? ''}/roles`,
        protocol: 'HTTP/1.1',
        sourceIp: '10.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'PUT /api/v1/personnel/members/{memberId}/roles',
      stage: '$default',
      time: '2026-01-01T00:00:00Z',
      timeEpoch: 0,
      authorizer: { lambda: { sub, deptId: 'NICHOLS', 'cognito:groups': groups } },
    },
  };
}

async function put(roles: unknown, groups = 'ADMIN', memberId = 'm1', sub = 'actor-1') {
  const result = await handler(
    buildEvent(memberId, JSON.stringify({ roles }), groups, sub),
    {} as never,
    () => undefined,
  );
  return result as { statusCode: number; body: string };
}

/** Cognito currently has the member in `current`; every write succeeds. */
function cognitoHas(current: string[]): void {
  cognitoSend.mockImplementation((command: unknown) =>
    Promise.resolve(
      command instanceof AdminListGroupsForUserCommand
        ? { Groups: current.map((GroupName) => ({ GroupName })) }
        : {},
    ),
  );
}

interface GroupWrite {
  readonly kind: 'add' | 'remove';
  readonly group: string | undefined;
}

function cognitoWrites(): GroupWrite[] {
  return cognitoSend.mock.calls.flatMap(([command]): GroupWrite[] => {
    if (command instanceof AdminAddUserToGroupCommand) {
      return [{ kind: 'add', group: command.input.GroupName }];
    }
    if (command instanceof AdminRemoveUserFromGroupCommand) {
      return [{ kind: 'remove', group: command.input.GroupName }];
    }
    return [];
  });
}

function bodyOf(result: { body: string }): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

describe('members/updateRoles handler (entrypoint test)', () => {
  beforeEach(() => {
    getMemberMock.mockReset();
    updateMemberRolesMock.mockReset();
    cognitoSend.mockReset();
    process.env.PERSONNEL_TABLE_NAME = 'boxalarm-dev-platform';
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_pool';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  describe('authorization', () => {
    it.each(['ADMIN', 'CHIEF', 'MEMBER CHIEF'])('lets %s assign roles', async (groups) => {
      getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER'] });
      cognitoHas(['MEMBER']);
      updateMemberRolesMock.mockResolvedValueOnce({ updatedAt: 1, eventId: 'evt-1' });
      expect((await put(['OFFICER'], groups)).statusCode).toBe(200);
    });

    it.each(['OFFICER', 'MEMBER OFFICER TRAINING', 'MEMBER'])(
      'refuses %s with 403 before any read or Cognito call',
      async (groups) => {
        const result = await put(['OFFICER'], groups);
        expect(result.statusCode).toBe(403);
        expect(getMemberMock).not.toHaveBeenCalled();
        expect(cognitoSend).not.toHaveBeenCalled();
      },
    );

    it('refuses a chief changing their own roles with 403 (self-escalation and self-lockout)', async () => {
      const result = await put(['MEMBER'], 'CHIEF', 'actor-1', 'actor-1');
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toMatchObject({
        detail: 'you cannot change your own roles',
        traceId: 'req-1',
      });
      expect(getMemberMock).not.toHaveBeenCalled();
      expect(cognitoSend).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it.each([
      ['a missing roles field', {}],
      ['a non-array roles field', { roles: 'OFFICER' }],
      ['an unknown role', { roles: ['MEMBER', 'SUPERUSER'] }],
      ['a lowercase role', { roles: ['officer'] }],
      ['a non-string entry', { roles: [1] }],
    ])('answers 400 for %s', async (_label, body) => {
      const result = await handler(
        buildEvent('m1', JSON.stringify(body), 'ADMIN'),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 400 });
      expect(getMemberMock).not.toHaveBeenCalled();
    });

    it('answers 400 for a body that is not JSON', async () => {
      const result = await handler(buildEvent('m1', '{nope', 'ADMIN'), {} as never, () => {});
      expect(result).toMatchObject({ statusCode: 400 });
    });

    it('dedupes, orders canonically, and always keeps MEMBER', async () => {
      getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER'] });
      cognitoHas(['MEMBER']);
      updateMemberRolesMock.mockResolvedValueOnce({ updatedAt: 1, eventId: 'evt-1' });
      const result = await put(['CHIEF', 'OFFICER', 'OFFICER']);
      expect(bodyOf(result).roles).toEqual(['MEMBER', 'OFFICER', 'CHIEF']);
      expect(updateMemberRolesMock).toHaveBeenCalledWith(
        'boxalarm-dev-platform',
        expect.objectContaining({ sub: 'actor-1', deptId: 'NICHOLS' }),
        'm1',
        ['MEMBER'],
        ['MEMBER', 'OFFICER', 'CHIEF'],
        'actor-1',
      );
    });

    it('treats an empty list as MEMBER only', async () => {
      getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER', 'OFFICER'] });
      cognitoHas(['MEMBER', 'OFFICER']);
      updateMemberRolesMock.mockResolvedValueOnce({ updatedAt: 1, eventId: 'evt-1' });
      const result = await put([]);
      expect(bodyOf(result).roles).toEqual(['MEMBER']);
      expect(cognitoWrites()).toEqual([{ kind: 'remove', group: 'OFFICER' }]);
    });
  });

  it('answers 404 for a member not in the caller department, with no Cognito call', async () => {
    getMemberMock.mockResolvedValueOnce(undefined);
    const result = await put(['OFFICER']);
    expect(result.statusCode).toBe(404);
    expect(getMemberMock).toHaveBeenCalledWith(
      'boxalarm-dev-platform',
      expect.objectContaining({ deptId: 'NICHOLS' }),
      'm1',
    );
    expect(cognitoSend).not.toHaveBeenCalled();
  });

  describe('Cognito group sync', () => {
    it('adds and removes exactly the difference and leaves non-role groups alone', async () => {
      getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER', 'TRAINING'] });
      cognitoHas(['MEMBER', 'TRAINING', 'us-east-1_Google', 'beta-testers']);
      updateMemberRolesMock.mockResolvedValueOnce({ updatedAt: 1, eventId: 'evt-1' });

      const result = await put(['OFFICER', 'APPARATUS']);

      expect(result.statusCode).toBe(200);
      expect(cognitoWrites()).toEqual([
        { kind: 'add', group: 'OFFICER' },
        { kind: 'add', group: 'APPARATUS' },
        { kind: 'remove', group: 'TRAINING' },
      ]);
      for (const [command] of cognitoSend.mock.calls) {
        const input = (command as { input: { UserPoolId: string; Username: string } }).input;
        expect(input).toMatchObject({ UserPoolId: 'us-east-1_pool', Username: 'm1' });
      }
    });

    it('re-adds a missing MEMBER group', async () => {
      getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER'] });
      cognitoHas([]);
      updateMemberRolesMock.mockResolvedValueOnce({ updatedAt: 1, eventId: 'evt-1' });
      await put(['MEMBER']);
      expect(cognitoWrites()).toEqual([{ kind: 'add', group: 'MEMBER' }]);
    });

    it('reads every page of the member groups before deciding', async () => {
      getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER', 'OFFICER'] });
      cognitoSend.mockImplementation((command: unknown) => {
        if (!(command instanceof AdminListGroupsForUserCommand)) {
          return Promise.resolve({});
        }
        return Promise.resolve(
          command.input.NextToken
            ? { Groups: [{ GroupName: 'OFFICER' }] }
            : { Groups: [{ GroupName: 'MEMBER' }], NextToken: 'page-2' },
        );
      });
      const result = await put(['OFFICER']);
      expect(bodyOf(result).changed).toBe(false);
      expect(cognitoWrites()).toEqual([]);
    });

    it('answers 503 "retry" and writes no row when a group change fails', async () => {
      getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER'] });
      cognitoSend.mockImplementation((command: unknown) =>
        command instanceof AdminAddUserToGroupCommand
          ? Promise.reject(new Error('TooManyRequestsException'))
          : Promise.resolve({ Groups: [{ GroupName: 'MEMBER' }] }),
      );
      const result = await put(['OFFICER']);
      expect(result.statusCode).toBe(503);
      expect(bodyOf(result).detail).toContain('retry');
      expect(updateMemberRolesMock).not.toHaveBeenCalled();
    });

    it('answers 409 when the member has no login', async () => {
      getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER'] });
      cognitoSend.mockRejectedValue(new UserNotFoundException({ message: 'nope', $metadata: {} }));
      expect((await put(['OFFICER'])).statusCode).toBe(409);
      expect(updateMemberRolesMock).not.toHaveBeenCalled();
    });
  });

  it('answers 503 "retry" when the row write fails after the groups changed', async () => {
    getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER'] });
    cognitoHas(['MEMBER']);
    updateMemberRolesMock.mockRejectedValueOnce(new Error('TransactionCanceledException'));
    const result = await put(['OFFICER']);
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body)).toMatchObject({
      status: 503,
      detail: 'member roles were only partly saved; retry the same request to finish',
      traceId: 'req-1',
    });
    expect(cognitoWrites()).toEqual([{ kind: 'add', group: 'OFFICER' }]);
  });

  // Review MINOR-1: admins A and B edit at once; B's row write lands first, so A's guarded
  // write fails. A had already moved the groups - they must go back to what the row holds.
  describe('when another admin changed the roles first', () => {
    /** Stateful: adds and removes change what the next list returns. */
    function cognitoStarts(initial: string[]): Set<string> {
      const groups = new Set(initial);
      cognitoSend.mockImplementation((command: unknown) => {
        if (command instanceof AdminListGroupsForUserCommand) {
          return Promise.resolve({ Groups: [...groups].map((GroupName) => ({ GroupName })) });
        }
        if (command instanceof AdminAddUserToGroupCommand) groups.add(command.input.GroupName!);
        if (command instanceof AdminRemoveUserFromGroupCommand) {
          groups.delete(command.input.GroupName!);
        }
        return Promise.resolve({});
      });
      return groups;
    }
    const conflict = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });

    it('answers 409 and puts Cognito back to the roles the row now holds', async () => {
      getMemberMock
        .mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER'] })
        .mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER', 'TRAINING'] });
      const groups = cognitoStarts(['MEMBER', 'TRAINING']);
      updateMemberRolesMock.mockRejectedValueOnce(conflict);

      const result = await put(['OFFICER']);

      expect(result.statusCode).toBe(409);
      expect(bodyOf(result).detail).toMatch(/changed by someone else/);
      expect([...groups].sort()).toEqual(['MEMBER', 'TRAINING']);
    });

    it('answers 404 and removes the granted groups when the member is gone', async () => {
      getMemberMock
        .mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER'] })
        .mockResolvedValueOnce(undefined);
      const groups = cognitoStarts(['MEMBER']);
      updateMemberRolesMock.mockRejectedValueOnce(conflict);

      const result = await put(['ADMIN']);

      expect(result.statusCode).toBe(404);
      expect(groups.has('ADMIN')).toBe(false);
    });
  });

  it('converges on retry after a partial failure: groups already right, row still written', async () => {
    getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER'] });
    cognitoHas(['MEMBER', 'OFFICER']);
    updateMemberRolesMock.mockResolvedValueOnce({ updatedAt: 1, eventId: 'evt-1' });
    const result = await put(['OFFICER']);
    expect(bodyOf(result).changed).toBe(true);
    expect(cognitoWrites()).toEqual([]);
    expect(updateMemberRolesMock).toHaveBeenCalledOnce();
  });

  it('is idempotent: a repeat answers changed=false with no Cognito or DynamoDB writes', async () => {
    getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['OFFICER', 'MEMBER'] });
    cognitoHas(['MEMBER', 'OFFICER']);
    const result = await put(['MEMBER', 'OFFICER']);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      memberId: 'm1',
      roles: ['MEMBER', 'OFFICER'],
      changed: false,
    });
    expect(cognitoWrites()).toEqual([]);
    expect(updateMemberRolesMock).not.toHaveBeenCalled();
  });

  it('says in the response that the change applies at the next session refresh', async () => {
    getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER'] });
    cognitoHas(['MEMBER']);
    updateMemberRolesMock.mockResolvedValueOnce({ updatedAt: 1, eventId: 'evt-1' });
    const body = JSON.parse((await put(['OFFICER'])).body) as Record<string, unknown>;
    expect(body).toMatchObject({ memberId: 'm1', roles: ['MEMBER', 'OFFICER'], changed: true });
    expect(body.takesEffect).toMatch(/within one hour/);
  });

  it('emits a MemberRolesUpdated metric on a change', async () => {
    getMemberMock.mockResolvedValueOnce({ memberId: 'm1', roles: ['MEMBER'] });
    cognitoHas(['MEMBER']);
    updateMemberRolesMock.mockResolvedValueOnce({ updatedAt: 1, eventId: 'evt-1' });
    await put(['OFFICER']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"MemberRolesUpdated":1'));
  });

  it('answers 503 when COGNITO_USER_POOL_ID is unset', async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    expect((await put(['OFFICER'])).statusCode).toBe(503);
    expect(getMemberMock).not.toHaveBeenCalled();
  });
});
