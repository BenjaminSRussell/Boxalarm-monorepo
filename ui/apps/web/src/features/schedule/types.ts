export type ShiftStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FULL' | 'CANCELLED';

export interface DutyShift {
  shiftId: string;
  /** Epoch milliseconds (personnel-service DUTY_SHIFT convention). */
  startAt: number;
  /** Epoch milliseconds. */
  endAt: number;
  stationId: string;
  status: ShiftStatus;
}

export interface CreateShiftPosition {
  positionCode: string;
  requiredQual?: string;
}

export interface CreateShiftInput {
  startAt: number;
  endAt: number;
  stationId: string;
  positions: CreateShiftPosition[];
}

export type CoverageStatus = 'covered' | 'short' | 'qual-gapped';

export interface ShiftCoveragePosition {
  positionCode: string;
  requiredQual?: string;
  status: CoverageStatus;
}

export interface ShiftCoverage {
  shiftId: string;
  startAt: number;
  endAt: number;
  stationId: string;
  status: CoverageStatus;
  positions: ShiftCoveragePosition[];
}

export interface ShiftSwapApproval {
  shiftId: string;
  swapId: number;
  status: 'APPROVED';
  claimedByMemberId: string;
}
