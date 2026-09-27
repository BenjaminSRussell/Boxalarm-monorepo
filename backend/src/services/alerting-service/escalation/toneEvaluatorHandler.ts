import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildBridgeOutboxRecord } from '../platformBusBridge.js';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { buildAlertingEnvelope } from './alertingEnvelope.js';
import {
  buildChannelPagePayload,
  readDispatchAlertText,
  type DispatchAlertText,
} from '../channels/channelEnvelope.js';
import { queryEligibleMembers, type EligibilitySnapshotItem } from '../eligibility/selector.js';
import { resolvePushTarget, resolveSmsTarget } from '../eligibility/resolvePushTarget.js';
import { logError, logInfo } from '../dispatches/logger.js';
import { queryRoster } from '../roster/repository.js';
import { createSnsClient, readFanOutTopicConfig } from '../fanout/snsClient.js';
import { runWithConcurrencyLimit } from '../fanout/handler.js';
import {
  deriveFanOutKey,
  deriveMessageDeduplicationId,
  type FanOutChannel,
} from '../fanout/idempotencyKey.js';
import { createEscalationSchedule, getSchedulerClient } from './scheduleEscalation.js';
import { requestMutualAid } from './mutualAidPort.js';
import {
  isPredicateMet,
  readDepartmentToneConfig,
  MUTUAL_AID_AFTER_TONE,
  TONE_SEQUENCE_THREE,
  TONE_SEQUENCE_TWO,
} from './toneLadder.js';

const METRIC_NAMESPACE = 'Boxalarm/Alerting';
const CHANNEL_TIER = 'escalation';
const VOICE_ESCALATION_DELAY_SECONDS = 75;
const FAN_OUT_CHANNELS: readonly FanOutChannel[] = ['push', 'sms'];
const MAX_CONCURRENT_TONE_TASKS = 10;
const GUARD_ITEM_INDEX = 0;
const METADATA_ITEM_INDEX = 3;

interface TransactCancellationError {
  readonly name: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
}

function asTransactionCancellation(error: unknown): TransactCancellationError | undefined {
  return error instanceof Error && error.name === 'TransactionCanceledException'
    ? error
    : undefined;
}

function isGuardConflict(error: unknown): boolean {
  return (
    asTransactionCancellation(error)?.CancellationReasons?.[GUARD_ITEM_INDEX]?.Code ===
    'ConditionalCheckFailed'
  );
}

function isMetadataAdvanceRejected(error: unknown): boolean {
  const cancellation = asTransactionCancellation(error);
  return (
    cancellation?.CancellationReasons?.[GUARD_ITEM_INDEX]?.Code !== 'ConditionalCheckFailed' &&
    cancellation?.CancellationReasons?.[METADATA_ITEM_INDEX]?.Code === 'ConditionalCheckFailed'
  );
}

/**
 * Present only on the synchronous invocation from POST /tone-ladder/advance (F1.14). It
 * bypasses the responder predicate for this one tone; the halt/completed/fire-guard checks
 * and the fan-out below are the same code the scheduled evaluation runs. Scheduler payloads
 * never carry it (toneLadder.ts builds them as {deptId, dispatchId, toneSequence}).
 */
export interface ManualOverride {
  readonly triggeredBy: string;
}

export interface ToneEvaluatorPayload {
  readonly deptId: string;
  readonly dispatchId: string;
  readonly toneSequence: number;
  readonly manualOverride?: ManualOverride;
}

export type ToneOutcome =
  | 'FIRED'
  | 'FIRED_MANUAL_OVERRIDE'
  | 'SKIPPED_PREDICATE_MET'
  | 'SKIPPED_ALREADY_FIRED'
  | 'SKIPPED_MANUALLY_HALTED'
  | 'SKIPPED_COMPLETED'
  | 'SKIPPED_NOT_FOUND';

