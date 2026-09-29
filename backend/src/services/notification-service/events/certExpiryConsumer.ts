import { certExpiryItem, CERT_EXPIRY_CATEGORY } from '../reminders/categories.js';
import { createReminderConsumer, requireString } from './reminderIngest.js';

const LABEL = 'cert.expiry.due';

/**
 * cert.expiry.due (training-service's daily scanner) -> a cert-expiry reminder for the
 * certificate holder, plus the TRAINING role's copy, which the digest delivers to every
 * training officer under cert-expiry-officer.
 */
export const handler = createReminderConsumer({
  label: LABEL,
  acceptedEventTypes: new Set([
    'cert.expiry.due',
    // architecture.md N-5's canonical rename; training-service still emits cert.expiry.due.
    'training.expiry.due',
  ]),
  logPrefix: 'notification.certExpiry',
  metricPrefix: 'CertExpiry',
  toReminder: ({ payload }) => {
    const certId = requireString(payload, 'certId', LABEL);
    const expiryDate = requireString(payload, 'expiryDate', LABEL);
    return {
      deptId: requireString(payload, 'deptId', LABEL),
      category: CERT_EXPIRY_CATEGORY,
      memberId: requireString(payload, 'memberId', LABEL),
      item: certExpiryItem(certId, expiryDate),
    };
  },
});
