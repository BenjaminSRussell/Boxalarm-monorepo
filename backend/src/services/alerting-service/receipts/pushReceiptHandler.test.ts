import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

function buildEvent(
  headers: Record<string, string> | undefined,
  body: unknown,
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/alerting/receipts/push',
    rawPath: '/api/v1/alerting/receipts/push',
    rawQueryString: '',
    headers,
    body: JSON.stringify(body),
    requestContext: {},
  } as unknown as APIGatewayProxyEventV2;
}

describe('parseReceiptBody', () => {
  it('throws when errorCode is absent (AC-matrix: 400, no state change)', async () => {
    const { parseReceiptBody } = await import('./pushReceiptHandler.js');
    expect(() =>
      parseReceiptBody(JSON.stringify({ deptId: 'NICHOLS', memberId: 'mbr-1', token: 'tok-1' })),
    ).toThrow('errorCode is required');
  });

  it('parses a valid body', async () => {
    const { parseReceiptBody } = await import('./pushReceiptHandler.js');
    expect(
      parseReceiptBody(
        JSON.stringify({
          deptId: 'NICHOLS',
          memberId: 'mbr-1',
          token: 'tok-1',
          errorCode: 'BadDeviceToken',
        }),
      ),
    ).toEqual({
      deptId: 'NICHOLS',
      memberId: 'mbr-1',
      token: 'tok-1',
      errorCode: 'BadDeviceToken',
    });
  });
});

describe('pushReceiptHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PUSH_PROVIDER_WEBHOOK_SECRET = 'shared-secret';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../eligibility/dynamoClient.js');
  });

  it('returns 401 problem+json on a missing vendor secret (AC-matrix)', async () => {
    const { handler } = await import('./pushReceiptHandler.js');
    const result = (await handler(
      buildEvent(undefined, {
        deptId: 'NICHOLS',
        memberId: 'mbr-1',
        token: 'tok-1',
        errorCode: 'BadDeviceToken',
      }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('returns 401 problem+json on a mismatched vendor secret (AC-matrix)', async () => {
    const { handler } = await import('./pushReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-push-provider-secret': 'wrong' },
        { deptId: 'NICHOLS', memberId: 'mbr-1', token: 'tok-1', errorCode: 'BadDeviceToken' },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('returns 401 (never throws) on a secret of a different length than the configured secret (P1 regression: timing-safe compare)', async () => {
    const { handler } = await import('./pushReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-push-provider-secret': 'short' },
        { deptId: 'NICHOLS', memberId: 'mbr-1', token: 'tok-1', errorCode: 'BadDeviceToken' },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('returns 400 problem+json when errorCode is absent, and makes no DynamoDB call (AC-matrix)', async () => {
    const send = vi.fn();
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./pushReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-push-provider-secret': 'shared-secret' },
        { deptId: 'NICHOLS', memberId: 'mbr-1', token: 'tok-1' },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('marks the PUSH entry invalid while preserving other channels, on a permanent invalid-token error (AC4)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: {
            pk: 'DEPT#NICHOLS#ELIGIBILITY',
            sk: 'MEMBER#mbr-1',
            contactChannels: [
              { channel: 'SMS', token: '+15551234567' },
              { channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: true },
            ],
          },
        });
      }
      return Promise.resolve({});
    });
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));

    const { handler } = await import('./pushReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-push-provider-secret': 'shared-secret' },
        { deptId: 'NICHOLS', memberId: 'mbr-1', token: 'tok-1', errorCode: 'BadDeviceToken' },
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ memberId: 'mbr-1', invalidated: true });

    const updateCall = send.mock.calls[1]?.[0] as {
      input: {
        ExpressionAttributeValues: { ':contactChannels': { channel: string; valid?: boolean }[] };
      };
    };
    const contactChannels = updateCall.input.ExpressionAttributeValues[':contactChannels'];
    expect(contactChannels).toEqual([
      { channel: 'SMS', token: '+15551234567' },
      { channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: false },
    ]);
  });

  it('returns 200 with invalidated:false and makes no write when there is no PUSH entry to invalidate', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { contactChannels: [] } });
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));

    const { handler } = await import('./pushReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-push-provider-secret': 'shared-secret' },
        { deptId: 'NICHOLS', memberId: 'mbr-1', token: 'tok-1', errorCode: 'BadDeviceToken' },
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ memberId: 'mbr-1', invalidated: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  // Review minor 6: a bare INVALID_ARGUMENT cannot say whether it names the token or the
  // payload, so the webhook path must not disable a device on it.
  it('treats a bare INVALID_ARGUMENT as non-permanent: 200 invalidated:false, no DynamoDB call', async () => {
    const send = vi.fn();
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./pushReceiptHandler.js');
    const result = (await handler(
      buildEvent(
        { 'x-push-provider-secret': 'shared-secret' },
        { deptId: 'NICHOLS', memberId: 'mbr-1', token: 'tok-1', errorCode: 'INVALID_ARGUMENT' },
      ),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ memberId: 'mbr-1', invalidated: false });
    expect(send).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
