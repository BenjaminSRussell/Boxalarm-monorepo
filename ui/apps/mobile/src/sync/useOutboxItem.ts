import { useEffect, useState } from 'react';
import type { SyncItemStatus } from '../features/sync/types';
import * as syncManager from './syncManager';

// SYNCED and DISCARDED are only reachable once the row has left the outbox; NOT_QUEUED is the
// state before the caller has enqueued anything under this id.
export type OutboxItemState = SyncItemStatus | 'SYNCED' | 'DISCARDED' | 'NOT_QUEUED';

export interface OutboxItemView {
  readonly state: OutboxItemState;
  readonly lastError: string | null;
}

/** Live delivery state of one outbox entry, so the screen that queued it can say honestly
 * whether it is still on the phone, being sent, sent, failing, or refused by the server. */
export function useOutboxItem(id: string | null): OutboxItemView {
  const [view, setView] = useState<OutboxItemView>({ state: 'NOT_QUEUED', lastError: null });

  useEffect(() => {
    if (!id) {
      setView({ state: 'NOT_QUEUED', lastError: null });
      return undefined;
    }
    let seen = false;
    return syncManager.subscribe((status) => {
      const item = status.items.find((candidate) => candidate.id === id);
      if (item) {
        seen = true;
        setView({ state: item.status, lastError: item.lastError });
      } else if (syncManager.hasSynced(id)) {
        setView({ state: 'SYNCED', lastError: null });
      } else if (seen) {
        setView({ state: 'DISCARDED', lastError: null });
      }
    });
  }, [id]);

  return view;
}
