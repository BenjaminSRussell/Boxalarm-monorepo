import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';

const { createMemberMock, createLoginMock, deleteLoginMock } = vi.hoisted(() => ({
  createMemberMock: vi.fn(),
  createLoginMock: vi.fn(),
  deleteLoginMock: vi.fn(),
}));

vi.mock('../lib/memberRepository.js', () => ({
  createMember: createMemberMock,
}));

vi.mock('../lib/memberLogin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/memberLogin.js')>();
  return {
    ...actual,
    getCognitoClient: () => ({}),
    createMemberLogin: createLoginMock,
    deleteMemberLogin: deleteLoginMock,
  };
});

const { MemberLoginExistsError } = await import('../lib/memberLogin.js');

const { handler } = await import('./create.js');

function buildEvent(
  body: string | undefined,
  groups: string,
): APIGatewayProxyEventV2WithLambdaAuthorizer<VerifiedAccessToken> {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/personnel/members',
    rawPath: '/api/v1/personnel/members',
    rawQueryString: '',
    headers: {},
    ...(body !== undefined ? { body } : {}),
    isBase64Encoded: false,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/api/v1/personnel/members',
        protocol: 'HTTP/1.1',
        sourceIp: '10.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'POST /api/v1/personnel/members',
      stage: '$default',
      time: '2026-01-01T00:00:00Z',
      timeEpoch: 0,
      authorizer: { lambda: { sub: 'actor-1', deptId: 'NICHOLS', 'cognito:groups': groups } },
    },
  };
}

const VALID_BODY = JSON.stringify({
  firstName: 'Jamie',
  lastName: 'Rios',
  phone: '203-555-0100',
  email: 'jamie@example.com',
  joinDate: '2026-01-01',
  rank: 'FIREFIGHTER',
  agencyId: 'NFD-0099',
});

describe('members/create handler (entrypoint test)', () => {
  beforeEach(() => {
    createMemberMock.mockReset();
    createLoginMock.mockReset().mockResolvedValue('sub-jamie');
    deleteLoginMock.mockReset().mockResolvedValue(undefined);
    process.env.PERSONNEL_TABLE_NAME = 'boxalarm-dev-platform';
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_pool';
  });

  it('creates a member and returns 201 with the persisted record (AC1)', async () => {
    createMemberMock.mockResolvedValueOnce({
      memberId: 'm1',
      deptId: 'NICHOLS',
      status: 'PROBATIONARY',
    });
    const result = await handler(buildEvent(VALID_BODY, 'ADMIN'), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 201 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({
      memberId: 'm1',
      status: 'PROBATIONARY',
    });
  });

  it('rejects a non-admin caller with 403 before touching the repository (AC3)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await handler(buildEvent(VALID_BODY, 'MEMBER'), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 403 });
    expect(createMemberMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('member.create.forbidden'));
  });

  it('rejects a missing required field with 400', async () => {
    const body = JSON.stringify({
      firstName: 'Jamie',
      lastName: 'Rios',
      phone: '203-555-0100',
      email: 'jamie@example.com',
      joinDate: '2026-01-01',
      rank: 'FIREFIGHTER',
    });
    const result = await handler(buildEvent(body, 'ADMIN'), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 400 });
    const parsed = JSON.parse((result as { body: string }).body) as { detail: string };
    expect(parsed.detail).toContain('agencyId');
  });

  it('rejects malformed JSON with 400', async () => {
    const result = await handler(buildEvent('{not-json', 'ADMIN'), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 503 and logs the original error when the repository write fails (fail-closed)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createMemberMock.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));
    const result = await handler(buildEvent(VALID_BODY, 'ADMIN'), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ProvisionedThroughputExceeded'));
  });

  it('emits a MemberCreated business metric on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createMemberMock.mockResolvedValueOnce({ memberId: 'm1', status: 'PROBATIONARY' });
    await handler(buildEvent(VALID_BODY, 'ADMIN'), {} as never, () => undefined);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('MemberCreated'));
  });

  it("creates the member's login first and keys the member on its sub", async () => {
    createMemberMock.mockResolvedValueOnce({ memberId: 'sub-jamie', status: 'PROBATIONARY' });
    await handler(buildEvent(VALID_BODY, 'ADMIN'), {} as never, () => undefined);
    expect(createLoginMock).toHaveBeenCalledWith(
      expect.anything(),
      { userPoolId: 'us-east-1_pool' },
      { email: 'jamie@example.com', deptId: 'NICHOLS' },
    );
    expect(createMemberMock.mock.calls[0]?.[4]).toBe('sub-jamie');
  });

  it('answers 409 without writing a member when a login already exists for the email', async () => {
    createLoginMock.mockRejectedValueOnce(new MemberLoginExistsError('jamie@example.com'));
    const result = await handler(buildEvent(VALID_BODY, 'ADMIN'), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 409 });
    expect(createMemberMock).not.toHaveBeenCalled();
  });

  it('deletes the new login when the member write fails, so a retry can succeed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createMemberMock.mockRejectedValueOnce(new Error('TransactionCanceled'));
    const result = await handler(buildEvent(VALID_BODY, 'ADMIN'), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 503 });
    expect(deleteLoginMock).toHaveBeenCalledWith(
      expect.anything(),
      { userPoolId: 'us-east-1_pool' },
      'jamie@example.com',
    );
  });

  it('rejects a non-admin caller before creating any login', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handler(buildEvent(VALID_BODY, 'MEMBER'), {} as never, () => undefined);
    expect(createLoginMock).not.toHaveBeenCalled();
  });
});
