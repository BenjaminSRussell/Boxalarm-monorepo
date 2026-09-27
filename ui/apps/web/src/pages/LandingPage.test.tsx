import { typography } from '@boxalarm/design-tokens';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { User, UserManager } from 'oidc-client-ts';
import { AuthProvider } from '../auth/AuthContext';
import { LandingPage } from './LandingPage';

const NOW_S = Math.floor(Date.now() / 1000);
const EMPTY_ACTIVE = { dispatches: [], activeWindowSeconds: 7200, asOf: NOW_S, truncated: false };

const server = setupServer(
  http.get('/api/v1/apparatus', () => HttpResponse.json({ apparatus: [] })),
  http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  http.get('/api/v1/alerting/dispatches', () => HttpResponse.json(EMPTY_ACTIVE)),
  http.get('/api/v1/personnel/shifts', () => HttpResponse.json({ shifts: [] })),
  http.get('/api/v1/training/certifications/expiring', () => HttpResponse.json([])),
);

function serverError(status = 500) {
  return HttpResponse.json(
    { type: 'about:blank', title: status === 403 ? 'Forbidden' : 'Error', status, traceId: 't' },
    { status },
  );
}
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

function makeManager(profile: Record<string, unknown>): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile,
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

function renderLanding(profile: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(profile)}>
        <MemoryRouter>
          <LandingPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('renders the highest-priority role dashboard when CHIEF is present', async () => {
  renderLanding({ sub: 'm1', 'cognito:groups': ['MEMBER', 'CHIEF'] });
  await screen.findByRole('heading', { name: 'Chief dashboard' });
});

test('falls back to member home when no groups are present', async () => {
  renderLanding({ sub: 'm1' });
  await screen.findByRole('heading', { name: 'Member home' });
});

test('the heading uses the design-token type scale, matching the sign-in page', async () => {
  renderLanding({ sub: 'm1' });
  const heading = await screen.findByRole('heading', { name: 'Member home' });
  expect(heading.style.fontSize).toBe(`${typography.size.xl}px`);
});

// Regression for MAJOR-2: the dashboard used to hardcode "No active call." as fact regardless
// of whether a call was active. It now shows only what GET alerting/dispatches?status=active
// returned, scoped to the window the server applied.
test('active-call tile lists the dispatches the endpoint returned, with a roster link', async () => {
  let requestedStatus: string | null = null;
  server.use(
    http.get('/api/v1/alerting/dispatches', ({ request }) => {
      requestedStatus = new URL(request.url).searchParams.get('status');
      return HttpResponse.json({
        ...EMPTY_ACTIVE,
        dispatches: [
          {
            dispatchId: 'NICHOLS-4471-1',
            incidentType: 'STRUCTURE_FIRE',
            address: '123 Main St',
            crossStreets: 'Main & Elm',
            dispatchedAt: NOW_S - 600,
            toneLadder: { status: 'ACTIVE', currentToneSequence: 2 },
          },
        ],
      });
    }),
  );

  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  expect(await screen.findByText('STRUCTURE_FIRE')).toBeTruthy();
  expect(requestedStatus).toBe('active');
  expect(screen.getByText(/123 Main St/)).toBeTruthy();
  expect(screen.getByText(/dispatched in the last 2 hours/i)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Live roster' }).getAttribute('href')).toBe(
    '/alerts/roster?dispatchId=NICHOLS-4471-1',
  );
  expect(screen.queryByText(/no active call/i)).toBeNull();
});

