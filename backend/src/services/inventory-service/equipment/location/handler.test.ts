import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent, WithAuthorizationOptions } from '@boxalarm/authz';
import { createHandler } from './handler.js';

// @boxalarm/authz caches the first client it is handed, so every test shares this one.
const authzSend = vi.fn();
const authzClient = { send: authzSend } as unknown as NonNullable<
  WithAuthorizationOptions['client']
>;

function event(assetId: string | undefined, body: unknown): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/inventory/equipment/{assetId}/location',
    rawPath: `/api/v1/inventory/equipment/${assetId ?? ''}/location`,
    rawQueryString: '',
    headers: { authorization: 'Bearer test-token' },
    pathParameters: assetId ? { assetId } : undefined,
    requestContext: {
      requestId: 'req-1',
      authorizer: { lambda: { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' } },
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as GuardEvent;
}

function fakeDocClient(send: (command: unknown) => unknown) {
  const sendMock = vi.fn((command: unknown) => Promise.resolve(send(command)));
  return Object.assign({ send: sendMock } as unknown as DynamoDBDocumentClient, { sendMock });
}

type Result = { statusCode: number; body?: string };

async function invoke(evt: GuardEvent, client: DynamoDBDocumentClient): Promise<Result> {
  return (await createHandler({ authzClient, dynamoClient: client })(evt)) as Result;
}

describe('handler (PUT /api/v1/inventory/equipment/{assetId}/location)', () => {
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

  it('AC3: updates location and leaves assignment fields unchanged (entrypoint-test)', async () => {
    const client = fakeDocClient(() => ({
      Attributes: {
        assetId: 'AS-1',
        deptId: 'NICHOLS',
        serialNumber: 'SN-1',
        assignedToType: 'MEMBER',
        assignedToId: 'MBR-1',
        location: 'Station 2',
        lifecycleStatus: 'ACQUIRED',
      },
    }));
    const result = await invoke(event('AS-1', { location: 'Station 2' }), client);
    expect(result.statusCode).toBe(200);
    const asset = JSON.parse(result.body ?? '{}') as Record<string, unknown>;
    expect(asset.location).toBe('Station 2');
    expect(asset.assignedToType).toBe('MEMBER');
    expect(asset.assignedToId).toBe('MBR-1');
  });

  it('asks Verified Permissions for SetEquipmentLocation on the path asset', async () => {
    await invoke(
      event('AS-1', { location: 'Station 2' }),
      fakeDocClient(() => ({ Attributes: { assetId: 'AS-1' } })),
    );
    const input = (authzSend.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'SetEquipmentLocation',
    });
    expect(input.resource).toEqual({ entityType: 'Boxalarm::Asset', entityId: 'AS-1' });
  });

  it('403 and no write when Cedar denies (caller lacks chief/admin/officer)', async () => {
    authzSend.mockResolvedValue({ decision: 'DENY' });
    const client = fakeDocClient(() => ({}));
    const result = await invoke(event('AS-1', { location: 'Station 2' }), client);
    expect(result.statusCode).toBe(403);
    expect(client.sendMock).not.toHaveBeenCalled();
  });

  it('400 problem+json when location is empty/absent', async () => {
    const result = await invoke(
      event('AS-1', {}),
      fakeDocClient(() => ({})),
    );
    expect(result.statusCode).toBe(400);
  });

  it('404 problem+json when assetId is not found', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeDocClient(() => {
      throw new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });
    });
    const result = await invoke(event('missing', { location: 'Station 2' }), client);
    expect(result.statusCode).toBe(404);
  });
});
