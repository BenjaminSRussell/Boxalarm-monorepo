import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  notFoundProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
  type ProblemResponse,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readApparatusConfig } from './client.js';
import {
  ApparatusNotFoundError,
  ApparatusRepositoryUnavailableError,
  ServiceStatusConflictError,
  isApparatusStatus,
  logError,
  setServiceStatus,
} from './repository.js';

interface ServiceStatusRequestBody {
  readonly status?: unknown;
  readonly reason?: unknown;
}

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function parseBody(
  rawBody: string | undefined,
  traceId: string,
): ServiceStatusRequestBody | undefined {
  if (!rawBody) {
    return undefined;
  }
  try {
    return JSON.parse(rawBody) as ServiceStatusRequestBody;
  } catch (error) {
    logError('apparatus.serviceStatus.parseBody.failed', error, {
      traceId,
      bodyLength: rawBody.length,
    });
    return undefined;
  }
}

function conflictProblem(traceId: string, detail: string): ProblemResponse {
  return {
    statusCode: 409,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/conflict',
      title: 'Conflict',
      status: 409,
      detail,
      traceId,
    }),
  };
}
async function updateServiceStatus(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const unitId = event.pathParameters?.unitId;
  const body = parseBody(event.body, traceId);

  if (!unitId || !body || !isApparatusStatus(body.status)) {
    return badRequestProblem(traceId, 'The request body must include a valid status.');
  }
  const reason =
    typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : undefined;
  if (body.status === 'OUT_OF_SERVICE' && !reason) {
    return badRequestProblem(traceId, 'reason is required when status is OUT_OF_SERVICE.');
  }

  const deptId = toVerifiedDeptId(principal);
  try {
    const client = createDynamoClient(process.env);
    const config = readApparatusConfig(process.env);
    await setServiceStatus(client, config.tableName, {
      deptId,
      unitId,
      status: body.status,
      ...(reason ? { reason } : {}),
    });
    return { statusCode: 204 };
  } catch (error) {
    if (error instanceof ApparatusNotFoundError) {
      return notFoundProblem(traceId, error.message);
    }
    if (error instanceof ServiceStatusConflictError) {
      return conflictProblem(traceId, error.message);
    }
    if (error instanceof ApparatusRepositoryUnavailableError) {
      return serviceUnavailableProblem(traceId);
    }
    throw error;
  }
}

export const handler = withAuthorization(updateServiceStatus, {
  actionType: 'Boxalarm::Action',
  actionId: 'UpdateServiceStatus',
  resourceType: 'Boxalarm::Apparatus',
  resourceId: (event) => event.pathParameters?.unitId ?? '',
});
