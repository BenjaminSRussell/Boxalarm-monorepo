import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  notFoundProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readApparatusServiceConfig } from './dynamoClient.js';
import {
  resolveApparatusIdByUnitId,
  resolveChecklistTemplateForUnit,
} from './checklistResolution.js';

function emitChecklistMetric(outcome: 'Found' | 'NotFound' | 'Error'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/apparatus-service',
            Dimensions: [[]],
            Metrics: [{ Name: `GetChecklist${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      [`GetChecklist${outcome}`]: 1,
    }),
  );
}

function logChecklistError(operation: string, error: unknown, correlationId: string): void {
  console.error(
    JSON.stringify({
      event: 'apparatus.checklist.error',
      service: 'apparatus-service',
      operation,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      correlationId,
    }),
  );
}

async function getChecklist(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const unitId = event.pathParameters?.unitId;
  if (!unitId || unitId.trim().length === 0) {
    return badRequestProblem(traceId, 'unitId path parameter is required');
  }

  let operation = 'resolveConfig';
  try {
    const deptId = toVerifiedDeptId(principal);
    const config = readApparatusServiceConfig(process.env);
    const client = createDynamoClient(process.env);

    operation = 'resolveApparatus';
    const apparatusId = await resolveApparatusIdByUnitId(client, config.tableName, deptId, unitId);
    if (!apparatusId) {
      emitChecklistMetric('NotFound');
      return notFoundProblem(traceId, `No apparatus found for unitId "${unitId}"`);
    }

    operation = 'resolveTemplate';
    const template = await resolveChecklistTemplateForUnit(
      client,
      config.tableName,
      deptId,
      apparatusId,
    );
    if (!template) {
      emitChecklistMetric('NotFound');
      return notFoundProblem(
        traceId,
        `No checklist template applies to apparatus "${apparatusId}"`,
      );
    }

    emitChecklistMetric('Found');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(template),
    };
  } catch (error) {
    logChecklistError(operation, error, traceId);
    emitChecklistMetric('Error');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(getChecklist, {
  actionType: 'Boxalarm::Action',
  actionId: 'GetChecklist',
  resourceType: 'Boxalarm::Apparatus',
  resourceId: (event) => event.pathParameters?.unitId ?? '',
});
