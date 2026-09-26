import type { ProblemDetails } from '../../lib/apiClient';
import {
  REPORT_NAMES,
  type DashboardView,
  type ExportFormat,
  type GrantsReport,
  type IsoReport,
  type LosapYearEndReport,
  type MembershipTrends,
  type ReportExportJob,
  type ReportName,
  type ResponseTimeAnalytics,
} from './types';

/**
 * VITE_DEMO fixtures for /reporting, shaped exactly like the reporting-service responses and
 * keyed to the other demo stores' ids (members m-1..m-5, units Engine 301 / Truck 304,
 * incidents i-1 / i-2, hydrants HYD-014 / HYD-022). Validation mirrors the handlers', so a
 * bad range fails in demo the way it fails for real.
 */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, title: string, detail?: string): Response {
  const body: ProblemDetails = { type: 'about:blank', title, status, traceId: 'demo', detail };
  return json(body, status);
}

const DAY_S = 86_400;

function dashboard(): DashboardView {
  return {
    lastUpdated: new Date(Date.now() - 12 * 60_000).toISOString(),
    staffing: {
      activeMemberCount: 3,
      unavailableCount: 1,
      shiftCoverage: {
        gapCount: 1,
        gaps: [{ shiftId: 'shift-sat-night', gapReason: 'No driver/operator' }],
      },
    },
    outOfServiceApparatus: [
      { unitId: 'Truck 304', reason: 'Aerial hydraulic leak', durationSeconds: 2 * DAY_S },
    ],
    expiringCertifications: {
      count: 1,
      certifications: [{ memberId: 'm-3', certId: 'EMR', expiryDate: isoDateInDays(21) }],
    },
    nerisCompliance: {
      pendingCount: 1,
      failedCount: 0,
      submissions: [{ incidentId: 'i-2', status: 'PENDING', href: '/api/v1/incidents/i-2' }],
    },
  };
}

function isoDateInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const RESPONSE_TIMES: ResponseTimeAnalytics = {
  units: [
    {
      incidentId: 'i-1',
      unitId: 'Engine 301',
      turnoutSeconds: 95,
      travelSeconds: 240,
      totalSeconds: 335,
    },
    {
      incidentId: 'i-1',
      unitId: 'Rescue 300',
      turnoutSeconds: 130,
      travelSeconds: 300,
      totalSeconds: 430,
    },
    {
      incidentId: 'i-2',
      unitId: 'Engine 305',
      turnoutSeconds: 110,
      travelSeconds: null,
      totalSeconds: null,
    },
  ],
  turnout: { medianSeconds: 110, p90Seconds: 126, sampleCount: 3, excludedCount: 0 },
  travel: { medianSeconds: 270, p90Seconds: 294, sampleCount: 2, excludedCount: 1 },
  total: { medianSeconds: 382.5, p90Seconds: 420.5, sampleCount: 2, excludedCount: 1 },
};

function isoReport(from: number, to: number): IsoReport {
  return {
    from,
    to,
    trainingHours: {
      totalHours: 46,
      categories: [
        { category: 'HAZMAT', totalHours: 12 },
        { category: 'PUMP_OPS', totalHours: 18 },
        { category: 'SEARCH_RESCUE', totalHours: 16 },
      ],
    },
    apparatusTests: {
      byType: [
        { testType: 'LADDER', passCount: 1, failCount: 1 },
        { testType: 'PUMP', passCount: 3, failCount: 0 },
      ],
    },
    hydrantFlowTests: {
      count: 2,
      currentCount: 1,
      overdueCount: 1,
      hydrants: [
        { hydrantId: 'HYD-014', nextFlowTestDue: '2027-04-01', current: true },
        { hydrantId: 'HYD-022', nextFlowTestDue: '2026-11-01', current: false },
      ],
    },
    responseTimes: RESPONSE_TIMES,
  };
}