function isToneEvaluatorPayload(value: unknown): value is ToneEvaluatorPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deptId === 'string' &&
    candidate.deptId.length > 0 &&
    typeof candidate.dispatchId === 'string' &&
    candidate.dispatchId.length > 0 &&
    typeof candidate.toneSequence === 'number' &&
    (candidate.manualOverride === undefined ||
      (isManualOverride(candidate.manualOverride) &&
        (candidate.toneSequence === TONE_SEQUENCE_TWO ||
          candidate.toneSequence === TONE_SEQUENCE_THREE)))
  );
}

function isManualOverride(value: unknown): value is ManualOverride {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const triggeredBy = (value as Record<string, unknown>).triggeredBy;
  return typeof triggeredBy === 'string' && triggeredBy.trim().length > 0;
}

interface DispatchMetadata extends DispatchAlertText {
  readonly toneLadderStatus: string;
}

async function publishToneChannel(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchMetadata,
  memberId: string,
  channel: FanOutChannel,
  toneSequence: number,
): Promise<void> {
  const { sk, idempotencyKey } = deriveFanOutKey({ dispatchId, toneSequence, memberId, channel });
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk,
          sk,
          entityType: 'DELIVERY_RECEIPT',
          dispatchId,
          memberId,
          deptId,
          channel,
          channelTier: CHANNEL_TIER,
          toneSequence,
          idempotencyKey,
          gsi1pk: `MEMBER#${memberId}`,
          gsi1sk: `RECEIPT#${Math.floor(Date.now() / 1000)}#${dispatchId}`,
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') {
      logError('alerting.toneLadder.receiptWriteFailed', error, {
        deptId,
        dispatchId,
        memberId,
        channel,
      });
      throw error;
    }
    // The receipt already exists. It only proves an earlier attempt claimed this
    // {dispatch, tone, member, channel} - not that the page was published: the claim is
    // written before the publish, and a publish that failed after it left the receipt
    // behind. Skipping on the claim alone meant a retry (Scheduler, or an officer's manual
    // advance) silently never paged that member on that channel. Skip only once sentAt
    // shows the publish succeeded - the same rule fan-out applies to tone 1. Re-publishing
    // is safe: the deterministic MessageDeduplicationId dedupes within SNS FIFO's window,
    // and the channel worker's own send guard dedupes after it.
    const existing = await ddb.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }),
    );
    if (existing.Item?.sentAt) {
      logInfo('alerting.toneLadder.duplicateReceipt', {
        deptId,
        dispatchId,
        memberId,
        channel,
        toneSequence,
      });
      return;
    }
    logInfo('alerting.toneLadder.republishUnsentReceipt', {
      deptId,
      dispatchId,
      memberId,
      channel,
      toneSequence,
    });
  }
  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: JSON.stringify(
        buildAlertingEnvelope(
          'alerting.dispatch.normalized',
          dispatchId,
          buildChannelPagePayload({
            deptId,
            dispatchId,
            memberId,
            channel,
            channelTier: CHANNEL_TIER,
            toneSequence,
            dispatch,
          }),
        ),
      ),
      MessageGroupId: dispatchId,
      MessageDeduplicationId: deriveMessageDeduplicationId({
        dispatchId,
        toneSequence,
        memberId,
        channel,
      }),
      MessageAttributes: {
        channel: { DataType: 'String', StringValue: channel },
        channelTier: { DataType: 'String', StringValue: CHANNEL_TIER },
        toneSequence: { DataType: 'Number', StringValue: String(toneSequence) },
      },
    }),
  );

  // Marks the claim as published, so a later retry skips it instead of re-publishing.
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression: 'SET sentAt = :sentAt',
      ExpressionAttributeValues: { ':sentAt': Math.floor(Date.now() / 1000) },
    }),
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('non-Error thrown', { cause: error });
}

