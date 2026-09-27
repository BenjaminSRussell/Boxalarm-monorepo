import { InvocationType, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  badRequestProblem,
  extractTraceId,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import type { ToneEvaluatorPayload, ToneOutcome } from '../escalation/toneEvaluatorHandler.js';
import {
  FINAL_TONE_SEQUENCE,
  LADDER_CONTROL_FAILED_METRIC,
  LADDER_CONTROL_METRIC_NAMESPACE,
  TONE_LADDER_COMPLETED,
  TONE_LADDER_HALTED,
  conflictProblem,
  dataUnavailableProblem,
  getDispatchMetadata,
  jsonResponse,
  outcomeUnknownProblem,
  parseDispatchId,
  parseJsonObjectBody,
  readLadderState,
} from './shared.js';

/**
 * POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/advance (F1.14, AP 5d).
 *
 * Fires the next tone now, bypassing its timer and the responder predicate. This route owns
 * no fan-out: it synchronously invokes the Tone Evaluator Lambda — the same handler the
 * T+180s/T+360s schedules invoke — with `manualOverride`, so a manual tone produces exactly
 * the receipts, publishes, `{dispatchId}#{toneSequence}#{memberId}#{channel}` keys and voice
 * escalation schedules a scheduled tone would.
 *
 * Idempotency (AP 5d): the caller sends the tone it is looking at
 * (`expectedCurrentToneSequence`, from GET /dispatches/{id}'s `toneLadder`), and the tone to
 * fire is that value + 1 — fixed by the request, never re-derived from ladder state at fire
 * time. A double-submit therefore targets the same tone number: whichever request commits
 * the `TONE#{n}` fire-guard first wins, the other is reported as already fired, and the
 * per-member-channel receipt guards collapse any overlap to one send per member per channel.
 * A retry after success fails the `currentToneSequence` precondition with a 409 instead of
 * minting a further tone.
 */

const CONTROL = 'AdvanceToneLadder';

let cachedLambda: LambdaClient | undefined;

function getLambdaClient(): LambdaClient {
  // maxAttempts 1: the SDK must never silently re-invoke a page-sending function. A failed
  // invocation is reported to the officer, who can retry safely (see idempotency above).
  cachedLambda ??= captureAWSv3Client(new LambdaClient({ maxAttempts: 1 }));
  return cachedLambda;
}

function readToneEvaluatorArn(env: NodeJS.ProcessEnv): string {
  const arn = env.TONE_EVALUATOR_HANDLER_ARN;
  if (!arn) {
    throw new Error('TONE_EVALUATOR_HANDLER_ARN is required and was not set');
  }
  return arn;
}

function parseExpectedTone(body: Record<string, unknown>): number | undefined {
  const value = body.expectedCurrentToneSequence;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value < FINAL_TONE_SEQUENCE
    ? value
    : undefined;
}

/**
 * The evaluator's error class, from the runtime's `{errorType, errorMessage}` error payload.
 * It separates "some member was not paged" from "every member was paged and the tone
 * committed, but an officer's mutual-aid prompt was not" - an officer must act differently.
 */
function readErrorType(payload: Uint8Array | undefined): string | undefined {
  if (!payload) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload).toString('utf8')) as { errorType?: unknown };
    return typeof parsed.errorType === 'string' ? parsed.errorType : undefined;
  } catch {
    return undefined;
  }
}

const MUTUAL_AID_PROMPT_INCOMPLETE = 'MutualAidPromptIncompleteError';

type InvokeResult =
  | { readonly kind: 'outcome'; readonly outcome: ToneOutcome }
  | { readonly kind: 'failed'; readonly reason: string };

async function invokeToneEvaluator(
  lambda: LambdaClient,
  functionArn: string,
  payload: ToneEvaluatorPayload,
): Promise<InvokeResult> {
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: InvocationType.RequestResponse,
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  if (response.FunctionError) {
    return { kind: 'failed', reason: readErrorType(response.Payload) ?? response.FunctionError };
  }
  if (!response.Payload) {
    return { kind: 'failed', reason: 'EmptyPayload' };
  }
  const parsed = JSON.parse(Buffer.from(response.Payload).toString('utf8')) as {
    outcome?: unknown;
  };
  return typeof parsed.outcome === 'string'
    ? { kind: 'outcome', outcome: parsed.outcome as ToneOutcome }
    : { kind: 'failed', reason: 'MalformedPayload' };
}

export interface AdvanceHandlerDeps {
  readonly authzClient?: VerifiedPermissionsClient;
  readonly docClient?: DynamoDBDocumentClient;
  readonly lambdaClient?: LambdaClient;
}

