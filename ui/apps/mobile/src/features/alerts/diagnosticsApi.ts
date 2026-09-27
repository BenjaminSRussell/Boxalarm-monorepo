import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';

/**
 * One raw alerting-table timeline item (diagnostics/queryDiagnostics.ts returns DynamoDB items
 * unchanged). Receipts carry no status field: delivery state is which timestamps are present.
 * Times are epoch seconds.
 */
export interface OwnTimelineEntry {
  entityType: string;
  channel?: string;
  toneSequence?: number;
  sentAt?: number;
  deliveredAt?: number | null;
  openedAt?: number | null;
  failureReason?: string | null;
  escalatedAt?: number;
  reason?: string;
  answeredAt?: number;
  ackStatus?: string;
}

export interface OwnDeviceState {
  notificationPermission: boolean;
  criticalAlertPermission: boolean;
  batteryOptimizationExempt: boolean;
  appVersion: string;
  osVersion: string;
  /** Epoch seconds. */
  reportedAt: number;
}

/** GET alerting/dispatches/{dispatchId}/diagnostics (diagnostics/selfHandler.ts). */
export interface OwnDiagnostics {
  dispatchId: string;
  diagnosis: 'ON_ROSTER' | 'NOT_ON_ELIGIBLE_ROSTER';
  timeline: OwnTimelineEntry[];
  deviceState: OwnDeviceState | null;
}

export interface RecentDispatch {
  dispatchId: string;
  /** Epoch seconds: dispatch time when known, else the latest page sent to this member. */
  at: number;
  incidentType: string | null;
}

export interface RecentDispatches {
  dispatches: RecentDispatch[];
  /** True when one of the two sources failed, so the list may be missing a dispatch. */
  partial: boolean;
  /** The server's active-call window in seconds, or null when that source failed. */
  activeWindowSeconds: number | null;
}

export const RECENT_DISPATCH_LIMIT = 3;

export async function getOwnDiagnostics(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  dispatchId: string,
): Promise<OwnDiagnostics> {
  const response = await apiRequest(
    `alerting/dispatches/${encodeURIComponent(dispatchId)}/diagnostics`,
    tokens,
    { apiBaseUrl },
  );
  return (await response.json()) as OwnDiagnostics;
}

/**
 * The member's most recent dispatches, from two sources: their own delivery history (GET
 * alerting/audit?memberId=<own sub>, newest receipts first) and the department's active
 * dispatches (GET alerting/dispatches?status=active). The second matters for exactly the
 * question this screen answers: a member who was never paged has no receipts, so their own
 * history alone would never surface the call they missed. Throws only when both fail.
 */
export async function listRecentOwnDispatches(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  memberId: string,
): Promise<RecentDispatches> {
  const [history, active] = await Promise.allSettled([
    apiRequest(`alerting/audit?memberId=${encodeURIComponent(memberId)}`, tokens, {
      apiBaseUrl,
    }).then(
      async (r) => (await r.json()) as { entries: { dispatchId?: string; sentAt?: number }[] },
    ),
    apiRequest('alerting/dispatches?status=active', tokens, { apiBaseUrl }).then(
      async (r) =>
        (await r.json()) as {
          dispatches: { dispatchId: string; dispatchedAt: number; incidentType: string | null }[];
          activeWindowSeconds: number;
        },
    ),
  ]);
  if (history.status === 'rejected' && active.status === 'rejected') {
    throw history.reason;
  }

  const byId = new Map<string, RecentDispatch>();
  if (active.status === 'fulfilled') {
    for (const d of active.value.dispatches) {
      byId.set(d.dispatchId, {
        dispatchId: d.dispatchId,
        at: d.dispatchedAt,
        incidentType: d.incidentType,
      });
    }
  }
  if (history.status === 'fulfilled') {
    for (const entry of history.value.entries) {
      if (typeof entry.dispatchId !== 'string' || byId.has(entry.dispatchId)) continue;
      byId.set(entry.dispatchId, {
        dispatchId: entry.dispatchId,
        at: entry.sentAt ?? 0,
        incidentType: null,
      });
    }
  }

  return {
    dispatches: [...byId.values()].sort((a, b) => b.at - a.at).slice(0, RECENT_DISPATCH_LIMIT),
    partial: history.status === 'rejected' || active.status === 'rejected',
    activeWindowSeconds: active.status === 'fulfilled' ? active.value.activeWindowSeconds : null,
  };
}
