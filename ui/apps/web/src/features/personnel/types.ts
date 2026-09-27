import type { Role } from '../../auth/roles';

export type MemberStatus = 'PROBATIONARY' | 'ACTIVE' | 'LOA' | 'RETIRED';

export interface Member {
  memberId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  status: MemberStatus;
  joinDate: string;
  rank: string;
  agencyId: string;
  /** Always holds MEMBER on the server; absent only on fixtures that predate roles. */
  roles?: Role[];
}

/** PUT /personnel/members/{memberId}/roles. `takesEffect` is the server's own wording. */
export interface UpdateRolesResult {
  memberId: string;
  roles: Role[];
  changed: boolean;
  takesEffect: string;
}

export interface CreateMemberInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  joinDate: string;
  rank: string;
  agencyId: string;
}

export interface Qualification {
  qualCode: string;
  grantedByCertId: string | null;
  currentlyEligible: boolean;
}

export interface LosapTotal {
  memberId: string;
  year: number;
  totalPoints: number;
}

export type AttendanceActivityType = 'CALL' | 'DRILL' | 'MEETING' | 'WORK_DETAIL' | 'STANDBY';

export interface AttendanceRecord {
  activityType: AttendanceActivityType;
  refId: string | null;
  occurredAt: number;
  hours: number;
  losapPointsAwarded?: number;
}
