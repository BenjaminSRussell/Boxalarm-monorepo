import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  extractTraceId,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import {
  FINAL_TONE_SEQUENCE,
  LADDER_CONTROL_FAILED_METRIC,
  LADDER_CONTROL_METRIC_NAMESPACE,
  TONE_LADDER_ACTIVE,
  TONE_LADDER_COMPLETED,
  TONE_LADDER_HALTED,
  conflictProblem,
  dataUnavailableProblem,
  getDispatchMetadata,
  jsonResponse,
  parseDispatchId,
  readLadderState,
  type LadderState,
} from './shared.js';

/**
 * POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/halt (F1.14, AP 5d).
 *
 * Sets `toneLadderStatus = HALTED_MANUAL`. Nothing is cancelled: every later scheduled Tone
 * Evaluator fire reads METADATA (strongly consistent) and self-skips as
 * SKIPPED_MANUALLY_HALTED, and the automatic mutual-aid trigger carries a ConditionCheck on
 * the same attribute, so it cannot record a trigger once this write has committed.
 *
 * Race handling: the write is conditional on the ladder still being ACTIVE at the tone this
 * request read, in one transaction with the TONE_EVENT audit row (outcome
 * SKIPPED_MANUALLY_HALTED, triggeredBy). If a scheduled tone lands in between, the audit
 * row's tone number would be stale, so the request re-reads and retries; if the ladder
 * completed or was already halted it answers from the committed state. A tone evaluation
 * that had already passed its halt check before this commit may still finish sending that
 * one tone — the halt cannot recall pages already in flight, and the response says which
 * tone the ladder was at.
 */

const CONTROL = 'HaltToneLadder';
const MAX_ATTEMPTS = 3;

type HaltAttempt =
  { readonly kind: 'halted'; readonly ladder: LadderState } | { readonly kind: 'retry' };

async function attemptHalt(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  ladder: LadderState,
  memberId: string,
): Promise<HaltAttempt> {
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
  const haltedAt = Math.floor(Date.now() / 1000);
  const suppressedTone = ladder.currentToneSequence + 1;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk: 'METADATA' },
              UpdateExpression:
                'SET toneLadderStatus = :halted, nextToneAt = :null, haltedBy = :member, haltedAt = :now',
              // Records written before the ladder fields existed default to ACTIVE / tone 1,
              // matching the Tone Evaluator and GET /dispatches/{id}.
              ConditionExpression:
                'attribute_exists(pk) AND (attribute_not_exists(toneLadderStatus) OR toneLadderStatus = :active) AND (attribute_not_exists(currentToneSequence) OR currentToneSequence = :tone)',
              ExpressionAttributeValues: {
                ':halted': TONE_LADDER_HALTED,
                ':active': TONE_LADDER_ACTIVE,
                ':tone': ladder.currentToneSequence,
                ':null': null,
                ':member': memberId,
                ':now': haltedAt,
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk,
                // Suffixed with the outcome: an unconditional put keyed on the second alone
                // overwrote the Tone Evaluator's audit row for the same tone and second.
                sk: `TONE#${suppressedTone}#${haltedAt}#SKIPPED_MANUALLY_HALTED`,
                entityType: 'TONE_EVENT',
                dispatchId,
                deptId,
                toneSequence: suppressedTone,
                evaluatedAt: haltedAt,
                outcome: 'SKIPPED_MANUALLY_HALTED',
                triggeredBy: memberId,
              },
            },
          },
        ],
      }),
    );
    return {
      kind: 'halted',
      ladder: { status: TONE_LADDER_HALTED, currentToneSequence: ladder.currentToneSequence },
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      return { kind: 'retry' };
    }
    throw error;
  }
}

export interface HaltHandlerDeps {
  readonly authzClient?: VerifiedPermissionsClient;
  readonly docClient?: DynamoDBDocumentClient;
}

async function halt(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: HaltHandlerDeps,
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
    const ddb = createDynamoClient(process.env, deps.docClient);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const metadata = await getDispatchMetadata(ddb, tableName, deptId, dispatchId);
      if (!metadata) {
        return notFoundProblem(traceId, `No dispatch alert found for dispatchId "${dispatchId}"`);
      }
      const ladder = readLadderState(metadata);
      if (ladder.status === TONE_LADDER_HALTED) {
        // Double-submit, or another officer halted first: the requested state already holds.
        return jsonResponse(200, { dispatchId, toneLadder: ladder, changed: false });
      }
      if (
        ladder.status === TONE_LADDER_COMPLETED ||
        ladder.currentToneSequence >= FINAL_TONE_SEQUENCE
      ) {
        return conflictProblem(
          traceId,
          'Every tone has already fired, so there is nothing left to halt.',
          { toneLadder: ladder },
        );
      }
      if (ladder.status !== TONE_LADDER_ACTIVE) {
        return conflictProblem(traceId, `The tone ladder is ${ladder.status}; it was not halted.`, {
          toneLadder: ladder,
        });
      }
      const result = await attemptHalt(ddb, tableName, deptId, dispatchId, ladder, memberId);
      if (result.kind === 'halted') {
        logInfo('alerting.ladderControl.halt', {
          traceId,
          dispatchId,
          currentToneSequence: ladder.currentToneSequence,
          triggeredBy: memberId,
        });
        emitOutcomeMetric(LADDER_CONTROL_METRIC_NAMESPACE, 'ToneLadderHalted');
        return jsonResponse(200, { dispatchId, toneLadder: result.ladder, changed: true });
      }
    }
    throw new Error(`halt did not settle after ${MAX_ATTEMPTS} attempts`);
  } catch (error) {
    logError('alerting.ladderControl.halt.failed', error, { traceId, dispatchId });
    emitOutcomeMetric(LADDER_CONTROL_METRIC_NAMESPACE, LADDER_CONTROL_FAILED_METRIC, CONTROL);
    return dataUnavailableProblem(traceId);
  }
}

export function createHandler(
  deps: HaltHandlerDeps = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization((event, principal) => halt(event, principal, deps), {
    actionType: 'Boxalarm::Action',
    actionId: 'HaltToneLadder',
    resourceType: 'Boxalarm::Dispatch',
    resourceId: (event) => event.pathParameters?.dispatchId ?? '',
    ...(deps.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
