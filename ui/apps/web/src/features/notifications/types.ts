/** Where an item links: the apparatus detail (keyed by unitId) or list, a member, consumables. */
export interface NotificationItemLink {
  kind: 'apparatus' | 'member' | 'consumables';
  id?: string;
}

/**
 * One due thing folded into a notification (notification-service reminders/categories.ts
 * ReminderItem). Items written before reminder categories existed carry only certId and
 * expiryDate; cert-expiry items still carry both alongside the generic fields.
 */
export interface NotificationDigestItem {
  subjectId?: string;
  title?: string;
  detail?: string;
  dueDate?: string;
  link?: NotificationItemLink;
  certId?: string;
  expiryDate?: string;
}

/** GET /api/v1/notifications item — notification-service inbox/handler.ts toInboxEntry. */
export interface InboxNotification {
  notificationId: string;
  category: string;
  summary: string;
  items: NotificationDigestItem[];
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds, or null while unread. */
  readAt: number | null;
}

export interface InboxPage {
  items: InboxNotification[];
  /** Opaque; pass back as ?cursor= for the next (older) page. Null on the last page. */
  nextCursor: string | null;
}

/**
 * Per-channel MUTE flags, exactly as notification-service stores them: `true` means that
 * channel is muted for the category (digestJob.ts: pushMuted = channels.push === true). No
 * stored preference means nothing is muted.
 */
export interface NotificationChannelMutes {
  push: boolean;
  email: boolean;
}

export interface NotificationPreference {
  category: string;
  channels: NotificationChannelMutes;
}
