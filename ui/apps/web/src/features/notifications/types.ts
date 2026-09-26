/** One certification (or other due item) folded into a digest notification. */
export interface NotificationDigestItem {
  certId: string;
  expiryDate: string;
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
