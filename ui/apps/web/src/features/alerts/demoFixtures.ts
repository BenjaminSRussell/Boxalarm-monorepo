import type {
  CanaryStatus,
  DeliveryReceipt,
  DeviceState,
  DiagnosticsResult,
  DispatchAlert,
  ManualDispatchInput,
  RidingBoard,
  RosterEntry,
} from './types';

let dispatchCounter = 0;
const DISPATCHES = new Map<string, DispatchAlert>();
const ROSTERS = new Map<string, RosterEntry[]>();
const RECEIPTS = new Map<string, DeliveryReceipt[]>();
const RIDING_BOARDS = new Map<string, RidingBoard>();

const DEVICE_STATES = new Map<string, DeviceState>([
  [
    'm-2',
    {
      memberId: 'm-2',
      notificationPermission: true,
      criticalAlertPermission: true,
      batteryOptimizationExempt: true,
      appVersion: '1.4.0',
      osVersion: 'iOS 18.1',
      reportedAt: Math.floor(Date.now() / 1000) - 3600,
    },
  ],
]);

const CANARY_RUNS: readonly {
  ranAt: number;
  result: 'PASS' | 'FAIL';
  latencyMs: number;
  channelResults: Record<string, unknown>;
}[] = [
  {
    ranAt: Math.floor(Date.now() / 1000) - 90,
    result: 'PASS',
    latencyMs: 1800,
    channelResults: { push: 'PASS', sms: 'PASS', voice: 'PASS' },
  },
  {
    ranAt: Math.floor(Date.now() / 1000) - 210,
    result: 'PASS',
    latencyMs: 2100,
    channelResults: { push: 'PASS', sms: 'PASS', voice: 'PASS' },
  },
];

// Nichols FD's real apparatus (tenant data - never hardcoded outside fixtures/test data).
function seedRidingBoard(dispatchId: string): RidingBoard {
  return {
    dispatchId,
    apparatus: [
      {
        apparatusId: 'a-301',
        unitId: 'Engine 301',
        type: 'Engine',
        status: 'IN_SERVICE',
        assignable: true,
        positions: [
          { code: 'OFF', label: 'Officer' },
          { code: 'DRIVER', label: 'Driver/Operator', requiredQual: 'DRIVER_OPERATOR' },
          { code: 'FF1', label: 'Firefighter' },
        ],
      },
      {
        apparatusId: 'a-304',
        unitId: 'Truck 304',
        type: 'Ladder',
        status: 'IN_SERVICE',
        assignable: true,
        positions: [
          { code: 'OFF', label: 'Officer' },
          { code: 'DRIVER', label: 'Driver/Operator', requiredQual: 'DRIVER_OPERATOR' },
        ],
      },
      {
        apparatusId: 'a-309',
        unitId: 'Squad 309',
        type: 'Squad',
        status: 'OUT_OF_SERVICE',
        assignable: false,
        outOfServiceReason: 'Scheduled maintenance',
        positions: [{ code: 'DRIVER', label: 'Driver/Operator' }],
      },
    ],
  };
}

function seedDispatch(dispatchId: string, input?: Partial<DispatchAlert>): DispatchAlert {
  return {
    dispatchId,
    incidentType: input?.incidentType ?? 'Structure fire',
    address: input?.address ?? '18 Nichols Ave',
    crossStreets: input?.crossStreets ?? 'Main St & Nichols Ave',
    mapLink: input?.mapLink ?? null,
    narrative: input?.narrative ?? 'Smoke showing from the second floor.',
    prePlan: {
      summary: 'Two-story wood-frame occupancy, residential above commercial.',
      hazards: ['Rooftop solar array'],
      utilityShutoffs: [{ utility: 'Gas', location: 'Rear exterior wall' }],
      nearestHydrants: [{ hydrantId: 'H-014', size: '4"', flowRatingGpm: 1000 }],
    },
  };
}

function seedRoster(): RosterEntry[] {
  return [
    {
      memberId: 'm-2',
      name: 'Jordan Osei',
      ackStatus: 'RESPONDING',
      eta: Math.floor(Date.now() / 1000) + 10 * 60,
      assignedApparatusId: null,
      quals: ['FF1', 'DRIVER_OPERATOR'],
      lastAnsweredTone: 1,
    },
    {
      memberId: 'm-3',
      name: 'Casey Nolan',
      ackStatus: 'DIRECT_TO_SCENE',
      eta: Math.floor(Date.now() / 1000) + 4 * 60,
      assignedApparatusId: null,
      quals: ['FF1'],
      lastAnsweredTone: 1,
    },
    {
      memberId: 'm-5',
      name: 'Miguel Torres',
      ackStatus: 'UNANSWERED',
      eta: null,
      assignedApparatusId: null,
      quals: ['FF1'],
      lastAnsweredTone: null,
    },
  ];
}

