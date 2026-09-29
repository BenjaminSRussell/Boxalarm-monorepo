import { INVENTORY_REORDER_CATEGORY } from '../reminders/categories.js';
import { createReminderConsumer, MalformedEventError, requireString } from './reminderIngest.js';

const LABEL = 'inventory.reorder.due';

function requireNumber(payload: Record<string, unknown>, field: string): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MalformedEventError(LABEL);
  }
  return value;
}

/**
 * inventory.reorder.due (inventory-service's daily consumable scan) -> an inventory-reorder
 * reminder for the APPARATUS role (quartermaster) and ADMIN. Links to the consumables list.
 */
export const handler = createReminderConsumer({
  label: LABEL,
  acceptedEventTypes: new Set([LABEL]),
  logPrefix: 'notification.inventoryReorderDue',
  metricPrefix: 'InventoryReorder',
  toReminder: ({ payload }) => {
    const currentQty = requireNumber(payload, 'currentQty');
    const reorderThreshold = requireNumber(payload, 'reorderThreshold');
    return {
      deptId: requireString(payload, 'deptId', LABEL),
      category: INVENTORY_REORDER_CATEGORY,
      item: {
        subjectId: requireString(payload, 'itemId', LABEL),
        title: requireString(payload, 'itemName', LABEL),
        detail: `${currentQty} on hand, reorder at ${reorderThreshold}`,
        link: { kind: 'consumables' },
      },
    };
  },
});
