import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { DescribeEventBusCommand, EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * GET /api/v1/{service}/health/liveness and /health/readiness (architecture.md §2, §4.3).
 * Both routes are unauthenticated, so responses carry only a status word: no service name,
 * version, dependency name, or error detail. Failure detail goes to the service log.
 */

/** The reserved, non-tenant partition every readiness probe reads. The item never exists. */
export const HEALTH_SENTINEL_PK = buildDeptScopedPk(
  toVerifiedDeptId({ deptId: 'HEALTHCHECK' }),
  'HEALTH',
);
export const HEALTH_SENTINEL_SK = 'PROBE';

const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export interface HealthEvent {
  readonly routeKey?: string;
  readonly rawPath?: string;
}

export interface HealthResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** One hard dependency. Resolves true when healthy; false or a rejection means not ready. */
export interface ReadinessCheck {
  readonly name: string;
  readonly run: (signal: AbortSignal) => Promise<boolean>;
}

export interface HealthHandlerOptions {
  readonly service: string;
  readonly readinessChecks: readonly ReadinessCheck[];
  readonly timeoutMs?: number;
}

function respond(statusCode: number, status: string): HealthResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ status }),
  };
}

function logFailure(service: string, check: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'health.readiness.failed',
      service,
      check,
      reason: error instanceof Error ? error.name : 'CheckReportedUnhealthy',
      message: error instanceof Error ? error.message : undefined,
    }),
  );
}

async function runCheck(
  service: string,
  check: ReadinessCheck,
  signal: AbortSignal,
): Promise<boolean> {
  // A check that ignores the signal still loses the race once the deadline passes.
  const deadline = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
  try {
    const healthy = await Promise.race([check.run(signal), deadline]);
    if (!healthy) {
      logFailure(service, check.name, undefined);
    }
    return healthy;
  } catch (error) {
    logFailure(service, check.name, error);
    return false;
  }
}

/**
 * One Lambda serves both routes: liveness touches nothing, readiness runs every check in
 * parallel under a shared deadline so a hung dependency answers 503 instead of holding the
 * invocation to the Lambda timeout.
 */
export function createHealthHandler(
  options: HealthHandlerOptions,
): (event: HealthEvent) => Promise<HealthResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  return async (event) => {
    const path = event.routeKey ?? event.rawPath ?? '';
    if (path.endsWith('/health/liveness')) {
      return respond(200, 'ok');
    }
    if (!path.endsWith('/health/readiness')) {
      return respond(404, 'not-found');
    }
    const signal = AbortSignal.timeout(timeoutMs);
    const results = await Promise.all(
      options.readinessChecks.map((check) => runCheck(options.service, check, signal)),
    );
    return results.every(Boolean) ? respond(200, 'ready') : respond(503, 'unavailable');
  };
}

function requireEnvValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required and was not set`);
  }
  return value;
}

/**
 * DynamoDB data-plane probe: an eventually consistent GetItem of the sentinel key on this
 * service's own table (HEALTH_TABLE_NAME). Unlike DescribeTable it proves the read path,
 * including the table's KMS key, and IAM can pin it to the sentinel partition.
 */
export function dynamoTableCheck(
  env: NodeJS.ProcessEnv,
  client: DynamoDBClient = new DynamoDBClient({}),
): ReadinessCheck {
  return {
    name: 'dynamodb',
    run: async (signal) => {
      await client.send(
        new GetItemCommand({
          TableName: requireEnvValue(env, 'HEALTH_TABLE_NAME'),
          Key: { pk: { S: HEALTH_SENTINEL_PK }, sk: { S: HEALTH_SENTINEL_SK } },
          ProjectionExpression: 'pk',
        }),
        { abortSignal: signal },
      );
      return true;
    },
  };
}

/** LOB EventBridge probe (architecture.md §4.3): the platform bus exists and is reachable. */
export function eventBusCheck(
  env: NodeJS.ProcessEnv,
  client: EventBridgeClient = new EventBridgeClient({}),
): ReadinessCheck {
  return {
    name: 'eventbridge',
    run: async (signal) => {
      await client.send(
        new DescribeEventBusCommand({ Name: requireEnvValue(env, 'HEALTH_EVENT_BUS_NAME') }),
        { abortSignal: signal },
      );
      return true;
    },
  };
}

/** The standard LOB-plane handler: DynamoDB plus the platform bus. */
export function createLobHealthHandler(
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): (event: HealthEvent) => Promise<HealthResponse> {
  return createHealthHandler({
    service,
    readinessChecks: [dynamoTableCheck(env), eventBusCheck(env)],
  });
}
