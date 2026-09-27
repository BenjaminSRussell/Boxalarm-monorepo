// UI-side view of the SQLite outbox (src/sync/outbox.ts, drained by syncManager.ts) that the
// sync-status banner and each capturing screen render from.

// FAILED = transient, retried automatically with backoff; REJECTED = terminal server refusal
// (4xx), kept until the user retries or discards it.
export type SyncItemStatus = 'QUEUED' | 'SYNCING' | 'FAILED' | 'REJECTED';

// kind mirrors the outbox entry's underlying entity type (CHECKLIST_RUN, DEFECT, AVAILABILITY,
// SHIFT_CLAIM, ...) so a failed-item row can show what actually failed, not just "an item."
export interface SyncItem {
  id: string;
  kind: string;
  label: string;
  status: SyncItemStatus;
  queuedAt: string; // ISO
  lastError: string | null;
}

export interface SyncQueueStatus {
  items: SyncItem[];
  lastSyncAt: string | null; // ISO, null if nothing has ever synced this session
}
