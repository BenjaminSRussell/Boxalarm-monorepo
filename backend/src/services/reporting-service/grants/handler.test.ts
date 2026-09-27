import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const originalEnv = { ...process.env };

const ADMIN: CedarPrincipalContext = {
  sub: 'MBR-0001',
  deptId: 'NICHOLS',
  'cognito:groups': 'admin',
};

function buildEvent(
  query: Record<string, string> | undefined = {
    periodStart: '1700000000000',
    periodEnd: '1701000000000',
  },
  headers: Record<string, string> = { authorization: 'Bearer token' },
  principal: Partial<CedarPrincipalContext> | null | undefined = ADMIN,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/reporting/grants',
    rawPath: '/api/v1/reporting/grants',
    rawQueryString: '',
    headers,
    queryStringParameters: query,
    requestContext: { authorizer: { lambda: principal ?? undefined } },
  } as unknown as GuardEvent;
}

function fakeAuthzClient(decision: 'ALLOW' | 'DENY' | Error = 'ALLOW'): VerifiedPermissionsClient {
  return {
    send:
      decision instanceof Error
        ? vi.fn().mockRejectedValue(decision)
        : vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function fakeDynamoClient(
  items: readonly Record<string, unknown>[] | Error = [],
): DynamoDBDocumentClient {
  const send = vi.fn((command: unknown) => {
    if (!(command instanceof QueryCommand)) {
      return Promise.reject(new Error('unexpected command'));
    }
    return items instanceof Error ? Promise.reject(items) : Promise.resolve({ Items: items });
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

beforeEach(() => {
  vi.resetModules();
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
  process.env.TRAINING_DYNAMO_TABLE_NAME = 'training-table';
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('grants/handler.ts (entrypoint)', () => {
  it('returns 403 when a non-admin caller is denied by Cedar (AC3, core-harm)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, fakeAuthzClient('DENY'));
    const { createDynamoClient } = await import('../client.js');
    createDynamoClient(process.env, fakeDynamoClient());
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('asks Verified Permissions with the namespaced Boxalarm::Action / Boxalarm::Department types the Cedar schema declares', async () => {
    const send = vi.fn().mockResolvedValue({ decision: Decision.DENY });
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, { send } as unknown as VerifiedPermissionsClient);
    const { createDynamoClient } = await import('../client.js');
    createDynamoClient(process.env, fakeDynamoClient());
    const { handler } = await import('./handler.js');

    await handler(buildEvent());

    const command = send.mock.calls[0]?.[0] as {
      input: { action: unknown; resource: unknown };
    };
    expect(command.input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'ViewGrantsReport',
    });
    expect(command.input.resource).toEqual({
      entityType: 'Boxalarm::Department',
      entityId: 'NICHOLS',
    });
  });

  it('returns 401 (fail-closed) when the bearer token is missing (no authorization decision made)', async () => {
    const { createDynamoClient } = await import('../client.js');
    createDynamoClient(process.env, fakeDynamoClient());
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent(undefined, {}));

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 503 when Verified Permissions is unavailable (fail-closed)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, fakeAuthzClient(new Error('VP outage')));
    const { createDynamoClient } = await import('../client.js');
    createDynamoClient(process.env, fakeDynamoClient());
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 400 when periodStart/periodEnd are absent', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, fakeAuthzClient('ALLOW'));
    const { createDynamoClient } = await import('../client.js');
    createDynamoClient(process.env, fakeDynamoClient());
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({}));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when periodEnd is not after periodStart', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, fakeAuthzClient('ALLOW'));
    const { createDynamoClient } = await import('../client.js');
    createDynamoClient(process.env, fakeDynamoClient());
    const { handler } = await import('./handler.js');

    const result = await handler(
      buildEvent({ periodStart: '1701000000000', periodEnd: '1700000000000' }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { traceId: string };
    expect(body.traceId).toBeTruthy();
  });

  it('returns 400 when periodEnd is non-numeric', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, fakeAuthzClient('ALLOW'));
    const { createDynamoClient } = await import('../client.js');
    createDynamoClient(process.env, fakeDynamoClient());
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent({ periodStart: '1700000000000', periodEnd: 'abc' }));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 503 (fail-closed, never a partial/degraded 200) when a dependency table Query throws', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, fakeAuthzClient('ALLOW'));
    const { createDynamoClient } = await import('../client.js');
    createDynamoClient(process.env, fakeDynamoClient(new Error('table throttled')));
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 200 with the assembled grants report for an authorized admin (AC1, AC2)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, fakeAuthzClient('ALLOW'));
    const { createDynamoClient } = await import('../client.js');
    createDynamoClient(process.env, fakeDynamoClient([]));
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      fieldSetSource: string;
      totalIncidentVolume: { available: boolean };
    };
    expect(body.fieldSetSource).toBe('default');
    expect(body.totalIncidentVolume).toEqual({ available: false, reason: 'E6-S1' });
  });
});
