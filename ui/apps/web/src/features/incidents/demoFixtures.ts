import type { ProblemDetails } from '../../lib/apiClient';
import { CORE_SCHEMA, SECONDARY_SCHEMA } from './nerisSchema';
import type {
  CreateIncidentInput,
  Incident,
  IncidentDetail,
  IncidentSecondary,
  PutExposureInput,
  ResponseUnit,
  ResponseUnitType,
  SubmissionStatus,
  TimeField,
} from './types';
import { MAX_NARRATIVE_LENGTH, TIME_FIELDS } from './types';
import {
  missingRequiredCoreFields,
  missingRequiredSecondaryFields,
  validateCoreFields,
  validateSecondaryFields,
} from './validateEnum';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, title: string, detail?: string, errors?: unknown): Response {
  const body: ProblemDetails & { errors?: unknown } = {
    type: 'about:blank',
    title,
    status,
    traceId: 'demo',
    ...(detail ? { detail } : {}),
    ...(errors ? { errors } : {}),
  };
  return json(body, status);
}

const nowSeconds = Math.floor(Date.now() / 1000);
const daysAgo = (days: number) => nowSeconds - days * 86400;

let incidents: Incident[] = [
  {
    incidentId: 'i-1',
    deptId: 'nichols-fd',
    dispatchNumber: '26-001841',
    epochSeconds: daysAgo(40),
    nerisSchemaVersion: '2026.2',
    corePayload: {
      incident_type: 'STRUCTURE_FIRE',
      action_taken: 'EXTINGUISH',
      address: '14 Elm St, Trumbull, CT',
      narrative: 'Working fire, first floor kitchen, extinguished on arrival of Engine 301.',
    },
    incidentType: 'Structure fire',
    address: '14 Elm St, Trumbull, CT',
    alarmAt: daysAgo(40),
    dispatchAt: daysAgo(40) + 30,
    narrative: 'Working fire, first floor kitchen, extinguished on arrival of Engine 301.',
    status: 'VALIDATED',
    sourceDispatchId: 'd-100',
    createdBy: 'm-1',
    createdAt: daysAgo(40),
    updatedAt: daysAgo(39),
  },
  {
    incidentId: 'i-2',
    deptId: 'nichols-fd',
    dispatchNumber: '26-002014',
    epochSeconds: daysAgo(10),
    nerisSchemaVersion: '2026.2',
    corePayload: {
      incident_type: 'VEHICLE_FIRE',
      address: 'Route 111 & Daniels Farm Rd, Trumbull, CT',
    },
    incidentType: 'Motor vehicle accident',
    address: 'Route 111 & Daniels Farm Rd, Trumbull, CT',
    alarmAt: daysAgo(10),
    dispatchAt: daysAgo(10) + 90,
    narrative: 'Two-vehicle MVA, extrication not required.',
    status: 'DRAFT',
    sourceDispatchId: 'd-101',
    createdBy: 'm-2',
    createdAt: daysAgo(10),
    updatedAt: daysAgo(10),
  },
];

const unitsByIncident = new Map<string, ResponseUnit[]>([
  [
    'i-1',
    [
      {
        incidentId: 'i-1',
        unitId: 'Engine 301',
        unitType: 'APPARATUS',
        dispatchedAt: daysAgo(40) + 30,
        enRouteAt: daysAgo(40) + 90,
        assignedPositions: ['Officer'],
      },
      {
        incidentId: 'i-1',
        unitId: 'Truck 304',
        unitType: 'APPARATUS',
        dispatchedAt: daysAgo(40) + 45,
        assignedPositions: ['Driver'],
      },
    ],
  ],
  [
    'i-2',
    [
      {
        incidentId: 'i-2',
        unitId: 'Rescue 300',
        unitType: 'APPARATUS',
        dispatchedAt: daysAgo(10) + 90,
        assignedPositions: ['Officer'],
      },
      {
        incidentId: 'i-2',
        unitId: 'Squad 309',
        unitType: 'APPARATUS',
        dispatchedAt: daysAgo(10) + 120,
        assignedPositions: ['Firefighter'],
      },
    ],
  ],
]);

