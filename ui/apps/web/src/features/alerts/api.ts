import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type {
  CanaryStatus,
  DeliveryReceipt,
  DiagnosticsResult,
  DispatchAlert,
  ManualDispatchInput,
  RidingBoard,
  RosterEntry,
} from './types';

export async function getDispatch(
  tokens: AuthTokenSource,
  dispatchId: string,
): Promise<DispatchAlert> {
  const response = await apiRequest(
    `alerting/dispatches/${encodeURIComponent(dispatchId)}`,
    tokens,
  );
  return (await response.json()) as DispatchAlert;
}

export async function getRoster(
  tokens: AuthTokenSource,
  dispatchId: string,
): Promise<RosterEntry[]> {
  const response = await apiRequest(
    `alerting/dispatches/${encodeURIComponent(dispatchId)}/roster`,
    tokens,
  );
  const body = (await response.json()) as { members: RosterEntry[] };
  return body.members;
}

export async function getReceipts(
  tokens: AuthTokenSource,
  dispatchId: string,
): Promise<DeliveryReceipt[]> {
  const response = await apiRequest(
    `alerting/dispatches/${encodeURIComponent(dispatchId)}/receipts`,
    tokens,
  );
  const body = (await response.json()) as { receipts: DeliveryReceipt[] };
  return body.receipts;
}

export async function getRidingBoard(
  tokens: AuthTokenSource,
  dispatchId: string,
): Promise<RidingBoard> {
  const response = await apiRequest(
    `apparatus/riding-board/${encodeURIComponent(dispatchId)}`,
    tokens,
  );
  return (await response.json()) as RidingBoard;
}

export async function assignRidingSeat(
  tokens: AuthTokenSource,
  dispatchId: string,
  seat: { unitId: string; positionCode: string; memberId: string | null; expectedVersion: number },
): Promise<void> {
  await apiRequest(`apparatus/riding-board/${encodeURIComponent(dispatchId)}/assignments`, tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...seat,
      clientAssignmentId: `${dispatchId}-${seat.unitId}-${seat.positionCode}-${Date.now()}`,
    }),
  });
}

// Routed path per infrastructure/components/alerting/routes-ops.ts (GET
// /api/v1/alerting/dispatches/{dispatchId}/diagnostics/{memberId}) - not the ticket's stale
// /alerting/audit prose.
export async function getDiagnostics(
  tokens: AuthTokenSource,
  dispatchId: string,
  memberId: string,
): Promise<DiagnosticsResult> {
  const response = await apiRequest(
    `alerting/dispatches/${encodeURIComponent(dispatchId)}/diagnostics/${encodeURIComponent(memberId)}`,
    tokens,
  );
  return (await response.json()) as DiagnosticsResult;
}

export async function getCanaryStatus(tokens: AuthTokenSource): Promise<CanaryStatus> {
  const response = await apiRequest('alerting/canary/status', tokens);
  return (await response.json()) as CanaryStatus;
}

export async function submitManualDispatch(
  tokens: AuthTokenSource,
  input: ManualDispatchInput,
): Promise<{ dispatchId: string }> {
  const response = await apiRequest('alerting/dispatches', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as { dispatchId: string };
}
