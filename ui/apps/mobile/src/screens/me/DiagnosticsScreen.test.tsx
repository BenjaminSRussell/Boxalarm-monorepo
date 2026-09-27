import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { ApiError, apiRequest } from '../../lib/apiClient';
import { DiagnosticsScreen } from './DiagnosticsScreen';

jest.mock('../../lib/apiClient', () => {
  const actual = jest.requireActual('../../lib/apiClient');
  return { ...actual, apiRequest: jest.fn() };
});
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { API_BASE_URL: 'https://api.example.com' },
}));

const mockApiRequest = apiRequest as jest.Mock;
const mockUseOptionalAuth = useOptionalAuth as jest.Mock;

const mockAuthValue: AuthContextValue = {
  roles: ['MEMBER'],
  memberId: 'MBR-0012',
  isAuthenticated: true,
  isLoading: false,
  signIn: jest.fn(),
  signOut: jest.fn(),
  getAccessToken: jest.fn().mockResolvedValue('access-token'),
  renewSilently: jest.fn().mockResolvedValue('access-token'),
};

const T = 1_798_000_000;

function ok(body: unknown) {
  return Promise.resolve({ json: async () => body });
}

function forbidden() {
  return Promise.reject(
    new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, traceId: 't' }),
  );
}

type Routes = Record<string, () => Promise<unknown>>;

function routeRequests(routes: Routes) {
  mockApiRequest.mockImplementation((path: string) => {
    const handler = routes[path];
    if (!handler) throw new Error(`unexpected request ${path}`);
    return handler();
  });
}

const HISTORY = 'alerting/audit?memberId=MBR-0012';
const ACTIVE = 'alerting/dispatches?status=active';

beforeEach(() => {
  mockApiRequest.mockReset();
  mockUseOptionalAuth.mockReturnValue(mockAuthValue);
});

test('renders the per-tone, per-channel timeline for the most recent dispatch', async () => {
  routeRequests({
    [HISTORY]: () =>
      ok({
        entries: [
          { dispatchId: 'D-1', sentAt: T + 185 },
          { dispatchId: 'D-1', sentAt: T + 5 },
        ],
      }),
    [ACTIVE]: () => ok({ dispatches: [], activeWindowSeconds: 7200 }),
    'alerting/dispatches/D-1/diagnostics': () =>
      ok({
        dispatchId: 'D-1',
        diagnosis: 'ON_ROSTER',
        timeline: [
          {
            entityType: 'DELIVERY_RECEIPT',
            channel: 'PUSH',
            toneSequence: 1,
            sentAt: T + 5,
            deliveredAt: T + 6,
          },
          {
            entityType: 'DELIVERY_RECEIPT',
            channel: 'SMS',
            toneSequence: 1,
            sentAt: T + 5,
            failureReason: 'CARRIER_REJECTED',
          },
          { entityType: 'DELIVERY_RECEIPT', channel: 'PUSH', toneSequence: 2, sentAt: T + 185 },
        ],
        deviceState: {
          notificationPermission: true,
          criticalAlertPermission: false,
          batteryOptimizationExempt: true,
          appVersion: '1.4.0',
          osVersion: 'iOS 18.1',
          reportedAt: T,
        },
      }),
  });

  const { findByText, getByText, getByLabelText } = await render(<DiagnosticsScreen />);

  expect(await findByText(/Push: delivered/)).toBeTruthy();
  expect(getByText(/SMS: failed \(CARRIER_REJECTED\)/)).toBeTruthy();
  expect(getByText(/Push: sent, delivery not confirmed/)).toBeTruthy();
  expect(getByLabelText('Tone 1')).toBeTruthy();
  expect(getByLabelText('Tone 2')).toBeTruthy();
  expect(getByText(/Critical alerts \/ full-screen alerts: not allowed/)).toBeTruthy();
  // The self route only — never another member's diagnostics.
  expect(mockApiRequest.mock.calls.map((c) => c[0])).not.toContainEqual(
    expect.stringMatching(/diagnostics\/MBR/),
  );
});

test('a recent call the member was never paged for shows as not on the eligible roster', async () => {
  routeRequests({
    [HISTORY]: () => ok({ entries: [] }),
    [ACTIVE]: () =>
      ok({
        dispatches: [{ dispatchId: 'D-9', dispatchedAt: T, incidentType: 'STRUCTURE_FIRE' }],
        activeWindowSeconds: 7200,
      }),
    'alerting/dispatches/D-9/diagnostics': () =>
      ok({
        dispatchId: 'D-9',
        diagnosis: 'NOT_ON_ELIGIBLE_ROSTER',
        timeline: [],
        deviceState: null,
      }),
  });

  const { findByText } = await render(<DiagnosticsScreen />);

  expect(await findByText('You were not on the eligible roster')).toBeTruthy();
  expect(await findByText(/STRUCTURE_FIRE/)).toBeTruthy();
});