function seedReceipts(roster: RosterEntry[]): DeliveryReceipt[] {
  const now = Math.floor(Date.now() / 1000);
  return roster.flatMap((entry) => [
    {
      memberId: entry.memberId,
      channel: 'PUSH',
      toneSequence: 1,
      status: entry.ackStatus === 'UNANSWERED' ? 'SENT_UNCONFIRMED' : 'DELIVERED',
      sentAt: now - 60,
      deliveredAt: entry.ackStatus === 'UNANSWERED' ? null : now - 55,
      openedAt: null,
      failureReason: null,
    },
    {
      memberId: entry.memberId,
      channel: 'SMS',
      toneSequence: 1,
      status: 'DELIVERED',
      sentAt: now - 60,
      deliveredAt: now - 50,
      openedAt: null,
      failureReason: null,
    },
  ]);
}

function ensureSeeded(dispatchId: string): void {
  if (DISPATCHES.has(dispatchId)) return;
  const dispatch = seedDispatch(dispatchId);
  const roster = seedRoster();
  DISPATCHES.set(dispatchId, dispatch);
  ROSTERS.set(dispatchId, roster);
  RECEIPTS.set(dispatchId, seedReceipts(roster));
  RIDING_BOARDS.set(dispatchId, seedRidingBoard(dispatchId));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Returns null when the path isn't an alerting/apparatus-riding-board route this file owns. */
export function demoAlertsRequest(
  path: string,
  method: string,
  body: Record<string, unknown>,
): Response | null {
  const parts = path.split('/');

  if (path === 'alerting/dispatches' && method === 'POST') {
    dispatchCounter += 1;
    const dispatchId = `MANUAL-${dispatchCounter}`;
    const input = body as unknown as ManualDispatchInput;
    ensureSeeded(dispatchId);
    DISPATCHES.set(dispatchId, seedDispatch(dispatchId, input));
    return json({ dispatchId, sourceSystem: 'MANUAL' }, 201);
  }

  if (
    parts[0] === 'alerting' &&
    parts[1] === 'dispatches' &&
    parts.length === 3 &&
    method === 'GET'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    ensureSeeded(dispatchId);
    return json(DISPATCHES.get(dispatchId));
  }

  if (
    parts[0] === 'alerting' &&
    parts[1] === 'dispatches' &&
    parts[3] === 'roster' &&
    method === 'GET'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    ensureSeeded(dispatchId);
    return json({ members: ROSTERS.get(dispatchId) ?? [] });
  }

  if (
    parts[0] === 'alerting' &&
    parts[1] === 'dispatches' &&
    parts[3] === 'receipts' &&
    method === 'GET'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    ensureSeeded(dispatchId);
    return json({ receipts: RECEIPTS.get(dispatchId) ?? [] });
  }

  if (
    parts[0] === 'alerting' &&
    parts[1] === 'dispatches' &&
    parts[3] === 'diagnostics' &&
    parts.length === 5 &&
    method === 'GET'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    const memberId = decodeURIComponent(parts[4] ?? '');
    ensureSeeded(dispatchId);
    const roster = ROSTERS.get(dispatchId) ?? [];
    const onEligibleRoster = roster.some((entry) => entry.memberId === memberId);
    const receipts = onEligibleRoster
      ? (RECEIPTS.get(dispatchId) ?? []).filter((r) => r.memberId === memberId)
      : [];
    const result: DiagnosticsResult = {
      dispatchId,
      memberId,
      diagnosis: onEligibleRoster ? 'ON_ROSTER' : 'NOT_ON_ELIGIBLE_ROSTER',
      timeline: receipts.map((r) => ({
        entityType: 'DELIVERY_RECEIPT',
        channel: r.channel,
        toneSequence: r.toneSequence,
        status: r.status,
        sentAt: r.sentAt,
        deliveredAt: r.deliveredAt,
        openedAt: r.openedAt,
      })),
      deviceState: DEVICE_STATES.get(memberId) ?? null,
    };
    return json(result);
  }

  if (path === 'alerting/canary/status' && method === 'GET') {
    const latest = CANARY_RUNS[0];
    const status: CanaryStatus = {
      healthy: latest?.result === 'PASS',
      latestResult: latest?.result ?? null,
      latestLatencyMs: latest?.latencyMs ?? null,
      latestRanAt: latest?.ranAt ?? null,
      runs: [...CANARY_RUNS],
    };
    return json(status);
  }

  if (
    parts[0] === 'apparatus' &&
    parts[1] === 'riding-board' &&
    parts.length === 3 &&
    method === 'GET'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    ensureSeeded(dispatchId);
    return json(RIDING_BOARDS.get(dispatchId));
  }

  if (
    parts[0] === 'apparatus' &&
    parts[1] === 'riding-board' &&
    parts[3] === 'assignments' &&
    method === 'POST'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    ensureSeeded(dispatchId);
    const board = RIDING_BOARDS.get(dispatchId);
    const unit = board?.apparatus.find((a) => a.unitId === body.unitId);
    const position = unit?.positions.find((p) => p.code === body.positionCode);
    if (position) {
      position.assignment =
        body.memberId === null || body.memberId === undefined
          ? undefined
          : {
              memberId: body.memberId as string,
              version: ((body.expectedVersion as number) ?? 0) + 1,
              assignedAt: Math.floor(Date.now() / 1000),
              assignedBy: 'demo',
              qualStatus: 'NO_REQUIREMENT',
            };
    }
    return json({ dispatchId, replayed: false });
  }

  return null;
}
