import { demoAlertsRequest } from '../features/alerts/demoFixtures';
import { incidentsDemoRequest } from '../features/incidents/demoFixtures';
import { apparatusDemoRequest } from '../features/apparatus/demoFixtures';
import type {
  AssignedToType,
  ConsumableStock,
  CreateEquipmentAssetInput,
  EquipmentAsset,
  IssuePpeInput,
  LifecycleStatus,
  PpeAssignment,
} from '../features/inventory/types';
import type {
  CreateHydrantInput,
  CreateOccupancyInput,
  Hydrant,
  Inspection,
  Occupancy,
  PrePlanView,
  PutPrePlanInput,
  UpdateHydrantInput,
  UpdateOccupancyInput,
  Violation,
} from '../features/inspections/types';
import type { CreateMemberInput, Member, MemberStatus } from '../features/personnel/types';
import type {
  AuditEntry,
  ConfigResponse,
  DisposalResult,
  EditableConfigType,
  ExportStatus,
  RetentionConfig,
} from '../features/platform/types';
import { tryHandleLosapExtras } from '../features/losap/demoFixtures';
import { tryHandleNotificationExtras } from '../features/notifications/demoFixtures';
import { tryHandlePersonnelExtras } from '../features/personnel/demoFixtures';
import { tryHandleScheduleExtras } from '../features/schedule/demoFixtures';
import type { ApiRequestOptions, ProblemDetails } from './apiClient';
import { trainingDemoRequest } from './trainingDemoFixtures';

let members: Member[] = [
  {
    memberId: 'm-1',
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'arivera@nicholsfd.org',
    phone: '203-555-0111',
    status: 'ACTIVE',
    joinDate: '2018-04-12',
    rank: 'Chief',
    agencyId: 'nichols-fd',
  },
  {
    memberId: 'm-2',
    firstName: 'Jordan',
    lastName: 'Osei',
    email: 'josei@nicholsfd.org',
    phone: '203-555-0122',
    status: 'ACTIVE',
    joinDate: '2015-09-01',
    rank: 'Deputy Chief',
    agencyId: 'nichols-fd',
  },
  {
    memberId: 'm-3',
    firstName: 'Casey',
    lastName: 'Nolan',
    email: 'cnolan@nicholsfd.org',
    phone: '203-555-0133',
    status: 'ACTIVE',
    joinDate: '2019-06-20',
    rank: 'Captain',
    agencyId: 'nichols-fd',
  },
  {
    memberId: 'm-4',
    firstName: 'Priya',
    lastName: 'Shah',
    email: 'pshah@nicholsfd.org',
    phone: '203-555-0144',
    status: 'PROBATIONARY',
    joinDate: '2025-11-03',
    rank: 'Firefighter',
    agencyId: 'nichols-fd',
  },
  {
    memberId: 'm-5',
    firstName: 'Miguel',
    lastName: 'Torres',
    email: 'mtorres@nicholsfd.org',
    phone: '203-555-0155',
    status: 'LOA',
    joinDate: '2012-02-14',
    rank: 'Firefighter',
    agencyId: 'nichols-fd',
  },
];

const configStore = new Map<EditableConfigType, ConfigResponse>([
  [
    'ALERT_RULES',
    {
      configType: 'ALERT_RULES',
      value: { escalationThresholdN: 90 },
      version: 1,
      updatedAt: '2026-08-01T00:00:00.000Z',
      updatedBy: 'demo-admin',
    },
  ],
]);

let retentionConfig: RetentionConfig = { retentionYears: 7, version: 1, source: 'stored' };

const auditEntries: AuditEntry[] = [
  {
    actorId: 'demo-admin',
    ts: Date.parse('2026-08-01T00:00:00.000Z'),
    action: 'UPDATE',
    mutatedEntityType: 'DEPARTMENT_CONFIG',
    mutatedEntityId: 'ALERT_RULES',
    changedFields: { escalationThresholdN: { old: 60, new: 90 } },
  },
];