test('shows only the three most recent dispatches', async () => {
  routeRequests({
    [HISTORY]: () =>
      ok({
        entries: [
          { dispatchId: 'D-4', sentAt: T + 400 },
          { dispatchId: 'D-3', sentAt: T + 300 },
          { dispatchId: 'D-2', sentAt: T + 200 },
          { dispatchId: 'D-1', sentAt: T + 100 },
        ],
      }),
    [ACTIVE]: () => ok({ dispatches: [], activeWindowSeconds: 7200 }),
    'alerting/dispatches/D-4/diagnostics': () =>
      ok({ dispatchId: 'D-4', diagnosis: 'ON_ROSTER', timeline: [], deviceState: null }),
    'alerting/dispatches/D-3/diagnostics': () =>
      ok({ dispatchId: 'D-3', diagnosis: 'ON_ROSTER', timeline: [], deviceState: null }),
    'alerting/dispatches/D-2/diagnostics': () =>
      ok({ dispatchId: 'D-2', diagnosis: 'ON_ROSTER', timeline: [], deviceState: null }),
  });

  const { findAllByText } = await render(<DiagnosticsScreen />);

  expect(await findAllByText(/no delivery attempt is recorded yet/)).toHaveLength(3);
  expect(mockApiRequest).not.toHaveBeenCalledWith(
    'alerting/dispatches/D-1/diagnostics',
    expect.anything(),
    expect.anything(),
  );
});

test('no history and no active calls says so, qualified by the window', async () => {
  routeRequests({
    [HISTORY]: () => ok({ entries: [] }),
    [ACTIVE]: () => ok({ dispatches: [], activeWindowSeconds: 7200 }),
  });

  const { findByText } = await render(<DiagnosticsScreen />);

  expect(
    await findByText(
      /No pages to you are on record, and no calls were dispatched in the last 2 hours/,
    ),
  ).toBeTruthy();
});

test('when both history sources fail it shows a retryable error, never an empty history', async () => {
  let fail = true;
  routeRequests({
    [HISTORY]: () =>
      fail ? Promise.reject(new TypeError('Network request failed')) : ok({ entries: [] }),
    [ACTIVE]: () =>
      fail
        ? Promise.reject(new TypeError('Network request failed'))
        : ok({ dispatches: [], activeWindowSeconds: 7200 }),
  });

  const { findByRole, queryByText, getByRole, findByText } = await render(<DiagnosticsScreen />);

  const alert = await findByRole('alert');
  expect(alert.props.children).toMatch(/could not be loaded/);
  expect(queryByText(/No pages to you/)).toBeNull();

  fail = false;
  await act(async () => {
    fireEvent.press(getByRole('button', { name: 'Try again' }));
  });
  expect(await findByText(/No pages to you are on record/)).toBeTruthy();
});

test('a 403 on history says the member lacks access', async () => {
  routeRequests({ [HISTORY]: forbidden, [ACTIVE]: forbidden });

  const { findByRole } = await render(<DiagnosticsScreen />);

  expect((await findByRole('alert')).props.children).toBe(
    'You do not have access to your delivery history.',
  );
});

test('one failed source is flagged as partial history', async () => {
  routeRequests({
    [HISTORY]: () => Promise.reject(new TypeError('Network request failed')),
    [ACTIVE]: () => ok({ dispatches: [], activeWindowSeconds: 7200 }),
  });

  const { findByText } = await render(<DiagnosticsScreen />);

  expect(await findByText(/a recent dispatch may be missing/)).toBeTruthy();
});

test('a failed per-dispatch diagnostics read is shown on that dispatch only', async () => {
  routeRequests({
    [HISTORY]: () => ok({ entries: [{ dispatchId: 'D-1', sentAt: T }] }),
    [ACTIVE]: () => ok({ dispatches: [], activeWindowSeconds: 7200 }),
    'alerting/dispatches/D-1/diagnostics': () => Promise.reject(new TypeError('offline')),
  });

  const { findByText } = await render(<DiagnosticsScreen />);

  expect(await findByText('The timeline for this dispatch could not be loaded.')).toBeTruthy();
});

test('signed out, it asks the member to sign in and makes no request', async () => {
  mockUseOptionalAuth.mockReturnValue(undefined);

  const { findByText } = await render(<DiagnosticsScreen />);

  expect(await findByText("Why didn't I get the page?")).toBeTruthy();
  expect(await findByText(/Sign in to see the delivery timeline/)).toBeTruthy();
  await waitFor(() => expect(mockApiRequest).not.toHaveBeenCalled());
});