async function advance(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: AdvanceHandlerDeps,
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
  const expected = parseExpectedTone(parsedBody.body);
  if (expected === undefined) {
    return badRequestProblem(traceId, [
      {
        field: 'expectedCurrentToneSequence',
        detail: `must be the ladder's current tone (an integer from 1 to ${FINAL_TONE_SEQUENCE - 1}) as last shown to the officer`,
      },
    ]);
  }

  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;
  let metadata: Record<string, unknown> | undefined;
  try {
    const { tableName } = readAlertingConfig(process.env);
    metadata = await getDispatchMetadata(
      createDynamoClient(process.env, deps.docClient),
      tableName,
      deptId,
      dispatchId,
    );
  } catch (error) {
    logError('alerting.ladderControl.advance.readFailed', error, { traceId, dispatchId });
    emitOutcomeMetric(LADDER_CONTROL_METRIC_NAMESPACE, LADDER_CONTROL_FAILED_METRIC, CONTROL);
    return dataUnavailableProblem(traceId);
  }
  if (!metadata) {
    return notFoundProblem(traceId, `No dispatch alert found for dispatchId "${dispatchId}"`);
  }

  const ladder = readLadderState(metadata);
  if (ladder.status === TONE_LADDER_HALTED) {
    return conflictProblem(traceId, 'The tone ladder is halted. No tone was sent.', {
      toneLadder: ladder,
    });
  }
  if (
    ladder.status === TONE_LADDER_COMPLETED ||
    ladder.currentToneSequence >= FINAL_TONE_SEQUENCE
  ) {
    return conflictProblem(traceId, 'Every tone has already fired. No tone was sent.', {
      toneLadder: ladder,
    });
  }
  if (ladder.currentToneSequence !== expected) {
    return conflictProblem(
      traceId,
      `The ladder is now at tone ${ladder.currentToneSequence}, not tone ${expected}. No tone was sent; refresh before advancing again.`,
      { toneLadder: ladder },
    );
  }

  const toneSequence = expected + 1;
  let result: InvokeResult;
  try {
    result = await invokeToneEvaluator(
      deps.lambdaClient ?? getLambdaClient(),
      readToneEvaluatorArn(process.env),
      { deptId, dispatchId, toneSequence, manualOverride: { triggeredBy: memberId } },
    );
  } catch (error) {
    logError('alerting.ladderControl.advance.invokeFailed', error, {
      traceId,
      dispatchId,
      toneSequence,
    });
    result = { kind: 'failed', reason: error instanceof Error ? error.name : 'UnknownError' };
  }

  if (result.kind === 'failed') {
    logError('alerting.ladderControl.advance.evaluatorFailed', new Error(result.reason), {
      traceId,
      dispatchId,
      toneSequence,
    });
    emitOutcomeMetric(LADDER_CONTROL_METRIC_NAMESPACE, LADDER_CONTROL_FAILED_METRIC, CONTROL);
    if (result.reason === MUTUAL_AID_PROMPT_INCOMPLETE) {
      return outcomeUnknownProblem(
        traceId,
        `Tone ${toneSequence} was sent to every eligible member, but the mutual-aid prompt did not reach every officer. Make the mutual-aid call now if no officer has confirmed it.`,
      );
    }
    return outcomeUnknownProblem(
      traceId,
      `Tone ${toneSequence} may not have reached every member. Check the ladder and delivery receipts before advancing again — retrying tone ${toneSequence} will not re-page members who already received it.`,
    );
  }

  logInfo('alerting.ladderControl.advance', {
    traceId,
    dispatchId,
    toneSequence,
    outcome: result.outcome,
    triggeredBy: memberId,
  });
  switch (result.outcome) {
    case 'FIRED_MANUAL_OVERRIDE':
      return jsonResponse(200, {
        dispatchId,
        toneSequence,
        outcome: result.outcome,
      });
    case 'SKIPPED_ALREADY_FIRED':
      return conflictProblem(
        traceId,
        `Tone ${toneSequence} has already fired. No additional tone was sent.`,
        { toneSequence, outcome: result.outcome },
      );
    case 'SKIPPED_MANUALLY_HALTED':
      return conflictProblem(traceId, 'The tone ladder was halted. No tone was sent.', {
        toneSequence,
        outcome: result.outcome,
      });
    case 'SKIPPED_COMPLETED':
      return conflictProblem(traceId, 'Every tone has already fired. No tone was sent.', {
        toneSequence,
        outcome: result.outcome,
      });
    case 'SKIPPED_NOT_FOUND':
      return notFoundProblem(traceId, `No dispatch alert found for dispatchId "${dispatchId}"`);
    default:
      emitOutcomeMetric(LADDER_CONTROL_METRIC_NAMESPACE, LADDER_CONTROL_FAILED_METRIC, CONTROL);
      return outcomeUnknownProblem(
        traceId,
        `The tone evaluator returned an unexpected outcome (${result.outcome}). Check the ladder before advancing again.`,
      );
  }
}

export function createHandler(
  deps: AdvanceHandlerDeps = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization((event, principal) => advance(event, principal, deps), {
    actionType: 'Boxalarm::Action',
    actionId: 'AdvanceToneLadder',
    resourceType: 'Boxalarm::Dispatch',
    resourceId: (event) => event.pathParameters?.dispatchId ?? '',
    ...(deps.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
