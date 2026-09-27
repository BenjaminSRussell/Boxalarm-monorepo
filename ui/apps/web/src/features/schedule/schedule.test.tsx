import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { SchedulePage } from './SchedulePage';

const server = setupServer(
  http.get('/api/v1/personnel/shifts/coverage', () => HttpResponse.json({ shifts: [] })),
);
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

function makeManager(): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'officer-1', 'cognito:groups': ['OFFICER'] },
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

function renderSchedule() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager()}>
        <SchedulePage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

// DUTY_SHIFT.startAt/endAt are epoch milliseconds on the backend (coverage and claim compare
// them with Date.now()); the page used to send and read seconds.
test('creates a shift with epoch-millisecond start/end', async () => {
  let posted: Record<string, unknown> | undefined;
  server.use(
    http.get('/api/v1/personnel/shifts', () => HttpResponse.json({ shifts: [] })),
    http.post('/api/v1/personnel/shifts', async ({ request }) => {
      posted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ shiftId: 's-9' }, { status: 201 });
    }),
  );
  renderSchedule();

  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Start'), '2026-10-01T18:00');
  await user.type(screen.getByLabelText('End'), '2026-10-02T06:00');
  await user.type(screen.getByLabelText('Station ID'), 'STATION-1');
  await user.click(screen.getByRole('button', { name: 'Create shift' }));

  await waitFor(() => expect(posted).toBeDefined());
  expect(posted?.startAt).toBe(new Date('2026-10-01T18:00').getTime());
  expect(posted?.endAt).toBe(new Date('2026-10-02T06:00').getTime());
});

test('renders a listed shift from its epoch-millisecond startAt', async () => {
  const startAt = new Date('2026-10-01T18:00').getTime();
  server.use(
    http.get('/api/v1/personnel/shifts', () =>
      HttpResponse.json({
        shifts: [
          {
            shiftId: 's-1',
            startAt,
            endAt: startAt + 43_200_000,
            stationId: 'STATION-1',
            status: 'OPEN',
          },
        ],
      }),
    ),
  );
  renderSchedule();

  expect(await screen.findByText(new RegExp(new Date(startAt).toLocaleString()))).toBeTruthy();
});
