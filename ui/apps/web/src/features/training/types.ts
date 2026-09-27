export type CertificationStatus = 'CURRENT' | 'EXPIRED' | 'REVOKED';

export interface Certification {
  certId: string;
  memberId: string;
  certType: string;
  issueDate: string;
  expiryDate: string;
  issuingAuthority: string;
  attachmentS3Key: string | null;
  status: CertificationStatus;
  uploadUrl?: string;
}

export interface CreateCertificationInput {
  certType: string;
  issueDate: string;
  expiryDate: string;
  issuingAuthority: string;
  attachmentFilename?: string;
}

export interface ExpiringCertification {
  certId: string;
  memberId: string;
  certType: string;
  expiryDate: string;
  issuingAuthority: string;
  status: CertificationStatus;
}

export interface TrainingEvent {
  eventId: string;
  title: string;
  category: string;
  startAt: number;
  endAt: number;
  signedUp: boolean;
}

export interface CreateTrainingEventInput {
  title: string;
  category: string;
  startAt: number;
  endAt: number;
}

export interface AttendeeHoursInput {
  memberId: string;
  hours: number;
}

export interface Transcript {
  memberId: string;
  certifications: readonly Certification[];
  attendance: readonly {
    eventId: string;
    category: string;
    hours: number;
    startAt: number;
  }[];
  hoursByCategory: Readonly<Record<string, number>>;
}

export type TranscriptExportFormat = 'csv' | 'pdf';

export interface CategoryHours {
  category: string;
  hours: number;
}

/** GET training/hours without memberId (training-service hoursHandler.ts roster path). */
export interface RosterTrainingHours {
  /** Epoch milliseconds, as sent. */
  from: number;
  to: number;
  members: { memberId: string; categories: CategoryHours[] }[];
}
