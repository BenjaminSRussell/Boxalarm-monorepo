import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  badRequestProblem,
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import {
  LADDER_CONTROL_FAILED_METRIC,
  LADDER_CONTROL_METRIC_NAMESPACE,
  conflictProblem,
  dataUnavailableProblem,
  getMutualAidEvent,
  isConditionalCheckFailed,
  jsonResponse,
  parseDispatchId,
  parseJsonObjectBody,
  toMutualAidView,
} from './shared.js';

/**
 * POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/acknowledge (F1.13, AP 5e).
 *
 * The officer confirms the mutual-aid phone call was made. One conditional UpdateItem on the
 * MUTUAL_AID_EVENT singleton sets acknowledgedBy/acknowledgedAt/notes only if mutual aid was
 * requested and not yet acknowledged, so the first acknowledgement is the record and is
 * never overwritten. A repeat by the same officer (double-submit) returns the stored record;
 * a different officer gets a 409 naming who already acknowledged it.
 *
 * `notes` is officer free text retained with the alert audit (architecture §3.1: no occupant
 * or caller PII by guidance; it is not scrubbed, since free text cannot be reliably).
 */

const CONTROL = 'AcknowledgeMutualAid';
export const MAX_NOTES_LENGTH = 1000;

export interface MutualAidAcknowledgeDeps {
  readonly authzClient?: VerifiedPermissionsClient;
  readonly docClient?: DynamoDBDocumentClient;
}

async function acknowledge(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: MutualAidAcknowledgeDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const parsedId = parseDispatchId(event, traceId);
  if (!parsedId.ok) {
    return parsedId.problem;
  }
  const { dispatchId } = parsedId;
  const parsedBody = parseJsonObjectBody(event, traceId);
  if (!parsedBody.ok) {
    return parsedBody.problem;
  }
  const rawNotes = parsedBody.body.notes;
  if (rawNotes !== undefined && rawNotes !== null && typeof rawNotes !== 'string') {
    return badRequestProblem(traceId, [{ field: 'notes', detail: 'must be a string' }]);
  }
  const notes = typeof rawNotes === 'string' ? rawNotes.trim() : '';
  if (notes.length > MAX_NOTES_LENGTH) {
    return badRequestProblem(traceId, [
      { field: 'notes', detail: `must be at most ${MAX_NOTES_LENGTH} characters` },
    ]);
  }

  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;
  try {
    const { tableName } = readAlertingConfig(process.env);
    const ddb = createDynamoClient(process.env, deps.docClient);
    const acknowledgedAt = Math.floor(Date.now() / 1000);
    try {
      const result = await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: 'MUTUALAID#SINGLETON' },
          UpdateExpression: 'SET acknowledgedBy = :member, acknowledgedAt = :now, notes = :notes',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(acknowledgedAt)',
          ExpressionAttributeValues: {
            ':member': memberId,
            ':now': acknowledgedAt,
            ':notes': notes.length > 0 ? notes : null,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      logInfo('alerting.ladderControl.mutualAidAcknowledge', {
        traceId,
        dispatchId,
        acknowledgedBy: memberId,
      });
      emitOutcomeMetric(LADDER_CONTROL_METRIC_NAMESPACE, 'MutualAidAcknowledged');
      return jsonResponse(200, {
        dispatchId,
        changed: true,
        mutualAid: toMutualAidView(result.Attributes ?? {}),
      });
    } catch (error) {
      if (!isConditionalCheckFailed(error)) {
        throw error;
      }
    }

    const existing = await getMutualAidEvent(ddb, tableName, deptId, dispatchId);
    if (!existing) {
      return conflictProblem(
        traceId,
        'Mutual aid has not been requested for this dispatch, so there is nothing to acknowledge.',
      );
    }
    const mutualAid = toMutualAidView(existing);
    if (mutualAid.acknowledgedBy === memberId) {
      return jsonResponse(200, { dispatchId, changed: false, mutualAid });
    }
    return conflictProblem(
      traceId,
      'Mutual aid was already acknowledged by another officer. Your notes were not saved.',
      { mutualAid },
    );
  } catch (error) {
    logError('alerting.ladderControl.mutualAidAcknowledge.failed', error, { traceId, dispatchId });
    emitOutcomeMetric(LADDER_CONTROL_METRIC_NAMESPACE, LADDER_CONTROL_FAILED_METRIC, CONTROL);
    return dataUnavailableProblem(traceId);
  }
}

export function createHandler(
  deps: MutualAidAcknowledgeDeps = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization((event, principal) => acknowledge(event, principal, deps), {
    actionType: 'Boxalarm::Action',
    actionId: 'AcknowledgeMutualAid',
    resourceType: 'Boxalarm::Dispatch',
    resourceId: (event) => event.pathParameters?.dispatchId ?? '',
    ...(deps.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