async function requestTone3MutualAid(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchMetadata,
): Promise<void> {
  try {
    await requestMutualAid({
      ddb,
      sns,
      tableName,
      topicArn,
      deptId,
      dispatchId,
      dispatch,
      reason: 'TONE_3_PREDICATE_UNMET',
    });
  } catch (error) {
    logError('alerting.toneLadder.mutualAidFailed', error, {
      correlationId: `${dispatchId}#${TONE_SEQUENCE_THREE}`,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'MutualAidRequestFailed');
    throw error;
  }
}

async function markMutualAidPending(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  toneSequence: number,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk: `TONE#${toneSequence}` },
      UpdateExpression: 'SET mutualAidPending = :pending',
      ExpressionAttributeValues: { ':pending': true },
    }),
  );
}

/** Re-runs the prompt pass for a committed tone 3 and clears the pending flag once it succeeds. */
async function completePendingMutualAid(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  pk: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchMetadata,
  toneSequence: number,
): Promise<void> {
  await requestTone3MutualAid(ddb, sns, tableName, topicArn, deptId, dispatchId, dispatch);
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk: `TONE#${toneSequence}` },
      UpdateExpression: 'REMOVE mutualAidPending',
    }),
  );
  logInfo('alerting.toneLadder.mutualAidCompleted', {
    correlationId: `${dispatchId}#${toneSequence}`,
  });
}

function firingMarkerSk(toneSequence: number): string {
  return `FIRING#TONE#${toneSequence}`;
}

/**
 * Records that this tone has started firing, before its first page is published, so a retry
 * resumes the fire instead of re-deciding it (see the marker read in the handler). Written
 * once; a twin that lost the race to write it is firing the same tone and needs nothing more.
 */
async function writeFiringMarker(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  toneSequence: number,
  mutualAidDue: boolean,
): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk,
          sk: firingMarkerSk(toneSequence),
          entityType: 'TONE_FIRE_STARTED',
          dispatchId,
          deptId,
          toneSequence,
          mutualAidDue,
          startedAt: Math.floor(Date.now() / 1000),
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') {
      throw error;
    }
  }
}

async function fireToneForMember(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  scheduler: Parameters<typeof createEscalationSchedule>[0],
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchMetadata,
  toneSequence: number,
  member: EligibilitySnapshotItem,
): Promise<void> {
  // Every channel is attempted even if an earlier one fails: a push outage must not also
  // cost the member their SMS page and voice escalation. The first failure is rethrown
  // after the voice schedule, so the evaluation still retries.
  let channelFailure: Error | undefined;
  for (const channel of FAN_OUT_CHANNELS) {
    if (channel === 'push' && resolvePushTarget(member.contactChannels).skipped) {
      continue;
    }
    if (channel === 'sms' && resolveSmsTarget(member.contactChannels).skipped) {
      continue;
    }
    try {
      await publishToneChannel(
        ddb,
        sns,
        tableName,
        topicArn,
        deptId,
        dispatchId,
        dispatch,
        member.memberId,
        channel,
        toneSequence,
      );
    } catch (error) {
      channelFailure ??= asError(error);
    }
  }
  try {
    await createEscalationSchedule(
      scheduler,
      {
        deptId,
        dispatchId,
        memberId: member.memberId,
        toneSequence,
        delaySeconds: VOICE_ESCALATION_DELAY_SECONDS,
      },
      ddb,
      tableName,
    );
  } catch (error) {
    logError('alerting.toneLadder.voiceScheduleFailed', error, {
      deptId,
      dispatchId,
      memberId: member.memberId,
      toneSequence,
    });
  }
  if (channelFailure !== undefined) {
    throw channelFailure;
  }
}

