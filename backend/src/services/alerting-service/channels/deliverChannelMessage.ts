import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import {
  parseChannelEnvelope,
  parseMutualAidPromptEnvelope,
  resolveChannelTarget,
  type ChannelEnvelopePayload,
  type ChannelName,
  type ContactChannelSnapshot,
  type MutualAidPromptPayload,
} from './channelEnvelope.js';
import { sendViaHttpProvider } from './httpProviderAdapter.js';
import { resolvePushPlatform, sendPush, type PushSendResult } from './push/pushProviderAdapter.js';
import { findContactEntry } from '../eligibility/resolvePushTarget.js';
import { invalidatePushToken } from '../receipts/invalidatePushToken.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingChannel';

/**
 * A send guard moves CLAIMED -> SENT (provider accepted) or FAILED (provider refused, with
 * failureReason). A guard left CLAIMED means the attempt never finished: the worker died
 * mid-send, or the FAILED write itself failed. Guards written before sendState existed carry
 * none and are treated as sent, as they always were.
 */
const SEND_STATE_CLAIMED = 'CLAIMED';
const SEND_STATE_SENT = 'SENT';
const SEND_STATE_FAILED = 'FAILED';

/**
 * How old a CLAIMED guard must be before a redelivery may take it over. Longer than the
 * worker's 15s Lambda timeout (infrastructure DEFAULT_WORKER_TIMEOUT_SECONDS), so the
 * attempt that wrote it has certainly ended; shorter than the queue's 30s visibility
 * timeout, so the redelivery of a message whose worker died does qualify. A concurrent twin
 * - a re-publish of the same page - sees a fresh claim and is skipped as a duplicate.
 */
export const STALE_CLAIM_SECONDS = 20;

const CHANNEL_TIER: Record<ChannelName, 'primary' | 'escalation'> = {
  push: 'primary',
  sms: 'primary',
  voice: 'escalation',
};

interface DeliverChannelMessageCommon {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: ChannelName;
  readonly contactChannels: readonly ContactChannelSnapshot[] | undefined;
  readonly message: string;
  /** Push notification title; the message is the body. SMS/voice send the message alone. */
  readonly title?: string;
  readonly env: NodeJS.ProcessEnv;
  /** Self-test/canary message — sent with the sandbox provider credentials. */
  readonly isTest?: boolean;
}

/**
 * A dispatch page is guarded per tone; a mutual-aid prompt carries no toneSequence and is
 * guarded in its own MAPROMPT# namespace (architecture §3.1 "Officer push item shape") so it
 * never collides with the tone-3 receipt an officer already holds.
 */
export type DeliverChannelMessageParams = DeliverChannelMessageCommon &
  (
    | { readonly alertKind?: 'dispatch'; readonly toneSequence: number }
    | { readonly alertKind: 'mutual_aid_prompt'; readonly toneSequence?: undefined }
  );

interface SendGuard {
  readonly sk: string;
  readonly idempotencyKey: string;
  readonly attributes: Record<string, unknown>;
}

function buildSendGuard(params: DeliverChannelMessageParams, sentAt: number): SendGuard {
  const { dispatchId, memberId, channel } = params;
  const channelUpper = channel.toUpperCase();
  if (params.alertKind === 'mutual_aid_prompt') {
    // Disjoint from the producer's MAPROMPT#{memberId}#PUSH record, which mutualAidPort writes
    // before publishing — sharing it would make this worker duplicate-skip every prompt.
    return {
      sk: `MAPROMPT#${memberId}#${channelUpper}#SEND`,
      idempotencyKey: `${dispatchId}#MUTUALAID#${memberId}#${channelUpper}#SEND`,
      attributes: { entityType: 'MUTUAL_AID_PROMPT_SEND' },
    };
  }
  const { toneSequence } = params;
  return {
    sk: `RECEIPT#${memberId}#${channelUpper}#${toneSequence}`,
    idempotencyKey: `${dispatchId}#${toneSequence}#${memberId}#${channelUpper}`,
    attributes: {
      entityType: 'DELIVERY_RECEIPT',
      channelTier: CHANNEL_TIER[channel],
      toneSequence,
      gsi1pk: `MEMBER#${memberId}`,
      gsi1sk: `RECEIPT#${sentAt}#${dispatchId}`,
    },
  };
}

