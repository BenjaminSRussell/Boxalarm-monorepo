import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'member-0012', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };
const NOW_MS = 1_798_007_200_000;
const NOW_S = NOW_MS / 1000;

function buildEvent(
  query: Record<string, string> | null = { status: 'active' },
  principal: typeof PRINCIPAL = PRINCIPAL,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/dispatches',
    rawPath: '/api/v1/alerting/dispatches',
    rawQueryString: '',
    headers: { authorization: 'Bearer token-1' },
    queryStringParameters: query,
    requestContext: { authorizer: { lambda: principal } },
  } as unknown as GuardEvent;
}

function fakeAuthzClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient & {
  send: ReturnType<typeof vi.fn>;
} {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient & { send: ReturnType<typeof vi.fn> };
}

const ALERT = {
  pk: 'DEPT#NICHOLS#DISPATCH#NICHOLS-4471-1798006000',
  sk: 'METADATA',
  entityType: 'DISPATCH_ALERT',
  dispatchId: 'NICHOLS-4471-1798006000',
  incidentType: 'STRUCTURE_FIRE',
  address: '123 Main St',
  crossStreets: 'Main & Elm',
  narrative: 'Smoke showing',
  dispatchedAt: 1_798_006_000,
  toneLadderStatus: 'HALTED_MANUAL',
  currentToneSequence: 2,
};

describe('list-active-dispatches handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'store-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('queries GSI2 for the caller department over the active window, newest first, never a Scan', async () => {
    const { createHandler } = await import('./handler.js');
    const send = vi.fn().mockResolvedValue({ Items: [ALERT] });
    const handler = createHandler({
      authzClient: fakeAuthzClient('ALLOW'),
      docClient: { send } as unknown as DynamoDBDocumentClient,
      now: () => NOW_MS,
    });

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as QueryCommand;
    expect(command.constructor.name).toBe('QueryCommand');
    expect(command.input).toMatchObject({
      TableName: 'alerting-table',
      IndexName: 'GSI2',
      KeyConditionExpression: 'gsi2pk = :gsi2pk AND gsi2sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':gsi2pk': 'DEPT#NICHOLS',
        ':from': `DISPATCH#${NOW_S - 7200}`,
        ':to': 'DISPATCH#9999999999',
      },
      ScanIndexForward: false,
    });
  });

  it('returns only the summary fields plus the window it applied, not the narrative or keys', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({
      authzClient: fakeAuthzClient('ALLOW'),
      docClient: {
        send: vi.fn().mockResolvedValue({ Items: [ALERT] }),
      } as unknown as DynamoDBDocumentClient,
      now: () => NOW_MS,
    });

    const result = await handler(buildEvent());

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toEqual({
      dispatches: [
        {
          dispatchId: 'NICHOLS-4471-1798006000',
          incidentType: 'STRUCTURE_FIRE',
          address: '123 Main St',
          crossStreets: 'Main & Elm',
          dispatchedAt: 1_798_006_000,
          toneLadder: { status: 'HALTED_MANUAL', currentToneSequence: 2 },
        },
      ],
      activeWindowSeconds: 7200,
      asOf: NOW_S,
      truncated: false,
    });
  });

  it('returns an empty list (not an error) when nothing was dispatched in the window', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({
      authzClient: fakeAuthzClient('ALLOW'),
      docClient: { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient,
      now: () => NOW_MS,
    });

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { dispatches: unknown[] };
    expect(body.dispatches).toEqual([]);
  });

  it('follows pagination and flags truncation when the page cap is hit', async () => {
    const { createHandler } = await import('./handler.js');
    const send = vi.fn().mockResolvedValue({ Items: [ALERT], LastEvaluatedKey: { pk: 'x' } });
    const handler = createHandler({
      authzClient: fakeAuthzClient('ALLOW'),
      docClient: { send } as unknown as DynamoDBDocumentClient,
      now: () => NOW_MS,
    });

    const result = await handler(buildEvent());

    expect(send).toHaveBeenCalledTimes(5);
    const body = JSON.parse((result as { body: string }).body) as {
      dispatches: unknown[];
      truncated: boolean;
    };
    expect(body.dispatches).toHaveLength(5);
    expect(body.truncated).toBe(true);
  });

  it.each([[null], [{}], [{ status: 'all' }]])(
    'rejects a missing or unsupported status filter (%j) with 400 and no read',
    async (query) => {
      const { createHandler } = await import('./handler.js');
      const send = vi.fn();
      const handler = createHandler({
        authzClient: fakeAuthzClient('ALLOW'),
        docClient: { send } as unknown as DynamoDBDocumentClient,
      });

      const result = await handler(buildEvent(query));

      expect(result).toMatchObject({ statusCode: 400 });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('authorizes ListActiveDispatches on the caller department and returns 403 on DENY without reading', async () => {
    const { createHandler } = await import('./handler.js');
    const authzClient = fakeAuthzClient('DENY');
    const send = vi.fn();
    const handler = createHandler({
      authzClient,
      docClient: { send } as unknown as DynamoDBDocumentClient,
    });

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(send).not.toHaveBeenCalled();
    const input = (authzClient.send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      action: { actionType: 'Boxalarm::Action', actionId: 'ListActiveDispatches' },
      resource: { entityType: 'Boxalarm::Department', entityId: 'NICHOLS' },
    });
  });

  it('returns 503 and logs when the alerting table read fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({
      authzClient: fakeAuthzClient('ALLOW'),
      docClient: {
        send: vi.fn().mockRejectedValue(new Error('throttled')),
      } as unknown as DynamoDBDocumentClient,
    });

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy.mock.calls.map((c) => c[0] as string).join('\n')).toContain(
      'dispatches.list_active.read_failed',
    );
  });
});
