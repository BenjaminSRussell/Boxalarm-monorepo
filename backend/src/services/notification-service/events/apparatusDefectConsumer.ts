import { DeleteCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { sendPushDigest } from '../channelSender.js';
import { createDynamoClient, readNotificationConfig } from '../dynamoClient.js';
import {
  APPARATUS_DEFECT_CATEGORY,
  categoryConfig,
  type ReminderItem,
} from '../reminders/categories.js';
import { loadRoster, membersWithRoles, readChannelMutes } from '../reminders/recipients.js';
import { buildNotificationItem, isConditionalPutFailed } from '../repository.js';
import {
  logError,
  METRIC_NAMESPACE,
  parseEnvelope,
  recordReminder,
  requireString,
  type EventEnvelope,
  type ReminderRecord,
} from './reminderIngest.js';

const LABEL = 'apparatus.defect.reported';
const LOG_PREFIX = 'notification.apparatusDefect';

/** Severities that take a unit off the road: delivered at once, never held for the digest. */
const IMMEDIATE_SEVERITIES: ReadonlySet<string> = new Set(['OUT_OF_SERVICE', 'CRITICAL']);

interface DefectReminder extends ReminderRecord {
  readonly immediate: boolean;
}

function toDefectReminder({ payload }: EventEnvelope): DefectReminder {
  const unitLabel = requireString(payload, 'unitLabel', LABEL);
  const severity = requireString(payload, 'severity', LABEL);
  const immediate = payload.outOfService === true || IMMEDIATE_SEVERITIES.has(severity);
  return {
    deptId: requireString(payload, 'deptId', LABEL),
    category: APPARATUS_DEFECT_CATEGORY,
    immediate,
    item: {
      subjectId: requireString(payload, 'defectId', LABEL),
      title: unitLabel,
      detail: immediate
        ? 'reported out of service'
        : `${severity.toLowerCase().replaceAll('_', ' ')} defect reported`,
      // The web apparatus detail route is keyed by the display unitId the event carries.
      link: { kind: 'apparatus', id: unitLabel },
    },
  };
}

type ImmediateOutcome = 'Delivered' | 'Failed';
type ChannelOutcome = 'Sent' | 'AlreadySent' | 'Muted' | 'Failed';

/**
 * How long a channel claim stays owned by the invocation that took it. The queue's
 * visibility timeout (30s) outlasts the Lambda's (25s), so by the time SQS redelivers a
 * message whose handler died between claiming and sending, the claim is stale and the
 * redelivery takes it over rather than skipping the send.
 */
export const CLAIM_STALE_MS = 30_000;
const CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

function claimKey(deptId: VerifiedDeptId, memberId: string, marker: string, eventId: string) {
  return { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: `${marker}#${eventId}` };
}

/**
 * At-most-once-per-success delivery on one channel, independent of the inbox record: claim
 * `{marker}#{eventId}` (new, or abandoned by a dead invocation), send, then stamp sentAt.
 * A failed send releases only the claim, so the redelivery retries just that channel.
 */
async function sendOnce(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  marker: string,
  envelope: EventEnvelope,
  send: () => Promise<void>,
): Promise<ChannelOutcome> {
  const key = claimKey(deptId, memberId, marker, envelope.eventId);
  const now = Date.now();
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...key,
          entityType: 'NOTIFICATION_DELIVERY_CLAIM',
          claimedAt: now,
          ttl: Math.floor(now / 1000) + CLAIM_TTL_SECONDS,
        },
        ConditionExpression:
          'attribute_not_exists(sk) OR (attribute_not_exists(sentAt) AND claimedAt < :staleBefore)',
        ExpressionAttributeValues: { ':staleBefore': now - CLAIM_STALE_MS },
      }),
    );
  } catch (error) {
    if (isConditionalPutFailed(error)) {
      return 'AlreadySent';
    }
    logError(`${LOG_PREFIX}.claim_failed`, error, envelope.eventId, { memberId, marker });
    return 'Failed';
  }

  try {
    await send();
  } catch (error) {
    logError(`${LOG_PREFIX}.send_failed`, error, envelope.eventId, { memberId, marker });
    try {
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: key }));
    } catch (releaseError) {
      logError(`${LOG_PREFIX}.release_failed`, releaseError, envelope.eventId, {
        memberId,
        marker,
      });
    }
    return 'Failed';
  }

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...key,
          entityType: 'NOTIFICATION_DELIVERY_CLAIM',
          claimedAt: now,
          sentAt: Date.now(),
          ttl: Math.floor(now / 1000) + CLAIM_TTL_SECONDS,
        },
      }),
    );
  } catch (error) {
    // Sent, but not recorded as sent: a redelivery after the claim goes stale may send again.
    logError(`${LOG_PREFIX}.mark_sent_failed`, error, envelope.eventId, { memberId, marker });
  }
  return 'Sent';
}