let equipment: EquipmentAsset[] = [
  {
    assetId: 'eq-1',
    deptId: 'nichols-fd',
    serialNumber: 'SCBA-4471',
    assignedToType: 'APPARATUS',
    assignedToId: 'a-2',
    location: 'Station 1',
    lifecycleStatus: 'IN_SERVICE',
  },
  {
    assetId: 'eq-2',
    deptId: 'nichols-fd',
    serialNumber: 'THERM-0092',
    assignedToType: 'APPARATUS',
    assignedToId: 'a-1',
    location: 'Station 1',
    lifecycleStatus: 'IN_SERVICE',
  },
  {
    assetId: 'eq-3',
    deptId: 'nichols-fd',
    serialNumber: 'RADIO-1187',
    location: 'Quartermaster shelf',
    lifecycleStatus: 'ACQUIRED',
  },
];

let ppeAssignments: PpeAssignment[] = [
  {
    ppeItemId: 'turnout-coat',
    memberId: 'm-1',
    itemType: 'turnout_coat',
    size: 'L',
    issueDate: '2020-05-01',
    nfpaExpiryDate: '2030-05-01',
    status: 'ISSUED',
  },
];

const consumables: ConsumableStock[] = [
  {
    itemId: 'foam-3pct',
    deptId: 'nichols-fd',
    itemName: 'Class A foam (3%)',
    stockLevel: 4,
    reorderThreshold: 8,
    location: 'Station 1',
    reorderFlagged: true,
  },
  {
    itemId: 'first-aid',
    deptId: 'nichols-fd',
    itemName: 'First aid kits',
    stockLevel: 12,
    reorderThreshold: 5,
    location: 'Station 1',
    reorderFlagged: false,
  },
];

let occupancies: Occupancy[] = [
  {
    occupancyId: 'occ-1',
    address: '12 Main St, Trumbull CT',
    occupancyType: 'Commercial',
    contacts: [{ name: 'Sam Lee', phone: '203-555-0199', role: 'Manager' }],
    hazards: ['Flammable storage'],
    latitude: 41.24,
    longitude: -73.19,
  },
];

const prePlans: Record<string, PrePlanView> = {};

let hydrants: Hydrant[] = [
  {
    hydrantId: 'HYD-014',
    latitude: 41.241,
    longitude: -73.191,
    size: '5 inch',
    flowRatingGpm: 1000,
    nextFlowTestDue: '2027-04-01',
    status: 'IN_SERVICE',
  },
  {
    hydrantId: 'HYD-022',
    latitude: 41.238,
    longitude: -73.188,
    size: '4 inch',
    flowRatingGpm: 750,
    nextFlowTestDue: '2026-11-01',
    status: 'OUT_OF_SERVICE',
  },
];

let inspections: Inspection[] = [
  {
    occupancyId: 'occ-1',
    inspectionId: 'insp-1',
    scheduledDate: '2026-10-01',
    violations: [],
    nextDueDate: '2026-10-01',
  },
];

let exportJobId = 0;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, title: string): Response {
  const body: ProblemDetails = { type: 'about:blank', title, status, traceId: 'demo' };
  return json(body, status);
}

