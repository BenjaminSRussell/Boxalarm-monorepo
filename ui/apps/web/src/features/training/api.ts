import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type {
  AttendeeHoursInput,
  Certification,
  CreateCertificationInput,
  CreateTrainingEventInput,
  ExpiringCertification,
  RosterTrainingHours,
  Transcript,
  TranscriptExportFormat,
  TrainingEvent,
} from './types';

export async function listCertifications(
  tokens: AuthTokenSource,
  memberId: string,
): Promise<Certification[]> {
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/certifications`,
    tokens,
  );
  return (await response.json()) as Certification[];
}

export async function createCertification(
  tokens: AuthTokenSource,
  memberId: string,
  input: CreateCertificationInput,
): Promise<Certification> {
  const { attachmentFilename, ...rest } = input;
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/certifications`,
    tokens,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        attachmentFilename ? { ...rest, attachment: { filename: attachmentFilename } } : rest,
      ),
    },
  );
  return (await response.json()) as Certification;
}

export async function uploadCertificationAttachment(uploadUrl: string, file: File): Promise<void> {
  const response = await fetch(uploadUrl, { method: 'PUT', body: file });
  if (!response.ok) {
    throw new Error(`Attachment upload failed with status ${response.status}`);
  }
}

export async function revokeCertification(
  tokens: AuthTokenSource,
  memberId: string,
  certId: string,
): Promise<Certification> {
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/certifications/${encodeURIComponent(certId)}/revoke`,
    tokens,
    { method: 'POST' },
  );
  return (await response.json()) as Certification;
}

export async function listExpiringCertifications(
  tokens: AuthTokenSource,
): Promise<ExpiringCertification[]> {
  const response = await apiRequest('training/certifications/expiring', tokens);
  return (await response.json()) as ExpiringCertification[];
}

/** Department-wide hours by member and category for events starting in [from, to] (epoch ms). */
export async function getRosterTrainingHours(
  tokens: AuthTokenSource,
  from: number,
  to: number,
): Promise<RosterTrainingHours> {
  const response = await apiRequest(`training/hours?from=${from}&to=${to}`, tokens);
  return (await response.json()) as RosterTrainingHours;
}

export async function listTrainingEvents(tokens: AuthTokenSource): Promise<TrainingEvent[]> {
  const response = await apiRequest('training/events', tokens);
  return (await response.json()) as TrainingEvent[];
}

export async function createTrainingEvent(
  tokens: AuthTokenSource,
  input: CreateTrainingEventInput,
): Promise<TrainingEvent> {
  const response = await apiRequest('training/events', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const created = (await response.json()) as Omit<TrainingEvent, 'signedUp'>;
  return { ...created, signedUp: false };
}

export async function signUpForEvent(tokens: AuthTokenSource, eventId: string): Promise<void> {
  await apiRequest(`training/events/${encodeURIComponent(eventId)}/signup`, tokens, {
    method: 'POST',
  });
}

export async function recordEventHours(
  tokens: AuthTokenSource,
  eventId: string,
  attendees: readonly AttendeeHoursInput[],
): Promise<void> {
  await apiRequest(`training/events/${encodeURIComponent(eventId)}/signup`, tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attendees }),
  });
}

export async function getTranscript(
  tokens: AuthTokenSource,
  memberId: string,
): Promise<Transcript> {
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/transcript`,
    tokens,
  );
  return (await response.json()) as Transcript;
}

export async function downloadTranscript(
  tokens: AuthTokenSource,
  memberId: string,
  format: TranscriptExportFormat,
): Promise<Blob> {
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/transcript?format=${format}`,
    tokens,
  );
  return response.blob();
}
