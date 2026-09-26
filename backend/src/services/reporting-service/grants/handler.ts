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
import { createDynamoClient, readGrantsReportConfig } from '../client.js';
import { logError } from '../logger.js';
import { assembleGrantsReport } from './assembleReport.js';
import {
  getActiveMemberCountAndTrend,
  getApparatusOosHistory,
  getTrainingHoursCompliance,
  type ReportPeriod,
} from './repository.js';

const METRIC_NAMESPACE = 'Boxalarm/Reporting';
const METRIC_NAME = 'GrantsReport';

function parsePeriod(event: GuardEvent): ReportPeriod | undefined {
  const periodStartRaw = event.queryStringParameters?.periodStart;
  const periodEndRaw = event.queryStringParameters?.periodEnd;
  if (!periodStartRaw || !periodEndRaw) {
    return undefined;
  }
  const periodStart = Number(periodStartRaw);
  const periodEnd = Number(periodEndRaw);
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || periodEnd <= periodStart) {
    return undefined;
  }
  return { periodStart, periodEnd };
}

async function getGrantsReport(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const period = parsePeriod(event);
  if (!period) {
    emitOutcomeMetric(METRIC_NAMESPACE, METRIC_NAME, 'ValidationError');
    return badRequestProblem(
      traceId,
      'periodStart and periodEnd query params are required, must be finite epoch-ms numbers, and periodEnd must be after periodStart.',
    );
  }

  const deptId = toVerifiedDeptId(principal);
  try {
    const client = createDynamoClient(process.env);
    const config = readGrantsReportConfig(process.env);
    const [memberCountAndTrend, trainingHoursCompliance, apparatusOosHistory] = await Promise.all([
      getActiveMemberCountAndTrend(client, config, deptId, period, traceId),
      getTrainingHoursCompliance(client, config, deptId, period, traceId),
      getApparatusOosHistory(client, config, deptId, period, traceId),
    ]);

    const report = assembleGrantsReport({
      period,
      memberCountAndTrend,
      trainingHoursCompliance,
      apparatusOosHistory,
      incidentVolume: { available: false, reason: 'E6-S1' },
    });

    emitOutcomeMetric(METRIC_NAMESPACE, METRIC_NAME, 'Served');
    // TODO(E7-S9): CSV/PDF export of this same payload
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    };
  } catch (error) {
    logError('reporting.grants.get_failed', error, { correlationId: traceId, deptId });
    emitOutcomeMetric(METRIC_NAMESPACE, METRIC_NAME, 'Failed');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(getGrantsReport, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewGrantsReport',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
