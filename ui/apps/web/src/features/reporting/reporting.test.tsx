import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import { ReportingPage } from './ReportingPage';
import type {
  DashboardView,
  LosapYearEndReport,
  ResponseTimesReport,
  ReportExportJob,
} from './types';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'chief-1', 'cognito:groups': groups },
  } as unknown as User;
  return {
    getUser: vi.fn(async () => user),
    events: {
      addUserLoaded: () => undefined,
      removeUserLoaded: () => undefined,
      addUserUnloaded: () => undefined,
      removeUserUnloaded: () => undefined,
      addSilentRenewError: () => undefined,
      removeSilentRenewError: () => undefined,
    },
  } as unknown as UserManager;
}

function renderPage(groups: string[] = ['CHIEF']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={['/reporting']}>
          <Routes>
            <Route
              path="/reporting"
              element={
                <RequireRole>
                  <ReportingPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const DASHBOARD: DashboardView = {
  lastUpdated: '2026-09-26T12:00:00.000Z',
  staffing: {
    activeMemberCount: 17,
    unavailableCount: 2,
    shiftCoverage: { gapCount: 1, gaps: [{ shiftId: 'shift-9', gapReason: 'No driver' }] },
  },
  outOfServiceApparatus: [{ unitId: 'Truck 304', reason: 'Hydraulic leak', durationSeconds: 3900 }],
  expiringCertifications: { count: 0, certifications: [] },
  nerisCompliance: {
    pendingCount: 0,
    failedCount: 1,
    submissions: [{ incidentId: 'i-7', status: 'FAILED', href: '/api/v1/incidents/i-7' }],
  },
};

const EMPTY_SUMMARY = { medianSeconds: null, p90Seconds: null, sampleCount: 0, excludedCount: 0 };

function dashboardHandler(body: unknown, status = 200) {
  return http.get('/api/v1/reporting/dashboard', () =>
    HttpResponse.json(body as object, { status }),
  );
}

function problem(status: number, title: string) {
  return { type: 'about:blank', title, status, traceId: 't-1' };
}

async function openTab(name: string) {
  await userEvent.setup().click(await screen.findByRole('tab', { name }));
}

test('dashboard renders the real rollup figures and links a failed NERIS submission', async () => {
  server.use(dashboardHandler(DASHBOARD));
  renderPage();

  expect(await screen.findByText('17')).toBeTruthy();
  expect(screen.getByText('Active members')).toBeTruthy();
  expect(screen.getByText('1 failed')).toBeTruthy();
  expect(screen.getByRole('rowheader', { name: 'Truck 304' })).toBeTruthy();
  // 3900 s → 1:05:00
  expect(screen.getByText('1:05:00')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'i-7' }).getAttribute('href')).toBe('/incidents/i-7');
  expect(screen.getByText('No certifications are expiring.')).toBeTruthy();
});

test('dashboard with no projected events says so instead of showing zero tiles', async () => {
  server.use(
    dashboardHandler({
      ...DASHBOARD,
      lastUpdated: null,
      staffing: {
        activeMemberCount: 0,
        unavailableCount: 0,
        shiftCoverage: { gapCount: 0, gaps: [] },
      },
      outOfServiceApparatus: [],
      nerisCompliance: { pendingCount: 0, failedCount: 0, submissions: [] },
    }),
  );
  renderPage();

  expect(await screen.findByText('No dashboard data yet')).toBeTruthy();
  expect(screen.queryByText('Active members')).toBeNull();
});

test('a 403 from the report renders the forbidden state, not an empty report', async () => {
  server.use(dashboardHandler(problem(403, 'Forbidden'), 403));
  renderPage();

  expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
  expect(screen.queryByText('No dashboard data yet')).toBeNull();
});

