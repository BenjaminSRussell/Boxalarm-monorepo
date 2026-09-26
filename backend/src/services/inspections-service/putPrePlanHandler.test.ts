import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'admin-1', deptId: 'NICHOLS', 'cognito:groups': 'admin' };

function buildEvent(
  body: string | undefined,
  occupancyId = 'OCC-1',
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/inspections/occupancies/{id}/pre-plan',
    rawPath: `/api/v1/inspections/occupancies/${occupancyId}/pre-plan`,
    rawQueryString: '',
    headers,
    pathParameters: { id: occupancyId },
    body,
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function allowClient(): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision.ALLOW }),
  } as unknown as VerifiedPermissionsClient;
}

function fakeDoc(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('putPrePlanHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    process.env.PLATFORM_ASSETS_BUCKET_NAME = 'bucket';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 401 on a missing bearer token via the real exported handler, before any AWS call (entrypoint test)', async () => {
    const { handler } = await import('./putPrePlanHandler.js');
    const result = await handler(buildEvent(undefined, 'OCC-1', {}));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 on a Cedar deny', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const denySend = vi.fn().mockResolvedValue({ decision: Decision.DENY });
    const denyClient = { send: denySend } as unknown as VerifiedPermissionsClient;
    const wrapped = createPutPrePlanHandler(fakeDoc(vi.fn()), vi.fn(), denyClient);
    const result = await wrapped(buildEvent('{}'));
    expect(result).toMatchObject({ statusCode: 403 });
    const command = denySend.mock.calls[0]?.[0] as unknown as {
      input: { action: unknown; resource: unknown };
    };
    expect(command.input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'UpdatePrePlan',
    });
    expect(command.input.resource).toEqual({
      entityType: 'Boxalarm::Occupancy',
      entityId: 'OCC-1',
    });
  });

  it('returns 503 when Verified Permissions is unavailable', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const unavailableClient = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const wrapped = createPutPrePlanHandler(fakeDoc(vi.fn()), vi.fn(), unavailableClient);
    const result = await wrapped(buildEvent('{}'));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 400 when the pre-plan body has a wrong-typed field (AC coverage of the input-domain matrix)', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const wrapped = createPutPrePlanHandler(fakeDoc(vi.fn()), vi.fn(), allowClient());
    const result = await wrapped(buildEvent(JSON.stringify({ utilityShutoffs: 'GAS' })));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when the body is unparseable JSON', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const wrapped = createPutPrePlanHandler(fakeDoc(vi.fn()), vi.fn(), allowClient());
    const result = await wrapped(buildEvent('{not valid json'));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when siteDiagramFilename contains a path traversal segment', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const wrapped = createPutPrePlanHandler(fakeDoc(vi.fn()), vi.fn(), allowClient());
    const result = await wrapped(
      buildEvent(
        JSON.stringify({ siteDiagramFilename: '../../OTHERDEPT/PRE_PLAN/PP-9/diagram.pdf' }),
      ),
    );
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('siteDiagramUploadUrl');
  });

  it('returns 400 when an attachmentFilenames entry contains a forward slash', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const wrapped = createPutPrePlanHandler(fakeDoc(vi.fn()), vi.fn(), allowClient());
    const result = await wrapped(
      buildEvent(JSON.stringify({ attachmentFilenames: ['sub/dir/photo.jpg'] })),
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when attachmentFilenames exceeds the maximum length', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const wrapped = createPutPrePlanHandler(fakeDoc(vi.fn()), vi.fn(), allowClient());
    const result = await wrapped(
      buildEvent(
        JSON.stringify({
          attachmentFilenames: Array.from({ length: 51 }, (_, i) => `photo${i}.jpg`),
        }),
      ),
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('writes the pre-plan and returns signed upload URLs on success (AC1/AC2)', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const send = vi.fn().mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});
    const signer = vi.fn().mockResolvedValue('https://signed.example.com/x');
    const wrapped = createPutPrePlanHandler(fakeDoc(send), signer, allowClient());
    const result = await wrapped(
      buildEvent(
        JSON.stringify({
          siteDiagramFilename: 'diagram.pdf',
          attachmentFilenames: ['photo.jpg'],
          utilityShutoffs: [{ utility: 'GAS', location: 'rear' }],
          hazards: ['PROPANE_TANK'],
        }),
      ),
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.siteDiagramUploadUrl).toBe('https://signed.example.com/x');
    expect(body.attachmentUploadUrls).toEqual([
      { filename: 'photo.jpg', uploadUrl: 'https://signed.example.com/x' },
    ]);
    const requests = signer.mock.calls.map(([request]) => request as Record<string, unknown>);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({ bucketName: 'bucket', method: 'PUT', expiresInSeconds: 600 });
      expect(request.key).toMatch(/^NICHOLS\/PRE_PLAN\/[^/]+\/(diagram\.pdf|photo\.jpg)$/);
    }
  });

  it('fails before writing the pre-plan when the assets bucket is not configured (checked before the DynamoDB transaction)', async () => {
    delete process.env.PLATFORM_ASSETS_BUCKET_NAME;
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const send = vi.fn();
    const wrapped = createPutPrePlanHandler(fakeDoc(send), vi.fn(), allowClient());
    await expect(
      wrapped(
        buildEvent(JSON.stringify({ siteDiagramFilename: 'diagram.pdf', attachmentFilenames: [] })),
      ),
    ).rejects.toThrow('PLATFORM_ASSETS_BUCKET_NAME is required');
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 404 when the occupancy does not exist (ConditionCheck fails)', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      );
    const wrapped = createPutPrePlanHandler(fakeDoc(send), vi.fn(), allowClient());
    const result = await wrapped(buildEvent('{}', 'OCC-missing'));
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 409 when a concurrent create races on the same occupancy', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        }),
      );
    const wrapped = createPutPrePlanHandler(fakeDoc(send), vi.fn(), allowClient());
    const result = await wrapped(buildEvent('{}', 'OCC-1'));
    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('returns 503 when DynamoDB is unavailable/throttled', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
    const wrapped = createPutPrePlanHandler(fakeDoc(send), vi.fn(), allowClient());
    const result = await wrapped(buildEvent('{}'));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('defaults an absent body to empty hazards/utilityShutoffs/files (200)', async () => {
    const { createPutPrePlanHandler } = await import('./putPrePlanHandler.js');
    const send = vi.fn().mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});
    const wrapped = createPutPrePlanHandler(fakeDoc(send), vi.fn(), allowClient());
    const result = await wrapped(buildEvent(undefined));
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.hazards).toEqual([]);
  });
});
