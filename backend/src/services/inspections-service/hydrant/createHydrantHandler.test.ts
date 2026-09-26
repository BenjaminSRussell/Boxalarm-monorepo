import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  Decision,
  IsAuthorizedWithTokenCommand,
  VerifiedPermissionsClient,
} from '@aws-sdk/client-verifiedpermissions';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import { createHydrantInner, handler } from './createHydrantHandler.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const vpMock = mockClient(VerifiedPermissionsClient);

const validPrincipal: CedarPrincipalContext = {
  sub: 'mbr-102',
  deptId: 'NICHOLS',
  'cognito:groups': 'OFFICER',
};

const validBody = JSON.stringify({
  hydrantId: 'HYD-0231',
  latitude: 41.2417,
  longitude: -73.2004,
  size: '6-inch',
  flowRatingGpm: 1000,
  nextFlowTestDue: '2027-01-10',
});

function buildEvent(overrides: {
  body?: string;
  authorizer?: Partial<CedarPrincipalContext>;
  authorization?: string;
}): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/inspections/hydrants',
    rawPath: '/api/v1/inspections/hydrants',
    rawQueryString: '',
    headers: overrides.authorization ? { authorization: overrides.authorization } : {},
    isBase64Encoded: false,
    body: overrides.body,
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.boxalarm.dev',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/api/v1/inspections/hydrants',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'req-1',
      routeKey: 'POST /api/v1/inspections/hydrants',
      stage: '$default',
      time: '03/Sep/2026:00:00:00 +0000',
      timeEpoch: Date.now(),
      authorizer: { lambda: overrides.authorizer },
    },
  } as unknown as GuardEvent;
}

beforeEach(() => {
  ddbMock.reset();
  vpMock.reset();
  process.env.PLATFORM_TABLE_NAME = 'boxalarm-platform-table';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-test';
});

// These test the hydrant-creation business logic directly (validation, persistence,
// error mapping) against the inner handler, independent of Cedar authorization mechanics
// — the same discipline packages/authz's own guard.test.ts uses for the wrapper itself.
describe('createHydrantInner (business logic, AC1)', () => {
  it('creates a hydrant and returns 201 with GSI2/GSI3 keys populated', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const result = (await createHydrantInner(buildEvent({ body: validBody }), validPrincipal)) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(201);
    const persisted = JSON.parse(result.body) as { gsi2pk: string; gsi3pk: string };
    expect(persisted.gsi2pk).toBe('DEPT#NICHOLS#DUE#HYDRANT#2027-01');
    expect(persisted.gsi3pk).toMatch(/^DEPT#NICHOLS#HYDRANT#GEO#/);
  });

  it('rejects an absent body with 400 RFC7807', async () => {
    const result = (await createHydrantInner(buildEvent({}), validPrincipal)) as {
      statusCode: number;
      headers: Record<string, string>;
    };
    expect(result.statusCode).toBe(400);
    expect(result.headers['content-type']).toBe('application/problem+json');
  });

  it('rejects a string-typed flowRatingGpm with 400 RFC7807', async () => {
    const body = JSON.stringify({ ...(JSON.parse(validBody) as object), flowRatingGpm: 'a lot' });
    const result = (await createHydrantInner(buildEvent({ body }), validPrincipal)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('rejects a shape-valid but calendar-invalid nextFlowTestDue with 400 (core-harm: month 13 silently breaks scheduling)', async () => {
    const body = JSON.stringify({
      ...(JSON.parse(validBody) as object),
      nextFlowTestDue: '2027-13-45',
    });
    const result = (await createHydrantInner(buildEvent({ body }), validPrincipal)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('rejects a hydrantId containing "#" with 400 rather than a 503 misclassified as a DynamoDB outage', async () => {
    const body = JSON.stringify({ ...(JSON.parse(validBody) as object), hydrantId: 'HYD#1' });
    const result = (await createHydrantInner(buildEvent({ body }), validPrincipal)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('fails closed with 503 when DynamoDB is unavailable (never a defaulted success)', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error('simulated outage'));
    const result = (await createHydrantInner(buildEvent({ body: validBody }), validPrincipal)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(503);
  });
});

// These test the exported, Cedar-wrapped `handler` end to end — the real fix for the
// review's persistent P1/P8 finding: a hand-rolled "any non-empty cognito:groups" gate
// let any authenticated member write hydrant records. Now that E8-S3's Cedar
// authorization is merged, the real IsAuthorizedWithTokenCommand call gates every write.
describe('handler (Cedar-authorized entrypoint)', () => {
  it('denies with 403 and never reaches the repository when Cedar denies the caller', async () => {
    vpMock.on(IsAuthorizedWithTokenCommand).resolves({ decision: Decision.DENY });
    const result = (await handler(
      buildEvent({
        body: validBody,
        authorizer: validPrincipal,
        authorization: 'Bearer member-token',
      }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(403);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('denies with 401 when the authorizer context is missing (fail-secure)', async () => {
    const result = (await handler(
      buildEvent({ body: validBody, authorization: 'Bearer member-token' }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('fails closed with 503, not a silent allow, when Verified Permissions is unavailable', async () => {
    vpMock.on(IsAuthorizedWithTokenCommand).rejects(new Error('VP outage'));
    const result = (await handler(
      buildEvent({
        body: validBody,
        authorizer: validPrincipal,
        authorization: 'Bearer officer-token',
      }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(503);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('creates a hydrant (201) when Cedar allows the caller', async () => {
    vpMock.on(IsAuthorizedWithTokenCommand).resolves({ decision: Decision.ALLOW });
    ddbMock.on(TransactWriteCommand).resolves({});
    const result = (await handler(
      buildEvent({
        body: validBody,
        authorizer: validPrincipal,
        authorization: 'Bearer officer-token',
      }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(201);
  });
});
