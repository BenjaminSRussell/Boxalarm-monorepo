import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type {
  BoundingBox,
  CreateHydrantInput,
  CreateOccupancyInput,
  Hydrant,
  Inspection,
  MapQueryResult,
  Occupancy,
  PrePlanView,
  PutPrePlanInput,
  PutPrePlanResult,
  UpdateHydrantInput,
  UpdateOccupancyInput,
  Violation,
} from './types';

export async function listOccupancies(tokens: AuthTokenSource): Promise<Occupancy[]> {
  const response = await apiRequest('inspections/occupancies', tokens);
  const body = (await response.json()) as { items: Occupancy[] };
  return body.items;
}

export async function getOccupancy(
  tokens: AuthTokenSource,
  occupancyId: string,
): Promise<Occupancy> {
  const response = await apiRequest(
    `inspections/occupancies/${encodeURIComponent(occupancyId)}`,
    tokens,
  );
  return (await response.json()) as Occupancy;
}

export async function createOccupancy(
  tokens: AuthTokenSource,
  input: CreateOccupancyInput,
): Promise<Occupancy> {
  const response = await apiRequest('inspections/occupancies', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as Occupancy;
}

export async function updateOccupancy(
  tokens: AuthTokenSource,
  occupancyId: string,
  input: UpdateOccupancyInput,
): Promise<Occupancy> {
  const response = await apiRequest(
    `inspections/occupancies/${encodeURIComponent(occupancyId)}`,
    tokens,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return (await response.json()) as Occupancy;
}

export async function getPrePlan(
  tokens: AuthTokenSource,
  occupancyId: string,
): Promise<PrePlanView | undefined> {
  try {
    const response = await apiRequest(
      `inspections/occupancies/${encodeURIComponent(occupancyId)}/pre-plan`,
      tokens,
    );
    return (await response.json()) as PrePlanView;
  } catch (error) {
    const status = (error as { problem?: { status?: number } }).problem?.status;
    if (status === 404) return undefined;
    throw error;
  }
}

export async function putPrePlan(
  tokens: AuthTokenSource,
  occupancyId: string,
  input: PutPrePlanInput,
): Promise<PutPrePlanResult> {
  const response = await apiRequest(
    `inspections/occupancies/${encodeURIComponent(occupancyId)}/pre-plan`,
    tokens,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return (await response.json()) as PutPrePlanResult;
}

// The presigned S3 PUT is not an API route, so it bypasses apiRequest — and with it
// apiRequest's non-2xx check. An expired URL or a rejected upload must surface as a failed
// save, never as "Pre-plan saved." with the file silently missing.
export async function uploadPrePlanFile(uploadUrl: string, file: File): Promise<void> {
  const response = await fetch(uploadUrl, { method: 'PUT', body: file });
  if (!response.ok) {
    throw new Error(`Uploading ${file.name} failed (HTTP ${response.status}).`);
  }
}

// No dueBefore: the backend returns the department's full hydrant list (dueBefore=YYYY-MM
// selects only the hydrants whose flow test falls due in that one month).
export async function listHydrants(tokens: AuthTokenSource): Promise<Hydrant[]> {
  const response = await apiRequest('inspections/hydrants', tokens);
  const body = (await response.json()) as { hydrants: Hydrant[] };
  return body.hydrants;
}

export async function createHydrant(
  tokens: AuthTokenSource,
  input: CreateHydrantInput,
): Promise<Hydrant> {
  const response = await apiRequest('inspections/hydrants', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as Hydrant;
}

export async function updateHydrant(
  tokens: AuthTokenSource,
  hydrantId: string,
  input: UpdateHydrantInput,
): Promise<Hydrant> {
  const response = await apiRequest(
    `inspections/hydrants/${encodeURIComponent(hydrantId)}`,
    tokens,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return (await response.json()) as Hydrant;
}

export async function listDueInspections(
  tokens: AuthTokenSource,
  month?: string,
): Promise<Inspection[]> {
  const response = await apiRequest(
    `inspections${month ? `?month=${encodeURIComponent(month)}` : ''}`,
    tokens,
  );
  const body = (await response.json()) as { items: Inspection[] };
  return body.items;
}

export async function scheduleInspection(
  tokens: AuthTokenSource,
  occupancyId: string,
  scheduledDate: string,
): Promise<Inspection> {
  const response = await apiRequest('inspections', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ occupancyId, scheduledDate }),
  });
  return (await response.json()) as Inspection;
}

export async function conductInspection(
  tokens: AuthTokenSource,
  occupancyId: string,
  inspectionId: string,
  violations: Violation[],
): Promise<Inspection> {
  const response = await apiRequest('inspections', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ occupancyId, inspectionId, violations }),
  });
  return (await response.json()) as Inspection;
}

export async function queryMap(
  tokens: AuthTokenSource,
  bbox: BoundingBox,
): Promise<MapQueryResult> {
  const params = new URLSearchParams({
    minLat: String(bbox.minLat),
    minLng: String(bbox.minLng),
    maxLat: String(bbox.maxLat),
    maxLng: String(bbox.maxLng),
  });
  const response = await apiRequest(`inspections/map?${params.toString()}`, tokens);
  return (await response.json()) as MapQueryResult;
}
