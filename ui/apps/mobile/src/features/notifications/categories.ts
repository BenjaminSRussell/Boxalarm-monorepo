import type { Role } from '../../auth/AuthContext';
import type { NotificationDigestItem } from '../training/types';

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

export interface ReminderPreference {
  /** The NOTIFPREF category key the digest reads this reminder's mutes from. */
  readonly category: string;
  readonly label: string;
  /** Roles the reminder is routed to; undefined means it is about the member's own records. */
  readonly roles?: readonly Role[];
}

/** Every mutable reminder category, in the order the preferences screen lists them. */
export const REMINDER_PREFERENCES: readonly ReminderPreference[] = [
  { category: 'cert-expiry', label: 'Certification expiry' },
  { category: 'ppe-expiry', label: 'Your PPE expiry' },
  { category: 'ppe-expiry-officer', label: 'Department PPE expiry', roles: ['APPARATUS'] },
  { category: 'apparatus-test-due', label: 'Apparatus tests due', roles: ['APPARATUS', 'CHIEF'] },
  { category: 'apparatus-defect', label: 'Apparatus defects', roles: ['APPARATUS', 'OFFICER'] },
  { category: 'inventory-reorder', label: 'Supply reorders', roles: ['APPARATUS', 'ADMIN'] },
];

export function preferencesFor(roles: readonly Role[]): ReminderPreference[] {
  return REMINDER_PREFERENCES.filter(
    (preference) => !preference.roles || preference.roles.some((role) => roles.includes(role)),
  );
}

/** One inbox item as text: "E1 reported out of service". Pre-category items carry certId. */
export function itemText(item: NotificationDigestItem): string {
  if (item.title) {
    return item.detail ? `${item.title} ${item.detail}` : item.title;
  }
  return `${item.certId ?? ''} expires ${item.expiryDate ?? ''}`.trim();
}
