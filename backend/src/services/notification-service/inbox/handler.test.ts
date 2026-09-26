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

function buildEvent(
  routeKey: string,
  pathParameters: Record<string, string> | undefined,
  queryStringParameters?: Record<string, string>,
): GuardEvent {
  return {
    version: '2.0',
    routeKey,
    rawPath: '/api/v1/notifications',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters,
    queryStringParameters,
    body: undefined,
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function mockDdb(dynamoSend: ReturnType<typeof vi.fn>): void {
  vi.doMock('../dynamoClient.js', () => ({
    createDynamoClient: () => ({ send: dynamoSend }) as unknown as DynamoDBDocumentClient,
    readNotificationConfig: () => ({ tableName: 'platform-service' }),
  }));
}

describe('inbox handler (entrypoint-test + authz-wiring obligations)', () => {
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

  it('GET /api/v1/notifications returns 200 with the member-scoped page and a nextCursor', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    const dynamoSend = vi.fn().mockResolvedValue({
      Items: [{ notificationId: 'NOTIF-1', readAt: null }],
      LastEvaluatedKey: { pk: 'DEPT#NICHOLS#MEMBER#MBR-1', sk: 'NOTIF#MBR-1#1#NOTIF-1' },
    });
    mockDdb(dynamoSend);

    const { listHandler } = await import('./handler.js');
    const result = (await listHandler(buildEvent('GET /api/v1/notifications', undefined))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
  });

  it('GET /api/v1/notifications returns 401/403 when Verified Permissions denies, never invoking the query', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    const dynamoSend = vi.fn();
    mockDdb(dynamoSend);

    const { listHandler } = await import('./handler.js');
    const result = (await listHandler(buildEvent('GET /api/v1/notifications', undefined))) as {
      statusCode: number;
    };

    expect(result.statusCode).toBe(403);
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('POST /api/v1/notifications/{id}/read marks readAt and returns it (AC6)', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    const dynamoSend = vi
      .fn()
      .mockImplementation(
        (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (command.constructor.name === 'QueryCommand') {
            expect(command.input.IndexName).toBe('GSI1');
            return Promise.resolve({
              Items: [{ sk: 'NOTIF#MBR-1#1#NOTIF-1', notificationId: 'NOTIF-1' }],
            });
          }
          return Promise.resolve({});
        },
      );
    mockDdb(dynamoSend);

    const { markReadHandler } = await import('./handler.js');
    const result = (await markReadHandler(
      buildEvent('POST /api/v1/notifications/{id}/read', { id: 'NOTIF-1' }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { notificationId: string; readAt: number };
    expect(body.notificationId).toBe('NOTIF-1');
    expect(typeof body.readAt).toBe('number');
  });

  it('POST /api/v1/notifications/{id}/read returns 400 when the id path parameter is absent (P9)', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    const dynamoSend = vi.fn();
    mockDdb(dynamoSend);

    const { markReadHandler } = await import('./handler.js');
    const result = (await markReadHandler(
      buildEvent('POST /api/v1/notifications/{id}/read', undefined),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(400);
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it("POST /api/v1/notifications/{id}/read returns 404 when the id is not in the member's own inbox", async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    const dynamoSend = vi.fn().mockResolvedValue({ Items: [] });
    mockDdb(dynamoSend);

    const { markReadHandler } = await import('./handler.js');
    const result = (await markReadHandler(
      buildEvent('POST /api/v1/notifications/{id}/read', { id: 'NOTIF-missing' }),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(404);
  });

  it('POST /api/v1/notifications/{id}/read returns 401/403 when Verified Permissions denies', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    const dynamoSend = vi.fn();
    mockDdb(dynamoSend);

    const { markReadHandler } = await import('./handler.js');
    const result = (await markReadHandler(
      buildEvent('POST /api/v1/notifications/{id}/read', { id: 'NOTIF-1' }),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(403);
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('GET /api/v1/notifications returns only the member-facing fields, never storage keys', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    const dynamoSend = vi.fn().mockResolvedValue({
      Items: [
        {
          pk: 'DEPT#NICHOLS#MEMBER#MBR-1',
          sk: 'NOTIF#MBR-1#1#NOTIF-1',
          gsi1pk: 'DEPT#NICHOLS#MEMBER#MBR-1',
          gsi1sk: 'NOTIFICATION#NOTIF-1',
          ttl: 123,
          entityType: 'NOTIFICATION',
          memberId: 'MBR-1',
          notificationId: 'NOTIF-1',
          category: 'cert-expiry',
          summary: '1 item expiring',
          items: [{ certId: 'CERT-1', expiryDate: '2027-01-10' }],
          createdAt: 1,
          readAt: null,
        },
      ],
    });
    mockDdb(dynamoSend);

    const { handler } = await import('./handler.js');
    const result = (await handler(buildEvent('GET /api/v1/notifications', undefined))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { items: Record<string, unknown>[] };
    expect(body.items).toEqual([
      {
        notificationId: 'NOTIF-1',
        category: 'cert-expiry',
        summary: '1 item expiring',
        items: [{ certId: 'CERT-1', expiryDate: '2027-01-10' }],
        createdAt: 1,
        readAt: null,
      },
    ]);
  });

  it('the Lambda entry point dispatches POST /api/v1/notifications/{id}/read to mark-read', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    const dynamoSend = vi
      .fn()
      .mockImplementation((command: { constructor: { name: string } }) =>
        Promise.resolve(
          command.constructor.name === 'QueryCommand'
            ? { Items: [{ sk: 'NOTIF#MBR-1#1#NOTIF-1' }] }
            : {},
        ),
      );
    mockDdb(dynamoSend);

    const { handler } = await import('./handler.js');
    const result = (await handler(
      buildEvent('POST /api/v1/notifications/{id}/read', { id: 'NOTIF-1' }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect((JSON.parse(result.body) as { notificationId: string }).notificationId).toBe('NOTIF-1');
  });

  it('the Lambda entry point returns 404 for the legacy bare /notifications route key', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    const dynamoSend = vi.fn();
    mockDdb(dynamoSend);

    const { handler } = await import('./handler.js');
    const result = (await handler(buildEvent('GET /notifications', undefined))) as {
      statusCode: number;
    };

    expect(result.statusCode).toBe(404);
    expect(dynamoSend).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
