import {
  ApiError,
  apiRequest,
  type AuthTokenSource,
  type ProblemDetails,
} from '../../lib/apiClient';
import type { FieldError } from './validateEnum';
import type {
  CreateIncidentInput,
  CreateIncidentResponse,
  GetIncidentResponse,
  Incident,
  PutExposureInput,
  PutExposureResponse,
  ResponseUnit,
  SearchIncidentsParams,
  SubmissionAccepted,
  SubmissionState,
  TimeField,
  UpdateIncidentInput,
} from './types';

function incidentPath(incidentId: string): string {
  return `incidents/${encodeURIComponent(incidentId)}`;
}

export async function searchIncidents(
  tokens: AuthTokenSource,
  params: SearchIncidentsParams,
): Promise<Incident[]> {
  const qs = new URLSearchParams({
    fromAlarmAt: String(params.fromAlarmAt),
    toAlarmAt: String(params.toAlarmAt),
  });
  const response = await apiRequest(`incidents?${qs.toString()}`, tokens);
  const body = (await response.json()) as { incidents: Incident[] };
  return body.incidents;
}

export async function getIncident(
  tokens: AuthTokenSource,
  incidentId: string,
): Promise<GetIncidentResponse> {
  const response = await apiRequest(incidentPath(incidentId), tokens);
  return (await response.json()) as GetIncidentResponse;
}

export async function createIncidentFromDispatch(
  tokens: AuthTokenSource,
  input: CreateIncidentInput,
): Promise<CreateIncidentResponse> {
  const response = await apiRequest('incidents', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as CreateIncidentResponse;
}

export async function updateIncident(
  tokens: AuthTokenSource,
  incidentId: string,
  input: UpdateIncidentInput,
): Promise<GetIncidentResponse> {
  const response = await apiRequest(incidentPath(incidentId), tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as GetIncidentResponse;
}

export async function putNarrative(
  tokens: AuthTokenSource,
  incidentId: string,
  narrative: string,
): Promise<GetIncidentResponse> {
  const response = await apiRequest(`${incidentPath(incidentId)}/narrative`, tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ narrative }),
  });
  return (await response.json()) as GetIncidentResponse;
}

export async function putResponseTimes(
  tokens: AuthTokenSource,
  incidentId: string,
  input: {
    unitId: string;
    unitType: ResponseUnit['unitType'];
  } & Partial<Record<TimeField, number>>,
): Promise<ResponseUnit> {
  const response = await apiRequest(`${incidentPath(incidentId)}/response-times`, tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as ResponseUnit;
}

export async function putExposure(
  tokens: AuthTokenSource,
  incidentId: string,
  input: PutExposureInput,
): Promise<PutExposureResponse> {
  const response = await apiRequest(`${incidentPath(incidentId)}/exposures`, tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as PutExposureResponse;
}

/** F7.6: accept-and-queue — 202 once the incident is SUBMITTED and the worker is enqueued. */
export async function submitIncident(
  tokens: AuthTokenSource,
  incidentId: string,
): Promise<SubmissionAccepted> {
  const response = await apiRequest(`${incidentPath(incidentId)}/submit`, tokens, {
    method: 'POST',
  });
  return (await response.json()) as SubmissionAccepted;
}

export async function getSubmission(
  tokens: AuthTokenSource,
  incidentId: string,
): Promise<SubmissionState> {
  const response = await apiRequest(`${incidentPath(incidentId)}/submission`, tokens);
  return (await response.json()) as SubmissionState;
}

/** Re-queues a FAILED submission (409 for any other submission status). */
export async function retrySubmission(
  tokens: AuthTokenSource,
  incidentId: string,
): Promise<SubmissionAccepted> {
  const response = await apiRequest(`${incidentPath(incidentId)}/submission/retry`, tokens, {
    method: 'POST',
  });
  return (await response.json()) as SubmissionAccepted;
}

export function fieldErrorsFromUnknown(error: unknown): FieldError[] {
  if (!(error instanceof ApiError)) return [];
  const extra = error.problem as ProblemDetails & { errors?: unknown };
  if (!Array.isArray(extra.errors)) return [];
  return extra.errors.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as { field?: unknown; message?: unknown };
    if (typeof record.field !== 'string' || typeof record.message !== 'string') return [];
    return [{ field: record.field, message: record.message }];
  });
}