/**
 * One recipient's copy of an out-of-service defect. The inbox record is written
 * idempotently (a conditional Put keyed on the eventId and event time; "already there" is
 * success) and is never removed. Each outbound channel then goes through its own claim, so
 * a failure on one channel neither erases the inbox record nor blocks a retry of the send.
 */
async function deliverTo(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  email: string | undefined,
  item: ReminderItem,
  envelope: EventEnvelope,
  createdAt: number,
): Promise<ImmediateOutcome> {
  const notification = buildNotificationItem(
    deptId,
    memberId,
    envelope.eventId,
    APPARATUS_DEFECT_CATEGORY,
    [item],
    createdAt,
  );
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: notification,
        ConditionExpression: 'attribute_not_exists(sk)',
      }),
    );
  } catch (error) {
    if (!isConditionalPutFailed(error)) {
      logError(`${LOG_PREFIX}.inbox_write_failed`, error, envelope.eventId, { memberId });
      return 'Failed';
    }
  }

  let mutes: { push: boolean; email: boolean };
  try {
    mutes = await readChannelMutes(
      ddb,
      tableName,
      deptId,
      memberId,
      categoryConfig(APPARATUS_DEFECT_CATEGORY).muteKey,
    );
  } catch (error) {
    logError(`${LOG_PREFIX}.mute_read_failed`, error, envelope.eventId, { memberId });
    return 'Failed';
  }

  const push: ChannelOutcome = mutes.push
    ? 'Muted'
    : await sendOnce(ddb, tableName, deptId, memberId, 'DEFECTPUSH', envelope, () =>
        sendPushDigest(
          process.env,
          { memberId, email },
          [item],
          envelope.correlationId ?? envelope.eventId,
          undefined,
          APPARATUS_DEFECT_CATEGORY,
        ),
      );
  emitOutcomeMetric(METRIC_NAMESPACE, `ApparatusDefectPush${push}`);
  return push === 'Failed' ? 'Failed' : 'Delivered';
}

async function deliverImmediately(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  reminder: DefectReminder,
  envelope: EventEnvelope,
): Promise<void> {
  const roster = await loadRoster(ddb, tableName, deptId);
  const recipients = membersWithRoles(roster, categoryConfig(APPARATUS_DEFECT_CATEGORY).roles);
  const eventTime = envelope.eventTime ? Date.parse(envelope.eventTime) : Number.NaN;
  const createdAt = Number.isFinite(eventTime) ? eventTime : Date.now();

  let failed = 0;
  for (const member of recipients) {
    const outcome = await deliverTo(
      ddb,
      tableName,
      deptId,
      member.memberId,
      member.email,
      reminder.item,
      envelope,
      createdAt,
    );
    emitOutcomeMetric(METRIC_NAMESPACE, `ApparatusDefectImmediate${outcome}`);
    if (outcome === 'Failed') {
      failed += 1;
    }
  }
  if (recipients.length === 0) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'ApparatusDefectImmediateNoRecipients');
  }
  if (failed > 0) {
    // Everyone already delivered is a conditional no-op on the redelivery.
    throw new Error(`immediate defect delivery failed for ${failed} recipient(s)`);
  }
}

/**
 * apparatus.defect.reported (apparatus-service outbox, F4.3) -> the APPARATUS role and
 * officers. A defect that takes the unit out of service (outOfService, or an
 * OUT_OF_SERVICE/CRITICAL severity) is written to their inboxes and pushed now, on the
 * non-critical notification channel — never an interruption-level alert. Any other defect
 * waits for the daily digest.
 */
export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readNotificationConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: EventEnvelope;
    let reminder: DefectReminder;
    try {
      envelope = parseEnvelope(record.body, new Set([LABEL]), LABEL);
      reminder = toDefectReminder(envelope);
    } catch (error) {
      logError(`${LOG_PREFIX}.malformed_event`, error, record.messageId);
      throw error;
    }
    const deptId = toVerifiedDeptId({ deptId: reminder.deptId });

    if (reminder.immediate) {
      try {
        await deliverImmediately(ddb, tableName, deptId, reminder, envelope);
      } catch (error) {
        logError(`${LOG_PREFIX}.immediate_failed`, error, envelope.eventId, {
          defectId: reminder.item.subjectId,
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'ApparatusDefectImmediateFailed');
        throw error;
      }
      continue;
    }

    try {
      const outcome = await recordReminder(
        ddb,
        tableName,
        deptId,
        envelope.eventId,
        reminder,
        Date.now(),
      );
      emitOutcomeMetric(
        METRIC_NAMESPACE,
        outcome === 'Duplicate'
          ? 'ApparatusDefectDuplicateSkipped'
          : 'ApparatusDefectPendingRecorded',
      );
    } catch (error) {
      logError(`${LOG_PREFIX}.write_failed`, error, envelope.eventId, {
        defectId: reminder.item.subjectId,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'ApparatusDefectPendingFailed');
      throw error;
    }
  }
};
