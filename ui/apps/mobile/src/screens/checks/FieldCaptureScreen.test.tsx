import { targetSize } from '@boxalarm/design-tokens';
import NetInfo from '@react-native-community/netinfo';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { launchCamera } from 'react-native-image-picker';
import { ApiError, apiRequest } from '../../lib/apiClient';
import { ConnectivityProvider } from '../../sync/ConnectivityContext';
import * as store from '../../sync/outboxStore';
import * as syncManager from '../../sync/syncManager';
import { FieldCaptureScreen } from './FieldCaptureScreen';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));
jest.mock('../../lib/apiClient', () => ({
  ...jest.requireActual('../../lib/apiClient'),
  apiRequest: jest.fn(),
}));

const mockApiRequest = apiRequest as jest.Mock;
const mockNetInfoFetch = NetInfo.fetch as jest.Mock;
const mockLaunchCamera = launchCamera as jest.Mock;
const tokens = { getAccessToken: jest.fn(), renewSilently: jest.fn() };

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

beforeEach(async () => {
  const rows = await store.all();
  await Promise.all(rows.map((row) => store.remove(row.id)));
  mockApiRequest.mockReset();
  mockNetInfoFetch.mockResolvedValue({ isConnected: true });
  syncManager.configure(tokens, 'https://api.example.com');
  await flush();
});

async function renderScreen(isOnline: boolean) {
  await render(
    <ConnectivityProvider initialIsOnline={isOnline}>
      <FieldCaptureScreen />
    </ConnectivityProvider>,
  );
}

async function fillIds(occupancyId = 'occ-1', inspectionId = 'insp-1') {
  await act(async () => {
    fireEvent.changeText(await screen.findByLabelText('Occupancy ID'), occupancyId);
  });
  await act(async () => {
    fireEvent.changeText(await screen.findByLabelText('Inspection ID'), inspectionId);
  });
}

async function save() {
  await act(async () => {
    fireEvent.press(await screen.findByRole('button', { name: 'Save capture' }));
  });
  await act(flush);
}

test('offline, the capture is kept in the SQLite outbox and the screen says it is waiting for signal', async () => {
  mockNetInfoFetch.mockResolvedValue({ isConnected: false });
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  await renderScreen(false);

  await fillIds();
  await save();

  expect(await screen.findByText('Waiting for signal')).toBeTruthy();
  expect(screen.queryByText('Sent')).toBeNull();
  expect(mockApiRequest).not.toHaveBeenCalled();
  const [row] = await store.all();
  expect(row?.kind).toBe('FIELD_CAPTURE');
  expect(row?.path).toBe('inspections/field-capture');
  const body = JSON.parse(row!.body);
  expect(body).toEqual(
    expect.objectContaining({
      occupancyId: 'occ-1',
      inspectionId: 'insp-1',
      idempotencyKey: row!.id,
      photoFilenames: [],
      violations: [],
      conductedAt: expect.any(String),
    }),
  );
  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/waiting for signal/i));
  announceSpy.mockRestore();
});

test('a capture queued offline is sent when the connection returns, and the screen says Sent', async () => {
  mockNetInfoFetch.mockResolvedValue({ isConnected: false });
  await renderScreen(false);
  await fillIds();
  await save();
  expect(await screen.findByText('Waiting for signal')).toBeTruthy();

  mockNetInfoFetch.mockResolvedValue({ isConnected: true });
  mockApiRequest.mockResolvedValueOnce({ json: async () => ({ photoUploadUrls: [] }) });
  await act(async () => {
    await syncManager.drain();
  });
  await act(flush);

  expect(await screen.findByText('Sent')).toBeTruthy();
  expect(mockApiRequest).toHaveBeenCalledWith(
    'inspections/field-capture',
    tokens,
    expect.objectContaining({ method: 'POST' }),
  );
});