async function fireTone(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  scheduler: Parameters<typeof createEscalationSchedule>[0],
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchMetadata,
  toneSequence: number,
  members: readonly EligibilitySnapshotItem[],
): Promise<void> {
  const results = await runWithConcurrencyLimit(members, MAX_CONCURRENT_TONE_TASKS, (member) =>
    fireToneForMember(
      ddb,
      sns,
      scheduler,
      tableName,
      topicArn,
      deptId,
      dispatchId,
      dispatch,
      toneSequence,
      member,
    ),
  );
  const failures: PromiseRejectedResult[] = [];
  results.forEach((result, index) => {
    if (result.status !== 'rejected') {
      return;
    }
    failures.push(result);
    logError('alerting.toneLadder.memberFireFailed', result.reason, {
      deptId,
      dispatchId,
      memberId: members[index]?.memberId,
      toneSequence,
    });
  });
  if (failures.length > 0) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'ToneFireFailed');
    throw failures[0]!.reason;
  }
}

type ToneCommitResult = 'committed' | 'already_exists';

/**
 * Commits the singleton fire-guard `TONE#{toneSequence}` (and the METADATA
 * advance or, for a skip, its `nextToneAt`) only after paging has succeeded — or when the evaluator is skipping
 * because the responder predicate is already met. Writing the guard before
 * `fireTone` made Scheduler retries return SKIPPED_ALREADY_FIRED and silently
 * suppressed unpublished members / tones 2 and 3.
 *
 * METADATA only advances when `currentToneSequence` is still behind this tone
 * and the ladder is not COMPLETED / HALTED_MANUAL. A rejected advance still
 * writes the fire-guard so retries stop; any other transaction cancel throws
 * so Scheduler retries.
 */
async function writeToneGuardItems(
  ddb: DynamoDBDocumentClient,
  transactItems: NonNullable<TransactWriteCommandInput['TransactItems']>,
  correlationId: string,
): Promise<ToneCommitResult> {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: transactItems,
      }),
    );
    return 'committed';
  } catch (error) {
    if (isGuardConflict(error)) {
      return 'already_exists';
    }
    logError('alerting.toneLadder.guardWriteFailed', error, {
      correlationId,
      cancellationReasons: asTransactionCancellation(error)?.CancellationReasons?.map(
        (r) => r.Code,
      ),
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'ToneEvaluationFailed');
    throw error;
  }
}

