import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { withAuthorization, type GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readInspectionsTableConfig } from './platformTable.js';
import {
  createSignedUploadUrl,
  isSafeAssetFilename,
  readAssetsConfig,
  type SignUrlFn,
} from './assetsSigner.js';
import {
  OccupancyNotFoundError,
  PrePlanConflictError,
  PrePlanDependencyError,
  putPrePlan,
  type PrePlanInput,
  type UtilityShutoff,
} from './prePlanRepository.js';
import {
  conflictProblem,
  dependencyUnavailableProblem,
  invalidRequestProblem,
  notFoundProblem,
} from './prePlanProblems.js';
import { logError } from './logger.js';

const MAX_LIST_LENGTH = 50;

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function occupancyIdFromPath(event: GuardEvent): string {
  return event.pathParameters?.id ?? '';
}

function emitPrePlanMetric(outcome: 'Created' | 'Failed', reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/inspections',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: `PrePlan${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [`PrePlan${outcome}`]: 1,
    }),
  );
}

interface RawPrePlanBody {
  readonly siteDiagramFilename?: unknown;
  readonly attachmentFilenames?: unknown;
  readonly utilityShutoffs?: unknown;
  readonly hazards?: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST_LENGTH &&
    value.every((entry) => typeof entry === 'string')
  );
}

function isSafeFilenameArray(value: unknown): value is string[] {
  return isStringArray(value) && value.every((entry) => isSafeAssetFilename(entry));
}

function isUtilityShutoffArray(value: unknown): value is UtilityShutoff[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST_LENGTH &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).utility === 'string' &&
        typeof (entry as Record<string, unknown>).location === 'string',
    )
  );
}

export function parsePrePlanInput(body: string | undefined | null): PrePlanInput | undefined {
  if (!body) {
    return { attachmentFilenames: [], utilityShutoffs: [], hazards: [] };
  }
  let parsed: RawPrePlanBody;
  try {
    parsed = JSON.parse(body) as RawPrePlanBody;
  } catch {
    return undefined;
  }
  if (
    parsed.siteDiagramFilename !== undefined &&
    (typeof parsed.siteDiagramFilename !== 'string' ||
      !isSafeAssetFilename(parsed.siteDiagramFilename))
  ) {
    return undefined;
  }
  const attachmentFilenames = parsed.attachmentFilenames ?? [];
  if (!isSafeFilenameArray(attachmentFilenames)) {
    return undefined;
  }
  const utilityShutoffs = parsed.utilityShutoffs ?? [];
  if (!isUtilityShutoffArray(utilityShutoffs)) {
    return undefined;
  }
  const hazards = parsed.hazards ?? [];
  if (!isStringArray(hazards)) {
    return undefined;
  }
  return {
    ...(typeof parsed.siteDiagramFilename === 'string'
      ? { siteDiagramFilename: parsed.siteDiagramFilename }
      : {}),
    attachmentFilenames,
    utilityShutoffs,
    hazards,
  };
}

export function createPutPrePlanHandler(
  doc?: DynamoDBDocumentClient,
  signer?: SignUrlFn,
  authzClient?: VerifiedPermissionsClient,
  secretsClient?: SecretsManagerClient,
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization<APIGatewayProxyResultV2>(
    async (event, principal) => {
      const traceId = extractTraceId(event);
      const occupancyId = occupancyIdFromPath(event);
      const input = parsePrePlanInput(event.body);
      if (!input) {
        emitPrePlanMetric('Failed', 'invalid-request');
        return invalidRequestProblem('The pre-plan request body is invalid.', traceId);
      }

      const deptId = toVerifiedDeptId(principal);
      const tableConfig = readInspectionsTableConfig(process.env);
      const client = createDynamoClient(process.env, doc);

      try {
        const assetsConfig = await readAssetsConfig(process.env, secretsClient);
        const prePlan = await putPrePlan(client, tableConfig.tableName, deptId, occupancyId, input);
        const siteDiagramUploadUrl = input.siteDiagramFilename
          ? createSignedUploadUrl(
              assetsConfig,
              deptId,
              'PRE_PLAN',
              prePlan.prePlanId,
              input.siteDiagramFilename,
              signer,
            )
          : undefined;
        const attachmentUploadUrls = input.attachmentFilenames.map((filename) => ({
          filename,
          uploadUrl: createSignedUploadUrl(
            assetsConfig,
            deptId,
            'PRE_PLAN',
            prePlan.prePlanId,
            filename,
            signer,
          ),
        }));
        emitPrePlanMetric('Created');
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prePlanId: prePlan.prePlanId,
            ...(siteDiagramUploadUrl ? { siteDiagramUploadUrl } : {}),
            attachmentUploadUrls,
            utilityShutoffs: prePlan.utilityShutoffs,
            hazards: prePlan.hazards,
          }),
        };
      } catch (error) {
        if (error instanceof OccupancyNotFoundError) {
          emitPrePlanMetric('Failed', error.name);
          logError({
            event: 'preplan.not_found',
            service: 'inspections-service',
            reason: error.name,
            deptId,
            occupancyId,
            traceId,
          });
          return notFoundProblem(error.message, traceId);
        }
        if (error instanceof PrePlanConflictError) {
          emitPrePlanMetric('Failed', error.name);
          logError({
            event: 'preplan.conflict',
            service: 'inspections-service',
            reason: error.name,
            deptId,
            occupancyId,
            traceId,
          });
          return conflictProblem(error.message, traceId);
        }
        if (error instanceof PrePlanDependencyError) {
          emitPrePlanMetric('Failed', error.reason);
          logError({
            event: 'preplan.dependency_unavailable',
            service: 'inspections-service',
            reason: error.reason,
            deptId,
            occupancyId,
            traceId,
          });
          return dependencyUnavailableProblem(traceId);
        }
        emitPrePlanMetric(
          'Failed',
          error instanceof Error ? error.constructor.name : 'UnknownError',
        );
        logError({
          event: 'preplan.unhandled_error',
          service: 'inspections-service',
          reason: error instanceof Error ? error.constructor.name : 'UnknownError',
          deptId,
          occupancyId,
          traceId,
        });
        throw error;
      }
    },
    {
      actionType: 'Boxalarm::Action',
      actionId: 'UpdatePrePlan',
      resourceType: 'Boxalarm::Occupancy',
      resourceId: occupancyIdFromPath,
      ...(authzClient ? { client: authzClient } : {}),
    },
  );
}

export const handler = createPutPrePlanHandler();