test('a 503 renders a retryable error that refetches the report', async () => {
  let calls = 0;
  server.use(
    http.get('/api/v1/reporting/dashboard', () => {
      calls += 1;
      return calls === 1
        ? HttpResponse.json(problem(503, 'Service Unavailable'), { status: 503 })
        : HttpResponse.json(DASHBOARD);
    }),
  );
  renderPage();

  const retry = await screen.findByRole('button', { name: 'Try again' });
  await userEvent.setup().click(retry);
  expect(await screen.findByText('17')).toBeTruthy();
  expect(calls).toBe(2);
});

test('response times sends epoch-second bounds and formats turnout/travel/total', async () => {
  let seen: URLSearchParams | undefined;
  const report: ResponseTimesReport = {
    from: 0,
    to: 0,
    units: [
      {
        incidentId: 'i-1',
        unitId: 'Engine 301',
        turnoutSeconds: 95,
        travelSeconds: null,
        totalSeconds: null,
      },
    ],
    turnout: { medianSeconds: 95, p90Seconds: 95, sampleCount: 1, excludedCount: 0 },
    travel: { ...EMPTY_SUMMARY, excludedCount: 1 },
    total: { ...EMPTY_SUMMARY, excludedCount: 1 },
  };
  server.use(
    dashboardHandler(DASHBOARD),
    http.get('/api/v1/reporting/response-times', ({ request }) => {
      seen = new URL(request.url).searchParams;
      return HttpResponse.json(report);
    }),
  );
  renderPage();
  await openTab('Response times');

  expect(await screen.findByText('Turnout (median)')).toBeTruthy();
  const from = Number(seen?.get('from'));
  const to = Number(seen?.get('to'));
  expect(Number.isInteger(from)).toBe(true);
  // Seconds, not milliseconds: a 30-day window ends inside ~31 days of its start.
  expect(to - from).toBeGreaterThan(29 * 86_400);
  expect(to - from).toBeLessThan(32 * 86_400);
  expect(from).toBeLessThan(10_000_000_000);
  expect(screen.getAllByText('1:35').length).toBeGreaterThan(0);
  // An unmeasurable leg renders a dash, never a made-up zero.
  expect(screen.getByRole('cell', { name: 'Engine 301' })).toBeTruthy();
  expect(screen.getAllByText('—').length).toBeGreaterThan(0);
});

test('response times with no unit timestamps shows the empty state', async () => {
  server.use(
    dashboardHandler(DASHBOARD),
    http.get('/api/v1/reporting/response-times', () =>
      HttpResponse.json({
        from: 0,
        to: 0,
        units: [],
        turnout: EMPTY_SUMMARY,
        travel: EMPTY_SUMMARY,
        total: EMPTY_SUMMARY,
      }),
    ),
  );
  renderPage();
  await openTab('Response times');

  expect(await screen.findByText('No unit response times in this range')).toBeTruthy();
});

test('a from date after the to date is flagged and never requested', async () => {
  const request = vi.fn();
  server.use(
    dashboardHandler(DASHBOARD),
    http.get('/api/v1/reporting/iso', () => {
      request();
      return HttpResponse.json({
        from: 0,
        to: 0,
        trainingHours: { totalHours: 0, categories: [] },
        apparatusTests: { byType: [] },
        hydrantFlowTests: { count: 0, currentCount: 0, overdueCount: 0, hydrants: [] },
        responseTimes: {
          units: [],
          turnout: EMPTY_SUMMARY,
          travel: EMPTY_SUMMARY,
          total: EMPTY_SUMMARY,
        },
      });
    }),
  );
  renderPage();
  await openTab('ISO');
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

  const user = userEvent.setup();
  const fromInput = screen.getByLabelText('From');
  await user.clear(fromInput);
  await user.type(fromInput, '2099-01-01');

  expect(await screen.findByText('Must be on or after From.')).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(1);
});

