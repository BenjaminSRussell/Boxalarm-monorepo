import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'member-0012', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

function buildEvent(
  dispatchId: string | undefined,
  headers: Record<string, string> | undefined = { authorization: 'Bearer token-1' },
  principal: typeof PRINCIPAL | undefined = PRINCIPAL,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/dispatches/{dispatchId}',
    rawPath: `/api/v1/alerting/dispatches/${dispatchId ?? ''}`,
    rawQueryString: '',
    headers,
    pathParameters: dispatchId ? { dispatchId } : undefined,
    requestContext: { authorizer: { lambda: principal } },
  } as unknown as GuardEvent;
}

function fakeAuthzClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

const DISPATCH_ITEM = {
  dispatchId: 'NICHOLS-4471-1798000000',
  incidentType: 'STRUCTURE_FIRE',
  address: '123 Main St',
  crossStreets: 'Main & Elm',
  narrative: 'Smoke showing, 2nd floor',
};

describe('alert-detail handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'store-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 200 with incident type, address, cross streets, map link, and narrative (AC1, entrypoint test)', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = {
      send: vi.fn().mockResolvedValue({ Item: DISPATCH_ITEM }),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({
      dispatchId: 'NICHOLS-4471-1798000000',
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      crossStreets: 'Main & Elm',
      narrative: 'Smoke showing, 2nd floor',
      mapLink: 'https://www.google.com/maps/search/?api=1&query=123%20Main%20St',
      eligibleMemberCount: null,
      fanOutStartedAt: null,
      toneLadder: { status: 'ACTIVE', currentToneSequence: 1, nextToneAt: null },
      prePlan: null,
    });
  });

  it('passes eligibleMemberCount/fanOutStartedAt through when E1-S2 has populated them, without blocking on their absence otherwise', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = {
      send: vi.fn().mockResolvedValue({
        Item: { ...DISPATCH_ITEM, eligibleMemberCount: 34, fanOutStartedAt: 1798000002 },
      }),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.eligibleMemberCount).toBe(34);
    expect(body.fanOutStartedAt).toBe(1798000002);
  });

  it('AC2: renders full core content with prePlan null when the pre-plan copy read throws — isolation from the alert-path failure domain', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createHandler } = await import('./handler.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { ...DISPATCH_ITEM, prePlanRefs: ['OCC-0231'] } })
      .mockRejectedValueOnce(new Error('pre-plan table unavailable'));
    const docClient = { send } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.prePlan).toBeNull();
    expect(body.address).toBe('123 Main St');
    const logged = errorSpy.mock.calls.map((call) => call[0] as string).join('\n');
    expect(logged).toContain('dispatches.detail.preplan_read_failed');
    expect(logged).toContain('pre-plan table unavailable');
    errorSpy.mockRestore();
  });

  describe('mutualAid (officer ladder controls, F1.13)', () => {
    function bySk(items: Record<string, unknown>) {
      return {
        send: vi.fn((command: { input: { Key: { sk: string } } }) => {
          const item = items[command.input.Key.sk];
          return item instanceof Error ? Promise.reject(item) : Promise.resolve({ Item: item });
        }),
      } as unknown as DynamoDBDocumentClient;
    }

    it('is null when mutual aid has not been requested', async () => {
      const { createHandler } = await import('./handler.js');
      const handler = createHandler({
        authzClient: fakeAuthzClient('ALLOW'),
        docClient: bySk({ METADATA: DISPATCH_ITEM }),
      });

      const body = JSON.parse(
        ((await handler(buildEvent('NICHOLS-4471-1798000000'))) as { body: string }).body,
      ) as Record<string, unknown>;

      expect(body.mutualAid).toBeNull();
    });

    it('carries the requested/acknowledged state of the MUTUAL_AID_EVENT singleton', async () => {
      const { createHandler } = await import('./handler.js');
      const handler = createHandler({
        authzClient: fakeAuthzClient('ALLOW'),
        docClient: bySk({
          METADATA: DISPATCH_ITEM,
          'MUTUALAID#SINGLETON': {
            entityType: 'MUTUAL_AID_EVENT',
            reason: 'TONE_3_PREDICATE_UNMET',
            triggeredAt: 1798000360,
            acknowledgedBy: 'officer-7',
            acknowledgedAt: 1798000400,
            notes: 'Called Trumbull Center',
            adapterUsed: 'OFFICER_MANUAL_PROMPT',
          },
        }),
      });

      const body = JSON.parse(
        ((await handler(buildEvent('NICHOLS-4471-1798000000'))) as { body: string }).body,
      ) as Record<string, unknown>;

      expect(body.mutualAid).toEqual({
        triggeredAt: 1798000360,
        reason: 'TONE_3_PREDICATE_UNMET',
        triggeredBy: null,
        acknowledgedBy: 'officer-7',
        acknowledgedAt: 1798000400,
        notes: 'Called Trumbull Center',
      });
    });

    it('omits mutualAid (unknown, not "not requested") and still serves the alert when the read fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { createHandler } = await import('./handler.js');
      const handler = createHandler({
        authzClient: fakeAuthzClient('ALLOW'),
        docClient: bySk({
          METADATA: DISPATCH_ITEM,
          'MUTUALAID#SINGLETON': new Error('throttled'),
        }),
      });

      const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

      expect(result).toMatchObject({ statusCode: 200 });
      const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
      expect(body.address).toBe('123 Main St');
      expect('mutualAid' in body).toBe(false);
      errorSpy.mockRestore();
    });
  });

  it('AC2: renders full core content with prePlan null when the DISPATCH_ALERT item has no prePlanRefs yet', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = {
      send: vi.fn().mockResolvedValue({ Item: DISPATCH_ITEM }),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.prePlan).toBeNull();
  });

  it('returns 400 when dispatchId path parameter is absent', async () => {
    const { createHandler } = await import('./handler.js');
    const sendSpy = vi.fn();
    const docClient = { send: sendSpy } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 400 });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('returns 400 (not 503) when dispatchId contains the pk delimiter "#"', async () => {
    const { createHandler } = await import('./handler.js');
    const sendSpy = vi.fn();
    const docClient = { send: sendSpy } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('a#b'));

    expect(result).toMatchObject({ statusCode: 400 });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('prefers the stored mapLink over a recomputed address-based link (AC1)', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = {
      send: vi
        .fn()
        .mockResolvedValue({ Item: { ...DISPATCH_ITEM, mapLink: 'https://maps.example/stored' } }),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.mapLink).toBe('https://maps.example/stored');
  });

  it('builds a coordinate-based mapLink when latitude/longitude are stored but mapLink is not', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = {
      send: vi
        .fn()
        .mockResolvedValue({ Item: { ...DISPATCH_ITEM, latitude: 41.2429, longitude: -73.2007 } }),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.mapLink).toBe('https://www.google.com/maps/search/?api=1&query=41.2429%2C-73.2007');
  });

  it('returns 404 when no DISPATCH_ALERT item exists for the given dispatchId', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('missing-dispatch'));

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 503 and logs the original error when the DISPATCH_ALERT GetCommand throws (core content read, not pre-plan)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createHandler } = await import('./handler.js');
    class ProvisionedThroughputExceededException extends Error {}
    const docClient = {
      send: vi.fn().mockRejectedValue(new ProvisionedThroughputExceededException('throttled')),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    expect(result).toMatchObject({ statusCode: 503 });
    const logged = errorSpy.mock.calls.map((call) => call[0] as string).join('\n');
    expect(logged).toContain('throttled');
    expect(logged).toContain('dispatches.detail.read_failed');
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.detail).not.toContain('authorization service');
    expect(body.detail).toContain('alert data store');
    errorSpy.mockRestore();
  });

  it('returns 401 (fail-closed) for a missing bearer token before any DynamoDB call', async () => {
    const { createHandler } = await import('./handler.js');
    const sendSpy = vi.fn();
    const docClient = { send: sendSpy } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000', {}));

    expect(result).toMatchObject({ statusCode: 401 });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('returns 403 on a Cedar deny (cross-department access)', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ authzClient: fakeAuthzClient('DENY') });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 (fail-closed, never a defaulted allow) when Verified Permissions is unavailable', async () => {
    const { createHandler } = await import('./handler.js');
    const authzClient = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const handler = createHandler({ authzClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