async function commitToneEvaluation(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  toneSequence: number,
  evaluatedAt: number,
  outcome: ToneOutcome,
  eligibleMemberCount: number,
  predicateSnapshot: {
    readonly minResponders: number;
    readonly requiredQuals: readonly string[];
    readonly respondingCount: number;
  },
  options: {
    readonly advanceMetadata: boolean;
    readonly triggeredBy?: string | undefined;
    /** Firing a tone whose guard only records a predicate-met skip (manual advance). */
    readonly upgradeSkippedGuard?: boolean;
    /** Every member was paged but a tone-3 mutual-aid prompt was not; a retry re-prompts. */
    readonly mutualAidPending?: boolean;
    /** When the next automatic tone fires; null once none is left. */
    readonly nextToneAt: number | null;
  },
): Promise<ToneCommitResult> {
  const correlationId = `${dispatchId}#${toneSequence}`;
  const guardAndAudit: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Put: {
        TableName: tableName,
        Item: {
          pk,
          sk: `TONE#${toneSequence}`,
          entityType: 'TONE_EVENT_GUARD',
          dispatchId,
          deptId,
          toneSequence,
          // A predicate-met skip still claims the tone so Scheduler retries of that skip are
          // idempotent, but it is not a firing: a manual advance may fire the tone later.
          skipped: !options.advanceMetadata,
          ...(options.mutualAidPending ? { mutualAidPending: true } : {}),
        },
        // Normally the tone may be claimed once. A manual advance of a tone that was only
        // skipped may take over the skip guard - exactly once, since the upgraded guard is
        // no longer skipped and a concurrent twin's condition then fails.
        ConditionExpression: options.upgradeSkippedGuard
          ? 'attribute_not_exists(pk) OR skipped = :skipped'
          : 'attribute_not_exists(pk)',
        ...(options.upgradeSkippedGuard ? { ExpressionAttributeValues: { ':skipped': true } } : {}),
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: {
          pk,
          // The outcome keeps this row distinct from a halt's audit row (haltHandler.ts) or a
          // skip later upgraded by a manual advance, written in the same second.
          sk: `TONE#${toneSequence}#${evaluatedAt}#${outcome}`,
          entityType: 'TONE_EVENT',
          dispatchId,
          deptId,
          toneSequence,
          evaluatedAt,
          outcome,
          eligibleMemberCount,
          ...(options.triggeredBy ? { triggeredBy: options.triggeredBy } : {}),
        },
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: buildBridgeOutboxRecord(deptId, 'alerting.tone.escalated', correlationId, {
          dispatchId,
          toneSequence,
          firedAt: evaluatedAt,
          outcome,
          predicateSnapshot,
          eligibleMemberCount,
        }),
      },
    },
  ];
  // Fired or skipped, this tone has been evaluated, so the ladder's next automatic tone is the
  // next schedule's - null after tone 3, which the officer sees as "no further tone".
  const metadataUpdate: NonNullable<TransactWriteCommandInput['TransactItems']>[number] = {
    Update: options.advanceMetadata
      ? {
          TableName: tableName,
          Key: { pk, sk: 'METADATA' },
          UpdateExpression:
            'SET currentToneSequence = :tone, toneLadderStatus = :status, nextToneAt = :next',
          ConditionExpression:
            'currentToneSequence < :tone AND toneLadderStatus <> :completed AND toneLadderStatus <> :halted',
          ExpressionAttributeValues: {
            ':tone': toneSequence,
            ':status': toneSequence >= MUTUAL_AID_AFTER_TONE ? 'COMPLETED' : 'ACTIVE',
            ':next': options.nextToneAt,
            ':completed': 'COMPLETED',
            ':halted': 'HALTED_MANUAL',
          },
        }
      : {
          TableName: tableName,
          Key: { pk, sk: 'METADATA' },
          UpdateExpression: 'SET nextToneAt = :next',
          ConditionExpression:
            'attribute_exists(pk) AND (attribute_not_exists(toneLadderStatus) OR toneLadderStatus = :active)',
          ExpressionAttributeValues: { ':next': options.nextToneAt, ':active': 'ACTIVE' },
        },
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [...guardAndAudit, metadataUpdate],
      }),
    );
    return 'committed';
  } catch (error) {
    if (isGuardConflict(error)) {
      return 'already_exists';
    }
    if (isMetadataAdvanceRejected(error)) {
      logInfo('alerting.toneLadder.metadataAdvanceSkipped', { correlationId, toneSequence });
      return writeToneGuardItems(ddb, guardAndAudit, correlationId);
    }
    logError('alerting.toneLadder.guardWriteFailed', error, {
      correlationId,
      cancellationReasons: asTransactionCancellation(error)?.CancellationReasons?.map(
        (r) => r.Code,
      ),
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'ToneEvaluationFailed');
    throw error;
  }
}

