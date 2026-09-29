/**
 * Typed reminder categories for the LOB digest pipeline (architecture.md §1.1 service 10).
 *
 * A consumer turns one domain event into a ReminderItem and records it as DIGEST_PENDING
 * rows for the recipients its category routes to; digestJob.ts batches the day's rows per
 * member per category into one push, one email and one inbox NOTIFICATION. Everything a
 * category varies on — recipient roles, the preference key that mutes it, and the text of
 * the push/email/inbox — lives in REMINDER_CATEGORIES, so the job itself is category-blind.
 *
 * Every category here is a non-critical, line-of-business channel. None of them is, or may
 * ever become, a dispatch alert: that path is the isolated alerting plane.
 */

export const CERT_EXPIRY_CATEGORY = 'cert-expiry';
export const TRAINING_OFFICER_DIGEST_CATEGORY = 'cert-expiry-officer';
export const APPARATUS_TEST_DUE_CATEGORY = 'apparatus-test-due';
export const APPARATUS_DEFECT_CATEGORY = 'apparatus-defect';
export const INVENTORY_REORDER_CATEGORY = 'inventory-reorder';
export const PPE_EXPIRY_CATEGORY = 'ppe-expiry';

/**
 * Department roles (personnel-service memberRepository.ts MEMBER_ROLES) a reminder routes to.
 *
 * Routing choices beyond architecture.md §5, decided here (recorded for the next architecture
 * revision rather than edited into it, which would stale the compiled artifacts):
 *  - apparatus-defect goes to APPARATUS and every OFFICER, not only "the apparatus officer
 *    role" (§5 :1552). A unit off the road changes who and what can respond, which is every
 *    line officer's business, and a volunteer department may have no APPARATUS holder at all.
 *  - apparatus-test-due goes to APPARATUS and the CHIEF, who answers for ISO/NFPA testing
 *    compliance.
 *  - inventory-reorder goes to APPARATUS (the quartermaster in practice) and ADMIN (§5's
 *    "quartermaster/admin").
 */
export type ReminderRole = 'OFFICER' | 'TRAINING' | 'APPARATUS' | 'ADMIN' | 'CHIEF';

/**
 * Where a client can take the reader for one item. The web and mobile apps map each kind to
 * their own route; `id` is the route's key (the apparatus page is keyed by display unitId).
 */
export interface ReminderLink {
  readonly kind: 'apparatus' | 'member' | 'consumables';
  readonly id?: string;
}

/** One thing that is due, as it is stored on a pending row and shown in the inbox. */
export interface ReminderItem {
  /** Stable per category: the pending row, and digest de-duplication, key on it. */
  readonly subjectId: string;
  readonly title: string;
  readonly detail?: string;
  /** ISO date the thing is due or expires, when it has one. */
  readonly dueDate?: string;
  readonly link?: ReminderLink;
  /** cert-expiry only: the fields its inbox items carried before categories existed. */
  readonly certId?: string;
  readonly expiryDate?: string;
}

/** An inbox item written before categories existed: cert-expiry, certId + expiryDate only. */
export interface LegacyCertItem {
  readonly certId: string;
  readonly expiryDate: string;
}

export type DigestNotificationItem = ReminderItem | LegacyCertItem;

export function toReminderItem(item: DigestNotificationItem): ReminderItem {
  if ('subjectId' in item && typeof item.subjectId === 'string') {
    return item;
  }
  const legacy = item as LegacyCertItem;
  return certExpiryItem(legacy.certId, legacy.expiryDate);
}

export function certExpiryItem(certId: string, expiryDate: string): ReminderItem {
  return {
    subjectId: certId,
    title: certId,
    detail: `expires ${expiryDate}`,
    dueDate: expiryDate,
    certId,
    expiryDate,
  };
}

