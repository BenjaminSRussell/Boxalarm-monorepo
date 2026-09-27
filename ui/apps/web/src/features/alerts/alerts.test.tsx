import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import { AlertsDiagnosticsPage } from './AlertsDiagnosticsPage';
import { AlertsRosterPage } from './AlertsRosterPage';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'u1', 'cognito:groups': groups },
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

function renderPage(groups: string[], path = '/alerts/roster') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/alerts/roster"
              element={
                <RequireRole>
                  <AlertsRosterPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function renderDiagnosticsPage(groups: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={['/alerts/diagnostics']}>
          <Routes>
            <Route
              path="/alerts/diagnostics"
              element={
                <RequireRole>
                  <AlertsDiagnosticsPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('a member cannot open /alerts/roster', async () => {
  renderPage(['MEMBER']);
  await screen.findByRole('heading', { name: 'Forbidden' });
});

test('an officer sees the manual entry form and, given a dispatch id, the roster and receipts', async () => {
  server.use(
    http.get('/api/v1/alerting/dispatches/D-1', () =>
      HttpResponse.json({
        dispatchId: 'D-1',
        incidentType: 'Structure fire',
        address: '18 Nichols Ave',
        crossStreets: 'Main & Nichols',
        mapLink: null,
        narrative: 'Smoke showing',
        prePlan: null,
      }),
    ),
    http.get('/api/v1/alerting/dispatches/D-1/roster', () =>
      HttpResponse.json({
        members: [
          {
            memberId: 'm-1',
            name: 'Jordan Osei',
            ackStatus: 'DIRECT_TO_SCENE',
            eta: null,
            assignedApparatusId: null,
            quals: ['FF1'],
            lastAnsweredTone: 1,
          },
        ],
      }),
    ),
    http.get('/api/v1/alerting/dispatches/D-1/receipts', () =>
      HttpResponse.json({
        receipts: [
          {
            memberId: 'm-1',
            channel: 'PUSH',
            toneSequence: 1,
            status: 'SENT_UNCONFIRMED',
            sentAt: 0,
            deliveredAt: null,
            openedAt: null,
            failureReason: null,
          },
        ],
      }),
    ),
    http.get('/api/v1/apparatus/riding-board/D-1', () =>
      HttpResponse.json({ dispatchId: 'D-1', apparatus: [] }),
    ),
  );

  renderPage(['OFFICER'], '/alerts/roster?dispatchId=D-1');

  expect(await screen.findByRole('form', { name: 'Enter dispatch manually' })).toBeTruthy();
  expect(await screen.findByRole('heading', { name: 'Structure fire' })).toBeTruthy();
  expect(await screen.findByText('Jordan Osei')).toBeTruthy();
  expect(await screen.findByText('Direct to scene')).toBeTruthy();
  expect(await screen.findByText('Sent, not confirmed delivered')).toBeTruthy();
});

test('submitting the manual entry form navigates the page to the new dispatch id', async () => {
  server.use(
    http.post('/api/v1/alerting/dispatches', async () =>
      HttpResponse.json({ dispatchId: 'D-9' }, { status: 201 }),
    ),
    http.get('/api/v1/alerting/dispatches/D-9', () =>
      HttpResponse.json({
        dispatchId: 'D-9',
        incidentType: 'MVA',
        address: '1 Main St',
        crossStreets: '',
        mapLink: null,
        narrative: '',
        prePlan: null,
      }),
    ),
    http.get('/api/v1/alerting/dispatches/D-9/roster', () => HttpResponse.json({ members: [] })),
    http.get('/api/v1/alerting/dispatches/D-9/receipts', () => HttpResponse.json({ receipts: [] })),
    http.get('/api/v1/apparatus/riding-board/D-9', () =>
      HttpResponse.json({ dispatchId: 'D-9', apparatus: [] }),
    ),
  );

  const user = userEvent.setup();
  renderPage(['CHIEF']);

  await user.type(await screen.findByLabelText('Incident type'), 'MVA');
  await user.type(screen.getByLabelText('Address'), '1 Main St');
  await user.type(screen.getByLabelText('Cross streets'), 'N/A');
  await user.type(screen.getByLabelText('Narrative'), 'MVA with injuries');
  await user.type(screen.getByLabelText('Operator-entered reference'), 'ext-9');
  await user.click(screen.getByRole('button', { name: 'Submit dispatch' }));

  await waitFor(() => expect(screen.getByRole('heading', { name: 'MVA' })).toBeTruthy());
});

test('a failed riding-board seat assignment surfaces an error instead of silently reverting', async () => {
  server.use(
    http.get('/api/v1/alerting/dispatches/D-2', () =>
      HttpResponse.json({
        dispatchId: 'D-2',
        incidentType: 'Structure fire',
        address: '18 Nichols Ave',
        crossStreets: '',
        mapLink: null,
        narrative: '',
        prePlan: null,
      }),
    ),
    http.get('/api/v1/alerting/dispatches/D-2/roster', () =>
      HttpResponse.json({
        members: [
          {
            memberId: 'm-1',
            name: 'Jordan Osei',
            ackStatus: 'RESPONDING',
            eta: null,
            assignedApparatusId: null,
            quals: ['FF1'],
            lastAnsweredTone: 1,
          },
        ],
      }),
    ),
    http.get('/api/v1/alerting/dispatches/D-2/receipts', () => HttpResponse.json({ receipts: [] })),
    http.get('/api/v1/apparatus/riding-board/D-2', () =>
      HttpResponse.json({
        dispatchId: 'D-2',
        apparatus: [
          {
            apparatusId: 'a-301',
            unitId: 'Engine 301',
            type: 'Engine',
            status: 'IN_SERVICE',
            assignable: true,
            positions: [{ code: 'OFF', label: 'Officer' }],
          },
        ],
      }),
    ),
    http.post('/api/v1/apparatus/riding-board/D-2/assignments', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This seat was already assigned.',
          traceId: 'trace-409',
        },
        { status: 409 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderPage(['OFFICER'], '/alerts/roster?dispatchId=D-2');

  const select = await screen.findByLabelText(/officer/i);
  await user.selectOptions(select, 'm-1');

  expect(
    await screen.findByText(
      'This seat was changed by another officer. The board has been refreshed.',
    ),
  ).toBeTruthy();
});

test('diagnostics renders the delivery timeline for a member on the eligible roster', async () => {
  server.use(
    http.get('/api/v1/alerting/dispatches/D-3/diagnostics/m-2', () =>
      HttpResponse.json({
        dispatchId: 'D-3',
        memberId: 'm-2',
        diagnosis: 'ON_ROSTER',
        timeline: [
          {
            entityType: 'DELIVERY_RECEIPT',
            channel: 'PUSH',
            toneSequence: 1,
            status: 'DELIVERED',
            sentAt: 1700000000,
            deliveredAt: 1700000005,
            openedAt: null,
          },
        ],
        deviceState: {
          memberId: 'm-2',
          notificationPermission: true,
          criticalAlertPermission: true,
          batteryOptimizationExempt: true,
          appVersion: '1.4.0',
          osVersion: 'iOS 18.1',
          reportedAt: 1700000000,
        },
      }),
    ),
    http.get('/api/v1/alerting/canary/status', () =>
      HttpResponse.json({
        healthy: true,
        latestResult: 'PASS',
        latestLatencyMs: 1800,
        latestRanAt: Math.floor(Date.now() / 1000),
        runs: [],
      }),
    ),
  );

  const user = userEvent.setup();
  renderDiagnosticsPage(['ADMIN']);
  await user.type(await screen.findByLabelText('Dispatch ID'), 'D-3');
  await user.type(screen.getByLabelText('Member ID'), 'm-2');

  expect(await screen.findByText('Delivered')).toBeTruthy();
  expect(await screen.findByText(/Notification permission: OK/)).toBeTruthy();
});

test('diagnostics labels raw receipts (no status field) from their provider timestamps', async () => {
  server.use(
    http.get('/api/v1/alerting/dispatches/D-5/diagnostics/m-2', () =>
      HttpResponse.json({
        dispatchId: 'D-5',
        memberId: 'm-2',
        diagnosis: 'ON_ROSTER',
        timeline: [
          {
            entityType: 'DELIVERY_RECEIPT',
            channel: 'PUSH',
            toneSequence: 1,
            sentAt: 1700000000,
            deliveredAt: 1700000005,
          },
          {
            entityType: 'DELIVERY_RECEIPT',
            channel: 'SMS',
            toneSequence: 1,
            sentAt: 1700000000,
            failureReason: 'CARRIER_REJECTED',
          },
          { entityType: 'DELIVERY_RECEIPT', channel: 'VOICE', toneSequence: 1, sentAt: 1700000090 },
        ],
        deviceState: null,
      }),
    ),
    http.get('/api/v1/alerting/canary/status', () =>
      HttpResponse.json({
        healthy: true,
        latestResult: 'PASS',
        latestLatencyMs: 1800,
        latestRanAt: Math.floor(Date.now() / 1000),
        runs: [],
      }),
    ),
  );

  const user = userEvent.setup();
  renderDiagnosticsPage(['ADMIN']);
  await user.type(await screen.findByLabelText('Dispatch ID'), 'D-5');
  await user.type(screen.getByLabelText('Member ID'), 'm-2');

  expect(await screen.findByText('Delivered')).toBeTruthy();
  expect(screen.getByText('Failed — CARRIER_REJECTED')).toBeTruthy();
  expect(screen.getByText('Sent, not confirmed delivered')).toBeTruthy();
});

test('diagnostics states the member was not on the eligible roster, distinct from sent-not-delivered', async () => {
  server.use(
    http.get('/api/v1/alerting/dispatches/D-4/diagnostics/m-9', () =>
      HttpResponse.json({
        dispatchId: 'D-4',
        memberId: 'm-9',
        diagnosis: 'NOT_ON_ELIGIBLE_ROSTER',
        timeline: [],
        deviceState: null,
      }),
    ),
    http.get('/api/v1/alerting/canary/status', () =>
      HttpResponse.json({
        healthy: true,
        latestResult: 'PASS',
        latestLatencyMs: 1800,
        latestRanAt: Math.floor(Date.now() / 1000),
        runs: [],
      }),
    ),
  );

  const user = userEvent.setup();
  renderDiagnosticsPage(['ADMIN']);
  await user.type(await screen.findByLabelText('Dispatch ID'), 'D-4');
  await user.type(screen.getByLabelText('Member ID'), 'm-9');

  expect(await screen.findByText('Not on the eligible roster')).toBeTruthy();
  expect(screen.queryByText(/Sent, not yet delivered/)).toBeNull();
});

test('canary panel shows unhealthy with text when the last run is stale even though it passed', async () => {
  server.use(
    http.get('/api/v1/alerting/canary/status', () =>
      HttpResponse.json({
        healthy: true,
        latestResult: 'PASS',
        latestLatencyMs: 1200,
        latestRanAt: Math.floor(Date.now() / 1000) - 600,
        runs: [
          {
            ranAt: Math.floor(Date.now() / 1000) - 600,
            result: 'PASS',
            latencyMs: 1200,
            channelResults: {},
          },
        ],
      }),
    ),
  );

  renderDiagnosticsPage(['ADMIN']);

  expect(await screen.findByText('Unhealthy — last run is stale')).toBeTruthy();
});
