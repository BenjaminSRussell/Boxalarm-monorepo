import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type { Role } from '../../auth/roles';
import type {
  AttendanceActivityType,
  AttendanceRecord,
  CreateMemberInput,
  LosapTotal,
  Member,
  MemberStatus,
  Qualification,
  UpdateRolesResult,
} from './types';

export async function listMembers(tokens: AuthTokenSource): Promise<Member[]> {
  const response = await apiRequest('personnel/members', tokens);
  const body = (await response.json()) as { items: Member[] };
  return body.items;
}

export async function getMember(tokens: AuthTokenSource, memberId: string): Promise<Member> {
  const response = await apiRequest(`personnel/members/${encodeURIComponent(memberId)}`, tokens);
  return (await response.json()) as Member;
}

export async function createMember(
  tokens: AuthTokenSource,
  input: CreateMemberInput,
): Promise<Member> {
  const response = await apiRequest('personnel/members', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as Member;
}

export async function updateMemberStatus(
  tokens: AuthTokenSource,
  memberId: string,
  status: MemberStatus,
): Promise<Member> {
  const response = await apiRequest(
    `personnel/members/${encodeURIComponent(memberId)}/status`,
    tokens,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
  );
  return (await response.json()) as Member;
}

/** Sets the member's full role set (CHIEF/ADMIN only, never your own). */
export async function updateMemberRoles(
  tokens: AuthTokenSource,
  memberId: string,
  roles: Role[],
): Promise<UpdateRolesResult> {
  const response = await apiRequest(
    `personnel/members/${encodeURIComponent(memberId)}/roles`,
    tokens,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles }),
    },
  );
  return (await response.json()) as UpdateRolesResult;
}

export async function getQuals(
  tokens: AuthTokenSource,
  memberId: string,
): Promise<Qualification[]> {
  const response = await apiRequest(
    `personnel/members/${encodeURIComponent(memberId)}/quals`,
    tokens,
  );
  return (await response.json()) as Qualification[];
}

export async function putQual(
  tokens: AuthTokenSource,
  memberId: string,
  qualCode: string,
  grantedByCertId: string | null,
): Promise<Qualification> {
  const response = await apiRequest(
    `personnel/members/${encodeURIComponent(memberId)}/quals`,
    tokens,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qualCode, grantedByCertId }),
    },
  );
  return (await response.json()) as Qualification;
}

export async function getMemberLosap(
  tokens: AuthTokenSource,
  memberId: string,
): Promise<LosapTotal> {
  const response = await apiRequest(
    `personnel/members/${encodeURIComponent(memberId)}/losap`,
    tokens,
  );
  return (await response.json()) as LosapTotal;
}

export async function listOwnAttendance(tokens: AuthTokenSource): Promise<AttendanceRecord[]> {
  const response = await apiRequest('personnel/attendance', tokens);
  const body = (await response.json()) as { records: AttendanceRecord[] };
  return body.records;
}

export async function recordAttendance(
  tokens: AuthTokenSource,
  input: {
    activityType: AttendanceActivityType;
    refId: string | null;
    occurredAt: number;
    hours: number;
  },
): Promise<AttendanceRecord> {
  const response = await apiRequest('personnel/attendance', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as AttendanceRecord;
}