function monthKeys(startDate: string, endDate: string): string[] {
  const keys: string[] = [];
  const cursor = new Date(`${startDate.slice(0, 7)}-01T00:00:00Z`);
  const end = endDate.slice(0, 7);
  while (cursor.toISOString().slice(0, 7) <= end && keys.length < 25) {
    keys.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

function membershipTrends(startDate: string, endDate: string): MembershipTrends {
  return {
    periodStart: `${startDate}T00:00:00.000Z`,
    periodEnd: `${endDate}T23:59:59.999Z`,
    startCount: 4,
    endCount: 4,
    joins: 1,
    departures: 1,
    netChange: 0,
    buckets: monthKeys(startDate, endDate).map((bucket, index) => ({
      bucket,
      activeMemberCount: 4,
      attendanceRateByActivityType: {
        CALL: index % 2 === 0 ? 0.75 : 0.5,
        DRILL: 0.5,
        MEETING: 0.25,
        WORK_DETAIL: 0,
        STANDBY: 0.25,
      },
    })),
  };
}

function grantsReport(periodStart: number, periodEnd: number): GrantsReport {
  return {
    periodStart,
    periodEnd,
    fields: [
      'activeMemberCount',
      'memberCountTrend',
      'totalIncidentVolume',
      'trainingHoursCompliance',
      'apparatusOutOfServiceHistory',
    ],
    fieldSetSource: 'default',
    activeMemberCount: 4,
    memberCountTrend: { joinedInPeriod: 1, trendMethod: 'joinDateApproximation' },
    totalIncidentVolume: { available: false, reason: 'E6-S1' },
    trainingHoursCompliance: { totalHours: 46, memberCount: 4, eventCount: 6 },
    apparatusOutOfServiceHistory: {
      records: [
        {
          unitId: 'Truck 304',
          reason: 'Aerial hydraulic leak',
          startAt: Date.now() - 2 * 86_400_000,
          endAt: null,
        },
      ],
      totalOutOfServiceEvents: 1,
    },
  };
}

function losapYearEnd(year: number): LosapYearEndReport {
  if (year !== new Date().getFullYear()) {
    return {
      deptId: 'nichols-fd',
      year,
      members: [],
      hasData: false,
      totalUnreadableEntryCount: 0,
    };
  }
  return {
    deptId: 'nichols-fd',
    year,
    members: [
      { memberId: 'm-1', totalPoints: 64, entryCount: 31, unreadableEntryCount: 0 },
      { memberId: 'm-2', totalPoints: 58, entryCount: 27, unreadableEntryCount: 0 },
      { memberId: 'm-3', totalPoints: 41, entryCount: 19, unreadableEntryCount: 0 },
      { memberId: 'm-4', totalPoints: 12, entryCount: 6, unreadableEntryCount: 0 },
    ],
    hasData: true,
    totalUnreadableEntryCount: 0,
  };
}

function epochRange(query: URLSearchParams): { from: number; to: number } | undefined {
  const from = Number(query.get('from'));
  const to = Number(query.get('to'));
  if (
    !query.get('from') ||
    !query.get('to') ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from > to
  ) {
    return undefined;
  }
  return { from, to };
}

const exportJobs = new Map<string, ReportExportJob>();
let exportCounter = 0;

export function reportingDemoRequest(
  path: string,
  method: string,
  query: URLSearchParams,
): Response | undefined {
  const parts = path.split('/');
  if (parts[0] !== 'reporting') return undefined;

  if (path === 'reporting/dashboard' && method === 'GET') return json(dashboard());

  if (path === 'reporting/response-times' && method === 'GET') {
    const range = epochRange(query);
    if (!range)
      return problem(400, 'Bad Request', 'from and to are required epoch seconds with from <= to');
    return json({ ...range, ...RESPONSE_TIMES });
  }

  if (path === 'reporting/iso' && method === 'GET') {
    const range = epochRange(query);
    if (!range)
      return problem(400, 'Bad Request', 'from and to are required epoch seconds with from <= to');
    return json(isoReport(range.from, range.to));
  }

  if (path === 'reporting/membership-trends' && method === 'GET') {
    const startDate = query.get('startDate') ?? '';
    const endDate = query.get('endDate') ?? '';
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
      startDate > endDate
    ) {
      return problem(
        400,
        'Bad Request',
        'startDate and endDate are required with startDate <= endDate',
      );
    }
    return json(membershipTrends(startDate, endDate));
  }

  if (path === 'reporting/grants' && method === 'GET') {
    const periodStart = Number(query.get('periodStart'));
    const periodEnd = Number(query.get('periodEnd'));
    if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || periodEnd <= periodStart) {
      return problem(400, 'Bad Request', 'periodEnd must be after periodStart');
    }
    return json(grantsReport(periodStart, periodEnd));
  }

  if (path === 'reporting/losap/year-end' && method === 'GET') {
    const year = query.get('year') ?? '';
    if (!/^\d{4}$/.test(year)) return problem(400, 'Bad Request', 'year must be a 4-digit year');
    return json(losapYearEnd(Number(year)));
  }

  if (path === 'reporting/export' && method === 'POST') {
    const report = query.get('report') ?? '';
    const format = query.get('format') ?? '';
    if (
      !(REPORT_NAMES as readonly string[]).includes(report) ||
      (format !== 'csv' && format !== 'pdf')
    ) {
      return problem(400, 'Bad Request', 'report and format are required');
    }
    exportCounter += 1;
    const jobId = `demo-report-export-${exportCounter}`;
    exportJobs.set(jobId, {
      jobId,
      report: report as ReportName,
      format: format as ExportFormat,
      status: 'COMPLETED',
      requestedAt: new Date().toISOString(),
      // Demo mode has no S3; a same-page anchor stands in for the signed link.
      downloadUrl: `#${jobId}`,
    });
    return json({ jobId, status: 'PENDING' }, 202);
  }

  if (parts[1] === 'export' && parts.length === 3 && method === 'GET') {
    const job = exportJobs.get(decodeURIComponent(parts[2] ?? ''));
    return job ? json(job) : problem(404, 'Not Found', 'export job was not found');
  }

  return undefined;
}
