export const NO_TOKEN_REGISTERED_REASON = 'push: no token registered';

export interface ContactChannelSnapshot {
  readonly channel: string;
  readonly platform?: string;
  readonly token?: string;
  readonly phoneNumber?: string;
  readonly valid?: boolean;
}

export type ContactChannelKey = 'PUSH' | 'SMS' | 'VOICE';

/**
 * The one contact lookup shared by the producers (fan-out, tone evaluator, mutual-aid port),
 * which decide what to publish, and the channel worker (channels/channelEnvelope.ts), which
 * resolves where to send. Two lookups drifted apart before: when the producer is stricter it
 * never publishes and nothing errors - the silent direction of the SMS-never-sends defect
 * (#12). Case-insensitive, and a malformed entry (no channel string) is ignored rather than
 * thrown on, which would fail the member's whole evaluation on every retry.
 */
export function findContactEntry<
  T extends { readonly channel?: unknown; readonly valid?: boolean },
>(contactChannels: readonly T[] | undefined, key: ContactChannelKey): T | undefined {
  return (contactChannels ?? []).find(
    (candidate) =>
      typeof candidate?.channel === 'string' &&
      candidate.channel.toUpperCase() === key &&
      candidate.valid !== false,
  );
}

/** A phone entry's number: `phoneNumber`, or `token` as maintainMemberSnapshot writes it. */
export function contactPhone(
  entry: { readonly phoneNumber?: string; readonly token?: string } | undefined,
): string | undefined {
  return entry?.phoneNumber ?? entry?.token;
}

export type ResolvePushTargetResult =
  | { readonly skipped: true; readonly reason: string }
  | { readonly skipped: false; readonly token: string; readonly platform?: string };

/** A PUSH entry's token - `platform` is informational; the worker never needed it to send. */
export function resolvePushTarget(
  contactChannels: readonly ContactChannelSnapshot[] | undefined,
): ResolvePushTargetResult {
  const entry = findContactEntry(contactChannels, 'PUSH');
  if (!entry?.token) {
    return { skipped: true, reason: NO_TOKEN_REGISTERED_REASON };
  }
  return {
    skipped: false,
    token: entry.token,
    ...(entry.platform ? { platform: entry.platform } : {}),
  };
}

export const NO_SMS_NUMBER_REASON = 'sms: no number registered';

export type ResolveSmsTargetResult =
  | { readonly skipped: true; readonly reason: string }
  | { readonly skipped: false; readonly number: string };

export function resolveSmsTarget(
  contactChannels: readonly ContactChannelSnapshot[] | undefined,
): ResolveSmsTargetResult {
  const number = contactPhone(findContactEntry(contactChannels, 'SMS'));
  if (!number) {
    return { skipped: true, reason: NO_SMS_NUMBER_REASON };
  }
  return { skipped: false, number };
}
