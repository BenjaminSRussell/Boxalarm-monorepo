import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'inspector' };

const EXISTING_ITEM = {
  pk: 'DEPT#NICHOLS#OCCUPANCY#OCC-1',
  sk: 'INSPECTION#INS-1',
  entityType: 'INSPECTION_RECORD' as const,
  scheduledDate: '2026-09-01',
  violations: [],
  nextDueDate: '2026-09-01',
  gsi2pk: 'DEPT#NICHOLS#DUE#INSPECTION_RECORD#2026-09',
  gsi2sk: '2026-09-01#INS-1',
};

function buildEvent(
  body: string | undefined,
  headers: Record<string, string> = { authorization: 'Bearer token' },
  principal: Record<string, string> | null = PRINCIPAL,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/inspections/field-capture',
    rawPath: '/api/v1/inspections/field-capture',
    rawQueryString: '',
    headers,
    body,
    requestContext: { authorizer: { lambda: principal ?? undefined } },
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

function docWithExistingItem(transactResult: () => Promise<unknown>): {
  doc: DynamoDBDocumentClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi
    .fn()
    .mockResolvedValueOnce({ Item: EXISTING_ITEM })
    .mockImplementationOnce(transactResult);
  return { doc: fakeDoc(send), send };
}

const VALID_BODY = JSON.stringify({
  occupancyId: 'OCC-1',
  inspectionId: 'INS-1',
  idempotencyKey: 'idem-001',
  photoFilenames: ['photo.jpg'],
  violations: [{ code: 'V1', description: 'bad wiring', status: 'open' }],
});

describe('fieldCapture handler', () => {
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

  it('returns 401 on a missing bearer token via the real exported handler (entrypoint test)', async () => {
    const { handler } = await import('./handler.js');
    const result = await handler(buildEvent(VALID_BODY, {}));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 401 on a missing/invalid authorizer principal', async () => {
    const { handler } = await import('./handler.js');
    const result = await handler(buildEvent(VALID_BODY, { authorization: 'Bearer token' }, null));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 on a Cedar deny', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const denyClient = {
      send: vi.fn().mockResolvedValue({ decision: Decision.DENY }),
    } as unknown as VerifiedPermissionsClient;
    const wrapped = createFieldCaptureHandler(fakeDoc(vi.fn()), vi.fn(), denyClient);
    const result = await wrapped(buildEvent(VALID_BODY));
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503, never a defaulted allow, when Verified Permissions is unavailable (core-harm)', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const unavailableClient = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const send = vi.fn();
    const wrapped = createFieldCaptureHandler(fakeDoc(send), vi.fn(), unavailableClient);
    const result = await wrapped(buildEvent(VALID_BODY));
    expect(result).toMatchObject({ statusCode: 503 });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty/absent body', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const wrapped = createFieldCaptureHandler(fakeDoc(vi.fn()), vi.fn(), allowClient());
    const result = await wrapped(buildEvent(undefined));
    expect(result).toMatchObject({ statusCode: 400 });
    expect((result as { headers: Record<string, string> }).headers['content-type']).toBe(
      'application/problem+json',
    );
  });

  it('returns 400 for malformed JSON', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const wrapped = createFieldCaptureHandler(fakeDoc(vi.fn()), vi.fn(), allowClient());
    const result = await wrapped(buildEvent('{not-json'));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 for a missing idempotencyKey', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const wrapped = createFieldCaptureHandler(fakeDoc(vi.fn()), vi.fn(), allowClient());
    const result = await wrapped(
      buildEvent(JSON.stringify({ occupancyId: 'OCC-1', inspectionId: 'INS-1' })),
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 for a path-traversal photo filename', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const wrapped = createFieldCaptureHandler(fakeDoc(vi.fn()), vi.fn(), allowClient());
    const result = await wrapped(
      buildEvent(
        JSON.stringify({
          occupancyId: 'OCC-1',
          inspectionId: 'INS-1',
          idempotencyKey: 'idem-001',
          photoFilenames: ['../../OTHERDEPT/photo.jpg'],
        }),
      ),
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 for a path-traversal inspectionId (it feeds the signed asset URL path directly)', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const wrapped = createFieldCaptureHandler(fakeDoc(vi.fn()), vi.fn(), allowClient());
    const result = await wrapped(
      buildEvent(
        JSON.stringify({
          occupancyId: 'OCC-1',
          inspectionId: '../../OTHERDEPT/INS-1',
          idempotencyKey: 'idem-001',
        }),
      ),
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('presigns one S3 PUT per photo against the {deptId}/INSPECTION_RECORD/{inspectionId}/ prefix and attaches the S3 keys to the record (AC3)', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const { doc, send } = docWithExistingItem(() => Promise.resolve({}));
    const signer = vi.fn().mockResolvedValue('https://signed.example.com/upload');
    const wrapped = createFieldCaptureHandler(doc, signer, allowClient());

    const result = await wrapped(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as {
      photoUploadUrls: { filename: string; uploadUrl: string }[];
      inspection: { photoS3Keys?: string[] };
    };
    expect(body.photoUploadUrls).toEqual([
      { filename: 'photo.jpg', uploadUrl: 'https://signed.example.com/upload' },
    ]);
    expect(body.inspection.photoS3Keys).toEqual(['NICHOLS/INSPECTION_RECORD/INS-1/photo.jpg']);
    expect(signer).toHaveBeenCalledWith({
      bucketName: 'bucket',
      key: 'NICHOLS/INSPECTION_RECORD/INS-1/photo.jpg',
      method: 'PUT',
      expiresInSeconds: 600,
    });

    const transactCommand = send.mock.calls[1]?.[0] as { input: { TransactItems: unknown[] } };
    const transactItems = transactCommand.input.TransactItems as Array<Record<string, unknown>>;
    const domainUpdate = transactItems[2]?.Update as {
      ExpressionAttributeValues: Record<string, unknown>;
    };
    expect(domainUpdate.ExpressionAttributeValues[':photoS3Keys']).toEqual([
      'NICHOLS/INSPECTION_RECORD/INS-1/photo.jpg',
    ]);
  });

  it('returns idempotencyOutcome duplicate (200) with fresh photoUploadUrls for the settled item, not a second write, on a retried idempotencyKey (AC2, AC3 resumed upload)', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const duplicateItem = {
      ...EXISTING_ITEM,
      conductedDate: '2026-09-10T00:00:00.000Z',
      conductedBy: 'member-1',
      photoS3Keys: ['NICHOLS/INSPECTION_RECORD/INS-1/photo.jpg'],
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: duplicateItem })
      .mockRejectedValueOnce(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        }),
      );
    const signer = vi.fn().mockResolvedValue('https://signed.example.com/resume');
    const wrapped = createFieldCaptureHandler(fakeDoc(send), signer, allowClient());

    const result = await wrapped(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      idempotencyOutcome: string;
      photoUploadUrls: { filename: string; uploadUrl: string }[];
    };
    expect(body.idempotencyOutcome).toBe('duplicate');
    expect(body.photoUploadUrls).toEqual([
      { filename: 'photo.jpg', uploadUrl: 'https://signed.example.com/resume' },
    ]);
  });

  it('returns 404 when no inspection record exists to attach to (ticket depends-on E5-S5)', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const send = vi.fn().mockResolvedValueOnce({ Item: undefined });
    const wrapped = createFieldCaptureHandler(fakeDoc(send), vi.fn(), allowClient());
    const result = await wrapped(buildEvent(VALID_BODY));
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 404, not 503, when the occupancy record no longer exists (client conflict, not a retriable outage)', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const { doc } = docWithExistingItem(() =>
      Promise.reject(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        }),
      ),
    );
    const wrapped = createFieldCaptureHandler(doc, vi.fn(), allowClient());
    const result = await wrapped(buildEvent(VALID_BODY));
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 503 fail-closed and logs the original error when DynamoDB is unavailable (error-path-logging)', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { createFieldCaptureHandler } = await import('./handler.js');
    const { doc } = docWithExistingItem(() =>
      Promise.reject(new Error('ProvisionedThroughputExceededException')),
    );
    const wrapped = createFieldCaptureHandler(doc, vi.fn(), allowClient());

    const result = await wrapped(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 503 });
    const logged = writeSpy.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes('fieldCapture.dependencyUnavailable'));
    expect(logged).toBeDefined();
    expect(logged).toContain('"reason":"Error"');
    writeSpy.mockRestore();
  });

  it('returns 503 without writing to DynamoDB when the assets bucket is not configured', async () => {
    delete process.env.PLATFORM_ASSETS_BUCKET_NAME;
    const { createFieldCaptureHandler } = await import('./handler.js');
    const send = vi.fn();
    const wrapped = createFieldCaptureHandler(fakeDoc(send), vi.fn(), allowClient());

    const result = await wrapped(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(send).not.toHaveBeenCalled();
  });

  it('never reads deptId from the request body — the pk comes only from the verified authorizer principal (tenancy boundary, core-harm)', async () => {
    const { createFieldCaptureHandler } = await import('./handler.js');
    const { doc, send } = docWithExistingItem(() => Promise.resolve({}));
    const wrapped = createFieldCaptureHandler(doc, vi.fn(), allowClient());

    await wrapped(
      buildEvent(
        JSON.stringify({
          occupancyId: 'OCC-1',
          inspectionId: 'INS-1',
          idempotencyKey: 'idem-001',
          deptId: 'dept-injected',
        }),
      ),
    );

    const transactCommand = send.mock.calls[1]?.[0] as { input: { TransactItems: unknown[] } };
    const transactItems = transactCommand.input.TransactItems as Array<Record<string, unknown>>;
    const domainUpdate = transactItems[2]?.Update as { Key: Record<string, unknown> };
    expect(domainUpdate.Key).toEqual({
      pk: 'DEPT#NICHOLS#OCCUPANCY#OCC-1',
      sk: 'INSPECTION#INS-1',
    });
    expect(JSON.stringify(transactItems)).not.toContain('dept-injected');
  });
});
