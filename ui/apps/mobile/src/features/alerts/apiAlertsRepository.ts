import { useMemo, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest, type ApiRequestOptions, type AuthTokenSource } from '../../lib/apiClient';
import { mockAlertsRepository } from './mockAlertsRepository';
import type {
  AckStatus,
  AlertsRepository,
  DeliveryReceipt,
  DispatchAlert,
  ManualDispatchInput,
  RidingBoard,
  RosterEntry,
  SelfTestRun,
} from './types';

function buildApiAlertsRepository(tokens: AuthTokenSource, apiBaseUrl: string): AlertsRepository {
  const req = (path: string, init?: Omit<ApiRequestOptions, 'apiBaseUrl'>) =>
    apiRequest(path, tokens, { ...init, apiBaseUrl });

  return {
    async triggerSelfTest() {
      const response = await req('alerting/self-test', { method: 'POST' });
      const body = (await response.json()) as { testId: string; dispatchId: string };
      return { testId: body.testId, dispatchId: body.dispatchId };
    },

    async getSelfTestRun(testId): Promise<SelfTestRun> {
      const response = await req(`alerting/self-test/${encodeURIComponent(testId)}`);
      return (await response.json()) as SelfTestRun;
    },

    async getDispatch(dispatchId): Promise<DispatchAlert> {
      const response = await req(`alerting/dispatches/${encodeURIComponent(dispatchId)}`);
      const body = (await response.json()) as {
        dispatchId: string;
        incidentType: string;
        address: string;
        crossStreets: string;
        mapLink: string | null;
        narrative: string;
        prePlan: DispatchAlert['prePlan'];
      };
      return {
        dispatchId: body.dispatchId,
        incidentType: body.incidentType,
        address: body.address,
        crossStreets: body.crossStreets,
        mapLink: body.mapLink,
        narrative: body.narrative,
        isSelfTest: false,
        prePlan: body.prePlan,
      };
    },

    async getRoster(dispatchId): Promise<RosterEntry[]> {
      const response = await req(`alerting/dispatches/${encodeURIComponent(dispatchId)}/roster`);
      const body = (await response.json()) as { members: RosterEntry[] };
      return body.members;
    },

    async submitResponse(dispatchId, ackStatus: AckStatus, etaMinutes) {
      const eta =
        ackStatus === 'NOT_RESPONDING'
          ? null
          : (etaMinutes ?? 0) > 0
            ? Math.floor(Date.now() / 1000) + (etaMinutes as number) * 60
            : null;
      await req(`alerting/dispatches/${encodeURIComponent(dispatchId)}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ackStatus, eta, assignedApparatusId: null }),
      });
    },

    async submitManualDispatch(input: ManualDispatchInput) {
      const response = await req('alerting/dispatches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = (await response.json()) as { dispatchId: string };
      return { dispatchId: body.dispatchId };
    },

    async getReceipts(dispatchId): Promise<DeliveryReceipt[]> {
      const response = await req(`alerting/dispatches/${encodeURIComponent(dispatchId)}/receipts`);
      const body = (await response.json()) as { receipts: DeliveryReceipt[] };
      return body.receipts;
    },

    async getRidingBoard(dispatchId): Promise<RidingBoard> {
      const response = await req(`apparatus/riding-board/${encodeURIComponent(dispatchId)}`);
      return (await response.json()) as RidingBoard;
    },

    async assignRidingSeat(dispatchId, seat) {
      await req(`apparatus/riding-board/${encodeURIComponent(dispatchId)}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unitId: seat.unitId,
          positionCode: seat.positionCode,
          memberId: seat.memberId,
          expectedVersion: seat.expectedVersion,
          clientAssignmentId: `${dispatchId}-${seat.unitId}-${seat.positionCode}-${Date.now()}`,
        }),
      });
    },
  };
}

/**
 * Prefers the real alerting-service/apparatus-service API when authenticated + API base is
 * configured; falls back to the local mock so the Alerts stack stays usable offline / pre-infra /
 * outside AuthProvider (navigation unit tests) - same pattern as useChecksRepository.
 */
export function useAlertsRepository(): AlertsRepository {
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const isAuthenticated = auth?.isAuthenticated ?? false;

  const authRef = useRef(auth);
  authRef.current = auth;

  return useMemo<AlertsRepository>(() => {
    if (!apiBaseUrl || !isAuthenticated || !authRef.current) {
      return mockAlertsRepository;
    }
    return buildApiAlertsRepository(authRef.current, apiBaseUrl);
  }, [apiBaseUrl, isAuthenticated]);
}
