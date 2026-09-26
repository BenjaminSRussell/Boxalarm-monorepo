import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { withAuthorization, type GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readInspectionsTableConfig } from './platformTable.js';
import { getPrePlan, PrePlanDependencyError } from './prePlanRepository.js';
import { createSignedAssetUrl, readAssetsConfig, type SignUrlFn } from './assetsSigner.js';
import { dependencyUnavailableProblem, notFoundProblem } from './prePlanProblems.js';
import { logError } from './logger.js';

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function occupancyIdFromPath(event: GuardEvent): string {
  return event.pathParameters?.id ?? '';
}

export function createGetPrePlanHandler(
  doc?: DynamoDBDocumentClient,
  authzClient?: VerifiedPermissionsClient,
  signer?: SignUrlFn,
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization<APIGatewayProxyResultV2>(
    async (event, principal) => {
      const traceId = extractTraceId(event);
      const occupancyId = occupancyIdFromPath(event);
      const deptId = toVerifiedDeptId(principal);
      const tableConfig = readInspectionsTableConfig(process.env);
      const client = createDynamoClient(process.env, doc);

      try {
        const prePlan = await getPrePlan(client, tableConfig.tableName, deptId, occupancyId);
        if (!prePlan) {
          return notFoundProblem(`No pre-plan is on file for occupancy ${occupancyId}.`, traceId);
        }
        const needsSignedUrls =
          prePlan.siteDiagramS3Key !== null || prePlan.attachmentS3Keys.length > 0;
        const assetsConfig = needsSignedUrls ? readAssetsConfig(process.env) : undefined;
        const siteDiagramUrl =
          assetsConfig && prePlan.siteDiagramS3Key
            ? await createSignedAssetUrl(assetsConfig, prePlan.siteDiagramS3Key, signer)
            : undefined;
        const attachmentUrls = assetsConfig
          ? await Promise.all(
              prePlan.attachmentS3Keys.map(async (key) => ({
                key,
                url: await createSignedAssetUrl(assetsConfig, key, signer),
              })),
            )
          : [];
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prePlanId: prePlan.prePlanId,
            siteDiagramS3Key: prePlan.siteDiagramS3Key,
            ...(siteDiagramUrl ? { siteDiagramUrl } : {}),
            attachmentS3Keys: prePlan.attachmentS3Keys,
            attachmentUrls,
            utilityShutoffs: prePlan.utilityShutoffs,
            hazards: prePlan.hazards,
          }),
        };
      } catch (error) {
        if (error instanceof PrePlanDependencyError) {
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
      actionId: 'GetPrePlan',
      resourceType: 'Boxalarm::Occupancy',
      resourceId: occupancyIdFromPath,
      ...(authzClient ? { client: authzClient } : {}),
    },
  );
}

export const handler = createGetPrePlanHandler();
