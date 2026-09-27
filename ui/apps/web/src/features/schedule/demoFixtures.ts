import type { DutyShift, ShiftCoverage } from './types';

let shifts: DutyShift[] = [
  {
    shiftId: 's-1',
    startAt: 1758391200000,
    endAt: 1758434400000,
    stationId: 'STATION-1',
    status: 'OPEN',
  },
];

const coverage: ShiftCoverage[] = [
  {
    shiftId: 's-1',
    startAt: 1758391200000,
    endAt: 1758434400000,
    stationId: 'STATION-1',
    status: 'short',
    positions: [
      { positionCode: 'DRIVER', requiredQual: 'DRIVER_OPERATOR', status: 'short' },
      { positionCode: 'OFFICER', status: 'covered' },
    ],
  },
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function tryHandleScheduleExtras(
  parts: string[],
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  if (parts[0] !== 'personnel' || parts[1] !== 'shifts') return undefined;

  if (parts.length === 2 && method === 'GET') return json({ shifts });
  if (parts.length === 2 && method === 'POST') {
    const created: DutyShift = {
      shiftId: `s-${shifts.length + 1}`,
      startAt: body.startAt as number,
      endAt: body.endAt as number,
      stationId: body.stationId as string,
      status: 'OPEN',
    };
    shifts = [...shifts, created];
    return json({ ...created, positions: body.positions }, 201);
  }
  if (parts[2] === 'coverage' && method === 'GET') return json({ shifts: coverage });
  if (parts[3] === 'swap' && parts[5] === 'approve' && method === 'POST') {
    return json({
      shiftId: parts[2],
      swapId: Number(parts[4]),
      status: 'APPROVED',
      claimedByMemberId: 'm-demo',
    });
  }

  return undefined;
}