test('an attached photo is named for the capture, queued with it, and PUT to the presigned URL', async () => {
  mockLaunchCamera.mockResolvedValueOnce({
    didCancel: false,
    assets: [{ uri: 'file:///tmp/front door.jpg', fileName: 'front door.jpg', type: 'image/jpeg' }],
  });
  let sentFilename = '';
  const uploadUrl = `https://assets.s3.amazonaws.com/k?X-Amz-Date=${amzDate(new Date())}&X-Amz-Expires=600&X-Amz-Signature=s`;
  mockApiRequest.mockImplementationOnce(
    async (_path: string, _tokens: unknown, init: { body: string }) => {
      sentFilename = JSON.parse(init.body).photoFilenames[0];
      return { json: async () => ({ photoUploadUrls: [{ filename: sentFilename, uploadUrl }] }) };
    },
  );
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) =>
      input === 'file:///tmp/front door.jpg'
        ? ({ blob: async () => new Blob(['x']) } as Response)
        : ({ ok: true, status: 200 } as Response),
    );
  await renderScreen(true);

  await fillIds();
  await act(async () => {
    fireEvent.press(await screen.findByRole('button', { name: 'Add photo' }));
  });
  expect(await screen.findByText(/photo attached: front door\.jpg/i)).toBeTruthy();
  await save();

  expect(await screen.findByText('Sent')).toBeTruthy();
  expect(sentFilename).toMatch(/^fc-[A-Za-z0-9._-]+-front_door\.jpg$/);
  expect(fetchSpy).toHaveBeenCalledWith(uploadUrl, expect.objectContaining({ method: 'PUT' }));
  expect(screen.queryByText(/photo attachment is not yet connected/i)).toBeNull();
  fetchSpy.mockRestore();
});

test('a server refusal is shown as Refused with the reason, and can be discarded', async () => {
  mockApiRequest.mockRejectedValueOnce(
    new ApiError({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Inspection insp-9 was not found',
      traceId: 't',
    }),
  );
  await renderScreen(true);

  await fillIds('occ-1', 'insp-9');
  await save();

  expect(await screen.findByText('Refused by server')).toBeTruthy();
  expect(await screen.findByText('Inspection insp-9 was not found')).toBeTruthy();
  await act(async () => {
    fireEvent.press(await screen.findByRole('button', { name: 'Discard Field capture — occ-1' }));
  });
  await act(flush);

  expect(await screen.findByText('Discarded')).toBeTruthy();
  await expect(store.all()).resolves.toHaveLength(0);
});

test('a transient failure says it will retry, not that it was sent', async () => {
  mockApiRequest.mockRejectedValueOnce(new Error('Network request failed'));
  await renderScreen(true);

  await fillIds();
  await save();

  expect(await screen.findByText('Not sent yet')).toBeTruthy();
  expect(screen.queryByText('Sent')).toBeNull();
  expect(await screen.findByRole('button', { name: 'Retry Field capture — occ-1' })).toBeTruthy();
});

test('violations are sent as open items and an incomplete one blocks saving', async () => {
  mockNetInfoFetch.mockResolvedValue({ isConnected: false });
  await renderScreen(false);
  await fillIds();

  await act(async () => {
    fireEvent.press(await screen.findByRole('button', { name: 'Add violation' }));
  });
  expect(await screen.findByText('Each violation needs a code and a description.')).toBeTruthy();
  expect(
    (await screen.findByRole('button', { name: 'Save capture' })).props.accessibilityState.disabled,
  ).toBe(true);

  await act(async () => {
    fireEvent.changeText(await screen.findByLabelText('Violation 1 code'), 'NFPA-10');
  });
  await act(async () => {
    fireEvent.changeText(
      await screen.findByLabelText('Violation 1 description'),
      'Extinguisher tag expired',
    );
  });
  await save();

  const [row] = await store.all();
  expect(JSON.parse(row!.body).violations).toEqual([
    { code: 'NFPA-10', description: 'Extinguisher tag expired', status: 'open' },
  ]);
});

test('an inspection id the API cannot accept is flagged before it reaches the outbox', async () => {
  await renderScreen(true);
  await fillIds('occ-1', 'insp/1');

  expect(await screen.findByText("Inspection ID can't contain / or ..")).toBeTruthy();
  expect(
    (await screen.findByRole('button', { name: 'Save capture' })).props.accessibilityState.disabled,
  ).toBe(true);
});

test('text inputs and actions meet the glove-sized field target', async () => {
  await renderScreen(true);

  expect((await screen.findByLabelText('Occupancy ID')).props.style.minHeight).toBe(
    targetSize.field,
  );
  expect(
    (await screen.findByRole('button', { name: 'Save capture' })).props.style.minHeight,
  ).toBeGreaterThanOrEqual(targetSize.field);
});

test('re-saving is impossible once queued: a new capture gets a fresh idempotency key', async () => {
  mockNetInfoFetch.mockResolvedValue({ isConnected: false });
  await renderScreen(false);
  await fillIds();
  await save();
  await act(async () => {
    fireEvent.press(await screen.findByRole('button', { name: 'New capture' }));
  });
  await fillIds('occ-2', 'insp-2');
  await save();

  const rows = await store.all();
  expect(rows).toHaveLength(2);
  expect(rows[0]!.id).not.toBe(rows[1]!.id);
});
