import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const originalEnv = { ...process.env };

const OFFICER: CedarPrincipalContext = {
  sub: 'MBR-0001',
  deptId: 'NICHOLS',
  'cognito:groups': 'officer',
};

function decidingClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function buildEvent(
  body: string | undefined,
  memberId = 'MBR-0034',
  traceparent?: string,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/training/members/{memberId}/certifications',
    rawPath: `/api/v1/training/members/${memberId}/certifications`,
    rawQueryString: '',
    headers: {
      authorization: 'Bearer token',
      ...(traceparent ? { traceparent } : {}),
    },
    pathParameters: { memberId },
    body,
    requestContext: { authorizer: { lambda: OFFICER } },
  } as unknown as GuardEvent;
}

beforeEach(() => {
  vi.resetModules();
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  process.env.TRAINING_DYNAMO_TABLE_NAME = 'platform-service';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const VALID_BODY = JSON.stringify({
  certType: 'FF1',
  issueDate: '2024-01-10',
  expiryDate: '2027-01-10',
  issuingAuthority: 'CT DESPP',
});

describe('create.ts handler (entrypoint)', () => {
  it('returns 403 on a Cedar deny before any repository write (auth-patterns fail-secure)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('DENY'));
    const { handler } = await import('./create.js');

    const result = await handler(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 when Verified Permissions is unavailable', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    const client = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    createAuthzClient(process.env, client);
    const { handler } = await import('./create.js');

    const result = await handler(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 400 with field-level errors for an empty/absent body', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { handler } = await import('./create.js');

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { errors: { field: string }[] };
    expect(body.errors.map((e) => e.field)).toEqual(
      expect.arrayContaining(['certType', 'issueDate', 'expiryDate', 'issuingAuthority']),
    );
  });

  it('returns 400 when expiryDate is before issueDate', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { handler } = await import('./create.js');

    const result = await handler(
      buildEvent(
        JSON.stringify({
          certType: 'FF1',
          issueDate: '2027-01-10',
          expiryDate: '2024-01-10',
          issuingAuthority: 'CT DESPP',
        }),
      ),
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('creates the record and returns 201 with a CURRENT status (AC1)', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockResolvedValue({});
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./create.js');

    const result = await handler(buildEvent(VALID_BODY));

    expect(result).toMatchObject({ statusCode: 201 });
    expect(send).toHaveBeenCalledTimes(1);
    const record = JSON.parse((result as { body: string }).body) as {
      status: string;
      memberId: string;
    };
    expect(record.status).toBe('CURRENT');
    expect(record.memberId).toBe('MBR-0034');
  });

  it('signs an attachment upload URL scoped to {deptId}/CERTIFICATION/{certId}/ and returns it alongside the record (AC2)', async () => {
    process.env.PLATFORM_ASSETS_BUCKET_NAME = 'boxalarm-dev-platform-assets';
    // Presigning is local SigV4: any credentials will do.
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = 'us-east-1';
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockResolvedValue({});
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const { handler } = await import('./create.js');

    const result = await handler(
      buildEvent(
        JSON.stringify({
          certType: 'FF1',
          issueDate: '2024-01-10',
          expiryDate: '2027-01-10',
          issuingAuthority: 'CT DESPP',
          attachment: { filename: 'card.pdf' },
        }),
      ),
    );

    expect(result).toMatchObject({ statusCode: 201 });
    const record = JSON.parse((result as { body: string }).body) as {
      attachmentS3Key: string;
      uploadUrl: string;
    };
    expect(record.attachmentS3Key).toMatch(/^NICHOLS\/CERTIFICATION\/CERT-[^/]+\/card\.pdf$/);
    expect(record.uploadUrl).toContain(record.attachmentS3Key);
  });

  it('logs the invalid-attachment error before returning 400 (error-path-logging)', async () => {
    process.env.PLATFORM_ASSETS_BUCKET_NAME = 'boxalarm-dev-platform-assets';
    // Presigning is local SigV4: any credentials will do.
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = 'us-east-1';
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./create.js');

    const result = await handler(
      buildEvent(
        JSON.stringify({
          certType: 'FF1',
          issueDate: '2024-01-10',
          expiryDate: '2027-01-10',
          issuingAuthority: 'CT DESPP',
          attachment: { filename: '../evil.pdf' },
        }),
      ),
    );

    expect(result).toMatchObject({ statusCode: 400 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.event).toBe('certification.create.invalidAttachment');
    expect(logged.correlationId).toBeDefined();
    errorSpy.mockRestore();
  });

  it('returns a 500 RFC 7807 problem with traceId when the repository write fails unexpectedly', async () => {
    const { createAuthzClient } = await import('@boxalarm/authz');
    createAuthzClient(process.env, decidingClient('ALLOW'));
    const { createDynamoClient } = await import('../dynamoClient.js');
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB throttled'));
    createDynamoClient({ send } as unknown as DynamoDBDocumentClient);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./create.js');

    const result = await handler(
      buildEvent(VALID_BODY, 'MBR-0034', '00-tracefail1000000000000000000-01234567890abcde-01'),
    );

    expect(result).toMatchObject({ statusCode: 500 });
    const body = JSON.parse((result as { body: string }).body) as {
      status: number;
      traceId: string;
    };
    expect(body.status).toBe(500);
    expect(body.traceId).toBe('tracefail1000000000000000000');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
