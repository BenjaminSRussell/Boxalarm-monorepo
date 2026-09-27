import { randomUUID } from 'node:crypto';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoDocClient, readReportingServiceConfig } from '../awsClients.js';
import { logError } from '../logger.js';
import {
  createExportLambdaClient,
  createExportS3Client,
  readExportsBucket,
  readExportWorkerFunctionName,
} from './clients.js';
import { getExportJob, markExportJob, putExportJob } from './repository.js';
import { isExportFormat, isReportName, type ExportJob } from './render.js';
import type { ReportingExportWorkerEvent } from './worker.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';
const SIGNED_URL_SECONDS = 900;

function paramsFromQuery(
  qs: Record<string, string | undefined> | null | undefined,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(qs ?? {})) {
    if (key === 'report' || key === 'format' || key === 'jobId' || value === undefined) {
      continue;
    }
    params[key] = value;
  }
  return params;
}

async function readJob(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  jobId: string,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  try {
    const { tableName } = readReportingServiceConfig(process.env);
    const job = await getExportJob(createDynamoDocClient(), tableName, deptId, jobId);
    if (!job) {
      return notFoundProblem(traceId, `export job ${jobId} was not found`);
    }
    if (job.status === 'COMPLETED' && job.objectKey) {
      const downloadUrl = await getSignedUrl(
        createExportS3Client(),
        new GetObjectCommand({ Bucket: readExportsBucket(process.env), Key: job.objectKey }),
        { expiresIn: SIGNED_URL_SECONDS },
      );
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...job, downloadUrl }),
      };
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(job),
    };
  } catch (error) {
    logError('reporting.export.status_failed', error, { correlationId: traceId, deptId, jobId });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingExportFailed');
    return serviceUnavailableProblem(traceId);
  }
}

async function acceptJob(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const report = event.queryStringParameters?.report;
  const format = event.queryStringParameters?.format;
  if (!report || !isReportName(report) || !format || !isExportFormat(format)) {
    return badRequestProblem(
      traceId,
      'report and format are required. report is dashboard, losap, iso, grants, response-times, or membership-trends. format is csv or pdf.',
    );
  }
  const deptId = toVerifiedDeptId(principal);
  const job: ExportJob = {
    jobId: randomUUID(),
    report,
    format,
    params: paramsFromQuery(event.queryStringParameters),
    status: 'PENDING',
    requestedBy: principal.sub,
    requestedAt: new Date().toISOString(),
  };
  const workerEvent: ReportingExportWorkerEvent = {
    jobId: job.jobId,
    deptId,
    report,
    format,
    params: job.params,
  };
  try {
    const { tableName } = readReportingServiceConfig(process.env);
    const client = createDynamoDocClient();
    await putExportJob(client, tableName, deptId, job);
    try {
      await createExportLambdaClient().send(
        new InvokeCommand({
          FunctionName: readExportWorkerFunctionName(process.env),
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify(workerEvent)),
        }),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'worker invoke failed';
      await markExportJob(client, tableName, deptId, job.jobId, 'FAILED', { detail });
      emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingExportFailed');
      return {
        statusCode: 202,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: job.jobId, status: 'FAILED', detail }),
      };
    }
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingExportAccepted');
    return {
      statusCode: 202,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.jobId, status: 'PENDING' }),
    };
  } catch (error) {
    logError('reporting.export.accept_failed', error, { correlationId: traceId, deptId, report });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingExportFailed');
    return serviceUnavailableProblem(traceId);
  }
}

/**
 * Deployed as POST /api/v1/reporting/export (accept-and-queue) and
 * GET /api/v1/reporting/export/{jobId} (status + signed link). The status read takes the
 * path parameter first; `?jobId=` is still honoured for the query-string form. A GET that
 * carries no jobId is rejected rather than treated as an accept, so a status poll can never
 * start a new export job.
 */
async function innerExport(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const jobId = event.pathParameters?.jobId ?? event.queryStringParameters?.jobId;
  if (jobId) {
    return readJob(event, principal, jobId);
  }
  if (event.requestContext.http?.method === 'GET') {
    return badRequestProblem(extractTraceId(event), 'jobId is required to read an export job');
  }
  return acceptJob(event, principal);
}

export const handler = withAuthorization(innerExport, {
  actionType: 'Boxalarm::Action',
  actionId: 'ExportReport',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
