import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'inspector-1', deptId: 'dept-001', 'cognito:groups': 'officer' };

function buildEvent(
  query: Record<string, string> | undefined,
  headers: Record<string, string> | undefined = { authorization: 'Bearer token' },
  principal: typeof PRINCIPAL | undefined = PRINCIPAL,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/inspections/map',
    rawPath: '/api/v1/inspections/map',
    rawQueryString: '',
    headers,
    queryStringParameters: query,
    requestContext: {
      authorizer: { lambda: principal },
    },
  } as unknown as GuardEvent;
}

function fakeAuthzClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

const VALID_QUERY = { minLat: '41.24', minLng: '-73.2', maxLat: '41.25', maxLng: '-73.19' };

describe('map handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 200 with merged occupancies/hydrants for a valid bbox (AC1, entrypoint test)', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = {
      send: vi.fn().mockResolvedValue({ Items: [] }),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent(VALID_QUERY));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      occupancies: unknown[];
      hydrants: unknown[];
    };
    expect(body).toEqual({ occupancies: [], hydrants: [] });
  });

  it('returns 400 with field errors for a missing bbox param', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW') });

    const result = await handler(buildEvent({ minLat: '41.24', minLng: '-73.2', maxLat: '41.25' }));

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { detail: string };
    expect(body.detail).toContain('maxLng');
  });

  it('returns 400 for a non-numeric bbox param and for minLat >= maxLat', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW') });

    const nonNumeric = await handler(buildEvent({ ...VALID_QUERY, minLat: 'abc' }));
    expect(nonNumeric).toMatchObject({ statusCode: 400 });

    const inverted = await handler(
      buildEvent({ minLat: '41.3', minLng: '-73.2', maxLat: '41.1', maxLng: '-73.19' }),
    );
    expect(inverted).toMatchObject({ statusCode: 400 });
  });

  it('returns 401 (fail-closed) for a missing bearer token before any DynamoDB call', async () => {
    const { createHandler } = await import('./handler.js');
    const sendSpy = vi.fn();
    const docClient = { send: sendSpy } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent(VALID_QUERY, {}));

    expect(result).toMatchObject({ statusCode: 401 });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('returns 400 (not an unbounded DynamoDB fan-out) for a bbox spanning more than the maximum covering-cell count (P1/P2/P7 DoS guard)', async () => {
    const { createHandler } = await import('./handler.js');
    const sendSpy = vi.fn();
    const docClient = { send: sendSpy } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(
      buildEvent({ minLat: '-90', minLng: '-180', maxLat: '90', maxLng: '180' }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('returns 503 when PLATFORM_TABLE_NAME is unset (config guard, P6)', async () => {
    delete process.env.PLATFORM_TABLE_NAME;
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW') });

    const result = await handler(buildEvent(VALID_QUERY));

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 403 on a Cedar deny', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ authzClient: fakeAuthzClient('DENY') });

    const result = await handler(buildEvent(VALID_QUERY));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('asks Verified Permissions with the namespace-qualified Boxalarm action and resource types', async () => {
    const { createHandler } = await import('./handler.js');
    const send = vi.fn().mockResolvedValue({ decision: Decision.DENY });
    const authzClient = { send } as unknown as VerifiedPermissionsClient;
    await createHandler({ authzClient })(buildEvent(VALID_QUERY));

    const command = send.mock.calls[0]?.[0] as {
      input: { action: unknown; resource: { entityType: string } };
    };
    expect(command.input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'ViewInspectionsMap',
    });
    expect(command.input.resource.entityType).toBe('Boxalarm::InspectionsMap');
  });

  it('returns 503 (fail-closed, never a defaulted allow) when Verified Permissions is unavailable', async () => {
    const { createHandler } = await import('./handler.js');
    const authzClient = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const handler = createHandler({ authzClient });

    const result = await handler(buildEvent(VALID_QUERY));

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 503 and logs the original error when the DynamoDB QueryCommand throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createHandler } = await import('./handler.js');
    class ProvisionedThroughputExceededException extends Error {}
    const docClient = {
      send: vi.fn().mockRejectedValue(new ProvisionedThroughputExceededException('throttled')),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent(VALID_QUERY));

    expect(result).toMatchObject({ statusCode: 503 });
    const logged = errorSpy.mock.calls.map((call) => call[0] as string).join('\n');
    expect(logged).toContain('ProvisionedThroughputExceededException');
    expect(logged).toContain('inspections-map.query-failed');
    errorSpy.mockRestore();
  });
});