test('an empty active list states the window it covers, not an unqualified all-clear', async () => {
  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  expect(await screen.findByText(/no calls dispatched in the last 2 hours \(as of/i)).toBeTruthy();
  expect(screen.queryByText(/no active call/i)).toBeNull();
});

test('a failed active-call read shows an error with retry, never an empty or all-clear state', async () => {
  let calls = 0;
  server.use(
    http.get('/api/v1/alerting/dispatches', () => {
      calls += 1;
      return calls === 1 ? serverError(503) : HttpResponse.json(EMPTY_ACTIVE);
    }),
  );

  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  expect(await screen.findByText(/couldn.t load active-call status/i)).toBeTruthy();
  expect(screen.queryByText(/no calls dispatched/i)).toBeNull();
  expect(screen.queryByText(/no active call/i)).toBeNull();

  await userEvent.setup().click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
  expect(await screen.findByText(/no calls dispatched in the last 2 hours/i)).toBeTruthy();
});

test('a 403 on the active-call read says so instead of showing an empty list', async () => {
  server.use(http.get('/api/v1/alerting/dispatches', () => serverError(403)));
  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  expect(await screen.findByText(/you don.t have access to active-call status/i)).toBeTruthy();
  expect(screen.queryByText(/no calls dispatched/i)).toBeNull();
});

test('the active-call tile shows a loading state before the first response', async () => {
  let release: () => void = () => undefined;
  server.use(
    http.get(
      '/api/v1/alerting/dispatches',
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(HttpResponse.json(EMPTY_ACTIVE));
        }),
    ),
  );
  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  const card = (await screen.findByRole('heading', { name: 'Active calls' })).parentElement!;
  expect(within(card).getByRole('status').textContent).toMatch(/loading/i);
  expect(within(card).queryByText(/no calls/i)).toBeNull();
  release();
  expect(await within(card).findByText(/no calls dispatched/i)).toBeTruthy();
});

test("today's shifts lists only shifts overlapping today, in local time", async () => {
  const today = new Date();
  today.setHours(18, 0, 0, 0);
  const yesterday = today.getTime() - 3 * 24 * 60 * 60 * 1000;
  server.use(
    http.get('/api/v1/personnel/shifts', () =>
      HttpResponse.json({
        shifts: [
          {
            shiftId: 's-today',
            startAt: today.getTime(),
            endAt: today.getTime() + 43_200_000,
            stationId: 'STATION-TODAY',
            status: 'PARTIALLY_FILLED',
          },
          {
            shiftId: 's-old',
            startAt: yesterday,
            endAt: yesterday + 43_200_000,
            stationId: 'STATION-OLD',
            status: 'OPEN',
          },
        ],
      }),
    ),
  );

  renderLanding({ sub: 'm1', 'cognito:groups': ['OFFICER'] });
  expect(await screen.findByText('STATION-TODAY')).toBeTruthy();
  expect(screen.getByText(/partially filled/)).toBeTruthy();
  expect(screen.queryByText('STATION-OLD')).toBeNull();
});

test("today's shifts says none are scheduled only after a successful empty read", async () => {
  renderLanding({ sub: 'm1', 'cognito:groups': ['OFFICER'] });
  expect(await screen.findByText('No duty shifts are scheduled today.')).toBeTruthy();
});

test("a failed shifts read shows an error, not 'no shifts'", async () => {
  server.use(http.get('/api/v1/personnel/shifts', () => serverError()));
  renderLanding({ sub: 'm1', 'cognito:groups': ['OFFICER'] });
  expect(await screen.findByText(/couldn.t load shifts/i)).toBeTruthy();
  expect(screen.queryByText(/no duty shifts/i)).toBeNull();
});

test('expiring certifications show the count and the soonest, named from the roster', async () => {
  server.use(
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json({
        items: [{ memberId: 'm-2', firstName: 'Jordan', lastName: 'Osei', status: 'ACTIVE' }],
      }),
    ),
    http.get('/api/v1/training/certifications/expiring', () =>
      HttpResponse.json([
        {
          certId: 'c-2',
          memberId: 'm-9',
          certType: 'Hazmat Ops',
          expiryDate: '2026-11-20',
          issuingAuthority: 'CT',
          status: 'CURRENT',
        },
        {
          certId: 'c-1',
          memberId: 'm-2',
          certType: 'EVOC',
          expiryDate: '2026-10-05',
          issuingAuthority: 'CT',
          status: 'CURRENT',
        },
      ]),
    ),
  );

  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  const card = (await screen.findByRole('heading', { name: 'Expiring certifications' }))
    .parentElement!;
  const items = await within(card).findAllByRole('listitem');
  expect(items[0]!.textContent).toMatch(/Jordan Osei — EVOC/);
  expect(items[1]!.textContent).toMatch(/m-9 — Hazmat Ops/);
  expect(screen.getByText('Expiring certifications', { selector: 'span' })).toBeTruthy();
  expect(await screen.findByText('2')).toBeTruthy();
});