/** One line of a push body or email: "E1 hose test due 2026-10-01". */
export function itemLine(item: DigestNotificationItem): string {
  const reminder = toReminderItem(item);
  return reminder.detail ? `${reminder.title} ${reminder.detail}` : reminder.title;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface ReminderCategoryConfig {
  readonly category: string;
  /**
   * The NOTIFPREF category whose per-channel mutes gate this digest's push and email, or
   * null when it cannot be muted. The inbox record is written either way.
   */
  readonly muteKey: string | null;
  /** Roles that get a copy (one ROLE pending row each), on top of any named member. */
  readonly roles: readonly ReminderRole[];
  /** The category a role's copy is delivered under, when it differs from `category`. */
  readonly roleCategory?: string;
  /** SNS message channelId — a notification-service literal, never an alerting channel. */
  readonly pushChannelId: string;
  /** Email subject and push title. */
  readonly subject: (count: number) => string;
  /** The inbox record's one-line summary. */
  readonly summary: (count: number) => string;
}

const CERT_EXPIRY_PUSH_CHANNEL_ID = 'cert-expiry-digest';

const CONFIGS: readonly ReminderCategoryConfig[] = [
  {
    category: CERT_EXPIRY_CATEGORY,
    muteKey: CERT_EXPIRY_CATEGORY,
    roles: ['TRAINING'],
    roleCategory: TRAINING_OFFICER_DIGEST_CATEGORY,
    pushChannelId: CERT_EXPIRY_PUSH_CHANNEL_ID,
    subject: (n) => `${plural(n, 'certification', 'certifications')} expiring`,
    summary: (n) => `${plural(n, 'item', 'items')} expiring`,
  },
  {
    // The training officer's copy is delivered unconditionally (E3-S3 AC2).
    category: TRAINING_OFFICER_DIGEST_CATEGORY,
    muteKey: null,
    roles: [],
    pushChannelId: CERT_EXPIRY_PUSH_CHANNEL_ID,
    subject: (n) => `${plural(n, 'certification', 'certifications')} expiring`,
    summary: (n) => `${plural(n, 'item', 'items')} expiring`,
  },
  {
    category: APPARATUS_TEST_DUE_CATEGORY,
    muteKey: APPARATUS_TEST_DUE_CATEGORY,
    roles: ['APPARATUS', 'CHIEF'],
    pushChannelId: 'apparatus-test-due-digest',
    subject: (n) => `${plural(n, 'apparatus test', 'apparatus tests')} due`,
    summary: (n) => `${plural(n, 'test', 'tests')} due`,
  },
  {
    category: APPARATUS_DEFECT_CATEGORY,
    muteKey: APPARATUS_DEFECT_CATEGORY,
    roles: ['APPARATUS', 'OFFICER'],
    pushChannelId: 'apparatus-defect',
    subject: (n) => `${plural(n, 'apparatus defect', 'apparatus defects')} reported`,
    summary: (n) => `${plural(n, 'defect', 'defects')} reported`,
  },
  {
    category: INVENTORY_REORDER_CATEGORY,
    muteKey: INVENTORY_REORDER_CATEGORY,
    roles: ['APPARATUS', 'ADMIN'],
    pushChannelId: 'inventory-reorder-digest',
    subject: (n) => `${plural(n, 'supply', 'supplies')} to reorder`,
    summary: (n) => `${plural(n, 'item', 'items')} below reorder level`,
  },
  {
    category: PPE_EXPIRY_CATEGORY,
    muteKey: PPE_EXPIRY_CATEGORY,
    roles: ['APPARATUS'],
    pushChannelId: 'ppe-expiry-digest',
    subject: (n) => `${plural(n, 'PPE item', 'PPE items')} expiring`,
    summary: (n) => `${plural(n, 'PPE item', 'PPE items')} expiring`,
  },
];

export const REMINDER_CATEGORIES: ReadonlyMap<string, ReminderCategoryConfig> = new Map(
  CONFIGS.map((config) => [config.category, config]),
);

/** Unknown categories fall back to a neutral, unmutable config rather than throwing. */
export function categoryConfig(category: string): ReminderCategoryConfig {
  return (
    REMINDER_CATEGORIES.get(category) ?? {
      category,
      muteKey: null,
      roles: [],
      pushChannelId: `${category}-digest`,
      subject: (n) => `${plural(n, 'reminder', 'reminders')}`,
      summary: (n) => `${plural(n, 'item', 'items')}`,
    }
  );
}

/** The category a recipient's copy is delivered under. */
export function deliveryCategory(category: string, recipientType: 'MEMBER' | 'ROLE'): string {
  const config = categoryConfig(category);
  return recipientType === 'ROLE' && config.roleCategory ? config.roleCategory : category;
}
