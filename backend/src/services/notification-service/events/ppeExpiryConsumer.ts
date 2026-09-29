import { PPE_EXPIRY_CATEGORY } from '../reminders/categories.js';
import { createReminderConsumer, requireString } from './reminderIngest.js';

const LABEL = 'ppe.expiry.due';

/**
 * ppe.expiry.due (inventory-service's daily NFPA service-life scan) -> a ppe-expiry reminder
 * for the member who holds the item, plus the APPARATUS role's copy naming the holder.
 */
export const handler = createReminderConsumer({
  label: LABEL,
  acceptedEventTypes: new Set([
    LABEL,
    // architecture.md N-5's canonical rename; inventory-service still emits ppe.expiry.due.
    'inventory.expiry.due',
  ]),
  logPrefix: 'notification.ppeExpiry',
  metricPrefix: 'PpeExpiry',
  toReminder: ({ payload }) => {
    const memberId = requireString(payload, 'memberId', LABEL);
    const ppeItemId = requireString(payload, 'ppeItemId', LABEL);
    const expiryDate = requireString(payload, 'expiryDate', LABEL);
    const item = {
      subjectId: `${memberId}:${ppeItemId}`,
      title: ppeItemId,
      detail: `expires ${expiryDate}`,
      dueDate: expiryDate,
      link: { kind: 'member' as const, id: memberId },
    };
    return {
      deptId: requireString(payload, 'deptId', LABEL),
      category: PPE_EXPIRY_CATEGORY,
      memberId,
      item,
      roleItem: { ...item, detail: `held by ${memberId}, expires ${expiryDate}` },
    };
  },
});