test('a failed expiring-certifications read marks the stat unavailable instead of zero', async () => {
  server.use(http.get('/api/v1/training/certifications/expiring', () => serverError()));
  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  expect(await screen.findByText(/couldn.t load expiring certifications/i)).toBeTruthy();
  expect(screen.getByText('Unavailable')).toBeTruthy();
  expect(screen.queryByText(/no certifications expire/i)).toBeNull();
});

test('a failed apparatus query does not hide the active-call tile', async () => {
  server.use(http.get('/api/v1/apparatus', () => serverError()));
  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  await screen.findByRole('heading', { name: 'Something went wrong loading this page' });
  expect(await screen.findByText(/no calls dispatched in the last 2 hours/i)).toBeTruthy();
});

// Regression for MAJOR-3: routeTable.ts grants /apparatus to APPARATUS|CHIEF only, but OFFICER
// is a DASHBOARD_ROLES member and this dashboard used to fetch apparatus for every dashboard
// role regardless — an OFFICER's dashboard triggered a request Cedar denies with 403 on every
// visit, and the failure rendered as a clean "0 / 0 apparatus in service" tile.
test('OFFICER dashboard never requests apparatus (routeTable denies it) and shows no apparatus tiles', async () => {
  let apparatusRequested = false;
  server.use(
    http.get('/api/v1/apparatus', () => {
      apparatusRequested = true;
      return HttpResponse.json({ apparatus: [] });
    }),
  );

  renderLanding({ sub: 'm1', 'cognito:groups': ['OFFICER'] });
  await screen.findByRole('heading', { name: 'Officer dashboard' });
  // Members is granted to OFFICER, so that tile should still render.
  await screen.findByText('Active members');

  expect(apparatusRequested).toBe(false);
  expect(screen.queryByText('Apparatus in service')).toBeNull();
  expect(screen.queryByText('Out of service')).toBeNull();
});

// Regression for MAJOR-3: a failed query (offline, 500, or a 403 that slips through role gating)
// used to fall through `data ?? []`, so the tile silently read "0 / 0" — a failure rendered as a
// healthy zero, and the project's ApiError/ApiForbiddenGate convention was never invoked.
test('a failed apparatus query renders the generic ApiErrorState, never a "0 / 0" tile', async () => {
  server.use(
    http.get('/api/v1/apparatus', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Internal Server Error',
          status: 500,
          traceId: 'trace-1',
        },
        { status: 500 },
      ),
    ),
  );

  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  await screen.findByRole('heading', { name: 'Something went wrong loading this page' });
  expect(screen.queryByText(/0 \/ 0/)).toBeNull();
});

test('CHIEF dashboard reads the real { apparatus } list payload into the tiles (m9)', async () => {
  server.use(
    http.get('/api/v1/apparatus', () =>
      HttpResponse.json({
        apparatus: [
          { apparatusId: 'a1', unitId: 'E1', type: 'Engine', status: 'IN_SERVICE' },
          { apparatusId: 'a2', unitId: 'T1', type: 'Ladder', status: 'OUT_OF_SERVICE' },
        ],
      }),
    ),
  );

  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  await screen.findByRole('heading', { name: 'Chief dashboard' });
  expect(await screen.findByText('1 / 2')).toBeTruthy();
  expect(screen.queryByText('Something went wrong loading this page')).toBeNull();
});