export async function deliverChannelMessage(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  params: DeliverChannelMessageParams,
): Promise<void> {
  const { deptId, dispatchId, memberId, channel, contactChannels } = params;
  const isTest = params.isTest === true;
  const correlationId = dispatchId;
  const resolved = resolveChannelTarget(channel, contactChannels);
  if (resolved.skipped) {
    logInfo('alerting.channel.no_target', {
      correlationId,
      memberId,
      channel,
      reason: resolved.reason,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'NoTargetRegistered', channel);
    return;
  }

  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
  const sentAt = Math.floor(Date.now() / 1000);
  const { sk, idempotencyKey, attributes } = buildSendGuard(params, sentAt);

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk,
          sk,
          ...attributes,
          dispatchId,
          memberId,
          deptId,
          channel: channel.toUpperCase(),
          sentAt,
          deliveredAt: null,
          openedAt: null,
          failureReason: null,
          sendState: SEND_STATE_CLAIMED,
          idempotencyKey,
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      const retried = await reattemptClaimedFailure(ddb, tableName, pk, sk, sentAt);
      if (!retried) {
        logInfo('alerting.channel.duplicate_skipped', { correlationId, memberId, channel });
        emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkipped', channel);
        return;
      }
    } else {
      logError('alerting.channel.receipt_write_failed', error, {
        correlationId,
        memberId,
        channel,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'SendFailed', channel);
      throw error;
    }
  }

  let result: PushSendResult;
  try {
    result = await sendToProvider(params, resolved.target, idempotencyKey, isTest);
  } catch (error) {
    logError('alerting.channel.send_failed', error, { correlationId, memberId, channel });
    emitOutcomeMetric(METRIC_NAMESPACE, 'SendFailed', channel);
    await recordClaimedFailure(ddb, tableName, pk, sk, error);
    throw error;
  }

  if (result.outcome === 'invalid_token') {
    // Terminal: the gateway says this device token is dead, so retrying it can never page the
    // member. Recorded FAILED (not thrown - no redelivery), and the contact entry is marked
    // invalid so producers stop publishing to it until the device re-registers. The parallel
    // SMS page and the voice escalation are unaffected.
    logInfo('alerting.channel.token_invalid', {
      correlationId,
      memberId,
      channel,
      reason: result.reason,
      isTest,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'TokenInvalid', channel);
    await recordClaimedFailure(
      ddb,
      tableName,
      pk,
      sk,
      new Error(`PUSH_TOKEN_INVALID ${result.reason}`),
    );
    // A self-test goes to the APNs sandbox host, which rejects every production token: that
    // says nothing about the token's validity for a real page, so it must never disable one.
    if (!isTest) {
      await invalidateDeadToken(ddb, tableName, deptId, memberId, resolved.target, correlationId);
    }
    return;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'Sent', channel);
  await recordSent(ddb, tableName, pk, sk);
}

/**
 * Push goes to APNs/FCM directly (architecture §Alerting); SMS and voice stay on the generic
 * vendor adapter until OQ-3 picks their vendors.
 */
async function sendToProvider(
  params: DeliverChannelMessageParams,
  target: string,
  idempotencyKey: string,
  isTest: boolean,
): Promise<PushSendResult> {
  const { channel, message, env, dispatchId } = params;
  if (channel !== 'push') {
    await sendViaHttpProvider(channel, target, message, env, { isTest });
    return { outcome: 'sent' };
  }
  const platform = resolvePushPlatform(
    findContactEntry(params.contactChannels, 'PUSH')?.platform,
    target,
  );
  const isPrompt = params.alertKind === 'mutual_aid_prompt';
  return sendPush(
    {
      token: target,
      alertKind: isPrompt ? 'mutual_aid_prompt' : 'dispatch',
      dispatchId,
      toneSequence: isPrompt ? undefined : params.toneSequence,
      title: params.title ?? (isPrompt ? 'MUTUAL AID REQUESTED' : 'DISPATCH'),
      body: message,
      idempotencyKey,
      // Per-tone notification identity (architecture §5.1 B4): tone 2 never collapses into 1.
      collapseKey: isPrompt ? `${dispatchId}#MUTUALAID` : `${dispatchId}#${params.toneSequence}`,
    },
    platform,
    env,
    { isTest },
  );
}

async function invalidateDeadToken(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  token: string,
  correlationId: string,
): Promise<void> {
  try {
    const outcome = await invalidatePushToken(ddb, tableName, deptId, memberId, token);
    logInfo('alerting.pushToken.invalidated_by_send', { correlationId, memberId, outcome });
  } catch (error) {
    // The page already failed terminally; a failed invalidation only means the next page
    // tries the dead token again and re-attempts this write.
    logError('alerting.pushToken.invalidate_failed', error, { correlationId, memberId });
  }
}

async function reattemptClaimedFailure(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  sk: string,
  sentAt: number,
): Promise<boolean> {
  // Strongly consistent: a failure recorded moments ago must not read as a clean claim.
  const existing = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }),
  );
  const item = existing.Item;
  if (!item || item.deliveredAt != null) {
    return false;
  }
  const claimedButFailed = item.failureReason != null;
  // Review MINOR-R5: a worker killed mid-send, or whose failureReason write was throttled,
  // left a claim with no failure recorded - and every redelivery skipped it as a duplicate,
  // so that member was never paged on this channel.
  const claimAbandoned =
    item.sendState === SEND_STATE_CLAIMED &&
    typeof item.sentAt === 'number' &&
    item.sentAt < sentAt - STALE_CLAIM_SECONDS;
  if (!claimedButFailed && !claimAbandoned) {
    return false;
  }
  // Re-claims atomically: the condition requires the state that was just read - the failure
  // still recorded, or the same abandoned claim - so when two redeliveries both saw it only
  // one wins the re-claim and sends; the other is treated as a duplicate.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk },
        UpdateExpression: 'SET sentAt = :sentAt, sendState = :claimed REMOVE failureReason',
        ConditionExpression: claimedButFailed
          ? 'attribute_exists(idempotencyKey) AND attribute_exists(failureReason) AND deliveredAt = :nullVal'
          : 'attribute_exists(idempotencyKey) AND sendState = :claimed AND sentAt = :observedSentAt AND deliveredAt = :nullVal',
        ExpressionAttributeValues: {
          ':sentAt': sentAt,
          ':claimed': SEND_STATE_CLAIMED,
          ':nullVal': null,
          ...(claimedButFailed ? {} : { ':observedSentAt': item.sentAt as number }),
        },
      }),
    );
    if (claimAbandoned) {
      logInfo('alerting.channel.abandoned_claim_retaken', { pk, sk });
    }
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw error;
  }
  return true;
}

