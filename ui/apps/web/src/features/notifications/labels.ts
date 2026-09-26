/** Human labels for the categories notification-service writes (repository.ts). */
const CATEGORY_LABEL: Record<string, string> = {
  'cert-expiry': 'Your certifications expiring',
  'cert-expiry-officer': 'Department certifications expiring',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

/** The only category digestJob.ts reads a member's mutes for today. */
export const CERT_EXPIRY_CATEGORY = 'cert-expiry';
