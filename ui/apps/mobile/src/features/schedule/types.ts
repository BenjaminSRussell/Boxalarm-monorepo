// Shaped to match architecture.md's DUTY_SHIFT and SHIFT_POSITION entities (Data Model §3.3).

export type ShiftStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FULL' | 'CANCELLED';

export interface ShiftPosition {
  positionCode: string;
  requiredQual: string | null;
  claimedByMemberId: string | null;
}

export interface DutyShift {
  shiftId: string;
  /** Epoch milliseconds, as personnel-service stores DUTY_SHIFT.startAt/endAt. */
  startAt: number;
  endAt: number;
  stationId: string;
  status: ShiftStatus;
  positions: ShiftPosition[];
}

// F2.9: an atomic claim either succeeds or discovers the position was already taken - never a
// silent "maybe." The UI shows PENDING between the tap and this result, never CLAIMED early.
// ALREADY_MINE mirrors the backend's claimShiftPosition.ts ClaimOutcome: this exact member
// already holds the position (an idempotent retry, e.g. a reconnect resubmit of a claim that
// actually succeeded before the connection dropped) - never conflate this with ALREADY_TAKEN
// (the backend's CONFLICT: someone else holds it), or a successful resubmit misleadingly reads
// as a lost shift.
export type ClaimResult = 'CLAIMED' | 'ALREADY_MINE' | 'ALREADY_TAKEN';

export interface ScheduleRepository {
  getShifts(): Promise<DutyShift[]>;
  // idempotencyKey is optional so existing single-attempt callers/tests are unaffected, but a
  // caller that may retry the same claim intent (e.g. ShiftDetailScreen's offline-queue reconnect
  // resubmit) must generate it once, up front, and pass the same value on every retry - a value
  // regenerated per attempt cannot function as an idempotency key across retries.
  claimPosition(
    shiftId: string,
    positionCode: string,
    idempotencyKey?: string,
  ): Promise<ClaimResult>;
  markUnavailable(startAt: string, endAt: string, reason?: string): Promise<void>;
  // F2.11: give-back and swap. Optional so the original two-method mock (still exercised by
  // ShiftBoardScreen/AvailabilityScreen tests) needs no change to keep satisfying this interface.
  releasePosition?(shiftId: string, positionCode: string): Promise<void>;
  proposeSwap?(shiftId: string, positionCode: string, toMemberId: string): Promise<void>;
}
