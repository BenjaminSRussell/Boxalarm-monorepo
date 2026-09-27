export class MalformedEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedEventError';
  }
}

export interface DomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly deptId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type ProjectionWrite =
  | {
      readonly kind: 'update';
      readonly sk: string;
      readonly values: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'delete'; readonly sk: string };

const PROJECTION_EVENT_TYPES = new Set([
  'personnel.attendance.recorded',
  'personnel.member.updated',
  'personnel.member.created',
  'personnel.availability.changed',
  'neris.incident.submitted',
  'neris.submission.failed',
  'training.expiry.due',
  'cert.expiry.due',
  'apparatus.out_of_service',
  'apparatus.defect.reported',
  'scheduling.coverage_gap.detected',
]);

export function isProjectionEvent(eventType: string): boolean {
  return PROJECTION_EVENT_TYPES.has(eventType);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireString(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = stringField(payload, key);
  if (!value) {
    throw new MalformedEventError(`${key} is required`);
  }
  return value;
}

function epochMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
}

export function parseDomainEvent(body: string): DomainEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    throw new MalformedEventError('event body is not JSON');
  }
  const root = asRecord(raw);
  if (!root) {
    throw new MalformedEventError('event body must be an object');
  }

  let detail: Record<string, unknown> | undefined;
  if (typeof root.detail === 'string') {
    try {
      detail = asRecord(JSON.parse(root.detail) as unknown);
    } catch {
      throw new MalformedEventError('event detail is not JSON');
    }
  } else {
    detail = asRecord(root.detail);
  }
  const source = detail ?? root;
  const payload = asRecord(source.payload) ?? source;
  const eventId = stringField(source, 'eventId') ?? stringField(root, 'id');
  const eventType = stringField(source, 'eventType') ?? stringField(root, 'detail-type');
  const deptId =
    stringField(payload, 'deptId') ??
    stringField(payload, 'departmentId') ??
    stringField(source, 'deptId');
  if (!eventId || !eventType || !deptId) {
    throw new MalformedEventError('event is missing eventId, eventType, or deptId');
  }
  return { eventId, eventType, deptId, payload };
}

function memberStatusWrite(payload: Readonly<Record<string, unknown>>): ProjectionWrite {
  const memberId = requireString(payload, 'memberId');
  const status = stringField(payload, 'newStatus') ?? stringField(payload, 'status');
  if (!status) {
    throw new MalformedEventError('newStatus is required');
  }
  return {
    kind: 'update',
    sk: `MEMBER#${memberId}`,
    values: { entityType: 'REPORTING_MEMBER', memberId, status },
  };
}

function apparatusUnitId(payload: Readonly<Record<string, unknown>>): string {
  return stringField(payload, 'unitId') ?? requireString(payload, 'apparatusId');
}

export function projectionWrites(event: DomainEvent, nowMs: number): readonly ProjectionWrite[] {
  const payload = event.payload;
  switch (event.eventType) {
    case 'personnel.attendance.recorded': {
      const memberId = requireString(payload, 'memberId');
      const activityId = requireString(payload, 'activityId');
      return [
        {
          kind: 'update',
          sk: `ATTENDANCE#${activityId}#${memberId}`,
          values: {
            entityType: 'REPORTING_ATTENDANCE',
            memberId,
            activityId,
            activityType: stringField(payload, 'activityType') ?? 'UNKNOWN',
            losapPoints: typeof payload.losapPoints === 'number' ? payload.losapPoints : 0,
          },
        },
      ];
    }
    case 'personnel.member.updated':
      // member.updated also carries profile, push-token and role changes, which hold no
      // status and have nothing for the status rollup.
      // memberId is checked first, so a payload with neither still reaches the DLQ.
      requireString(payload, 'memberId');
      return payload.status === undefined && payload.newStatus === undefined
        ? []
        : [memberStatusWrite(payload)];
    case 'personnel.member.created':
      return [memberStatusWrite(payload)];
    case 'personnel.availability.changed': {
      const memberId = requireString(payload, 'memberId');
      const state = stringField(payload, 'availabilityState') ?? 'MARKED_OFF';
      return [
        {
          kind: 'update',
          sk: `MEMBER#${memberId}`,
          values: {
            entityType: 'REPORTING_MEMBER',
            memberId,
            available: state !== 'MARKED_OFF',
          },
        },
      ];
    }
    case 'neris.incident.submitted': {
      const incidentId = requireString(payload, 'incidentId');
      const submissionStatus = stringField(payload, 'submissionStatus') ?? 'SUBMITTED';
      return [
        {
          kind: 'update',
          sk: `NERIS#${incidentId}`,
          values: {
            entityType: 'REPORTING_NERIS',
            incidentId,
            status: submissionStatus,
          },
        },
      ];
    }
    case 'neris.submission.failed': {
      const incidentId = requireString(payload, 'incidentId');
      const willRetry = payload.willRetry === true;
      return [
        {
          kind: 'update',
          sk: `NERIS#${incidentId}`,
          values: {
            entityType: 'REPORTING_NERIS',
            incidentId,
            status: willRetry ? 'PENDING' : 'FAILED',
            failureReason: stringField(payload, 'failureReason') ?? 'unknown',
            ...(typeof payload.httpStatus === 'number' ? { httpStatus: payload.httpStatus } : {}),
          },
        },
      ];
    }
    case 'training.expiry.due':
    case 'cert.expiry.due': {
      const memberId = requireString(payload, 'memberId');
      const certId = requireString(payload, 'certId');
      const expiryDate = requireString(payload, 'expiryDate');
      return [
        {
          kind: 'update',
          sk: `CERT#${certId}`,
          values: { entityType: 'REPORTING_CERT', memberId, certId, expiryDate },
        },
      ];
    }
    case 'apparatus.out_of_service': {
      const unitId = apparatusUnitId(payload);
      const status = stringField(payload, 'status') ?? 'OUT_OF_SERVICE';
      if (status === 'IN_SERVICE') {
        return [{ kind: 'delete', sk: `OOS#${unitId}` }];
      }
      return [
        {
          kind: 'update',
          sk: `OOS#${unitId}`,
          values: {
            entityType: 'REPORTING_OOS',
            unitId,
            reason: stringField(payload, 'reason') ?? 'unspecified',
            startedAt: epochMs(payload.startAt, nowMs),
          },
        },
      ];
    }
    case 'apparatus.defect.reported': {
      const outOfService = payload.outOfService === true || payload.severity === 'OUT_OF_SERVICE';
      if (!outOfService) {
        return [];
      }
      const unitId = apparatusUnitId(payload);
      return [
        {
          kind: 'update',
          sk: `OOS#${unitId}`,
          values: {
            entityType: 'REPORTING_OOS',
            unitId,
            reason: stringField(payload, 'reason') ?? stringField(payload, 'summary') ?? 'defect',
            startedAt: epochMs(payload.reportedAt, nowMs),
          },
        },
      ];
    }
    case 'scheduling.coverage_gap.detected': {
      const shiftId = requireString(payload, 'shiftId');
      return [
        {
          kind: 'update',
          sk: `COVERAGE#${shiftId}`,
          values: {
            entityType: 'REPORTING_COVERAGE',
            shiftId,
            gapReason: stringField(payload, 'gapReason') ?? 'unspecified',
            requiredQuals: payload.requiredQuals ?? [],
          },
        },
      ];
    }
    default:
      throw new MalformedEventError(`unsupported event type ${event.eventType}`);
  }
}
