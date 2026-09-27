import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  badRequestProblem,
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readAlertingConfig } from '../../eligibility/dynamoClient.js';
import { logError } from '../logger.js';
import { dataUnavailableProblem } from '../detail/problemDetails.js';
import { ACTIVE_WINDOW_SECONDS, queryActiveDispatches } from './repository.js';

const METRICS_NAMESPACE = 'Boxalarm/Alerting';

async function handleListActiveDispatches(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  docClient: DynamoDBDocumentClient | undefined,
  now: () => number,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  if (event.queryStringParameters?.status !== 'active') {
    return badRequestProblem(traceId, 'status=active is the only supported dispatch list filter');
  }

  try {
    const deptId = toVerifiedDeptId(principal);
    const { tableName } = readAlertingConfig(process.env);
    const doc = createDynamoClient(process.env, docClient);
    const asOf = Math.floor(now() / 1000);
    const page = await queryActiveDispatches(doc, tableName, deptId, asOf);

    emitOutcomeMetric(METRICS_NAMESPACE, 'ActiveDispatchesListed');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dispatches: page.items.map((item) => ({
          dispatchId: item.dispatchId,
          incidentType: item.incidentType ?? null,
          address: item.address ?? null,
          crossStreets: item.crossStreets ?? null,
          dispatchedAt: item.dispatchedAt,
          toneLadder: {
            status: item.toneLadderStatus ?? 'ACTIVE',
            currentToneSequence: item.currentToneSequence ?? 1,
          },
        })),
        activeWindowSeconds: ACTIVE_WINDOW_SECONDS,
        asOf,
        truncated: page.truncated,
      }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logError('dispatches.list_active.read_failed', error, { traceId, deptId: principal.deptId });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ActiveDispatchesListFailed', reason);
    return dataUnavailableProblem(traceId);
  }
}

export interface ListActiveDispatchesHandlerDeps {
  readonly authzClient?: VerifiedPermissionsClient;
  readonly docClient?: DynamoDBDocumentClient;
  readonly now?: () => number;
}

/** GET /api/v1/alerting/dispatches?status=active — every role, own department only. */
export function createHandler(
  deps: ListActiveDispatchesHandlerDeps = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) =>
      handleListActiveDispatches(event, principal, deps.docClient, deps.now ?? Date.now),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ListActiveDispatches',
      resourceType: 'Boxalarm::Department',
      resourceId: (event) =>
        toVerifiedDeptId({ deptId: event.requestContext.authorizer.lambda?.deptId ?? '' }),
      ...(deps.authzClient ? { client: deps.authzClient } : {}),
    },
  );
}

export const handler = createHandler();
