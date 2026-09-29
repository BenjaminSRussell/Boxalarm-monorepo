import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { badRequestProblem } from '@boxalarm/authz';
import { assertNoDelimiter, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { invalidatePushToken, PERMANENT_INVALID_TOKEN_CODES } from './invalidatePushToken.js';

function unauthorizedProblem(traceId: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 401,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Push provider webhook secret is missing or invalid.',
      traceId,
    }),
  };
}

export interface PushReceiptConfig {
  readonly webhookSecret: string;
}

export function readPushReceiptConfig(env: NodeJS.ProcessEnv): PushReceiptConfig {
  const webhookSecret = env.PUSH_PROVIDER_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('PUSH_PROVIDER_WEBHOOK_SECRET is required and was not set');
  }
  return { webhookSecret };
}

interface PushReceiptBody {
  readonly deptId: string;
  readonly memberId: string;
  readonly token: string;
  readonly errorCode: string;
}

export function parseReceiptBody(raw: string | undefined | null): PushReceiptBody {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('body must be valid JSON');
  }
  const body = (parsed ?? {}) as Partial<Record<string, unknown>>;
  if (typeof body.deptId !== 'string' || body.deptId.length === 0) {
    throw new Error('deptId is required');
  }
  if (typeof body.memberId !== 'string' || body.memberId.length === 0) {
    throw new Error('memberId is required');
  }
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error('token is required');
  }
  if (typeof body.errorCode !== 'string' || body.errorCode.length === 0) {
    throw new Error('errorCode is required');
  }
  return {
    deptId: body.deptId,
    memberId: body.memberId,
    token: body.token,
    errorCode: body.errorCode,
  };
}

function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function extractTraceId(event: APIGatewayProxyEventV2): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function emitInvalidTokenMetric(outcome: 'Invalidated' | 'Failed' | 'Skipped'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/push-token',
            Dimensions: [[]],
            Metrics: [{ Name: `PushToken${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      [`PushToken${outcome}`]: 1,
    }),
  );
}

function noopResponse(memberId: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId, invalidated: false }),
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const traceId = extractTraceId(event);
  const secret =
    event.headers?.['x-push-provider-secret'] ?? event.headers?.['X-Push-Provider-Secret'];
  const config = readPushReceiptConfig(process.env);
  if (!secret || !secretsMatch(secret, config.webhookSecret)) {
    return unauthorizedProblem(traceId);
  }

  let body: PushReceiptBody;
  try {
    body = parseReceiptBody(event.body);
  } catch (error) {
    return badRequestProblem(traceId, error instanceof Error ? error.message : 'invalid body');
  }

  if (!PERMANENT_INVALID_TOKEN_CODES.has(body.errorCode)) {
    console.log(
      JSON.stringify({
        event: 'alerting.pushToken.invalidate.transient_error_code',
        service: 'alerting-service',
        correlationId: traceId,
        memberId: body.memberId,
        errorCode: body.errorCode,
      }),
    );
    emitInvalidTokenMetric('Skipped');
    return noopResponse(body.memberId);
  }

  const deptId = toVerifiedDeptId({ deptId: body.deptId });
  assertNoDelimiter(body.memberId, 'memberId');
  const client = createDynamoClient(process.env);
  const tableName = readAlertingConfig(process.env).tableName;

  let result: Awaited<ReturnType<typeof invalidatePushToken>>;
  try {
    result = await invalidatePushToken(client, tableName, deptId, body.memberId, body.token);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'alerting.pushToken.invalidate.failed',
        service: 'alerting-service',
        correlationId: traceId,
        memberId: body.memberId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    emitInvalidTokenMetric('Failed');
    throw error;
  }

  if (result === 'no_match') {
    console.log(
      JSON.stringify({
        event: 'alerting.pushToken.invalidate.no_match',
        service: 'alerting-service',
        correlationId: traceId,
        memberId: body.memberId,
      }),
    );
    return noopResponse(body.memberId);
  }

  console.log(
    JSON.stringify({
      event: 'alerting.pushToken.invalidated',
      service: 'alerting-service',
      correlationId: traceId,
      memberId: body.memberId,
    }),
  );
  emitInvalidTokenMetric('Invalidated');

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId: body.memberId, invalidated: true }),
  };
};