const membersByIncident = new Map<string, IncidentDetail['respondingMembers']>([
  [
    'i-1',
    [
      { memberId: 'm-rivera', status: 'RESPONDING' },
      { memberId: 'm-chen', status: 'RESPONDING' },
    ],
  ],
  ['i-2', [{ memberId: 'm-owens', status: 'RESPONDING' }]],
]);

const secondariesByIncident = new Map<string, IncidentSecondary[]>([
  [
    'i-1',
    [
      {
        incidentId: 'i-1',
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: ['m-rivera'],
        complete: true,
        updatedAt: daysAgo(39),
      },
    ],
  ],
]);

const seededDispatches: Record<
  string,
  Pick<Incident, 'incidentType' | 'address' | 'narrative' | 'alarmAt' | 'dispatchAt'> & {
    units: Array<Pick<ResponseUnit, 'unitId' | 'unitType' | 'assignedPositions'>>;
    members: NonNullable<IncidentDetail['respondingMembers']>;
  }
> = {
  'd-1': {
    incidentType: 'Structure fire',
    address: '212 Church Hill Rd, Trumbull, CT',
    narrative: 'Smoke showing on arrival, Engine 301 first-due, Truck 304 laddered the rear.',
    alarmAt: nowSeconds - 600,
    dispatchAt: nowSeconds - 570,
    units: [
      { unitId: 'Engine 301', unitType: 'APPARATUS', assignedPositions: ['Officer'] },
      { unitId: 'Truck 304', unitType: 'APPARATUS', assignedPositions: ['Driver'] },
      { unitId: 'Engine 305', unitType: 'APPARATUS', assignedPositions: ['Firefighter'] },
    ],
    members: [
      { memberId: 'm-rivera', status: 'RESPONDING' },
      { memberId: 'm-chen', status: 'RESPONDING' },
    ],
  },
};

const submissionByIncident = new Map<string, SubmissionStatus>();

function findById(incidentId: string): Incident | undefined {
  return incidents.find((incident) => incident.incidentId === incidentId);
}

function toDetail(incident: Incident): IncidentDetail {
  return {
    ...incident,
    respondingUnits: unitsByIncident.get(incident.incidentId) ?? [],
    respondingMembers: membersByIncident.get(incident.incidentId) ?? [],
    secondaryModules: secondariesByIncident.get(incident.incidentId) ?? [],
  };
}

function stringFields(payload: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') fields[key] = value;
  }
  return fields;
}

