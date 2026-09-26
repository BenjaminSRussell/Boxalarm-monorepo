import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'member' };

function buildEvent(
  occupancyId = 'OCC-1',
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/inspections/occupancies/{id}/pre-plan',
    rawPath: `/api/v1/inspections/occupancies/${occupancyId}/pre-plan`,
    rawQueryString: '',
    headers,
    pathParameters: { id: occupancyId },
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

describe('getPrePlanHandler', () => {
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
    const { handler } = await import('./getPrePlanHandler.js');
    const result = await handler(buildEvent('OCC-1', {}));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 on a Cedar deny', async () => {
    const { createGetPrePlanHandler } = await import('./getPrePlanHandler.js');
    const denySend = vi.fn().mockResolvedValue({ decision: Decision.DENY });
    const denyClient = { send: denySend } as unknown as VerifiedPermissionsClient;
    const wrapped = createGetPrePlanHandler(fakeDoc(vi.fn()), denyClient);
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 403 });
    const command = denySend.mock.calls[0]?.[0] as unknown as {
      input: { action: unknown; resource: unknown };
    };
    expect(command.input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'GetPrePlan',
    });
    expect(command.input.resource).toEqual({
      entityType: 'Boxalarm::Occupancy',
      entityId: 'OCC-1',
    });
  });

  it('returns 503 when Verified Permissions is unavailable', async () => {
    const { createGetPrePlanHandler } = await import('./getPrePlanHandler.js');
    const unavailableClient = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const wrapped = createGetPrePlanHandler(fakeDoc(vi.fn()), unavailableClient);
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns the pre-plan with a signed diagram link from a single Query against the occupancy partition (AC3)', async () => {
    const { createGetPrePlanHandler } = await import('./getPrePlanHandler.js');
    const item = {
      prePlanId: 'PP-1',
      siteDiagramS3Key: 'NICHOLS/PRE_PLAN/PP-1/diagram.pdf',
      attachmentS3Keys: ['NICHOLS/PRE_PLAN/PP-1/photo.jpg'],
      utilityShutoffs: [],
      hazards: [],
    };
    const send = vi.fn().mockResolvedValue({ Items: [item] });
    const signer = vi.fn().mockResolvedValue('https://signed.example.com/read');
    const wrapped = createGetPrePlanHandler(fakeDoc(send), allowClient(), signer);
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 200 });
    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.prePlanId).toBe('PP-1');
    expect(body.siteDiagramUrl).toBe('https://signed.example.com/read');
    expect(body.attachmentUrls).toEqual([
      { key: 'NICHOLS/PRE_PLAN/PP-1/photo.jpg', url: 'https://signed.example.com/read' },
    ]);
    // Download links are presigned GETs against the platform-assets bucket, never PUTs.
    expect(signer).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketName: 'bucket',
        key: 'NICHOLS/PRE_PLAN/PP-1/diagram.pdf',
        method: 'GET',
      }),
    );
    expect(
      signer.mock.calls.every(([request]) => (request as { method: string }).method === 'GET'),
    ).toBe(true);
  });

  it('returns 404 when no pre-plan is on file for the occupancy', async () => {
    const { createGetPrePlanHandler } = await import('./getPrePlanHandler.js');
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const wrapped = createGetPrePlanHandler(fakeDoc(send), allowClient());
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 503 when DynamoDB is unavailable', async () => {
    const { createGetPrePlanHandler } = await import('./getPrePlanHandler.js');
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    const wrapped = createGetPrePlanHandler(fakeDoc(send), allowClient());
    const result = await wrapped(buildEvent());
    expect(result).toMatchObject({ statusCode: 503 });
  });
});
