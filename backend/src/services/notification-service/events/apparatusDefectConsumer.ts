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

type ImmediateOutcome = 'Delivered' | 'AlreadyDelivered' | 'Failed';

/**
 * One officer's copy of an out-of-service defect: the inbox record first (conditional, and
 * keyed on the eventId and event time so a redelivery finds it), then a non-critical push
 * unless they muted apparatus-defect push. A failed push removes the inbox record again so
 * the redelivery retries both — the same claim/release shape as the digest.
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
    if (isConditionalPutFailed(error)) {
      return 'AlreadyDelivered';
    }
    logError(`${LOG_PREFIX}.inbox_write_failed`, error, envelope.eventId, { memberId });
    return 'Failed';
  }

  try {
    const mutes = await readChannelMutes(
      ddb,
      tableName,
      deptId,
      memberId,
      categoryConfig(APPARATUS_DEFECT_CATEGORY).muteKey,
    );
    if (!mutes.push) {
      await sendPushDigest(
        process.env,
        { memberId, email },
        [item],
        envelope.correlationId ?? envelope.eventId,
        undefined,
        APPARATUS_DEFECT_CATEGORY,
      );
    }
  } catch (error) {
    logError(`${LOG_PREFIX}.push_failed`, error, envelope.eventId, { memberId });
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: notification.sk },
        }),
      );
    } catch (releaseError) {
      logError(`${LOG_PREFIX}.release_failed`, releaseError, envelope.eventId, { memberId });
    }
    return 'Failed';
  }
  return 'Delivered';
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
