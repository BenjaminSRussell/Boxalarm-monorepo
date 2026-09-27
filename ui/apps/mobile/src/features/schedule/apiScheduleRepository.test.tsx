import { renderHook } from '@testing-library/react-native';
import Config from 'react-native-config';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { apiRequest, ApiError } from '../../lib/apiClient';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { useScheduleRepository } from './apiScheduleRepository';
import { mockScheduleRepository } from './mockScheduleRepository';

// Mock factories are fully self-contained (no closures over outer consts), matching
// apiChecksRepository.test.tsx's precedent.
jest.mock('../../lib/apiClient', () => {
  const actual = jest.requireActual('../../lib/apiClient');
  return { ...actual, apiRequest: jest.fn() };
});
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('../../sync/ConnectivityContext', () => ({ useOptionalConnectivity: jest.fn() }));
// jest.setup.js pins react-native-config's API_BASE_URL to '' globally so the API branch of
// useScheduleRepository never runs under the default mock; this file needs it configured.
jest.mock('react-native-config', () => ({ __esModule: true, default: { API_BASE_URL: '' } }));

const mockApiRequest = apiRequest as jest.Mock;
const mockUseOptionalAuth = useOptionalAuth as jest.Mock;
const mockUseOptionalConnectivity = useOptionalConnectivity as jest.Mock;
const mockConfig = Config as unknown as { API_BASE_URL: string };

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

beforeEach(() => {
  mockApiRequest.mockReset();
  mockUseOptionalAuth.mockReturnValue(mockAuthValue);
  mockUseOptionalConnectivity.mockReturnValue({ isOnline: true });
  mockConfig.API_BASE_URL = 'https://api.example.com';
});

test('getShifts returns the real shifts (with empty positions) on a successful call', async () => {
  mockApiRequest.mockResolvedValue({
    json: async () => ({
      shifts: [
        {
          shiftId: 'SHIFT-1',
          startAt: Date.parse('2026-10-01T00:00:00Z'),
          endAt: Date.parse('2026-10-01T12:00:00Z'),
          stationId: 'STATION-1',
          status: 'OPEN',
        },
      ],
    }),
  });

  const { result } = await renderHook(() => useScheduleRepository());
  const shifts = await result.current.getShifts();

  expect(shifts).toEqual([expect.objectContaining({ shiftId: 'SHIFT-1', positions: [] })]);
});

test('getShifts re-throws an ApiError instead of silently falling back to mock data', async () => {
  const forbidden = new ApiError({
    type: 'about:blank',
    title: 'Forbidden',
    status: 403,
    traceId: 'trace-403',
  });
  mockApiRequest.mockRejectedValue(forbidden);

  const { result } = await renderHook(() => useScheduleRepository());

  await expect(result.current.getShifts()).rejects.toBe(forbidden);
});

test('getShifts falls back to mock data on a genuine network failure', async () => {
  mockApiRequest.mockRejectedValue(new TypeError('Failed to fetch'));

  const { result } = await renderHook(() => useScheduleRepository());

  const shifts = await result.current.getShifts();
  expect(shifts).toEqual(await mockScheduleRepository.getShifts());
});

test('claimPosition resolves CLAIMED on a bare 2xx with no outcome field', async () => {
  mockApiRequest.mockResolvedValue({ json: async () => ({}) });

  const { result } = await renderHook(() => useScheduleRepository());

  await expect(result.current.claimPosition('SHIFT-1', 'DRIVER')).resolves.toBe('CLAIMED');
});

test('claimPosition resolves ALREADY_MINE when the response body says so', async () => {
  mockApiRequest.mockResolvedValue({ json: async () => ({ outcome: 'ALREADY_MINE' }) });

  const { result } = await renderHook(() => useScheduleRepository());

  await expect(result.current.claimPosition('SHIFT-1', 'DRIVER')).resolves.toBe('ALREADY_MINE');
});

test('claimPosition resolves ALREADY_TAKEN on a 409 (CONFLICT)', async () => {
  const conflict = new ApiError({
    type: 'about:blank',
    title: 'Conflict',
    status: 409,
    traceId: 'trace-409',
  });
  mockApiRequest.mockRejectedValue(conflict);

  const { result } = await renderHook(() => useScheduleRepository());

  await expect(result.current.claimPosition('SHIFT-1', 'DRIVER')).resolves.toBe('ALREADY_TAKEN');
});

test('claimPosition re-throws a non-409 ApiError (e.g. NOT_FOUND) instead of masking it', async () => {
  const notFound = new ApiError({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    traceId: 'trace-404',
  });
  mockApiRequest.mockRejectedValue(notFound);

  const { result } = await renderHook(() => useScheduleRepository());

  await expect(result.current.claimPosition('SHIFT-1', 'DRIVER')).rejects.toBe(notFound);
});

test('claimPosition reuses a caller-supplied idempotencyKey instead of generating a new one', async () => {
  mockApiRequest.mockResolvedValue({ json: async () => ({}) });

  const { result } = await renderHook(() => useScheduleRepository());

  await result.current.claimPosition('SHIFT-1', 'DRIVER', 'fixed-key-123');

  const body = JSON.parse(mockApiRequest.mock.calls[0]?.[2]?.body as string) as {
    idempotencyKey: string;
  };
  expect(body.idempotencyKey).toBe('fixed-key-123');
});

test('claimPosition falls back to the mock repository while offline', async () => {
  mockUseOptionalConnectivity.mockReturnValue({ isOnline: false });

  const { result } = await renderHook(() => useScheduleRepository());

  await expect(result.current.claimPosition('SHIFT-0511', 'DRIVER')).resolves.toBe('CLAIMED');
  expect(mockApiRequest).not.toHaveBeenCalled();
});
