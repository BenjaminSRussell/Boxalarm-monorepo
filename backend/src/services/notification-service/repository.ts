import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  categoryConfig,
  certExpiryItem,
  CERT_EXPIRY_CATEGORY,
  TRAINING_OFFICER_DIGEST_CATEGORY,
  type DigestNotificationItem,
  type ReminderItem,
} from './reminders/categories.js';

export { CERT_EXPIRY_CATEGORY, TRAINING_OFFICER_DIGEST_CATEGORY, type DigestNotificationItem };
export const TRAINING_OFFICER_ROLE = 'TRAINING';

const NOTIFICATION_TTL_SECONDS = 180 * 24 * 60 * 60;
const DIGEST_PENDING_TTL_SECONDS = 3 * 24 * 60 * 60;
const EVENT_SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export function TODAY_BUCKET(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Minutes past 00:00 UTC after which a newly recorded reminder waits for the NEXT day's
 * digest. The digest runs at 12:00 UTC (infrastructure/components/notification/digest.ts
 * DIGEST_SCHEDULE_EXPRESSION) and reads only its own day's bucket, so a row bucketed under
 * today after that run would never be sent. The 5-minute margin covers a write racing the
 * run's query.
 */
export const DIGEST_CUTOFF_MINUTES_UTC = 11 * 60 + 55;

/** The day bucket of the digest run that will deliver a reminder recorded at `now`. */
export function DIGEST_BUCKET(now: Date): string {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (minutes < DIGEST_CUTOFF_MINUTES_UTC) {
    return TODAY_BUCKET(now);
  }
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return TODAY_BUCKET(tomorrow);
}

export interface NotificationChannelMutes {
  readonly push: boolean;
  readonly email: boolean;
}

export interface NotificationPreference {
  readonly memberId: string;
  readonly category: string;
  readonly channels: NotificationChannelMutes;
  readonly updatedAt: number;
}

export interface PreferenceItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'NOTIFICATION_PREFERENCE';
  readonly memberId: string;
  readonly category: string;
  readonly channels: NotificationChannelMutes;
  readonly updatedAt: number;
}

export function buildPreferenceItem(
  deptId: VerifiedDeptId,
  memberId: string,
  category: string,
  channels: NotificationChannelMutes,
  updatedAt: number,
): PreferenceItem {
  return {
    pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
    sk: `NOTIFPREF#${memberId}#${category}`,
    entityType: 'NOTIFICATION_PREFERENCE',
    memberId,
    category,
    channels,
    updatedAt,
  };
}

export function parsePreferenceItem(
  item: Record<string, unknown> | undefined,
): NotificationPreference | undefined {
  if (!item) {
    return undefined;
  }
  const channels = item.channels as NotificationChannelMutes | undefined;
  return {
    memberId: item.memberId as string,
    category: item.category as string,
    channels: { push: channels?.push === true, email: channels?.email === true },
    updatedAt: item.updatedAt as number,
  };
}

export interface NotificationItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'NOTIFICATION';
  readonly notificationId: string;
  readonly memberId: string;
  readonly category: string;
  readonly items: readonly DigestNotificationItem[];
  readonly summary: string;
  readonly createdAt: number;
  readonly readAt: number | null;
  readonly ttl: number;
  readonly gsi1pk: string;
  readonly gsi1sk: string;
}

export function buildNotificationItem(
  deptId: VerifiedDeptId,
  memberId: string,
  notificationId: string,
  category: string,
  items: readonly DigestNotificationItem[],
  createdAt: number,
): NotificationItem {
  return {
    pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
    sk: `NOTIF#${memberId}#${createdAt}#${notificationId}`,
    entityType: 'NOTIFICATION',
    notificationId,
    memberId,
    category,
    items,
    summary: categoryConfig(category).summary(items.length),
    createdAt,
    readAt: null,
    ttl: Math.floor(createdAt / 1000) + NOTIFICATION_TTL_SECONDS,
    gsi1pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
    gsi1sk: `NOTIFICATION#${notificationId}`,
  };
}

export type PendingRecipientType = 'MEMBER' | 'ROLE';

