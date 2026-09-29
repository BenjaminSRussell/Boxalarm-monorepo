import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readNotificationConfig } from '../dynamoClient.js';
import { categoryConfig, deliveryCategory, type ReminderItem } from '../reminders/categories.js';
import {
  asTransactionCancellation,
  buildEventSeenMarker,
  buildReminderPendingItem,
  DIGEST_BUCKET,
  isConditionalCheckFailed,
} from '../repository.js';
import { logError } from '../log.js';

export { logError };

export const METRIC_NAMESPACE = 'Boxalarm/NotificationDigest';

/** The standard Boxalarm event envelope, as it arrives under the EventBridge `detail`. */
export interface EventEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventTime?: string;
  readonly correlationId?: string;
  readonly payload: Record<string, unknown>;
}

export class MalformedEventError extends Error {
  constructor(label: string) {
    super(`${label} event failed shape validation`);
    this.name = 'MalformedEventError';
  }
}

/**
 * The SQS body is the EventBridge event (rule target, no input transformer): the standard
 * Boxalarm envelope lives under `detail`, never at the top level.
 */
export function parseEnvelope(
  body: string,
  acceptedEventTypes: ReadonlySet<string>,
  label: string,
): EventEnvelope {
  let parsed: { detail?: unknown };
  try {
    parsed = JSON.parse(body) as { detail?: unknown };
  } catch {
    throw new MalformedEventError(label);
  }
  const raw = parsed.detail as Record<string, unknown> | undefined;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof raw.eventType !== 'string' ||
    !acceptedEventTypes.has(raw.eventType) ||
    typeof raw.eventId !== 'string' ||
    raw.eventId.length === 0 ||
    typeof raw.payload !== 'object' ||
    raw.payload === null
  ) {
    throw new MalformedEventError(label);
  }
  return {
    eventId: raw.eventId,
    eventType: raw.eventType,
    ...(typeof raw.eventTime === 'string' ? { eventTime: raw.eventTime } : {}),
    ...(typeof raw.correlationId === 'string' ? { correlationId: raw.correlationId } : {}),
    payload: raw.payload as Record<string, unknown>,
  };
}

export function requireString(
  payload: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new MalformedEventError(label);
  }
  return value;
}

export function optionalString(
  payload: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** What one event becomes: a reminder for its category's roles, and optionally a member. */
export interface ReminderRecord {
  readonly deptId: string;
  readonly category: string;
  readonly item: ReminderItem;
  /** The member the reminder is about (cert holder, PPE holder), who gets their own copy. */
  readonly memberId?: string;
  /** The roles' copy, when it should read differently from the member's own. */
  readonly roleItem?: ReminderItem;
}

export type RecordOutcome = 'Recorded' | 'Duplicate';

/**
 * One TransactWrite: a DIGEST_PENDING row for the named member (if any), one per role the
 * category routes to, and the eventId marker — all conditional on not existing, so a
 * redelivered event (same eventId, or same subject already pending for that digest day)
 * writes nothing. IAM authorizes each item as its own PutItem.
 */
export async function recordReminder(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  eventId: string,
  record: ReminderRecord,
  now: number,
): Promise<RecordOutcome> {
  const day = DIGEST_BUCKET(new Date(now));
  const config = categoryConfig(record.category);
  const rows = [
    ...(record.memberId
      ? [
          buildReminderPendingItem(
            deptId,
            'MEMBER',
            record.memberId,
            deliveryCategory(record.category, 'MEMBER'),
            record.item,
            day,
            now,
          ),
        ]
      : []),
    ...config.roles.map((role) =>
      buildReminderPendingItem(
        deptId,
        'ROLE',
        role,
        record.category,
        record.roleItem ?? record.item,
        day,
        now,
        record.memberId,
      ),
    ),
    buildEventSeenMarker(deptId, eventId, now),
  ];

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: rows.map((Item) => ({
          Put: { TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(sk)' },
        })),
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return 'Duplicate';
    }
    throw error;
  }
  return 'Recorded';
}

export interface ReminderConsumerSpec {
  /** The event name used in error messages, e.g. `apparatus.test.due`. */
  readonly label: string;
  readonly acceptedEventTypes: ReadonlySet<string>;
  /** Structured-log event prefix, e.g. `notification.apparatusTestDue`. */
  readonly logPrefix: string;
  /** Metric name prefix, e.g. `ApparatusTestDue` -> ApparatusTestDuePendingRecorded. */
  readonly metricPrefix: string;
  /** Throws MalformedEventError when the payload lacks what the reminder needs. */
  readonly toReminder: (envelope: EventEnvelope) => ReminderRecord;
}

/**
 * An SQS handler that records each record's reminder for the daily digest. It throws on the
 * first malformed or failed record, so SQS redelivers the batch (every write is idempotent)
 * and a poison message ends in the queue's DLQ rather than being dropped.
 */
export function createReminderConsumer(
  spec: ReminderConsumerSpec,
): (event: SQSEvent) => Promise<void> {
  return async (event) => {
    const { tableName } = readNotificationConfig(process.env);
    const ddb = createDynamoClient(process.env);

    for (const record of event.Records) {
      let envelope: EventEnvelope;
      let reminder: ReminderRecord;
      try {
        envelope = parseEnvelope(record.body, spec.acceptedEventTypes, spec.label);
        reminder = spec.toReminder(envelope);
      } catch (error) {
        logError(`${spec.logPrefix}.malformed_event`, error, record.messageId);
        throw error;
      }

      const deptId = toVerifiedDeptId({ deptId: reminder.deptId });
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
            ? `${spec.metricPrefix}DuplicateSkipped`
            : `${spec.metricPrefix}PendingRecorded`,
        );
      } catch (error) {
        const cancellation = asTransactionCancellation(error);
        logError(`${spec.logPrefix}.write_failed`, error, envelope.eventId, {
          subjectId: reminder.item.subjectId,
          ...(cancellation
            ? { cancellationReasons: cancellation.CancellationReasons?.map((r) => r.Code) }
            : {}),
        });
        emitOutcomeMetric(METRIC_NAMESPACE, `${spec.metricPrefix}PendingFailed`);
        throw error;
      }
    }
  };
}