test('grants shows incident volume as unavailable rather than a number', async () => {
  let seen: URLSearchParams | undefined;
  server.use(
    dashboardHandler(DASHBOARD),
    http.get('/api/v1/reporting/grants', ({ request }) => {
      seen = new URL(request.url).searchParams;
      return HttpResponse.json({
        periodStart: 1,
        periodEnd: 2,
        fields: [],
        fieldSetSource: 'default',
        activeMemberCount: 17,
        memberCountTrend: { joinedInPeriod: 2, trendMethod: 'joinDateApproximation' },
        totalIncidentVolume: { available: false, reason: 'E6-S1' },
        trainingHoursCompliance: { totalHours: 120, memberCount: 15, eventCount: 9 },
        apparatusOutOfServiceHistory: { records: [], totalOutOfServiceEvents: 0 },
      });
    }),
  );
  renderPage();
  await openTab('Grants');

  expect(await screen.findByText('Not available')).toBeTruthy();
  expect(screen.getByText('120')).toBeTruthy();
  // Grants bounds are epoch milliseconds.
  expect(Number(seen?.get('periodStart'))).toBeGreaterThan(1_000_000_000_000);
  expect(Number(seen?.get('periodEnd'))).toBeGreaterThan(Number(seen?.get('periodStart')));
});

test('membership trends refuses a range over 731 days without calling the API', async () => {
  const request = vi.fn();
  server.use(
    dashboardHandler(DASHBOARD),
    http.get('/api/v1/reporting/membership-trends', () => {
      request();
      return HttpResponse.json({
        periodStart: '',
        periodEnd: '',
        startCount: 4,
        endCount: 5,
        joins: 1,
        departures: 0,
        netChange: 1,
        buckets: [
          {
            bucket: '2026-08',
            activeMemberCount: 5,
            attendanceRateByActivityType: {
              CALL: 0.6,
              DRILL: 0.4,
              MEETING: 0,
              WORK_DETAIL: 0,
              STANDBY: 0,
            },
          },
        ],
      });
    }),
  );
  renderPage();
  await openTab('Membership trends');
  expect(await screen.findByText('60%')).toBeTruthy();
  expect(screen.getByText('+1')).toBeTruthy();

  const user = userEvent.setup();
  const fromInput = screen.getByLabelText('From');
  await user.clear(fromInput);
  await user.type(fromInput, '2020-01-01');

  expect(await screen.findByText('Pick a range of at most 731 days.')).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(1);
});

test('LOSAP year-end with no points shows the empty state, and an invalid year is not requested', async () => {
  const years: string[] = [];
  server.use(
    dashboardHandler(DASHBOARD),
    http.get('/api/v1/reporting/losap/year-end', ({ request }) => {
      const year = new URL(request.url).searchParams.get('year') ?? '';
      years.push(year);
      const body: LosapYearEndReport = {
        deptId: 'nichols-fd',
        year: Number(year),
        members: [],
        hasData: false,
        totalUnreadableEntryCount: 0,
      };
      return HttpResponse.json(body);
    }),
  );
  renderPage();
  await openTab('LOSAP year-end');

  const thisYear = String(new Date().getFullYear());
  expect(await screen.findByText(`No LOSAP points recorded for ${thisYear}`)).toBeTruthy();

  const user = userEvent.setup();
  const yearInput = screen.getByLabelText('Year');
  await user.clear(yearInput);
  await user.type(yearInput, '20');
  expect(await screen.findByText('Enter a four-digit year.')).toBeTruthy();
  expect(years).toEqual([thisYear]);
});

test('LOSAP year-end lists member totals and flags unreadable entries', async () => {
  server.use(
    dashboardHandler(DASHBOARD),
    http.get('/api/v1/reporting/losap/year-end', () =>
      HttpResponse.json({
        deptId: 'nichols-fd',
        year: new Date().getFullYear(),
        members: [{ memberId: 'm-1', totalPoints: 64, entryCount: 31, unreadableEntryCount: 2 }],
        hasData: true,
        totalUnreadableEntryCount: 2,
      } satisfies LosapYearEndReport),
    ),
  );
  renderPage();
  await openTab('LOSAP year-end');

  const table = await screen.findByRole('table');
  expect(within(table).getByText('m-1')).toBeTruthy();
  expect(within(table).getByText('64')).toBeTruthy();
  expect(
    screen.getByText('2 point entries could not be read and are not counted in these totals.'),
  ).toBeTruthy();
});

