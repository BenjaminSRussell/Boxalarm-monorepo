import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent, WithAuthorizationOptions } from '@boxalarm/authz';
import { createHandler } from './handler.js';

// @boxalarm/authz caches the first client it is handed, so every test shares this one.
const authzSend = vi.fn();
const authzClient = { send: authzSend } as unknown as NonNullable<
  WithAuthorizationOptions['client']
>;

function event(assetId: string | undefined): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/inventory/equipment/{assetId}',
    rawPath: `/api/v1/inventory/equipment/${assetId ?? ''}`,
    rawQueryString: '',
    headers: { authorization: 'Bearer test-token' },
    pathParameters: assetId ? { assetId } : undefined,
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

describe('handler (GET /api/v1/inventory/equipment/{assetId})', () => {
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

  it('AC2: returns assignedToType/assignedToId reflected for the asset (entrypoint-test)', async () => {
    const client = fakeDocClient(() => ({
      Item: {
        assetId: 'AS-1',
        deptId: 'NICHOLS',
        serialNumber: 'SN-1',
        assignedToType: 'MEMBER',
        assignedToId: 'MBR-1',
        location: 'Station 1',
        lifecycleStatus: 'ACQUIRED',
      },
    }));
    const result = await createHandler({ authzClient, dynamoClient: client })(event('AS-1'));
    expect(result).toMatchObject({ statusCode: 200 });
    const asset = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(asset.assignedToType).toBe('MEMBER');
    expect(asset.assignedToId).toBe('MBR-1');
  });

  it('asks Verified Permissions for ViewEquipmentAsset on the path asset', async () => {
    const client = fakeDocClient(() => ({ Item: { assetId: 'AS-1' } }));
    await createHandler({ authzClient, dynamoClient: client })(event('AS-1'));
    const input = (authzSend.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'ViewEquipmentAsset',
    });
    expect(input.resource).toEqual({ entityType: 'Boxalarm::Asset', entityId: 'AS-1' });
  });

  it('returns 403 and never reads the asset when Cedar denies', async () => {
    authzSend.mockResolvedValue({ decision: 'DENY' });
    const client = fakeDocClient(() => ({ Item: undefined }));
    const result = await createHandler({ authzClient, dynamoClient: client })(event('AS-1'));
    expect(result).toMatchObject({ statusCode: 403 });
    expect(client.sendMock).not.toHaveBeenCalled();
  });

  it('404 problem+json when assetId is not found', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeDocClient(() => ({ Item: undefined }));
    const result = await createHandler({ authzClient, dynamoClient: client })(event('missing'));
    expect(result).toMatchObject({ statusCode: 404 });
    expect((result as { headers: Record<string, string> }).headers['content-type']).toBe(
      'application/problem+json',
    );
    expect(errorSpy).toHaveBeenCalled();
  });
});
