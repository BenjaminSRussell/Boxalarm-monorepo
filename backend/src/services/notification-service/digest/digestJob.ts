import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { sendEmailDigest, sendPushDigest } from '../channelSender.js';
import { createDynamoClient, readNotificationConfig } from '../dynamoClient.js';
import {
  categoryConfig,
  certExpiryItem,
  CERT_EXPIRY_CATEGORY,
  deliveryCategory,
  type ReminderItem,
} from '../reminders/categories.js';
import {
  loadRoster,
  membersWithRoles,
  readChannelMutes,
  readMemberEmail,
  type RosterMember,
} from '../reminders/recipients.js';
import {
  asTransactionCancellation,
  buildDigestSentMarker,
  buildNotificationItem,
  isConditionalCheckFailed,
  TODAY_BUCKET,
  type PendingRecipientType,
} from '../repository.js';

const METRIC_NAMESPACE = 'Boxalarm/NotificationDigest';

export interface DigestJobPayload {
  readonly deptId: string;
}

interface RawPendingItem {
  readonly recipientType: PendingRecipientType;
  readonly recipientId: string;
  readonly category?: string;
  readonly item?: ReminderItem;
  // Rows recorded before categories existed carry only the cert fields.
  readonly certId?: string;
  readonly expiryDate?: string;
}

interface PendingReminder {
  readonly recipientType: PendingRecipientType;
  readonly recipientId: string;
  /** The category the row was recorded under (its routing). */
  readonly category: string;
  readonly item: ReminderItem;
}

/** One member's digest for one category: what claim, mutes, text and inbox record key on. */
interface Delivery {
  readonly memberId: string;
  readonly category: string;
  email?: string | undefined;
  readonly items: Map<string, ReminderItem>;
}

function isDigestJobPayload(value: unknown): value is DigestJobPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).deptId === 'string'
  );
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

function normalize(row: RawPendingItem): PendingReminder | undefined {
  const category = row.category ?? CERT_EXPIRY_CATEGORY;
  const item =
    row.item ??
    (row.certId && row.expiryDate ? certExpiryItem(row.certId, row.expiryDate) : undefined);
  if (!item) {
    return undefined;
  }
  return { recipientType: row.recipientType, recipientId: row.recipientId, category, item };
}

async function queryPendingItems(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  today: string,
): Promise<RawPendingItem[]> {
  const items: RawPendingItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: {
          ':gsi3pk': buildDeptScopedPk(deptId, 'DIGEST_PENDING', today),
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as RawPendingItem[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

/**
 * Fans the day's rows out to per-member, per-category deliveries. A ROLE row becomes one
 * delivery entry per member holding the role; a member reached twice for the same subject
 * (named on the event and holding the role, or holding two routed roles) gets it once.
 * The roster is read at most once per run; when it cannot be read, every ROLE row is
 * logged and counted as a failed recipient and the MEMBER rows still go out.
 */
async function planDeliveries(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  pending: readonly PendingReminder[],
  correlationId: string,
): Promise<Delivery[]> {
  const deliveries = new Map<string, Delivery>();
  const add = (memberId: string, category: string, item: ReminderItem, email?: string) => {
    const key = `${memberId}#${category}`;
    let delivery = deliveries.get(key);
    if (!delivery) {
      delivery = { memberId, category, email, items: new Map() };
      deliveries.set(key, delivery);
    }
    delivery.email ??= email;
    if (!delivery.items.has(item.subjectId)) {
      delivery.items.set(item.subjectId, item);
    }
  };

  let roster: RosterMember[] | undefined;
  let rosterFailed = false;
  for (const row of pending) {
    if (row.recipientType === 'MEMBER') {
      add(row.recipientId, deliveryCategory(row.category, 'MEMBER'), row.item);
      continue;
    }
    if (!roster && !rosterFailed) {
      try {
        roster = await loadRoster(ddb, tableName, deptId);
      } catch (error) {
        rosterFailed = true;
        logError('notification.digest.roster_query_failed', error, correlationId);
      }
    }
    if (!roster) {
      logError(
        'notification.digest.recipient_failed',
        new Error('roster unavailable'),
        correlationId,
        {
          recipientType: 'ROLE',
          role: row.recipientId,
          category: row.category,
        },
      );
      emitOutcomeMetric(METRIC_NAMESPACE, 'DigestRecipientFailed');
      continue;
    }
    const category = deliveryCategory(row.category, 'ROLE');
    for (const member of membersWithRoles(roster, [row.recipientId])) {
      add(member.memberId, category, row.item, member.email);
    }
  }
  return [...deliveries.values()];
}

async function claimDigestSlot(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  recipientId: string,
  category: string,
  today: string,
  now: number,
  correlationId: string,
): Promise<'Claimed' | 'AlreadyClaimed'> {
  const marker = buildDigestSentMarker(deptId, 'MEMBER', recipientId, category, today, now);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: marker,
              ConditionExpression: 'attribute_not_exists(sk)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return 'AlreadyClaimed';
    }
    const cancellation = asTransactionCancellation(error);
    logError('notification.digest.claim_failed', error, correlationId, {
      memberId: recipientId,
      ...(cancellation
        ? { cancellationReasons: cancellation.CancellationReasons?.map((r) => r.Code) }
        : {}),
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestFailed');
    throw error;
  }
  return 'Claimed';
}

async function releaseDigestSlot(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  recipientId: string,
  category: string,
  today: string,
  correlationId: string,
): Promise<void> {
  const marker = buildDigestSentMarker(deptId, 'MEMBER', recipientId, category, today, 0);
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', recipientId), sk: marker.sk },
      }),
    );
  } catch (error) {
    logError('notification.digest.release_failed', error, correlationId, {
      memberId: recipientId,
    });
  }
}

