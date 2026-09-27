import { targetSize } from '@boxalarm/design-tokens';
import NetInfo from '@react-native-community/netinfo';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { ApiError, apiRequest } from '../../lib/apiClient';
import { ConnectivityProvider } from '../../sync/ConnectivityContext';
import * as store from '../../sync/outboxStore';
import * as syncManager from '../../sync/syncManager';
import { AttendanceScreen } from './AttendanceScreen';

jest.mock('../../lib/apiClient', () => ({
  ...jest.requireActual('../../lib/apiClient'),
  apiRequest: jest.fn(),
}));
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('react-native-config', () => ({ __esModule: true, default: { API_BASE_URL: '' } }));

const mockApiRequest = apiRequest as jest.Mock;
const mockNetInfoFetch = NetInfo.fetch as jest.Mock;
const mockConfig = Config as unknown as { API_BASE_URL: string };
const auth = {
  isAuthenticated: true,
  memberId: 'MBR-1',
  getAccessToken: jest.fn(),
  renewSilently: jest.fn(),
};

let serverRecords: { activityType: string; refId: null; occurredAt: number; hours: number }[];
let postOutcome: () => Promise<unknown>;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  const rows = await store.all();
  await Promise.all(rows.map((row) => store.remove(row.id)));
  mockConfig.API_BASE_URL = 'https://api.example.com';
  (useOptionalAuth as jest.Mock).mockReturnValue(auth);
  mockNetInfoFetch.mockResolvedValue({ isConnected: true });
  serverRecords = [];
  postOutcome = async () => ({ json: async () => ({}) });
  mockApiRequest.mockReset();
  mockApiRequest.mockImplementation(
    async (_path: string, _tokens: unknown, init: { method?: string; body?: string }) => {
      if (init.method === 'POST') {
        const response = await postOutcome();
        serverRecords.push(JSON.parse(init.body!));
        return response;
      }
      return { json: async () => ({ records: serverRecords }) };
    },
  );
  syncManager.configure(auth, 'https://api.example.com');
  await flush();
});

async function renderScreen(isOnline: boolean) {
  await render(
    <ConnectivityProvider initialIsOnline={isOnline}>
      <AttendanceScreen />
    </ConnectivityProvider>,
  );
  await act(flush);
}

async function recordDrill() {
  await act(async () => {
    fireEvent.press(await screen.findByRole('button', { name: 'Record drill attendance' }));
  });
  await act(flush);
}

test('offline, a record is kept on the phone and listed as waiting for signal, not as recorded', async () => {
  mockNetInfoFetch.mockResolvedValue({ isConnected: false });
  mockApiRequest.mockRejectedValue(new TypeError('Network request failed'));
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  await renderScreen(false);

  expect(await screen.findByText(/history loads when you have signal/i)).toBeTruthy();
  await recordDrill();

  expect(await screen.findByText('On this phone, not yet recorded')).toBeTruthy();
  expect(await screen.findByText('Waiting for signal')).toBeTruthy();
  const [row] = await store.all();
  expect(row?.kind).toBe('ATTENDANCE');
  expect(row?.path).toBe('personnel/attendance');
  expect(row?.id).toBe(`attendance-${JSON.parse(row!.body).occurredAt}`);
  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/saved on this phone/i));
  announceSpy.mockRestore();
});

test('a record queued offline drains on reconnect and then appears in the server history', async () => {
  mockNetInfoFetch.mockResolvedValue({ isConnected: false });
  await renderScreen(false);
  await recordDrill();
  expect(await screen.findByText('Waiting for signal')).toBeTruthy();

  mockNetInfoFetch.mockResolvedValue({ isConnected: true });
  await act(async () => {
    await syncManager.drain();
  });
  await act(flush);

  expect(screen.queryByText('On this phone, not yet recorded')).toBeNull();
  expect(screen.queryByText('No attendance recorded yet.')).toBeNull();
  // One "Drill" is the activity radio; the other is the server-history row.
  expect(await screen.findAllByText('Drill')).toHaveLength(2);
  await expect(store.all()).resolves.toHaveLength(0);
});

test('a server refusal stays visible with its reason and can be discarded', async () => {
  postOutcome = async () => {
    throw new ApiError({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Member was not found',
      traceId: 't',
    });
  };
  await renderScreen(true);
  await recordDrill();

  expect(await screen.findByText('Refused by server')).toBeTruthy();
  expect(await screen.findByText('Member was not found')).toBeTruthy();
  const discard = await screen.findByRole('button', { name: /^Discard Attendance — Drill/ });
  await act(async () => {
    fireEvent.press(discard);
  });
  await act(flush);

  expect(screen.queryByText('Refused by server')).toBeNull();
  await expect(store.all()).resolves.toHaveLength(0);
});

test('two quick taps make two distinct records rather than collapsing into one', async () => {
  mockNetInfoFetch.mockResolvedValue({ isConnected: false });
  await renderScreen(false);

  await recordDrill();
  await recordDrill();

  const ids = (await store.all()).map((row) => row.id);
  expect(new Set(ids).size).toBe(2);
});

test('activity choices are glove-sized radios with readable names', async () => {
  await renderScreen(true);

  const workDetail = await screen.findByRole('radio', { name: 'Work detail' });
  expect(workDetail.props.style.minHeight).toBe(targetSize.field);
  await act(async () => {
    fireEvent.press(workDetail);
  });
  expect(
    (await screen.findByRole('radio', { name: 'Work detail' })).props.accessibilityState.checked,
  ).toBe(true);
  expect(await screen.findByRole('button', { name: 'Record work detail attendance' })).toBeTruthy();
});

test('a 403 loading history is an error, not the offline note', async () => {
  mockApiRequest.mockRejectedValue(
    new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, traceId: 't' }),
  );
  await renderScreen(true);

  expect(
    await screen.findByText('You do not have access to view this attendance history.'),
  ).toBeTruthy();
  expect(screen.queryByText(/history loads when you have signal/i)).toBeNull();
});
