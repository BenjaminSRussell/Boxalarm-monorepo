import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

/**
 * Every member is a Cognito user, and the member's id IS that user's `sub`. The apps send
 * the ID-token `sub` as their memberId, the authorizer and every own-record check compare
 * against the access-token `sub`, and session revocation looks members up in Cognito by
 * memberId - so a member row keyed on anything else can never be reached by its own
 * member. The login also carries `custom:deptId`, without which the authorizer denies
 * every request (pre-token-generation copies it onto the access token).
 */
export interface MemberLoginConfig {
  readonly userPoolId: string;
}

export function readMemberLoginConfig(env: NodeJS.ProcessEnv): MemberLoginConfig {
  const userPoolId = env.COGNITO_USER_POOL_ID;
  if (!userPoolId) {
    throw new Error('COGNITO_USER_POOL_ID is required and was not set');
  }
  return { userPoolId };
}

let cachedClient: CognitoIdentityProviderClient | undefined;

export function getCognitoClient(): CognitoIdentityProviderClient {
  cachedClient ??= captureAWSv3Client(new CognitoIdentityProviderClient({}));
  return cachedClient;
}

/** Thrown when a login already exists for the email, so the caller can answer 409. */
export class MemberLoginExistsError extends Error {
  constructor(email: string) {
    super(`a login already exists for ${email}`);
    this.name = 'MemberLoginExistsError';
  }
}

/** Every new member starts in the MEMBER group, matching the member row's roles. */
const INITIAL_GROUP = 'MEMBER';

/**
 * Creates the member's login (username = email; Cognito sends its invite email with a
 * temporary password) and returns its `sub`. If adding the group fails, the half-made
 * login is deleted so a retry can succeed.
 */
export async function createMemberLogin(
  client: CognitoIdentityProviderClient,
  config: MemberLoginConfig,
  input: { readonly email: string; readonly deptId: string },
): Promise<string> {
  let sub: string | undefined;
  try {
    const created = await client.send(
      new AdminCreateUserCommand({
        UserPoolId: config.userPoolId,
        Username: input.email,
        DesiredDeliveryMediums: ['EMAIL'],
        UserAttributes: [
          { Name: 'email', Value: input.email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'custom:deptId', Value: input.deptId },
        ],
      }),
    );
    sub = created.User?.Attributes?.find((attr) => attr.Name === 'sub')?.Value;
  } catch (error) {
    if (error instanceof UsernameExistsException) {
      throw new MemberLoginExistsError(input.email);
    }
    throw error;
  }
  if (!sub) {
    await deleteMemberLogin(client, config, input.email);
    throw new Error('Cognito created the login but returned no sub');
  }

  try {
    await client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: config.userPoolId,
        Username: input.email,
        GroupName: INITIAL_GROUP,
      }),
    );
  } catch (error) {
    await deleteMemberLogin(client, config, input.email);
    throw error;
  }
  return sub;
}

/** Compensation for a member that could not be written after its login was created. */
export async function deleteMemberLogin(
  client: CognitoIdentityProviderClient,
  config: MemberLoginConfig,
  username: string,
): Promise<void> {
  await client.send(
    new AdminDeleteUserCommand({ UserPoolId: config.userPoolId, Username: username }),
  );
}