test('export queues a job with the on-screen parameters, polls it, and offers the signed link', async () => {
  let posted: URLSearchParams | undefined;
  let polls = 0;
  const completed: ReportExportJob = {
    jobId: 'job-1',
    report: 'losap',
    format: 'pdf',
    status: 'COMPLETED',
    requestedAt: '2026-09-26T00:00:00.000Z',
    downloadUrl: 'https://signed.example/report.pdf',
  };
  server.use(
    dashboardHandler(DASHBOARD),
    http.get('/api/v1/reporting/losap/year-end', () =>
      HttpResponse.json({
        deptId: 'nichols-fd',
        year: 2026,
        members: [],
        hasData: false,
        totalUnreadableEntryCount: 0,
      }),
    ),
    http.post('/api/v1/reporting/export', ({ request }) => {
      posted = new URL(request.url).searchParams;
      return HttpResponse.json({ jobId: 'job-1', status: 'PENDING' }, { status: 202 });
    }),
    http.get('/api/v1/reporting/export/job-1', () => {
      polls += 1;
      return HttpResponse.json(
        polls === 1 ? { ...completed, status: 'PENDING', downloadUrl: undefined } : completed,
      );
    }),
  );
  renderPage(['CHIEF']);
  await openTab('LOSAP year-end');

  const user = userEvent.setup();
  await user.selectOptions(await screen.findByLabelText('Format'), 'pdf');
  await user.click(screen.getByRole('button', { name: 'Export PDF' }));

  expect(await screen.findByText('Export in progress…')).toBeTruthy();
  const link = await screen.findByRole('link', { name: 'Download PDF' }, { timeout: 5_000 });
  expect(link.getAttribute('href')).toBe('https://signed.example/report.pdf');
  expect(posted?.get('report')).toBe('losap');
  expect(posted?.get('format')).toBe('pdf');
  expect(posted?.get('year')).toBe(String(new Date().getFullYear()));
});

test('a failed export job is shown, not hidden', async () => {
  server.use(
    dashboardHandler(DASHBOARD),
    http.post('/api/v1/reporting/export', () =>
      HttpResponse.json({ jobId: 'job-2', status: 'PENDING' }, { status: 202 }),
    ),
    http.get('/api/v1/reporting/export/job-2', () =>
      HttpResponse.json({
        jobId: 'job-2',
        report: 'dashboard',
        format: 'csv',
        status: 'FAILED',
        requestedAt: '2026-09-26T00:00:00.000Z',
      }),
    ),
  );
  renderPage(['ADMIN']);

  await userEvent.setup().click(await screen.findByRole('button', { name: 'Export CSV' }));
  expect(await screen.findByText('The export failed. Try again.')).toBeTruthy();
});

test('a 403 on starting an export shows the forbidden state', async () => {
  server.use(
    dashboardHandler(DASHBOARD),
    http.post('/api/v1/reporting/export', () =>
      HttpResponse.json(problem(403, 'Forbidden'), { status: 403 }),
    ),
  );
  renderPage(['CHIEF']);

  await userEvent.setup().click(await screen.findByRole('button', { name: 'Export CSV' }));
  expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
});

test('TRAINING can read reports but is not offered export (ExportReport is CHIEF/ADMIN)', async () => {
  server.use(dashboardHandler(DASHBOARD));
  renderPage(['TRAINING']);

  expect(await screen.findByText('17')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Export/ })).toBeNull();
});

test('the route guard blocks a MEMBER before any report is requested', async () => {
  const request = vi.fn();
  server.use(
    http.get('/api/v1/reporting/dashboard', () => {
      request();
      return HttpResponse.json(DASHBOARD);
    }),
  );
  renderPage(['MEMBER']);

  expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
});