export interface PendingItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'DIGEST_PENDING';
  readonly recipientType: PendingRecipientType;
  readonly recipientId: string;
  readonly category: string;
  readonly subjectId: string;
  readonly dueDate?: string;
  readonly item: ReminderItem;
  /** cert-expiry rows keep the pre-category top-level fields. */
  readonly certId?: string;
  readonly expiryDate?: string;
  readonly gsi3pk: string;
  readonly gsi3sk: string;
  readonly ttl: number;
}

/**
 * One reminder waiting for `today`'s digest, for a member or for everyone holding a role.
 * The sk is unique per category, day and subject, so a redelivered event is a conditional
 * no-op; `uniqueSuffix` further separates ROLE rows that share a subject.
 */
export function buildReminderPendingItem(
  deptId: VerifiedDeptId,
  recipientType: PendingRecipientType,
  recipientId: string,
  category: string,
  item: ReminderItem,
  today: string,
  now: number,
  uniqueSuffix?: string,
): PendingItem {
  const skSuffix = uniqueSuffix ? `${item.subjectId}#${uniqueSuffix}` : item.subjectId;
  return {
    pk: buildDeptScopedPk(deptId, recipientType, recipientId),
    sk: `DIGEST_PENDING#${category}#${today}#${skSuffix}`,
    entityType: 'DIGEST_PENDING',
    recipientType,
    recipientId,
    category,
    subjectId: item.subjectId,
    ...(item.dueDate ? { dueDate: item.dueDate } : {}),
    item,
    ...(item.certId && item.expiryDate ? { certId: item.certId, expiryDate: item.expiryDate } : {}),
    gsi3pk: buildDeptScopedPk(deptId, 'DIGEST_PENDING', today),
    gsi3sk: `${recipientType}#${recipientId}#${skSuffix}`,
    ttl: Math.floor(now / 1000) + DIGEST_PENDING_TTL_SECONDS,
  };
}

/** cert-expiry's pending row: a certificate is the subject and its expiry the due date. */
export function buildPendingItem(
  deptId: VerifiedDeptId,
  recipientType: PendingRecipientType,
  recipientId: string,
  category: string,
  certId: string,
  expiryDate: string,
  today: string,
  now: number,
  uniqueSuffix?: string,
): PendingItem {
  return buildReminderPendingItem(
    deptId,
    recipientType,
    recipientId,
    category,
    certExpiryItem(certId, expiryDate),
    today,
    now,
    uniqueSuffix,
  );
}

export interface EventSeenMarker {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'NOTIFICATION_EVENT_SEEN';
  readonly eventId: string;
  readonly ttl: number;
}

/**
 * Written in the same transaction as an event's pending rows, conditional on not existing:
 * a redelivery of the same eventId — even one landing in a later day's bucket — is a no-op.
 */
export function buildEventSeenMarker(
  deptId: VerifiedDeptId,
  eventId: string,
  now: number,
): EventSeenMarker {
  return {
    pk: buildDeptScopedPk(deptId, 'NOTIF_EVENT', eventId),
    sk: 'SEEN',
    entityType: 'NOTIFICATION_EVENT_SEEN',
    eventId,
    ttl: Math.floor(now / 1000) + EVENT_SEEN_TTL_SECONDS,
  };
}

export interface DigestSentMarker {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'DIGEST_SENT';
  readonly ttl: number;
}

export function buildDigestSentMarker(
  deptId: VerifiedDeptId,
  recipientType: PendingRecipientType,
  recipientId: string,
  category: string,
  today: string,
  now: number,
): DigestSentMarker {
  return {
    pk: buildDeptScopedPk(deptId, recipientType, recipientId),
    sk: `DIGESTSENT#${category}#${today}`,
    entityType: 'DIGEST_SENT',
    ttl: Math.floor(now / 1000) + DIGEST_PENDING_TTL_SECONDS,
  };
}

export interface TransactCancellationError {
  readonly name: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
}

export function asTransactionCancellation(error: unknown): TransactCancellationError | undefined {
  return error instanceof Error && error.name === 'TransactionCanceledException'
    ? error
    : undefined;
}

export function isConditionalCheckFailed(error: unknown): boolean {
  const cancellation = asTransactionCancellation(error);
  return (cancellation?.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed');
}

/** A single (non-transactional) conditional write that found its item already there. */
export function isConditionalPutFailed(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}
