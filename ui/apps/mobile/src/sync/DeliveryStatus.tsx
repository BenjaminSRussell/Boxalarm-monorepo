import { spacing, typeScale, type StatusRole } from '@boxalarm/design-tokens';
import { AccessibilityInfo, Text, View } from 'react-native';
import { Button, StatusChip, useTheme } from '../components/ui';
import * as syncManager from './syncManager';
import type { OutboxItemState } from './useOutboxItem';

interface Copy {
  readonly role: StatusRole;
  readonly chip: string;
  readonly detail: string;
}

// Says exactly where the record is - never "sent" while it is still only on this phone.
function describe(state: OutboxItemState, isOnline: boolean): Copy {
  switch (state) {
    case 'QUEUED':
      return isOnline
        ? { role: 'info', chip: 'Sending', detail: 'Saved on this phone. Sending now.' }
        : {
            role: 'warning',
            chip: 'Waiting for signal',
            detail: 'Saved on this phone. It sends automatically when you have signal.',
          };
    case 'SYNCING':
      return { role: 'info', chip: 'Sending', detail: 'Saved on this phone. Sending now.' };
    case 'FAILED':
      return {
        role: 'caution',
        chip: 'Not sent yet',
        detail: 'Saved on this phone. Sending failed and will be retried automatically.',
      };
    case 'REJECTED':
      return {
        role: 'danger',
        chip: 'Refused by server',
        detail: 'The server refused this record. Fix the problem and retry, or discard it.',
      };
    case 'SYNCED':
      return { role: 'ok', chip: 'Sent', detail: 'Received by Boxalarm.' };
    case 'DISCARDED':
      return { role: 'neutral', chip: 'Discarded', detail: 'This record was discarded.' };
    case 'NOT_QUEUED':
      return { role: 'neutral', chip: 'Not saved', detail: '' };
  }
}

export function deliveryAnnouncement(state: OutboxItemState, isOnline: boolean): string {
  const { chip, detail } = describe(state, isOnline);
  return `${chip}. ${detail}`;
}

interface DeliveryStatusProps {
  readonly itemId: string;
  readonly label: string;
  readonly state: OutboxItemState;
  readonly lastError: string | null;
  readonly isOnline: boolean;
}

/** Delivery state of one queued record with its recovery actions. Retry and Discard are
 * glove-sized (targetSize.field) and name the record, so a screen reader says what they act on. */
export function DeliveryStatus({ itemId, label, state, lastError, isOnline }: DeliveryStatusProps) {
  const theme = useTheme();
  const copy = describe(state, isOnline);
  const canRetry = state === 'FAILED' || state === 'REJECTED';

  return (
    <View style={{ gap: spacing.sm }} accessibilityLiveRegion="polite">
      <StatusChip status={copy.role} label={copy.chip} />
      {copy.detail ? (
        <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>{copy.detail}</Text>
      ) : null}
      {canRetry && lastError ? (
        <Text style={{ color: theme.status[copy.role], fontSize: typeScale.body.size }}>
          {lastError}
        </Text>
      ) : null}
      {canRetry ? (
        <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
          <Button
            label="Retry now"
            accessibilityLabel={`Retry ${label}`}
            onPress={() => {
              AccessibilityInfo.announceForAccessibility(`Retrying ${label}`);
              void syncManager.retry(itemId);
            }}
          />
          {state === 'REJECTED' ? (
            <Button
              label="Discard"
              variant="secondary"
              accessibilityLabel={`Discard ${label}`}
              onPress={() => {
                AccessibilityInfo.announceForAccessibility(`Discarded ${label}`);
                void syncManager.discard(itemId);
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
