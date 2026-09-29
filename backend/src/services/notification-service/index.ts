/**
 * notification-service (architecture.md §1.1 service 10): the LOB-plane in-app inbox,
 * notification preferences, and the reminder pipeline — events/*Consumer.ts record
 * reminders from the platform bus, digest/digestJob.ts delivers them once a day, and an
 * out-of-service apparatus defect is also written to the inbox and emailed straight away
 * (events/apparatusDefectConsumer.ts). The push topic has no device subscriber yet.
 *
 * Every channel here is non-critical. Nothing in this service routes through, or may be
 * mistaken for, the isolated alerting plane that carries dispatch alerts.
 */
export const service = { name: 'notification-service', plane: 'lob' } as const;
