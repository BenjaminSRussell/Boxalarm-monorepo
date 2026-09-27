import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  extractTraceId,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { readDispatchAlertText } from '../channels/channelEnvelope.js';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import { MutualAidPromptIncompleteError, requestMutualAid } from '../escalation/mutualAidPort.js';
import { createSnsClient, readFanOutTopicConfig } from '../fanout/snsClient.js';
import {
  LADDER_CONTROL_FAILED_METRIC,
  LADDER_CONTROL_METRIC_NAMESPACE,
  dataUnavailableProblem,
  outcomeUnknownProblem,
  getDispatchMetadata,
  getMutualAidEvent,
  jsonResponse,
  parseDispatchId,
  toMutualAidView,
} from './shared.js';

/**
 * POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/trigger (F1.13, AP 5e).
 *
 * Calls the same `requestMutualAid` port the Tone Evaluator calls after an unmet tone 3,
 * with reason MANUAL — one MUTUAL_AID_EVENT singleton (conditional put, at most once per
 * dispatch whichever path gets there first), the officer prompts on the existing push
 * queue under their own MAPROMPT# guard, and the alerting.mutual_aid.triggered outbox row.
 * Allowed while the ladder is halted: a halt suppresses only the automatic trigger.
 *
 * A second trigger (double-submit, or the automatic path already fired) returns 200 with
 * `created: false` and the existing record — mutual aid is requested either way, and no
 * officer is prompted twice.
 */

const CONTROL = 'TriggerMutualAid';

export interface MutualAidTriggerDeps {
  readonly authzClient?: VerifiedPermissionsClient;
  readonly docClient?: DynamoDBDocumentClient;
  readonly snsClient?: SNSClient;
}

async function trigger(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: MutualAidTriggerDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const parsedId = parseDispatchId(event, traceId);
  if (!parsedId.ok) {
    return parsedId.problem;
  }
  const { dispatchId } = parsedId;
  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;

  try {
    const { tableName } = readAlertingConfig(process.env);
    const { topicArn } = readFanOutTopicConfig(process.env);
    const ddb = createDynamoClient(process.env, deps.docClient);
    const metadata = await getDispatchMetadata(ddb, tableName, deptId, dispatchId);
    if (!metadata) {
      return notFoundProblem(traceId, `No dispatch alert found for dispatchId "${dispatchId}"`);
    }

    const result = await requestMutualAid({
      ddb,
      sns: createSnsClient(process.env, deps.snsClient),
      tableName,
      topicArn,
      deptId,
      dispatchId,
      dispatch: readDispatchAlertText(metadata),
      reason: 'MANUAL',
      triggeredBy: memberId,
    });

    const existing = await getMutualAidEvent(ddb, tableName, deptId, dispatchId);
    const mutualAid = existing ? toMutualAidView(existing) : null;
    logInfo('alerting.ladderControl.mutualAidTrigger', {
      traceId,
      dispatchId,
      created: result.requested,
      officersNotified: result.officersNotified,
      triggeredBy: memberId,
    });
    if (result.requested) {
      emitOutcomeMetric(LADDER_CONTROL_METRIC_NAMESPACE, 'MutualAidTriggeredManual');
    }
    return jsonResponse(200, {
      dispatchId,
      created: result.requested,
      // Prompts this request sent. On a repeat (created=false) these are re-sends to officers
      // an earlier attempt missed - the port skips anyone already prompted. 0 with
      // created=true means no officer had a registered push target and the call must be made
      // without a prompt.
      officersNotified: result.officersNotified,
      adapterUsed: result.adapterUsed,
      mutualAid,
    });
  } catch (error) {
    logError('alerting.ladderControl.mutualAidTrigger.failed', error, { traceId, dispatchId });
    emitOutcomeMetric(LADDER_CONTROL_METRIC_NAMESPACE, LADDER_CONTROL_FAILED_METRIC, CONTROL);
    if (error instanceof MutualAidPromptIncompleteError) {
      return outcomeUnknownProblem(
        traceId,
        `Mutual aid is recorded, but ${error.failed} of ${error.officers} officers could not be prompted. Trigger again to prompt only the officers who were missed, and make the mutual-aid call directly if it is urgent.`,
      );
    }
    return dataUnavailableProblem(traceId);
  }
}

export function createHandler(
  deps: MutualAidTriggerDeps = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization((event, principal) => trigger(event, principal, deps), {
    actionType: 'Boxalarm::Action',
    actionId: 'TriggerMutualAid',
    resourceType: 'Boxalarm::Dispatch',
    resourceId: (event) => event.pathParameters?.dispatchId ?? '',
    ...(deps.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
