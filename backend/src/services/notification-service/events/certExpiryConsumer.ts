import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readNotificationConfig } from '../dynamoClient.js';
import {
  asTransactionCancellation,
  buildPendingItem,
  CERT_EXPIRY_CATEGORY,
  isConditionalCheckFailed,
  TODAY_BUCKET,
  TRAINING_OFFICER_ROLE,
} from '../repository.js';

const METRIC_NAMESPACE = 'Boxalarm/NotificationDigest';

interface CertExpiryDueEnvelope {
  readonly eventId: string;
  readonly deptId: string;
  readonly memberId: string;
  readonly certId: string;
  readonly expiryDate: string;
}

const ACCEPTED_EVENT_TYPES: ReadonlySet<unknown> = new Set([
  'cert.expiry.due',
  // architecture.md N-5's canonical rename; training-service still emits cert.expiry.due.
  'training.expiry.due',
]);

// The SQS body is the EventBridge event (rule target, no input transformer): the
// standard Boxalarm envelope lives under `detail`, never at the top level.
function parseEnvelope(body: string): CertExpiryDueEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  const raw = parsed.detail as Record<string, unknown> | undefined;
  if (typeof raw !== 'object' || raw === null || !ACCEPTED_EVENT_TYPES.has(raw.eventType)) {
    throw new Error('cert.expiry.due event failed shape validation');
  }
  const eventId = raw.eventId;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const deptId = payload?.deptId;
  const memberId = payload?.memberId;
  const certId = payload?.certId;
  const expiryDate = payload?.expiryDate;
  if (
    typeof eventId !== 'string' ||
    typeof deptId !== 'string' ||
    typeof memberId !== 'string' ||
    typeof certId !== 'string' ||
    typeof expiryDate !== 'string'
  ) {
    throw new Error('cert.expiry.due event failed shape validation');
  }
  return { eventId, deptId, memberId, certId, expiryDate };
}

function logError(
  event: string,
  error: unknown,
  correlationId: string,
  extra: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'notification-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
      ...extra,
    }),
  );
}

export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readNotificationConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: CertExpiryDueEnvelope;
    try {
      envelope = parseEnvelope(record.body);
    } catch (error) {
      logError('notification.certExpiry.malformed_event', error, record.messageId);
      throw error;
    }

    const { eventId, memberId, certId, expiryDate } = envelope;
    const deptId = toVerifiedDeptId({ deptId: envelope.deptId });
    const now = Date.now();
    const today = TODAY_BUCKET(new Date(now));

    const memberPending = buildPendingItem(
      deptId,
      'MEMBER',
      memberId,
      CERT_EXPIRY_CATEGORY,
      certId,
      expiryDate,
      today,
      now,
    );
    const rolePending = buildPendingItem(
      deptId,
      'ROLE',
      TRAINING_OFFICER_ROLE,
      CERT_EXPIRY_CATEGORY,
      certId,
      expiryDate,
      today,
      now,
      memberId,
    );

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: memberPending,
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: rolePending,
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        emitOutcomeMetric(METRIC_NAMESPACE, 'CertExpiryDuplicateSkipped');
        continue;
      }
      const cancellation = asTransactionCancellation(error);
      logError('notification.certExpiry.write_failed', error, eventId, {
        memberId,
        certId,
        ...(cancellation
          ? { cancellationReasons: cancellation.CancellationReasons?.map((r) => r.Code) }
          : {}),
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'CertExpiryPendingFailed');
      throw error;
    }

    emitOutcomeMetric(METRIC_NAMESPACE, 'CertExpiryPendingRecorded');
  }
};
