import { describe, expect, it, vi } from 'vitest';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  UsernameExistsException,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { MemberLoginExistsError, createMemberLogin, readMemberLoginConfig } from './memberLogin.js';

const CONFIG = { userPoolId: 'us-east-1_pool' };
const INPUT = { email: 'jamie@example.com', deptId: 'NICHOLS' };

function client(send: (command: unknown) => Promise<unknown>): CognitoIdentityProviderClient {
  return { send: vi.fn(send) } as unknown as CognitoIdentityProviderClient;
}

function sentCommands(c: CognitoIdentityProviderClient): unknown[] {
  return (c.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[0]);
}

const created = { User: { Attributes: [{ Name: 'sub', Value: 'sub-jamie' }] } };

describe('createMemberLogin', () => {
  it('creates the login with custom:deptId, adds it to MEMBER, and returns its sub', async () => {
    const c = client(() => Promise.resolve(created));
    await expect(createMemberLogin(c, CONFIG, INPUT)).resolves.toBe('sub-jamie');
    const commands = sentCommands(c);
    const create = commands[0] as AdminCreateUserCommand;
    expect(create).toBeInstanceOf(AdminCreateUserCommand);
    expect(create.input.Username).toBe('jamie@example.com');
    expect(create.input.UserAttributes).toEqual(
      expect.arrayContaining([{ Name: 'custom:deptId', Value: 'NICHOLS' }]),
    );
    const group = commands[1] as AdminAddUserToGroupCommand;
    expect(group).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect(group.input.GroupName).toBe('MEMBER');
  });

  it('maps an existing username to MemberLoginExistsError', async () => {
    const c = client(() =>
      Promise.reject(new UsernameExistsException({ message: 'exists', $metadata: {} })),
    );
    await expect(createMemberLogin(c, CONFIG, INPUT)).rejects.toBeInstanceOf(
      MemberLoginExistsError,
    );
  });

  it('deletes the login when adding it to the MEMBER group fails', async () => {
    const c = client((command) =>
      command instanceof AdminAddUserToGroupCommand
        ? Promise.reject(new Error('throttled'))
        : Promise.resolve(created),
    );
    await expect(createMemberLogin(c, CONFIG, INPUT)).rejects.toThrow('throttled');
    const last = sentCommands(c).at(-1);
    expect(last).toBeInstanceOf(AdminDeleteUserCommand);
  });
});

describe('readMemberLoginConfig', () => {
  it('requires COGNITO_USER_POOL_ID', () => {
    expect(() => readMemberLoginConfig({})).toThrow('COGNITO_USER_POOL_ID');
    expect(readMemberLoginConfig({ COGNITO_USER_POOL_ID: 'p' })).toEqual({ userPoolId: 'p' });
  });
});
