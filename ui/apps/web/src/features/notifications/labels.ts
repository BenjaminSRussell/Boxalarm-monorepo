import type { Role } from '../../auth/roles';
import type { NotificationDigestItem } from './types';

/**
 * Human labels for the categories notification-service writes (backend
 * notification-service/reminders/categories.ts).
 */
const CATEGORY_LABEL: Record<string, string> = {
  'cert-expiry': 'Your certifications expiring',
  'cert-expiry-officer': 'Department certifications expiring',
  'apparatus-test-due': 'Apparatus tests due',
  'apparatus-defect': 'Apparatus defects reported',
  'inventory-reorder': 'Supplies to reorder',
  'ppe-expiry': 'Your PPE expiring',
  'ppe-expiry-officer': 'Department PPE expiring',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

export const CERT_EXPIRY_CATEGORY = 'cert-expiry';

export interface ReminderPreference {
  /** The NOTIFPREF category key the digest reads this reminder's mutes from. */
  readonly category: string;
  readonly legend: string;
  /**
   * Roles the reminder is routed to. Undefined: it is about the member's own records, so
   * every member can receive it.
   */
  readonly roles?: readonly Role[];
}

/** Every mutable reminder category, in the order the preferences screen lists them. */
export const REMINDER_PREFERENCES: readonly ReminderPreference[] = [
  { category: CERT_EXPIRY_CATEGORY, legend: 'Certification-expiry reminders' },
  { category: 'ppe-expiry', legend: 'Your PPE expiry reminders' },
  {
    category: 'ppe-expiry-officer',
    legend: 'Department PPE expiry reminders',
    roles: ['APPARATUS'],
  },
  {
    category: 'apparatus-test-due',
    legend: 'Apparatus test reminders',
    roles: ['APPARATUS', 'CHIEF'],
  },
  {
    category: 'apparatus-defect',
    legend: 'Apparatus defect reports',
    roles: ['APPARATUS', 'OFFICER'],
  },
  {
    category: 'inventory-reorder',
    legend: 'Supply reorder reminders',
    roles: ['APPARATUS', 'ADMIN'],
  },
];

/** The categories this member can actually receive. */
export function preferencesFor(roles: readonly Role[]): ReminderPreference[] {
  return REMINDER_PREFERENCES.filter(
    (preference) => !preference.roles || preference.roles.some((role) => roles.includes(role)),
  );
}

/** One inbox item as text: "E1 hose test due 2026-10-20". Pre-category items carry certId. */
export function itemText(item: NotificationDigestItem): string {
  if (item.title) {
    return item.detail ? `${item.title} ${item.detail}` : item.title;
  }
  return `${item.certId ?? ''} expires ${item.expiryDate ?? ''}`.trim();
}

/** The in-app route an item links to, when there is one. */
export function itemPath(item: NotificationDigestItem): string | undefined {
  const link = item.link;
  if (!link) return undefined;
  switch (link.kind) {
    case 'apparatus':
      return link.id ? `/apparatus/${encodeURIComponent(link.id)}` : '/apparatus';
    case 'member':
      return link.id ? `/personnel/${encodeURIComponent(link.id)}` : undefined;
    case 'consumables':
      return '/inventory';
    default:
      return undefined;
  }
}
