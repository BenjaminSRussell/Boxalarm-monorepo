import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  process.env.PLATFORM_ASSETS_BUCKET_NAME = 'boxalarm-dev-platform-assets';
  // Presigning is local SigV4: any credentials will do.
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'MBR-0012',
  deptId: 'NICHOLS',
  'cognito:groups': 'apparatus',
};

function buildEvent(
  body: string | undefined,
  unitId: string | undefined = 'E1',
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/apparatus/{unitId}/defects',
    rawPath: `/api/v1/apparatus/${unitId ?? ''}/defects`,
    rawQueryString: '',
    headers,
    pathParameters: unitId !== undefined ? { unitId } : undefined,
    body,
    requestContext: {
      authorizer: { lambda: principal ?? undefined },
    },
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

function apparatusItem() {
  return {
    pk: 'DEPT#NICHOLS#APPARATUS#APP-E1',
    sk: 'METADATA',
    unitId: 'E1',
    apparatusId: 'APP-E1',
    type: 'ENGINE',
    status: 'IN_SERVICE',
    gsi3pk: 'DEPT#NICHOLS#APPARATUS',
    gsi3sk: 'E1',
  };
}

function fakeDynamoClient(options: {
  readonly apparatusExists?: boolean;
  readonly onTransact?: (command: TransactWriteCommand) => Promise<unknown>;
  readonly existingIdempotency?: { defectId: string; photoS3Key?: string };
}): DynamoDBDocumentClient {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof QueryCommand && command.input.IndexName === 'GSI3') {
      return options.apparatusExists === false ? { Items: [] } : { Items: [apparatusItem()] };
    }
    if (command instanceof QueryCommand) {
      if (options.existingIdempotency) {
        return {
          Items: [
            {
              pk: 'DEPT#NICHOLS#APPARATUS#APP-E1',
              sk: 'IDEMPOTENCY#DEFECT#offline-1',
              defectId: options.existingIdempotency.defectId,
            },
          ],
        };
      }
      return { Items: [] };
    }
    if (command instanceof GetCommand) {
      if (options.existingIdempotency) {
        return {
          Item: {
            pk: 'DEPT#NICHOLS#APPARATUS#APP-E1',
            sk: `DEFECT#${options.existingIdempotency.defectId}`,
            entityType: 'DEFECT',
            defectId: options.existingIdempotency.defectId,
            apparatusId: 'APP-E1',
            unitId: 'E1',
            description: 'existing',
            severity: 'MINOR',
            status: 'OPEN',
            reportedBy: 'MBR-0012',
            reportedAt: 1798050000,
            photoS3Key: options.existingIdempotency.photoS3Key ?? null,
          },
        };
      }
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      return options.onTransact ? options.onTransact(command) : {};
    }
    return {};
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('reportDefect handler', () => {
  it('returns 403 when Cedar denies ReportDefect', async () => {
    const { createReportDefectHandler } = await import('./reportDefectHandler.js');
    const handler = createReportDefectHandler({
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient('DENY'),
    });
    const result = await handler(
      buildEvent(JSON.stringify({ description: 'x', severity: 'MINOR' })),
    );
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 400 when description or severity is missing', async () => {
    const { createReportDefectHandler } = await import('./reportDefectHandler.js');
    const handler = createReportDefectHandler({
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent(JSON.stringify({ severity: 'MINOR' })));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 404 when the apparatus unit does not exist', async () => {
    const { createReportDefectHandler } = await import('./reportDefectHandler.js');
    const handler = createReportDefectHandler({
      client: fakeDynamoClient({ apparatusExists: false }),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(
      buildEvent(JSON.stringify({ description: 'Leak', severity: 'MAJOR' })),
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it("returns 400 when photoS3Key is not scoped to the caller's department (cross-tenant reference)", async () => {
    const { createReportDefectHandler } = await import('./reportDefectHandler.js');
    const handler = createReportDefectHandler({
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(
      buildEvent(
        JSON.stringify({
          description: 'Leak',
          severity: 'MAJOR',
          photoS3Key: 'OTHERDEPT/defect/DEF-999/private.jpg',
        }),
      ),
    );
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as {
      errors?: readonly { field: string }[];
    };
    expect(body.errors).toContainEqual(expect.objectContaining({ field: 'photoS3Key' }));
  });

  it("rejects a photoS3Key using .. to escape the caller's department prefix", async () => {
    const { createReportDefectHandler } = await import('./reportDefectHandler.js');
    const handler = createReportDefectHandler({
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(
      buildEvent(
        JSON.stringify({
          description: 'Leak',
          severity: 'MAJOR',
          photoS3Key: 'NICHOLS/defect/../../OTHERDEPT/defect/DEF-999/private.jpg',
        }),
      ),
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('creates an OPEN defect, emits apparatus.defect.reported, and returns 201 (AC1)', async () => {
    const client = fakeDynamoClient({});
    const { createReportDefectHandler } = await import('./reportDefectHandler.js');
    const handler = createReportDefectHandler({
      client,
      authzClient: fakeAuthzClient('ALLOW'),
      now: () => 1798050000,
      newDefectId: () => 'DEF-0033',
    });

    const result = await handler(
      buildEvent(
        JSON.stringify({
          description: 'Low tire pressure, rear axle',
          severity: 'MAJOR',
          photoS3Key: 'NICHOLS/defect/DEF-0033/photo.jpg',
        }),
      ),
    );

    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({
      defectId: 'DEF-0033',
      status: 'OPEN',
      severity: 'MAJOR',
      photoS3Key: 'NICHOLS/defect/DEF-0033/photo.jpg',
      reportedBy: 'MBR-0012',
    });

    const transact = (client.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] instanceof TransactWriteCommand,
    )?.[0] as TransactWriteCommand;
    const outbox = transact.input.TransactItems?.[1]?.Put?.Item as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(outbox.eventType).toBe('apparatus.defect.reported');
    expect(outbox.payload).toMatchObject({
      defectId: 'DEF-0033',
      apparatusId: 'APP-E1',
      reportedByMemberId: 'MBR-0012',
      severity: 'MAJOR',
      photoS3Key: 'NICHOLS/defect/DEF-0033/photo.jpg',
      outOfService: false,
    });
  });

  it('signs a photo upload URL when photo.filename is provided (training attachment pattern)', async () => {
    const { createReportDefectHandler } = await import('./reportDefectHandler.js');
    const handler = createReportDefectHandler({
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient('ALLOW'),
      now: () => 1798050000,
      newDefectId: () => 'DEF-0033',
    });

    const result = await handler(
      buildEvent(
        JSON.stringify({
          description: 'Crack in windshield',
          severity: 'MINOR',
          photo: { filename: 'photo.jpg' },
        }),
      ),
    );

    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as {
      photoS3Key: string;
      uploadUrl: string;
    };
    expect(body.photoS3Key).toBe('NICHOLS/defect/DEF-0033/photo.jpg');
    expect(body.uploadUrl).toContain(body.photoS3Key);
  });

  it('triggers OUT_OF_SERVICE transition when severity is OUT_OF_SERVICE without re-entering apparatus details', async () => {
    const setServiceStatus = vi.fn().mockResolvedValue(undefined);
    const { createReportDefectHandler } = await import('./reportDefectHandler.js');
    const handler = createReportDefectHandler({
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient('ALLOW'),
      now: () => 1798050000,
      newDefectId: () => 'DEF-0099',
      setServiceStatus,
    });

    const result = await handler(
      buildEvent(
        JSON.stringify({
          description: 'Pump failure',
          severity: 'OUT_OF_SERVICE',
        }),
      ),
    );

    expect(result).toMatchObject({ statusCode: 201 });
    expect(setServiceStatus).toHaveBeenCalledWith(
      expect.anything(),
      'platform-table',
      expect.objectContaining({
        deptId: 'NICHOLS',
        unitId: 'E1',
        status: 'OUT_OF_SERVICE',
        reason: 'Pump failure',
      }),
    );
    const body = JSON.parse((result as { body: string }).body) as { outOfService: boolean };
    expect(body.outOfService).toBe(true);
  });

  it('returns the existing defect for a replayed clientMutationId without duplicating (AC4 server half)', async () => {
    const client = fakeDynamoClient({ existingIdempotency: { defectId: 'DEF-EXISTING' } });
    const { createReportDefectHandler } = await import('./reportDefectHandler.js');
    const handler = createReportDefectHandler({
      client,
      authzClient: fakeAuthzClient('ALLOW'),
    });

    const result = await handler(
      buildEvent(
        JSON.stringify({
          description: 'ignored on replay',
          severity: 'MINOR',
          clientMutationId: 'offline-1',
        }),
      ),
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { defectId: string };
    expect(body.defectId).toBe('DEF-EXISTING');
    const transactCalls = (client.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] instanceof TransactWriteCommand,
    );
    expect(transactCalls).toHaveLength(0);
  });

  // The offline outbox replays the POST when the first 10-minute link expired before the photo
  // went up; without a fresh link the photo was dropped ("reported without its photo").
  it('re-signs the stored photo key when a replay still carries a photo', async () => {
    const client = fakeDynamoClient({
      existingIdempotency: {
        defectId: 'DEF-EXISTING',
        photoS3Key: 'NICHOLS/defect/DEF-EXISTING/photo.jpg',
      },
    });
    const { createReportDefectHandler } = await import('./reportDefectHandler.js');
    const handler = createReportDefectHandler({ client, authzClient: fakeAuthzClient('ALLOW') });

    const result = await handler(
      buildEvent(
        JSON.stringify({
          description: 'ignored on replay',
          severity: 'MINOR',
          clientMutationId: 'offline-1',
          // A replay names its own file; the stored key is what gets signed.
          photo: { filename: 'other.jpg' },
        }),
      ),
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      photoS3Key: string;
      uploadUrl?: string;
    };
    expect(body.photoS3Key).toBe('NICHOLS/defect/DEF-EXISTING/photo.jpg');
    expect(body.uploadUrl).toContain('NICHOLS/defect/DEF-EXISTING/photo.jpg');
    expect(body.uploadUrl).toContain('X-Amz-Expires=600');
  });

  it('does not sign anything on a replay without a photo', async () => {
    const client = fakeDynamoClient({
      existingIdempotency: {
        defectId: 'DEF-EXISTING',
        photoS3Key: 'NICHOLS/defect/DEF-EXISTING/photo.jpg',
      },
    });
    const { createReportDefectHandler } = await import('./reportDefectHandler.js');
    const handler = createReportDefectHandler({ client, authzClient: fakeAuthzClient('ALLOW') });

    const result = await handler(
      buildEvent(
        JSON.stringify({ description: 'x', severity: 'MINOR', clientMutationId: 'offline-1' }),
      ),
    );

    expect(JSON.parse((result as { body: string }).body)).not.toHaveProperty('uploadUrl');
  });
});
