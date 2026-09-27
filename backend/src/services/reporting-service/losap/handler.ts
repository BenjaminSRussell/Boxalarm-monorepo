import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoDocClient, readReportingServiceConfig } from '../awsClients.js';
import { logError } from '../logger.js';
import { buildYearEndReport } from './repository.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';

function parseYear(raw: string | undefined): number | undefined {
  if (!raw || !/^\d{4}$/.test(raw)) {
    return undefined;
  }
  return Number.parseInt(raw, 10);
}

async function innerGetLosapYearEndHandler(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const year = parseYear(event.queryStringParameters?.year);
  if (year === undefined) {
    return badRequestProblem(
      traceId,
      'year query parameter is required and must be a 4-digit year',
    );
  }

  const deptId = toVerifiedDeptId(principal);
  const config = readReportingServiceConfig(process.env);
  const client = createDynamoDocClient();

  try {
    const report = await buildYearEndReport(client, config.tableName, deptId, year, traceId);
    if (report.totalUnreadableEntryCount > 0) {
      emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingLosapYearEndDataIntegrity');
    }
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingLosapYearEndSucceeded');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logError('reporting.losap.year_end.failed', error, { correlationId: traceId, deptId, year });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingLosapYearEndFailed', reason);
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(innerGetLosapYearEndHandler, {
  actionType: 'Boxalarm::Action',
  actionId: 'GetLosapYearEnd',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
