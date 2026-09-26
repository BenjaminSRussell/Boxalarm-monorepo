import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const send = vi.fn();

vi.mock('@aws-sdk/client-verifiedpermissions', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-verifiedpermissions')>(
    '@aws-sdk/client-verifiedpermissions',
  );
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send })),
  };
});

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'MBR-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(routeKey: string, body: unknown): GuardEvent {
  return {
    version: '2.0',
    routeKey,
    rawPath: '/api/v1/notifications/preferences',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function mockDdb(dynamoSend: ReturnType<typeof vi.fn>): void {
  vi.doMock('../dynamoClient.js', () => ({
    createDynamoClient: () => ({ send: dynamoSend }) as unknown as DynamoDBDocumentClient,
    readNotificationConfig: () => ({ tableName: 'platform-service' }),
  }));
}

describe('preferences handler (entrypoint-test + authz-wiring obligations)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    send.mockReset();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../dynamoClient.js');
  });

  it('PUT then GET round-trips a category preference', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    let stored: Record<string, unknown> | undefined;
    const dynamoSend = vi
      .fn()
      .mockImplementation(
        (command: { constructor: { name: string }; input: { Item?: Record<string, unknown> } }) => {
          if (command.constructor.name === 'PutCommand') {
            stored = command.input.Item;
            return Promise.resolve({});
          }
          return Promise.resolve({ Items: stored ? [stored] : [] });
        },
      );
    mockDdb(dynamoSend);

    const { putHandler, getHandler } = await import('./handler.js');
    const putResult = (await putHandler(
      buildEvent('PUT /api/v1/notifications/preferences', {
        category: 'cert-expiry',
        channels: { push: true, email: false },
      }),
    )) as { statusCode: number };
    expect(putResult.statusCode).toBe(200);

    const getResult = (await getHandler(
      buildEvent('GET /api/v1/notifications/preferences', undefined),
    )) as {
      statusCode: number;
      body: string;
    };
    expect(getResult.statusCode).toBe(200);
    const body = JSON.parse(getResult.body) as {
      preferences: {
        category: string;
        channels: { push: boolean; email: boolean };
        memberId: string;
        updatedAt: number;
      }[];
    };
    expect(body.preferences).toEqual([
      {
        category: 'cert-expiry',
        channels: { push: true, email: false },
        memberId: 'MBR-1',
        updatedAt: expect.any(Number) as number,
      },
    ]);
  });

  it('PUT returns 400 when channels is absent', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    const dynamoSend = vi.fn();
    mockDdb(dynamoSend);

    const { putHandler } = await import('./handler.js');
    const result = (await putHandler(
      buildEvent('PUT /api/v1/notifications/preferences', { category: 'cert-expiry' }),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(400);
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('PUT returns 400 when category is wrong-typed (a number)', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    const dynamoSend = vi.fn();
    mockDdb(dynamoSend);

    const { putHandler } = await import('./handler.js');
    const result = (await putHandler(
      buildEvent('PUT /api/v1/notifications/preferences', {
        category: 42,
        channels: { push: false, email: false },
      }),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(400);
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('GET returns 401/403 when Verified Permissions denies', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    const dynamoSend = vi.fn();
    mockDdb(dynamoSend);

    const { getHandler } = await import('./handler.js');
    const result = (await getHandler(
      buildEvent('GET /api/v1/notifications/preferences', undefined),
    )) as {
      statusCode: number;
    };

    expect(result.statusCode).toBe(403);
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('PUT returns 401/403 when Verified Permissions denies', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    const dynamoSend = vi.fn();
    mockDdb(dynamoSend);

    const { putHandler } = await import('./handler.js');
    const result = (await putHandler(
      buildEvent('PUT /api/v1/notifications/preferences', {
        category: 'cert-expiry',
        channels: { push: true, email: false },
      }),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(403);
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('the Lambda entry point dispatches GET and PUT /api/v1/notifications/preferences', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    const dynamoSend = vi.fn().mockResolvedValue({ Items: [] });
    mockDdb(dynamoSend);

    const { handler } = await import('./handler.js');
    const get = (await handler(buildEvent('GET /api/v1/notifications/preferences', undefined))) as {
      statusCode: number;
      body: string;
    };
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.body)).toEqual({ preferences: [] });

    const put = (await handler(
      buildEvent('PUT /api/v1/notifications/preferences', {
        category: 'cert-expiry',
        channels: { push: true, email: false },
      }),
    )) as { statusCode: number };
    expect(put.statusCode).toBe(200);
    expect(
      dynamoSend.mock.calls.map(
        (c) => (c[0] as { constructor: { name: string } }).constructor.name,
      ),
    ).toEqual(['QueryCommand', 'PutCommand']);
  });

  it('the Lambda entry point returns 404 for the legacy bare /notifications/preferences route key', async () => {
    const dynamoSend = vi.fn();
    mockDdb(dynamoSend);

    const { handler } = await import('./handler.js');
    const result = (await handler(buildEvent('GET /notifications/preferences', undefined))) as {
      statusCode: number;
    };

    expect(result.statusCode).toBe(404);
    expect(send).not.toHaveBeenCalled();
    expect(dynamoSend).not.toHaveBeenCalled();
  });
});
