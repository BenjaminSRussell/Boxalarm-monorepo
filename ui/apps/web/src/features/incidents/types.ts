export type IncidentStatus = 'DRAFT' | 'VALIDATED' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';

export interface Incident {
  incidentId: string;
  deptId: string;
  dispatchNumber: string;
  epochSeconds: number;
  nerisSchemaVersion: string;
  corePayload: Record<string, unknown>;
  incidentType?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  alarmAt?: number;
  dispatchAt?: number;
  arrivedAt?: number;
  clearedAt?: number;
  narrative?: string;
  status: IncidentStatus;
  sourceDispatchId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** incident-service submissionRepository.ts SUBMISSION_STATUSES (F7.7). */
export type SubmissionStatus = 'SUBMITTED' | 'ACCEPTED' | 'FAILED' | 'RETRYING';

/** GET /incidents/{id}/submission — status of the NERIS submission, never silently dropped. */
export interface SubmissionState {
  incidentId: string;
  status: IncidentStatus;
  submissionStatus: SubmissionStatus | null;
  submissionFailureReason?: string;
}

/** 202 body of POST .../submit and POST .../submission/retry. */
export interface SubmissionAccepted {
  incidentId: string;
  submissionStatus: SubmissionStatus;
}

export type ResponseUnitType = 'APPARATUS' | 'MEMBER';

export interface ResponseUnit {
  incidentId: string;
  unitId: string;
  unitType: ResponseUnitType;
  dispatchedAt?: number;
  enRouteAt?: number;
  arrivedAt?: number;
  clearedAt?: number;
  assignedPositions?: string[];
}

export interface RespondingMember {
  memberId: string;
  status?: string;
}

export interface IncidentSecondary {
  incidentId: string;
  secondaryType: string;
  payload: Record<string, string>;
  affectedMemberIds: string[];
  complete?: boolean;
  updatedAt: number;
}

/** GET adds modules the caller is allowed to see. Units ride along when the API includes them. */
export interface IncidentDetail extends Incident {
  secondaryModules?: IncidentSecondary[];
  respondingUnits?: ResponseUnit[];
  respondingMembers?: RespondingMember[];
}

export interface CreateIncidentInput {
  dispatchId: string;
}

export type GetIncidentResponse = IncidentDetail;
export type CreateIncidentResponse = IncidentDetail;

export interface SearchIncidentsParams {
  fromAlarmAt: number;
  toAlarmAt: number;
}

export interface UpdateIncidentInput {
  fields: Record<string, string>;
}

export interface PutExposureInput {
  secondaryType: string;
  payload: Record<string, string>;
  affectedMemberIds: string[];
}

export interface PutExposureResponse {
  incidentId: string;
  secondaryType: string;
  payload: Record<string, string>;
  affectedMemberIds: string[];
  complete: boolean;
  updatedAt: number;
}

export const MAX_NARRATIVE_LENGTH = 25_000;

export const TIME_FIELDS = ['dispatchedAt', 'enRouteAt', 'arrivedAt', 'clearedAt'] as const;
export type TimeField = (typeof TIME_FIELDS)[number];
