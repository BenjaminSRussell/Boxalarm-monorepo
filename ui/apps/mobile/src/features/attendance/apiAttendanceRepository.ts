import { useMemo, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import * as syncManager from '../../sync/syncManager';
import { mockAttendanceRepository } from './mockAttendanceRepository';
import type { AttendanceRecord, AttendanceRepository } from './types';

/** GET /api/v1/personnel/attendance for history, and POST through the SQLite offline outbox for
 * new records, when authenticated + API base configured; falls back to the local mock otherwise -
 * same pattern as useChecksRepository. `occurredAt` is the DynamoDB sort key on this entity
 * (attendance/handler.ts), so it doubles as the outbox idempotency key and the outbox treats a
 * replay's 409 as already recorded. */
const ACTIVITY_LABELS: Record<AttendanceRecord['activityType'], string> = {
  CALL: 'Call',
  DRILL: 'Drill',
  MEETING: 'Meeting',
  WORK_DETAIL: 'Work detail',
  STANDBY: 'Standby',
};

export function activityLabel(activityType: AttendanceRecord['activityType']): string {
  return ACTIVITY_LABELS[activityType];
}

export function attendanceOutboxId(entry: AttendanceRecord): string {
  return `attendance-${entry.occurredAt}`;
}

export function attendanceLabel(entry: AttendanceRecord): string {
  const when = new Date(entry.occurredAt * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Attendance — ${activityLabel(entry.activityType)}, ${when}`;
}

export function useAttendanceRepository(): AttendanceRepository {
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const isAuthenticated = auth?.isAuthenticated ?? false;
  const authRef = useRef(auth);
  authRef.current = auth;

  return useMemo<AttendanceRepository>(() => {
    if (!apiBaseUrl || !isAuthenticated) {
      return mockAttendanceRepository;
    }

    return {
      async getOwnRecords(): Promise<AttendanceRecord[]> {
        const tokens = authRef.current;
        if (!tokens) return mockAttendanceRepository.getOwnRecords();
        // No mock fallback on a network failure: offline, the screen says history is
        // unavailable rather than showing invented records as this member's history.
        const response = await apiRequest('personnel/attendance', tokens, { apiBaseUrl });
        const body = (await response.json()) as { records: AttendanceRecord[] };
        return body.records;
      },

      async record(entry): Promise<void> {
        if (!authRef.current) return mockAttendanceRepository.record(entry);
        // Resolves once the record is on the phone; delivery (now or on reconnect) is the
        // outbox's job, and its state is read from the outbox rather than this promise.
        await syncManager.enqueueAttendance(attendanceOutboxId(entry), attendanceLabel(entry), {
          ...entry,
        });
      },
    };
  }, [apiBaseUrl, isAuthenticated]);
}
