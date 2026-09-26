import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent, WithAuthorizationOptions } from '@boxalarm/authz';
import { createHandler, handler as exportedHandler } from './handler.js';

// @boxalarm/authz caches the first client it is handed, so every test shares this one
// and switches its decision instead of building a new client.
const authzSend = vi.fn();
const authzClient = { send: authzSend } as unknown as NonNullable<
  WithAuthorizationOptions['client']
>;

function event(
  query: Record<string, string> | undefined,
  headers: Record<string, string> = { authorization: 'Bearer test-token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/inventory/equipment',
    rawPath: '/api/v1/inventory/equipment',
    rawQueryString: '',
    headers,
    queryStringParameters: query,
    requestContext: {
      requestId: 'req-1',
      authorizer: { lambda: { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' } },
    },
    isBase64Encoded: false,
  } as unknown as GuardEvent;
}

function fakeDocClient(send: (command: unknown) => unknown) {
  const sendMock = vi.fn((command: unknown) => Promise.resolve(send(command)));
  return Object.assign({ send: sendMock } as unknown as DynamoDBDocumentClient, { sendMock });
}

describe('handler (GET /api/v1/inventory/equipment)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    authzSend.mockReset();
    process.env.PLATFORM_TABLE_NAME = 'boxalarm-platform';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    authzSend.mockResolvedValue({ decision: 'ALLOW' });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 401 (fail-closed) on the real exported handler when no bearer token is sent', async () => {
    const result = await exportedHandler(event(undefined, {}));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('asks Verified Permissions for ListEquipment on the caller department', async () => {
    const client = fakeDocClient(() => ({ Items: [] }));
    await createHandler({ authzClient, dynamoClient: client })(event(undefined));
    const input = (authzSend.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.action).toEqual({ actionType: 'Boxalarm::Action', actionId: 'ListEquipment' });
    expect(input.resource).toEqual({ entityType: 'Boxalarm::Department', entityId: 'NICHOLS' });
  });

  it('returns 403 and never touches DynamoDB when Cedar denies ListEquipment', async () => {
    authzSend.mockResolvedValue({ decision: 'DENY' });
    const client = fakeDocClient(() => ({ Items: [] }));
    const result = await createHandler({ authzClient, dynamoClient: client })(event(undefined));
    expect(result).toMatchObject({ statusCode: 403 });
    expect(client.sendMock).not.toHaveBeenCalled();
  });

  it('AC1: lists the department-wide registry by default (entrypoint-test)', async () => {
    const client = fakeDocClient((command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return {
        Items: [
          {
            assetId: 'AS-1',
            deptId: 'NICHOLS',
            serialNumber: 'SN-1',
            location: 'x',
            lifecycleStatus: 'ACQUIRED',
          },
        ],
      };
    });
    const result = await createHandler({ authzClient, dynamoClient: client })(event(undefined));
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it('AC2: an apparatus-filtered query is passed through to the repository', async () => {
    const client = fakeDocClient((command) => {
      const input = (command as QueryCommand).input;
      expect(input.ExpressionAttributeValues?.[':type']).toBe('APPARATUS');
      return { Items: [] };
    });
    const result = await createHandler({ authzClient, dynamoClient: client })(
      event({ assignedToType: 'APPARATUS', assignedToId: 'APP-1' }),
    );
    expect(result).toMatchObject({ statusCode: 200 });
    expect(client.sendMock).toHaveBeenCalledTimes(1);
  });
});
