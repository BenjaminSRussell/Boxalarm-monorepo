import { createHash } from 'node:crypto';
import type { ApnsInterruptionLevel } from './pushCredentials.js';

/**
 * One push send, platform-neutral. `idempotencyKey` is the send guard's exactly-once key
 * (`{dispatchId}#{toneSequence}#{memberId}#PUSH`, or the MUTUALAID form for an officer prompt);
 * `collapseKey` is the per-tone notification identity (`{dispatchId}#{toneSequence}`,
 * architecture §5.1 B4) so a tone-2 re-page is never coalesced into tone 1 on the device.
 */
export interface PushNotification {
  readonly token: string;
  readonly alertKind: 'dispatch' | 'mutual_aid_prompt';
  readonly dispatchId: string;
  readonly toneSequence?: number | undefined;
  readonly title: string;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly collapseKey: string;
}

/**
 * Every alerting-plane push is a dispatch-class alert. The mobile app routes anything but
 * `category: 'digest'` to its critical `dispatch-critical` channel (ui/apps/mobile
 * pushChannel.ts); the officer mutual-aid prompt is critical too — the architecture reserves
 * the non-critical channel for the LOB-plane notification service, never for this worker.
 */
export const PUSH_CATEGORY = 'dispatch';

/** Bundled critical-alert sound; `default` is the system sound. */
export const APNS_CRITICAL_SOUND_NAME = 'default';

const APNS_COLLAPSE_ID_MAX_BYTES = 64;

/** APNs caps apns-collapse-id at 64 bytes; hash a longer one rather than truncate it. */
export function apnsCollapseId(collapseKey: string): string {
  return Buffer.byteLength(collapseKey) <= APNS_COLLAPSE_ID_MAX_BYTES
    ? collapseKey
    : createHash('sha256').update(collapseKey).digest('hex');
}

/**
 * apns-id must be a UUID. Derived from the exactly-once key (name-based, RFC 9562 v8 layout
 * over SHA-256) so a redelivered send of the same page carries the same id — APNs and device
 * logs then show one notification, re-attempted.
 */
export function apnsIdFor(idempotencyKey: string): string {
  const bytes = createHash('sha256').update(idempotencyKey).digest().subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function routingFields(notification: PushNotification): Record<string, string> {
  return {
    category: PUSH_CATEGORY,
    alertKind: notification.alertKind,
    dispatchId: notification.dispatchId,
    ...(notification.toneSequence !== undefined
      ? { toneSequence: String(notification.toneSequence) }
      : {}),
  };
}

/**
 * Custom keys the app reads (pushRouting.ts / pushNotificationDisplay.ts): `category`,
 * `dispatchId`, `title`, `body`. FCM data values must be strings.
 */
export function pushDataFields(notification: PushNotification): Record<string, string> {
  return { ...routingFields(notification), title: notification.title, body: notification.body };
}

/**
 * `critical` needs Apple's Critical Alerts entitlement (issue #4). Until it is granted, the
 * operator sets the APNs secret's `interruptionLevel` to `time-sensitive`: the alert still
 * breaks through Focus (Time Sensitive Notifications capability, self-serve), plays the
 * default sound, but does not override the ring/silent switch. An app without the
 * entitlement that is sent a critical payload gets it without the critical treatment, so
 * `critical` stays the default and the switch is a downgrade the operator chooses.
 */
export function buildApnsPayload(
  notification: PushNotification,
  interruptionLevel: ApnsInterruptionLevel,
): Record<string, unknown> {
  return {
    aps: {
      alert: { title: notification.title, body: notification.body },
      sound:
        interruptionLevel === 'critical'
          ? { critical: 1, name: APNS_CRITICAL_SOUND_NAME, volume: 1 }
          : APNS_CRITICAL_SOUND_NAME,
      'interruption-level': interruptionLevel,
      // Lets the Notification Service Extension (architecture §5.1) enrich the alert.
      'mutable-content': 1,
    },
    ...routingFields(notification),
  };
}