async function recordClaimedFailure(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  sk: string,
  error: unknown,
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk },
        UpdateExpression: 'SET failureReason = :reason, sendState = :failed',
        ConditionExpression: 'attribute_exists(idempotencyKey)',
        ExpressionAttributeValues: {
          ':reason': error instanceof Error ? error.message : String(error),
          ':failed': SEND_STATE_FAILED,
        },
      }),
    );
  } catch (updateError) {
    logError('alerting.channel.failure_reason_write_failed', updateError, { pk, sk });
  }
}

/**
 * Marks the guard SENT so it is never taken over as abandoned. A failed write is only logged:
 * the page went out, and the worst case is one duplicate send after the stale window - for a
 * page, a duplicate is the safe side of a miss.
 */
async function recordSent(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  sk: string,
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk },
        UpdateExpression: 'SET sendState = :sent',
        ConditionExpression: 'attribute_exists(idempotencyKey)',
        ExpressionAttributeValues: { ':sent': SEND_STATE_SENT },
      }),
    );
  } catch (error) {
    logError('alerting.channel.sent_state_write_failed', error, { pk, sk });
  }
}

export function createChannelWorkerHandler(
  channel: ChannelName,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const { tableName } = readAlertingConfig(process.env);
    const ddb = createDynamoClient(process.env);

    async function processRecord(record: SQSEvent['Records'][number]): Promise<void> {
      let envelope: ChannelEnvelopePayload | MutualAidPromptPayload;
      try {
        envelope =
          parseMutualAidPromptEnvelope(record.body, channel) ??
          parseChannelEnvelope(record.body, channel);
      } catch (error) {
        logError('alerting.channel.malformed_event', error, {
          correlationId: record.messageId,
          channel,
        });
        throw error;
      }

      const deptId = toVerifiedDeptId({ deptId: envelope.deptId });
      let contactChannels: ContactChannelSnapshot[] | undefined;
      try {
        const snapshot = await ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              pk: buildDeptScopedPk(deptId, 'ELIGIBILITY'),
              sk: `MEMBER#${envelope.memberId}`,
            },
          }),
        );
        contactChannels = snapshot.Item?.contactChannels as ContactChannelSnapshot[] | undefined;
      } catch (error) {
        logError('alerting.channel.eligibility_read_failed', error, {
          correlationId: envelope.dispatchId,
          memberId: envelope.memberId,
          channel,
        });
        throw error;
      }

      const common = {
        deptId,
        dispatchId: envelope.dispatchId,
        memberId: envelope.memberId,
        channel,
        contactChannels,
        env: process.env,
        isTest: envelope.isTest,
      };
      const incidentText = `${envelope.incidentType} — ${envelope.address}`;
      await deliverChannelMessage(
        ddb,
        tableName,
        'alertKind' in envelope
          ? {
              ...common,
              alertKind: 'mutual_aid_prompt',
              title: 'MUTUAL AID REQUESTED',
              message: `MUTUAL AID REQUESTED — ${incidentText}`,
            }
          : {
              ...common,
              toneSequence: envelope.toneSequence,
              title: envelope.incidentType,
              message: incidentText,
            },
      );
    }

    const results = await Promise.allSettled(event.Records.map(processRecord));
    const batchItemFailures = results
      .map((result, index) =>
        result.status === 'rejected'
          ? { itemIdentifier: event.Records[index]?.messageId ?? '' }
          : null,
      )
      .filter((failure): failure is { itemIdentifier: string } => failure !== null);

    return { batchItemFailures };
  };
}