export async function demoRequest(
  path: string,
  options: ApiRequestOptions = {},
): Promise<Response> {
  const method = (options.method ?? 'GET').toUpperCase();
  const body = options.body ? (JSON.parse(options.body as string) as Record<string, unknown>) : {};
  const [requestPath, queryString] = path.split('?');
  path = requestPath ?? path;
  const query = new URLSearchParams(queryString ?? '');
  const parts = path.split('/');

  if (parts[0] === 'incidents') {
    const incidentsResponse = await incidentsDemoRequest(path, method, body, query);
    if (incidentsResponse) return incidentsResponse;
  }

  const trainingResponse = await trainingDemoRequest(path, options);
  if (trainingResponse) return trainingResponse;

  const alertsResponse = demoAlertsRequest(path, method, body);
  if (alertsResponse) return alertsResponse;

  if (parts[0] === 'apparatus') {
    const response = await apparatusDemoRequest(path, method, body);
    if (response) return response;
  }

  if (path === 'personnel/members' && method === 'GET') return json({ items: members });

  if (path === 'personnel/members' && method === 'POST') {
    const input = body as unknown as CreateMemberInput;
    const created: Member = {
      memberId: `m-${members.length + 1}`,
      status: 'PROBATIONARY',
      ...input,
    };
    members = [...members, created];
    return json(created, 201);
  }

  if (
    parts[0] === 'personnel' &&
    parts[1] === 'members' &&
    parts.length === 3 &&
    method === 'GET'
  ) {
    const found = members.find((m) => m.memberId === decodeURIComponent(parts[2] ?? ''));
    return found ? json(found) : problem(404, 'Member not found');
  }

  if (
    parts[0] === 'personnel' &&
    parts[1] === 'members' &&
    parts[3] === 'status' &&
    method === 'PUT'
  ) {
    const id = decodeURIComponent(parts[2] ?? '');
    const status = (body as { status: MemberStatus }).status;
    let updated: Member | undefined;
    members = members.map((m) => {
      if (m.memberId !== id) return m;
      updated = { ...m, status };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Member not found');
  }

  if (parts[0] === 'platform' && parts[1] === 'config' && parts.length === 3) {
    const configType = decodeURIComponent(parts[2] ?? '') as EditableConfigType;
    if (method === 'GET') {
      const stored = configStore.get(configType);
      return stored ? json(stored) : problem(404, `config ${configType} not found`);
    }
    if (method === 'PUT') {
      const existing = configStore.get(configType);
      const nextVersion = (existing?.version ?? 0) + 1;
      const saved: ConfigResponse = {
        configType,
        value: (body as { value: Record<string, unknown> }).value,
        version: nextVersion,
        updatedAt: new Date().toISOString(),
        updatedBy: 'demo-admin',
      };
      configStore.set(configType, saved);
      return json(saved);
    }
  }

  if (path.startsWith('platform/audit') && method === 'GET') {
    return json({ entries: auditEntries });
  }

  if (path === 'platform/export' && method === 'POST') {
    exportJobId += 1;
    return json({ jobId: `demo-export-${exportJobId}` }, 202);
  }

  if (parts[0] === 'platform' && parts[1] === 'export' && parts.length === 3 && method === 'GET') {
    const status: ExportStatus = {
      status: 'COMPLETE',
      files: [{ table: 'members', url: '#demo-export-members' }],
    };
    return json(status);
  }

  if (path === 'platform/retention' && method === 'GET') {
    return json(retentionConfig);
  }

  if (path === 'platform/retention' && method === 'PUT') {
    const retentionYears = (body as { retentionYears: number }).retentionYears;
    retentionConfig = {
      retentionYears,
      version: (retentionConfig.version ?? 0) + 1,
      source: 'stored',
    };
    return json(retentionConfig);
  }

  if (path === 'platform/retention/disposal' && method === 'POST') {
    const result: DisposalResult = {
      retentionYearsUsed: retentionConfig.retentionYears,
      hardDeleted: 0,
      cryptoShredded: 0,
      refused: [],
    };
    return json(result);
  }

  if (path === 'platform/sessions/revoke' && method === 'POST') {
    const memberId = (body as { memberId: string }).memberId;
    return json({ memberId, status: 'revoked' }, 202);
  }

  if (path === 'inventory/equipment' && method === 'GET') {
    const assignedToType = query.get('assignedToType');
    const assignedToId = query.get('assignedToId');
    const filtered = equipment.filter(
      (a) =>
        (!assignedToType || a.assignedToType === assignedToType) &&
        (!assignedToId || a.assignedToId === assignedToId),
    );
    return json({ items: filtered });
  }

  if (path === 'inventory/equipment' && method === 'POST') {
    const input = body as unknown as CreateEquipmentAssetInput;
    const created: EquipmentAsset = {
      assetId: `eq-${equipment.length + 1}`,
      deptId: 'nichols-fd',
      serialNumber: input.serialNumber,
      location: input.location,
      lifecycleStatus: 'ACQUIRED',
    };
    equipment = [...equipment, created];
    return json(created, 201);
  }

  if (
    parts[0] === 'inventory' &&
    parts[1] === 'equipment' &&
    parts.length === 3 &&
    method === 'GET'
  ) {
    const found = equipment.find((a) => a.assetId === decodeURIComponent(parts[2] ?? ''));
    return found ? json(found) : problem(404, 'Equipment asset not found');
  }

  if (
    parts[0] === 'inventory' &&
    parts[1] === 'equipment' &&
    parts[3] === 'assignment' &&
    method === 'PUT'
  ) {
    const assetId = decodeURIComponent(parts[2] ?? '');
    const { assignedToType, assignedToId } = body as {
      assignedToType: AssignedToType;
      assignedToId: string;
    };
    let updated: EquipmentAsset | undefined;
    equipment = equipment.map((a) => {
      if (a.assetId !== assetId) return a;
      updated = { ...a, assignedToType, assignedToId };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Equipment asset not found');
  }

  if (
    parts[0] === 'inventory' &&
    parts[1] === 'equipment' &&
    parts[3] === 'location' &&
    method === 'PUT'
  ) {
    const assetId = decodeURIComponent(parts[2] ?? '');
    const { location } = body as { location: string };
    let updated: EquipmentAsset | undefined;
    equipment = equipment.map((a) => {
      if (a.assetId !== assetId) return a;
      updated = { ...a, location };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Equipment asset not found');
  }

  if (
    parts[0] === 'inventory' &&
    parts[1] === 'equipment' &&
    parts[3] === 'lifecycle' &&
    method === 'PUT'
  ) {
    const assetId = decodeURIComponent(parts[2] ?? '');
    const { lifecycleStatus } = body as { lifecycleStatus: LifecycleStatus };
    let updated: EquipmentAsset | undefined;
    equipment = equipment.map((a) => {
      if (a.assetId !== assetId) return a;
      updated = { ...a, lifecycleStatus };
      return updated;
    });
    return updated
      ? json({ assetId: updated.assetId, lifecycleStatus: updated.lifecycleStatus })
      : problem(404, 'Equipment asset not found');
  }

  if (path === 'inventory/consumables' && method === 'GET') return json({ items: consumables });

  if (parts[0] === 'inventory' && parts[1] === 'ppe' && parts.length === 3 && method === 'GET') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    return json(ppeAssignments.filter((p) => p.memberId === memberId));
  }

  if (parts[0] === 'inventory' && parts[1] === 'ppe' && parts.length === 3 && method === 'POST') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    const input = body as unknown as IssuePpeInput;
    const nfpaExpiryDate = `${Number(input.issueDate.slice(0, 4)) + 10}${input.issueDate.slice(4)}`;
    const created: PpeAssignment = {
      ppeItemId: input.itemType.replace(/_/g, '-'),
      memberId,
      itemType: input.itemType,
      size: input.size,
      issueDate: input.issueDate,
      nfpaExpiryDate,
      status: 'ISSUED',
    };
    ppeAssignments = [...ppeAssignments, created];
    return json(created, 201);
  }

  if (path === 'inspections/occupancies' && method === 'GET') return json({ items: occupancies });

  if (path === 'inspections/occupancies' && method === 'POST') {
    const input = body as unknown as CreateOccupancyInput;
    const created: Occupancy = { occupancyId: `occ-${occupancies.length + 1}`, ...input };
    occupancies = [...occupancies, created];
    return json(created, 201);
  }

  if (
    parts[0] === 'inspections' &&
    parts[1] === 'occupancies' &&
    parts.length === 3 &&
    method === 'GET'
  ) {
    const found = occupancies.find((o) => o.occupancyId === decodeURIComponent(parts[2] ?? ''));
    return found ? json(found) : problem(404, 'Occupancy not found');
  }

  if (
    parts[0] === 'inspections' &&
    parts[1] === 'occupancies' &&
    parts.length === 3 &&
    method === 'PUT'
  ) {
    const occupancyId = decodeURIComponent(parts[2] ?? '');
    const input = body as unknown as UpdateOccupancyInput;
    let updated: Occupancy | undefined;
    occupancies = occupancies.map((o) => {
      if (o.occupancyId !== occupancyId) return o;
      updated = { ...o, ...input };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Occupancy not found');
  }

  if (
    parts[0] === 'inspections' &&
    parts[1] === 'occupancies' &&
    parts[3] === 'pre-plan' &&
    method === 'GET'
  ) {
    const occupancyId = decodeURIComponent(parts[2] ?? '');
    const prePlan = prePlans[occupancyId];
    return prePlan ? json(prePlan) : problem(404, 'No pre-plan on file');
  }

  if (
    parts[0] === 'inspections' &&
    parts[1] === 'occupancies' &&
    parts[3] === 'pre-plan' &&
    method === 'PUT'
  ) {
    const occupancyId = decodeURIComponent(parts[2] ?? '');
    const input = body as unknown as PutPrePlanInput;
    const prePlanId = prePlans[occupancyId]?.prePlanId ?? `preplan-${occupancyId}`;
    prePlans[occupancyId] = {
      prePlanId,
      siteDiagramS3Key: input.siteDiagramFilename ?? null,
      ...(input.siteDiagramFilename
        ? { siteDiagramUrl: `demo://${input.siteDiagramFilename}` }
        : {}),
      attachmentS3Keys: input.attachmentFilenames,
      attachmentUrls: input.attachmentFilenames.map((filename) => ({
        key: filename,
        url: `demo://${filename}`,
      })),
      utilityShutoffs: input.utilityShutoffs,
      hazards: input.hazards,
    };
    return json({
      prePlanId,
      ...(input.siteDiagramFilename
        ? { siteDiagramUploadUrl: `demo://upload/${input.siteDiagramFilename}` }
        : {}),
      attachmentUploadUrls: input.attachmentFilenames.map((filename) => ({
        filename,
        uploadUrl: `demo://upload/${filename}`,
      })),
      utilityShutoffs: input.utilityShutoffs,
      hazards: input.hazards,
    });
  }

  if (path.startsWith('inspections/hydrants') && method === 'GET') return json({ hydrants });

  if (path === 'inspections/hydrants' && method === 'POST') {
    const input = body as unknown as CreateHydrantInput;
    const created: Hydrant = { status: 'IN_SERVICE', ...input };
    hydrants = [...hydrants, created];
    return json(created, 201);
  }

  if (
    parts[0] === 'inspections' &&
    parts[1] === 'hydrants' &&
    parts.length === 3 &&
    method === 'PUT'
  ) {
    const hydrantId = decodeURIComponent(parts[2] ?? '');
    const input = body as unknown as UpdateHydrantInput;
    let updated: Hydrant | undefined;
    hydrants = hydrants.map((h) => {
      if (h.hydrantId !== hydrantId) return h;
      updated = { ...h, ...input };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Hydrant not found');
  }

  if (path.startsWith('inspections/map') && method === 'GET') {
    return json({
      occupancies: occupancies
        .filter((o) => o.latitude !== undefined && o.longitude !== undefined)
        .map((o) => ({ occupancyId: o.occupancyId, latitude: o.latitude, longitude: o.longitude })),
      hydrants: hydrants.map((h) => ({
        hydrantId: h.hydrantId,
        latitude: h.latitude,
        longitude: h.longitude,
        status: h.status,
      })),
    });
  }

  if (path.startsWith('inspections') && !path.includes('/') && method === 'GET') {
    return json({ items: inspections });
  }

  if (path === 'inspections' && method === 'POST') {
    const bodyRecord = body as {
      occupancyId: string;
      scheduledDate?: string;
      inspectionId?: string;
      violations?: Violation[];
    };
    if (bodyRecord.inspectionId) {
      let updated: Inspection | undefined;
      inspections = inspections.map((i) => {
        if (i.inspectionId !== bodyRecord.inspectionId) return i;
        updated = {
          ...i,
          conductedDate: new Date().toISOString(),
          conductedBy: 'demo-user',
          violations: bodyRecord.violations ?? [],
        };
        return updated;
      });
      return updated ? json(updated) : problem(404, 'Inspection not found');
    }
    const created: Inspection = {
      occupancyId: bodyRecord.occupancyId,
      inspectionId: `insp-${inspections.length + 1}`,
      scheduledDate: bodyRecord.scheduledDate ?? '',
      violations: [],
      nextDueDate: bodyRecord.scheduledDate ?? '',
    };
    inspections = [...inspections, created];
    return json(created, 201);
  }

  const extras =
    tryHandleScheduleExtras(parts, method, body) ??
    tryHandlePersonnelExtras(parts, method, body) ??
    tryHandleLosapExtras(parts, method, body) ??
    tryHandleNotificationExtras(parts, method, body);
  if (extras) return extras;

  return problem(404, 'Not found');
}