export const handler = async (payload: unknown): Promise<{ outcome: ToneOutcome }> => {
  if (!isToneEvaluatorPayload(payload)) {
    const error = new Error('tone evaluator payload failed shape validation');
    logError('alerting.toneLadder.malformedPayload', error, {});
    throw error;
  }
  const { dispatchId, toneSequence, manualOverride } = payload;
  const deptId = toVerifiedDeptId({ deptId: payload.deptId });
  const correlationId = `${dispatchId}#${toneSequence}`;
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);
  const sns = createSnsClient(process.env);
  const { topicArn } = readFanOutTopicConfig(process.env);
  const scheduler = getSchedulerClient();
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);

  // Strongly consistent: a halt committed by POST /tone-ladder/halt must be seen by every
  // evaluation that starts after it, not a replica that has not caught up yet.
  const metadataResult = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' }, ConsistentRead: true }),
  );
  const metadataItem = metadataResult.Item;
  if (!metadataItem) {
    logInfo('alerting.toneLadder.dispatchNotFound', { correlationId });
    return { outcome: 'SKIPPED_NOT_FOUND' };
  }
  const dispatch: DispatchMetadata = {
    ...readDispatchAlertText(metadataItem),
    toneLadderStatus:
      typeof metadataItem.toneLadderStatus === 'string' ? metadataItem.toneLadderStatus : 'ACTIVE',
  };

  if (dispatch.toneLadderStatus === 'HALTED_MANUAL') {
    logInfo('alerting.toneLadder.skippedHalted', { correlationId });
    return { outcome: 'SKIPPED_MANUALLY_HALTED' };
  }
  const existingGuard = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk, sk: `TONE#${toneSequence}` },
      ConsistentRead: true,
    }),
  );
  // Tone 3 paged every member and committed, but some officer's mutual-aid prompt did not go
  // out. Only the prompt pass is retried; checked before COMPLETED because that commit is
  // what completed the ladder.
  if (existingGuard.Item?.mutualAidPending === true) {
    await completePendingMutualAid(
      ddb,
      sns,
      tableName,
      topicArn,
      pk,
      deptId,
      dispatchId,
      dispatch,
      toneSequence,
    );
    return { outcome: 'SKIPPED_ALREADY_FIRED' };
  }
  if (dispatch.toneLadderStatus === 'COMPLETED') {
    logInfo('alerting.toneLadder.skippedCompleted', { correlationId });
    return { outcome: 'SKIPPED_COMPLETED' };
  }
  // A guard that only records a predicate-met skip does not stop a manual advance: the tone
  // never fired, and the officer is asking for it precisely because more people are needed.
  const upgradeSkippedGuard = manualOverride !== undefined && existingGuard.Item?.skipped === true;
  if (existingGuard.Item && !upgradeSkippedGuard) {
    logInfo('alerting.toneLadder.alreadyEvaluated', { correlationId });
    return { outcome: 'SKIPPED_ALREADY_FIRED' };
  }

  // An earlier attempt that started firing this tone and failed part-way left a marker. Its
  // retry must finish the fire, not re-check the predicate: members paged by that attempt may
  // have responded since, and a skip now would abandon the pages and officer prompts it left
  // unsent while recording the tone as skipped.
  const firingMarker = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk, sk: firingMarkerSk(toneSequence) },
      ConsistentRead: true,
    }),
  );
  const resumingFire = firingMarker.Item !== undefined;

  const roster = await queryRoster(ddb, tableName, deptId, dispatchId);
  const toneConfig = await readDepartmentToneConfig(ddb, tableName, deptId);
  const predicateMet = !resumingFire && isPredicateMet(roster, toneConfig);
  const outcome: ToneOutcome = manualOverride
    ? 'FIRED_MANUAL_OVERRIDE'
    : predicateMet
      ? 'SKIPPED_PREDICATE_MET'
      : 'FIRED';
  const evaluatedAt = Math.floor(Date.now() / 1000);
  // Tone 3's time was recorded at fan-out (toneLadder.ts recordToneTimes); nothing follows it.
  const nextToneAt =
    toneSequence === TONE_SEQUENCE_TWO && typeof metadataItem.tone3At === 'number'
      ? metadataItem.tone3At
      : null;
  const respondingCount = roster.filter(
    (entry) => entry.ackStatus === 'RESPONDING' || entry.ackStatus === 'DIRECT_TO_SCENE',
  ).length;
  const predicateSnapshot = {
    minResponders: toneConfig.minResponders,
    requiredQuals: toneConfig.requiredQuals,
    respondingCount,
  };

  if (predicateMet && !manualOverride) {
    const skipCommit = await commitToneEvaluation(
      ddb,
      tableName,
      pk,
      deptId,
      dispatchId,
      toneSequence,
      evaluatedAt,
      outcome,
      roster.length,
      predicateSnapshot,
      { advanceMetadata: false, nextToneAt },
    );
    if (skipCommit === 'already_exists') {
      logInfo('alerting.toneLadder.alreadyEvaluated', { correlationId });
      return { outcome: 'SKIPPED_ALREADY_FIRED' };
    }
    emitOutcomeMetric(METRIC_NAMESPACE, 'ToneSkippedPredicateMet');
    logInfo('alerting.toneLadder.predicateMet', { correlationId });
    return { outcome };
  }

  // A manual advance bypasses the predicate to fire, but mutual aid still follows the
  // architecture's rule - tone 3 fired with the predicate unmet - so an officer advancing a
  // department that is already staffed does not also page the mutual-aid prompt. A resumed
  // fire keeps the decision its first attempt recorded.
  const mutualAidDue = resumingFire
    ? firingMarker.Item?.mutualAidDue === true
    : toneSequence === TONE_SEQUENCE_THREE && !isPredicateMet(roster, toneConfig);
  if (!resumingFire) {
    await writeFiringMarker(ddb, tableName, pk, deptId, dispatchId, toneSequence, mutualAidDue);
  }

  const eligibleMembers = await queryEligibleMembers(ddb, tableName, deptId);
  // A failure paging some member must not also block mutual aid for tone 3: it is recorded,
  // mutual aid is still requested, and the failure is rethrown so the evaluation retries
  // (re-publishing only unsent pages).
  let pagingFailure: Error | undefined;
  try {
    await fireTone(
      ddb,
      sns,
      scheduler,
      tableName,
      topicArn,
      deptId,
      dispatchId,
      dispatch,
      toneSequence,
      eligibleMembers,
    );
  } catch (error) {
    pagingFailure = asError(error);
  }

  // Requested before the fire-guard commit, even when paging failed, so a paging retry does
  // not also delay the mutual-aid call. A mutual-aid failure never blocks the commit once
  // every member is paged: the guard records it as pending, and the retry re-runs only the
  // prompt pass (see the pending check above) - sent prompts are skipped, the MUTUALAID
  // singleton is written once.
  let mutualAidFailure: Error | undefined;
  if (mutualAidDue) {
    try {
      await requestTone3MutualAid(ddb, sns, tableName, topicArn, deptId, dispatchId, dispatch);
    } catch (error) {
      mutualAidFailure = asError(error);
    }
  }
  if (pagingFailure !== undefined) {
    throw pagingFailure;
  }

  const fireCommit = await commitToneEvaluation(
    ddb,
    tableName,
    pk,
    deptId,
    dispatchId,
    toneSequence,
    evaluatedAt,
    outcome,
    eligibleMembers.length,
    predicateSnapshot,
    // Always upgrade-capable for a manual advance, even when no skip guard was seen at read
    // time: a timer evaluation can write its skip guard in between, and the advance - which
    // has already paged everyone - must still claim the tone rather than report 'not sent'.
    {
      advanceMetadata: true,
      nextToneAt,
      triggeredBy: manualOverride?.triggeredBy,
      upgradeSkippedGuard: manualOverride !== undefined,
      mutualAidPending: mutualAidFailure !== undefined,
    },
  );
  if (mutualAidFailure !== undefined) {
    if (fireCommit === 'already_exists') {
      // A twin committed the guard first, without knowing this attempt's prompts failed.
      await markMutualAidPending(ddb, tableName, pk, toneSequence);
    }
    throw mutualAidFailure;
  }
  if (fireCommit === 'already_exists') {
    logInfo('alerting.toneLadder.alreadyEvaluated', { correlationId });
    return { outcome: 'SKIPPED_ALREADY_FIRED' };
  }

  emitOutcomeMetric(METRIC_NAMESPACE, manualOverride ? 'ToneFiredManualOverride' : 'ToneFired');
  logInfo('alerting.toneLadder.fired', {
    correlationId,
    toneSequence,
    outcome,
    triggeredBy: manualOverride?.triggeredBy,
    eligibleMemberCount: eligibleMembers.length,
  });
  return { outcome };
};