async function writeNotification(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  recipientId: string,
  category: string,
  items: readonly ReminderItem[],
  now: number,
): Promise<void> {
  const notification = buildNotificationItem(
    deptId,
    recipientId,
    randomUUID(),
    category,
    items,
    now,
  );
  await ddb.send(new PutCommand({ TableName: tableName, Item: notification }));
}

async function sendDigest(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  delivery: Delivery,
  today: string,
  now: number,
  correlationId: string,
): Promise<void> {
  const { memberId, category } = delivery;
  const items = [...delivery.items.values()];
  const claim = await claimDigestSlot(
    ddb,
    tableName,
    deptId,
    memberId,
    category,
    today,
    now,
    correlationId,
  );
  if (claim === 'AlreadyClaimed') {
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestSkipped');
    return;
  }

  let email = delivery.email;
  let mutes: { push: boolean; email: boolean };
  try {
    const [storedEmail, storedMutes] = await Promise.all([
      email ? Promise.resolve(email) : readMemberEmail(ddb, tableName, deptId, memberId),
      readChannelMutes(ddb, tableName, deptId, memberId, categoryConfig(category).muteKey),
    ]);
    email = storedEmail;
    mutes = storedMutes;
  } catch (error) {
    logError('notification.digest.recipient_read_failed', error, correlationId, {
      memberId,
      category,
    });
    await releaseDigestSlot(ddb, tableName, deptId, memberId, category, today, correlationId);
    throw error;
  }

  try {
    if (!mutes.push) {
      await sendPushDigest(
        process.env,
        { memberId, email },
        items,
        correlationId,
        undefined,
        category,
      );
    }
    if (!mutes.email) {
      await sendEmailDigest(
        process.env,
        { memberId, email },
        items,
        correlationId,
        undefined,
        category,
      );
    }
  } catch (error) {
    logError('notification.digest.send_failed', error, correlationId, { memberId, category });
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestSendFailed');
    await releaseDigestSlot(ddb, tableName, deptId, memberId, category, today, correlationId);
    throw error;
  }

  try {
    await writeNotification(ddb, tableName, deptId, memberId, category, items, now);
  } catch (error) {
    logError('notification.digest.write_failed', error, correlationId, { memberId, category });
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestFailed');
    await releaseDigestSlot(ddb, tableName, deptId, memberId, category, today, correlationId);
    throw error;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, mutes.push || mutes.email ? 'DigestMuted' : 'DigestSent');
}

export const handler = async (payload: unknown): Promise<{ processed: number }> => {
  if (!isDigestJobPayload(payload)) {
    const error = new Error('digest job payload failed shape validation');
    logError('notification.digest.malformed_payload', error, 'unknown');
    throw error;
  }

  const deptId = toVerifiedDeptId({ deptId: payload.deptId });
  const { tableName } = readNotificationConfig(process.env);
  const ddb = createDynamoClient(process.env);
  const now = Date.now();
  const today = TODAY_BUCKET(new Date(now));
  const correlationId = `${deptId}#${today}#digest`;

  let pendingItems: RawPendingItem[];
  try {
    pendingItems = await queryPendingItems(ddb, tableName, deptId, today);
  } catch (error) {
    logError('notification.digest.query_failed', error, correlationId);
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestFailed');
    throw error;
  }

  if (pendingItems.length === 0) {
    return { processed: 0 };
  }

  const pending = pendingItems
    .map(normalize)
    .filter((row): row is PendingReminder => row !== undefined);
  const deliveries = await planDeliveries(ddb, tableName, deptId, pending, correlationId);

  let processed = 0;
  for (const delivery of deliveries) {
    try {
      await sendDigest(ddb, tableName, deptId, delivery, today, now, correlationId);
      processed += 1;
    } catch (error) {
      logError('notification.digest.recipient_failed', error, correlationId, {
        memberId: delivery.memberId,
        category: delivery.category,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'DigestRecipientFailed');
    }
  }

  return { processed };
};
