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
    routeKey: 'PUT /api/v1/inventory/equipment/{assetId}/assignment',
    rawPath: `/api/v1/inventory/equipment/${assetId ?? ''}/assignment`,
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

describe('handler (PUT /api/v1/inventory/equipment/{assetId}/assignment)', () => {
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

  it('AC2: assigns to a member and returns the updated asset (entrypoint-test)', async () => {
    const client = fakeDocClient(() => ({
      Attributes: {
        assetId: 'AS-1',
        deptId: 'NICHOLS',
        serialNumber: 'SN-1',
        assignedToType: 'MEMBER',
        assignedToId: 'MBR-1',
        location: 'Station 1',
        lifecycleStatus: 'ACQUIRED',
      },
    }));
    const result = await invoke(
      event('AS-1', { assignedToType: 'MEMBER', assignedToId: 'MBR-1' }),
      client,
    );
    expect(result.statusCode).toBe(200);
    expect((JSON.parse(result.body ?? '{}') as Record<string, unknown>).assignedToType).toBe(
      'MEMBER',
    );
  });

  it('asks Verified Permissions for AssignEquipmentAsset on the path asset', async () => {
    await invoke(
      event('AS-1', { assignedToType: 'MEMBER', assignedToId: 'MBR-1' }),
      fakeDocClient(() => ({ Attributes: { assetId: 'AS-1' } })),
    );
    const input = (authzSend.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'AssignEquipmentAsset',
    });
    expect(input.resource).toEqual({ entityType: 'Boxalarm::Asset', entityId: 'AS-1' });
  });

  it('400 problem+json when assignedToType is not MEMBER|APPARATUS', async () => {
    const result = await invoke(
      event('AS-1', { assignedToType: 'ROBOT', assignedToId: 'X' }),
      fakeDocClient(() => ({})),
    );
    expect(result.statusCode).toBe(400);
  });

  it('400 problem+json when assignedToId is empty', async () => {
    const result = await invoke(
      event('AS-1', { assignedToType: 'MEMBER', assignedToId: '' }),
      fakeDocClient(() => ({})),
    );
    expect(result.statusCode).toBe(400);
  });

  it('404 problem+json when assetId is not found', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeDocClient(() => {
      throw new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });
    });
    const result = await invoke(
      event('missing', { assignedToType: 'MEMBER', assignedToId: 'MBR-1' }),
      client,
    );
    expect(result.statusCode).toBe(404);
  });

  it('403 and no write when Cedar denies (caller lacks chief/admin/officer)', async () => {
    authzSend.mockResolvedValue({ decision: 'DENY' });
    const client = fakeDocClient(() => ({}));
    const result = await invoke(
      event('AS-1', { assignedToType: 'MEMBER', assignedToId: 'MBR-1' }),
      client,
    );
    expect(result.statusCode).toBe(403);
    expect(client.sendMock).not.toHaveBeenCalled();
  });
});
