import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readApparatusServiceConfig } from './dynamoClient.js';
import {
  computeComplianceReport,
  queryChecklistRunsInRange,
  MAX_RANGE_SECONDS,
} from './complianceReport.js';
import { ApparatusRepositoryUnavailableError, listApparatus } from './repository.js';

function emitComplianceMetric(outcome: 'Success' | 'Unavailable' | 'Error'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/ApparatusService',
            Dimensions: [[]],
            Metrics: [{ Name: `ComplianceReport${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      [`ComplianceReport${outcome}`]: 1,
    }),
  );
}

function logComplianceError(operation: string, error: unknown, correlationId: string): void {
  console.error(
    JSON.stringify({
      event: 'apparatus.compliance.error',
      service: 'apparatus-service',
      operation,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      correlationId,
    }),
  );
}

function parseEpochParam(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface GetComplianceDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
}

async function getCompliance(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: GetComplianceDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const from = parseEpochParam(event.queryStringParameters?.from);
  const to = parseEpochParam(event.queryStringParameters?.to);
  if (from === undefined || to === undefined || to < from) {
    return badRequestProblem(
      traceId,
      'from and to query parameters are required, must be numeric epoch seconds, and to must be >= from.',
    );
  }
  if (to - from > MAX_RANGE_SECONDS) {
    return badRequestProblem(
      traceId,
      `from/to range must not exceed ${MAX_RANGE_SECONDS / 86400} days.`,
    );
  }

  const deptId = toVerifiedDeptId(principal);
  try {
    const [roster, runs] = await Promise.all([
      listApparatus(deps.client, deps.tableName, deptId),
      queryChecklistRunsInRange(deps.client, deps.tableName, deptId, from, to),
    ]);
    const report = computeComplianceReport(roster, runs, from, to);
    emitComplianceMetric('Success');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ report }),
    };
  } catch (error) {
    logComplianceError('getCompliance', error, traceId);
    if (error instanceof ApparatusRepositoryUnavailableError) {
      emitComplianceMetric('Unavailable');
      return serviceUnavailableProblem(traceId);
    }
    emitComplianceMetric('Error');
    throw error;
  }
}

interface GetComplianceOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: GetComplianceOverrides): GetComplianceDeps {
  return {
    client: overrides.client ?? createDynamoClient(process.env),
    tableName: overrides.tableName ?? readApparatusServiceConfig(process.env).tableName,
  };
}

export function createGetComplianceHandler(
  overrides: GetComplianceOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => getCompliance(event, principal, resolveDeps(overrides)),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'GetComplianceReport',
      resourceType: 'Boxalarm::Apparatus',
      resourceId: () => 'COMPLIANCE',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createGetComplianceHandler();
