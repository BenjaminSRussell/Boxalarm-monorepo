export type AckStatus = 'RESPONDING' | 'NOT_RESPONDING' | 'DIRECT_TO_SCENE' | 'UNANSWERED';

export interface RosterEntry {
  memberId: string;
  name: string;
  ackStatus: AckStatus;
  eta: number | null;
  assignedApparatusId: string | null;
  quals: string[];
  lastAnsweredTone: number | null;
}

export interface UtilityShutoff {
  utility: string;
  location: string;
}

export interface NearestHydrant {
  hydrantId: string;
  status?: string;
  size?: string;
  flowRatingGpm?: number;
}

export interface PrePlanEnrichment {
  summary?: string;
  hazards: string[];
  utilityShutoffs: UtilityShutoff[];
  nearestHydrants: NearestHydrant[];
}

export type ToneLadderStatus = 'ACTIVE' | 'HALTED_MANUAL' | 'COMPLETED';

/** GET /alerting/dispatches/{id} `toneLadder` (F1.14). */
export interface ToneLadder {
  status: ToneLadderStatus | string;
  currentToneSequence: number;
  nextToneAt: number | null;
}

/** The MUTUAL_AID_EVENT projection (F1.13). */
export interface MutualAid {
  triggeredAt: number | null;
  reason: string | null;
  triggeredBy: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
  notes: string | null;
}

export interface DispatchAlert {
  dispatchId: string;
  incidentType: string;
  address: string;
  crossStreets: string;
  mapLink: string | null;
  narrative: string;
  prePlan?: PrePlanEnrichment | null;
  toneLadder?: ToneLadder;
  /** null = not requested; absent = the server could not read it (state unknown). */
  mutualAid?: MutualAid | null;
}

export interface AdvanceToneResult {
  dispatchId: string;
  toneSequence: number;
  outcome: string;
}

export interface HaltToneLadderResult {
  dispatchId: string;
  toneLadder: { status: string; currentToneSequence: number };
  changed: boolean;
}

export interface TriggerMutualAidResult {
  dispatchId: string;
  created: boolean;
  /** Officers pushed by this request; null when mutual aid had already been requested. */
  officersNotified: number | null;
  mutualAid: MutualAid | null;
}

export interface AcknowledgeMutualAidResult {
  dispatchId: string;
  changed: boolean;
  mutualAid: MutualAid;
}

export type DeliveryReceiptStatus = 'FAILED' | 'OPENED' | 'DELIVERED' | 'SENT_UNCONFIRMED' | 'SENT';

export interface DeliveryReceipt {
  memberId: string;
  channel: string;
  toneSequence: number;
  status: DeliveryReceiptStatus;
  sentAt: number;
  deliveredAt: number | null;
  openedAt: number | null;
  failureReason: string | null;
}

export interface ManualDispatchInput {
  incidentType: string;
  address: string;
  crossStreets: string;
  unitsRequested: string[];
  narrative: string;
  externalDispatchId: string;
}

export interface FieldError {
  field: string;
  message: string;
}

export type SeatQualStatus = 'MET' | 'UNMET' | 'NO_REQUIREMENT';

export interface RidingSeatAssignment {
  memberId: string;
  version: number;
  assignedAt: number;
  assignedBy: string;
  qualStatus: SeatQualStatus;
}

export interface RidingSeatPosition {
  code: string;
  label: string;
  requiredQual?: string;
  assignment?: RidingSeatAssignment;
}

export interface RidingBoardApparatus {
  apparatusId: string;
  unitId: string;
  type: string;
  status: 'IN_SERVICE' | 'OUT_OF_SERVICE';
  assignable: boolean;
  outOfServiceReason?: string;
  positions: RidingSeatPosition[];
}

export interface RidingBoard {
  dispatchId: string;
  apparatus: RidingBoardApparatus[];
}

export type TimelineEntityType =
  'DELIVERY_RECEIPT' | 'ESCALATION_EVENT' | 'DISPATCH_RESPONSE_RECORD';

// Raw items from the DISPATCH pk (alerting-service audit/queryAuditLog.ts
// queryMemberDispatchTimeline) - fields present depend on entityType, so most are optional.
export interface DiagnosticsTimelineEntry {
  entityType: TimelineEntityType | string;
  channel?: string;
  toneSequence?: number;
  status?: string;
  sentAt?: number;
  deliveredAt?: number | null;
  openedAt?: number | null;
  escalatedAt?: number;
  reason?: string;
  answeredAt?: number;
  ackStatus?: string;
}

export interface DeviceState {
  memberId: string;
  notificationPermission: boolean;
  criticalAlertPermission: boolean;
  batteryOptimizationExempt: boolean;
  appVersion: string;
  osVersion: string;
  reportedAt: number;
}

export type Diagnosis = 'ON_ROSTER' | 'NOT_ON_ELIGIBLE_ROSTER';

export interface DiagnosticsResult {
  dispatchId: string;
  memberId: string;
  diagnosis: Diagnosis;
  timeline: DiagnosticsTimelineEntry[];
  deviceState: DeviceState | null;
}

export type CanaryResult = 'PASS' | 'FAIL';

export interface CanaryRun {
  ranAt: number;
  result: CanaryResult;
  latencyMs: number;
  channelResults: Record<string, unknown>;
}

export interface CanaryStatus {
  healthy: boolean;
  latestResult: CanaryResult | null;
  latestLatencyMs: number | null;
  latestRanAt: number | null;
  runs: CanaryRun[];
}
