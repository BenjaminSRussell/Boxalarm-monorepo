import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent, WithAuthorizationOptions } from '@boxalarm/authz';
import { createHandler } from './handler.js';

// @boxalarm/authz caches the first client it is handed, so every test shares this one.
const authzSend = vi.fn();
const authzClient = { send: authzSend } as unknown as NonNullable<
  WithAuthorizationOptions['client']
>;

function event(body: unknown, headers: Record<string, string> = {}): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/inventory/equipment',
    rawPath: '/api/v1/inventory/equipment',
    rawQueryString: '',
    headers: { authorization: 'Bearer test-token', ...headers },
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

type Result = { statusCode: number; headers?: Record<string, string>; body?: string };

async function invoke(evt: GuardEvent, client: DynamoDBDocumentClient): Promise<Result> {
  return (await createHandler({ authzClient, dynamoClient: client })(evt)) as Result;
}

describe('handler (POST /api/v1/inventory/equipment)', () => {
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

  it('AC1: creates an asset and returns it unassigned by default (entrypoint-test)', async () => {
    const client = fakeDocClient((command) => {
      expect(command).toBeInstanceOf(PutCommand);
      return {};
    });
    const result = await invoke(event({ serialNumber: 'SN-1', location: 'Station 1' }), client);
    expect(result.statusCode).toBe(201);
    const asset = JSON.parse(result.body ?? '{}') as Record<string, unknown>;
    expect(asset.serialNumber).toBe('SN-1');
    expect(asset.assignedToType).toBeUndefined();
  });

  it('asks Verified Permissions for RegisterEquipmentAsset on the caller department', async () => {
    await invoke(
      event({ serialNumber: 'SN-1' }),
      fakeDocClient(() => ({})),
    );
    const input = (authzSend.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'RegisterEquipmentAsset',
    });
    expect(input.resource).toEqual({ entityType: 'Boxalarm::Department', entityId: 'NICHOLS' });
  });

  it('403 and no write when Cedar denies (caller lacks chief/admin/officer)', async () => {
    authzSend.mockResolvedValue({ decision: 'DENY' });
    const client = fakeDocClient(() => ({}));
    const result = await invoke(event({ serialNumber: 'SN-1' }), client);
    expect(result.statusCode).toBe(403);
    expect(client.sendMock).not.toHaveBeenCalled();
  });

  it('400 problem+json when serialNumber is missing/empty', async () => {
    const result = await invoke(
      event({ serialNumber: '  ' }),
      fakeDocClient(() => ({})),
    );
    expect(result.statusCode).toBe(400);
    expect(result.headers?.['content-type']).toBe('application/problem+json');
  });

  it('500 problem+json, fail-closed, when the DynamoDB PutCommand throws (dependency unavailable)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeDocClient(() => {
      throw new Error('ProvisionedThroughputExceededException');
    });
    const result = await invoke(event({ serialNumber: 'SN-1' }), client);
    expect(result.statusCode).toBe(500);
    // error-path-logging: the original error is logged, not silently swallowed.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('ProvisionedThroughputExceededException'),
    );
  });

  it('business-metrics: emits an EquipmentAssetCreated metric on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await invoke(
      event({ serialNumber: 'SN-1' }),
      fakeDocClient(() => ({})),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('EquipmentAssetCreated'));
  });

  it('traceparent: propagates a valid incoming traceparent header on success', async () => {
    const result = await invoke(
      event(
        { serialNumber: 'SN-1' },
        { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      ),
      fakeDocClient(() => ({})),
    );
    expect(result.headers?.traceparent).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
  });

  it('traceparent: generates a fresh valid traceparent (root span) when no header is sent', async () => {
    const result = await invoke(
      event({ serialNumber: 'SN-1' }),
      fakeDocClient(() => ({})),
    );
    expect(result.headers?.traceparent).toMatch(/^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/);
  });

  it('traceparent: still returned on the error path (400)', async () => {
    const result = await invoke(
      event({ serialNumber: '  ' }),
      fakeDocClient(() => ({})),
    );
    expect(result.headers?.traceparent).toMatch(/^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/);
  });
});