export async function incidentsDemoRequest(
  path: string,
  method: string,
  body: Record<string, unknown>,
  query: URLSearchParams,
): Promise<Response | undefined> {
  const parts = path.split('/');
  if (parts[0] !== 'incidents') return undefined;

  if (path === 'incidents' && method === 'GET') {
    const from = Number(query.get('fromAlarmAt'));
    const to = Number(query.get('toAlarmAt'));
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return problem(400, 'Bad Request', 'fromAlarmAt and toAlarmAt are required');
    }
    if (from > to) return problem(400, 'Bad Request', 'fromAlarmAt must not be after toAlarmAt');
    const inRange = incidents
      .filter((incident) => (incident.alarmAt ?? 0) >= from && (incident.alarmAt ?? 0) <= to)
      .sort((a, b) => (a.alarmAt ?? 0) - (b.alarmAt ?? 0));
    return json({ incidents: inRange });
  }

  if (path === 'incidents' && method === 'POST') {
    const input = body as unknown as CreateIncidentInput;
    const seed = seededDispatches[input.dispatchId];
    if (!seed) {
      return problem(
        404,
        'Not Found',
        `No dispatch alert found for dispatchId "${input.dispatchId}".`,
      );
    }
    const created: Incident = {
      incidentId: `i-${incidents.length + 1}`,
      deptId: 'nichols-fd',
      dispatchNumber: `26-${2000 + incidents.length}`,
      epochSeconds: nowSeconds,
      nerisSchemaVersion: '2026.2',
      corePayload: {
        incident_type: 'STRUCTURE_FIRE',
        address: seed.address,
        narrative: seed.narrative,
      },
      incidentType: seed.incidentType,
      address: seed.address,
      narrative: seed.narrative,
      alarmAt: seed.alarmAt,
      dispatchAt: seed.dispatchAt,
      status: 'DRAFT',
      sourceDispatchId: input.dispatchId,
      createdBy: 'demo-user',
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
    };
    const units: ResponseUnit[] = seed.units.map((unit) => ({
      incidentId: created.incidentId,
      unitId: unit.unitId,
      unitType: unit.unitType,
      dispatchedAt: seed.dispatchAt,
      assignedPositions: unit.assignedPositions,
    }));
    incidents = [...incidents, created];
    unitsByIncident.set(created.incidentId, units);
    membersByIncident.set(created.incidentId, seed.members);
    secondariesByIncident.set(created.incidentId, []);
    return json(toDetail(created), 201);
  }

  const incidentId = decodeURIComponent(parts[1] ?? '');
  const incident = findById(incidentId);
  if (!incident)
    return problem(404, 'Not Found', `No incident found with incidentId "${incidentId}".`);

  if (parts.length === 2 && method === 'GET') return json(toDetail(incident));

  if (parts.length === 2 && method === 'PUT') {
    const fields = body.fields;
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
      return problem(
        400,
        'Bad Request',
        'fields is required and must be a JSON object of field:value pairs',
      );
    }
    const record = fields as Record<string, unknown>;
    const nextFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== 'string') {
        return problem(400, 'Bad Request', `field "${key}" must be a string`);
      }
      nextFields[key] = value;
    }
    const errors = validateCoreFields(CORE_SCHEMA, nextFields);
    if (errors.length > 0) {
      return problem(
        400,
        'Bad Request',
        'One or more fields failed NERIS enumeration validation.',
        errors,
      );
    }
    const merged = { ...stringFields(incident.corePayload), ...nextFields };
    const missing = missingRequiredCoreFields(CORE_SCHEMA, merged);
    const updated: Incident = {
      ...incident,
      corePayload: { ...incident.corePayload, ...nextFields },
      status: missing.length === 0 ? 'VALIDATED' : incident.status,
      updatedAt: nowSeconds,
    };
    incidents = incidents.map((item) => (item.incidentId === incidentId ? updated : item));
    return json(updated);
  }

  // Demo NERIS submission: the worker is simulated as accepting on the next status read.
  if (parts[2] === 'submit' && method === 'POST') {
    if (incident.status !== 'VALIDATED') {
      return problem(
        409,
        'Conflict',
        `incident "${incidentId}" is not VALIDATED and cannot be submitted (current status "${incident.status}")`,
      );
    }
    const submitted: Incident = { ...incident, status: 'SUBMITTED', updatedAt: nowSeconds };
    incidents = incidents.map((item) => (item.incidentId === incidentId ? submitted : item));
    submissionByIncident.set(incidentId, 'SUBMITTED');
    return json({ incidentId, submissionStatus: 'SUBMITTED' }, 202);
  }

  if (parts[2] === 'submission' && parts.length === 3 && method === 'GET') {
    const submissionStatus = submissionByIncident.get(incidentId) ?? null;
    if (submissionStatus === 'SUBMITTED' || submissionStatus === 'RETRYING') {
      submissionByIncident.set(incidentId, 'ACCEPTED');
      incidents = incidents.map((item) =>
        item.incidentId === incidentId ? { ...item, status: 'ACCEPTED' } : item,
      );
    }
    return json({ incidentId, status: incident.status, submissionStatus });
  }

  if (parts[2] === 'submission' && parts[3] === 'retry' && method === 'POST') {
    if (submissionByIncident.get(incidentId) !== 'FAILED') {
      return problem(409, 'Conflict', `incident "${incidentId}" submission is not FAILED`);
    }
    submissionByIncident.set(incidentId, 'RETRYING');
    return json({ incidentId, submissionStatus: 'RETRYING' }, 202);
  }

  if (parts[2] === 'narrative' && method === 'PUT') {
    const narrative = body.narrative;
    if (typeof narrative !== 'string') {
      return problem(400, 'Bad Request', 'narrative is required and must be a string');
    }
    if (narrative.length > MAX_NARRATIVE_LENGTH) {
      return problem(
        400,
        'Bad Request',
        `narrative must not exceed ${MAX_NARRATIVE_LENGTH} characters; received ${narrative.length}`,
      );
    }
    const updated: Incident = {
      ...incident,
      narrative,
      corePayload: { ...incident.corePayload, narrative },
      updatedAt: nowSeconds,
    };
    incidents = incidents.map((item) => (item.incidentId === incidentId ? updated : item));
    return json(updated);
  }

  if (parts[2] === 'response-times' && method === 'PUT') {
    const unitId = body.unitId;
    const unitType = body.unitType;
    if (typeof unitId !== 'string' || unitId.length === 0) {
      return problem(400, 'Bad Request', 'unitId is required and must be a non-empty string');
    }
    if (unitType !== 'APPARATUS' && unitType !== 'MEMBER') {
      return problem(400, 'Bad Request', 'unitType must be one of: APPARATUS, MEMBER');
    }
    const existing = unitsByIncident.get(incidentId) ?? [];
    const prior = existing.find((unit) => unit.unitId === unitId);
    const next: ResponseUnit = {
      incidentId,
      unitId,
      unitType: unitType as ResponseUnitType,
      ...(prior?.dispatchedAt !== undefined ? { dispatchedAt: prior.dispatchedAt } : {}),
      ...(prior?.enRouteAt !== undefined ? { enRouteAt: prior.enRouteAt } : {}),
      ...(prior?.arrivedAt !== undefined ? { arrivedAt: prior.arrivedAt } : {}),
      ...(prior?.clearedAt !== undefined ? { clearedAt: prior.clearedAt } : {}),
      ...(prior?.assignedPositions ? { assignedPositions: prior.assignedPositions } : {}),
    };
    for (const field of TIME_FIELDS) {
      if (body[field] === undefined) continue;
      if (typeof body[field] !== 'number') {
        return problem(400, 'Bad Request', `${field} must be a finite number`);
      }
      next[field as TimeField] = body[field] as number;
    }
    const replaced = prior
      ? existing.map((unit) => (unit.unitId === unitId ? next : unit))
      : [...existing, next];
    unitsByIncident.set(incidentId, replaced);
    return json(next);
  }

  if (parts[2] === 'exposures' && method === 'PUT') {
    const input = body as unknown as PutExposureInput;
    if (typeof input.secondaryType !== 'string' || input.secondaryType.length === 0) {
      return problem(
        400,
        'Bad Request',
        'secondaryType is required and must be a non-empty string',
      );
    }
    const payload = input.payload ?? {};
    const errors = validateSecondaryFields(SECONDARY_SCHEMA, input.secondaryType, payload);
    if (errors.length > 0) {
      return problem(
        400,
        'Bad Request',
        'One or more fields failed NERIS Secondary enumeration validation.',
        errors,
      );
    }
    const missing = missingRequiredSecondaryFields(SECONDARY_SCHEMA, input.secondaryType, payload);
    const saved: IncidentSecondary = {
      incidentId,
      secondaryType: input.secondaryType,
      payload,
      affectedMemberIds: input.affectedMemberIds ?? [],
      complete: missing.length === 0,
      updatedAt: nowSeconds,
    };
    const current = secondariesByIncident.get(incidentId) ?? [];
    const without = current.filter((module) => module.secondaryType !== saved.secondaryType);
    secondariesByIncident.set(incidentId, [...without, saved]);
    return json({
      incidentId,
      secondaryType: saved.secondaryType,
      payload: saved.payload,
      affectedMemberIds: saved.affectedMemberIds,
      complete: saved.complete,
      updatedAt: saved.updatedAt,
    });
  }

  return problem(404, 'Not Found', 'Not found');
}
