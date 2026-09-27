import { renderHook } from '@testing-library/react-native';
import Config from 'react-native-config';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { apiRequest, ApiError } from '../../lib/apiClient';
import * as syncManager from '../../sync/syncManager';
import { useAttendanceRepository } from './apiAttendanceRepository';

// Mock factories are fully self-contained (no closures over outer consts), matching
// apiChecksRepository.test.tsx's precedent - the module under test is imported statically above,
// which requires react-native-config/AuthContext/apiClient before any later top-level `const` in
// this file would have run.
jest.mock('../../lib/apiClient', () => {
  const actual = jest.requireActual('../../lib/apiClient');
  return { ...actual, apiRequest: jest.fn() };
});
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('../../sync/syncManager', () => ({ enqueueAttendance: jest.fn() }));
// jest.setup.js pins react-native-config's API_BASE_URL to '' globally so the API branch of
// useAttendanceRepository never runs under the default mock; this file needs it configured.
jest.mock('react-native-config', () => ({ __esModule: true, default: { API_BASE_URL: '' } }));

const mockApiRequest = apiRequest as jest.Mock;
const mockEnqueueAttendance = syncManager.enqueueAttendance as jest.Mock;
const mockUseOptionalAuth = useOptionalAuth as jest.Mock;
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
  mockEnqueueAttendance.mockReset();
  mockUseOptionalAuth.mockReturnValue(mockAuthValue);
  mockConfig.API_BASE_URL = 'https://api.example.com';
});

test('getOwnRecords returns the real records on a successful call', async () => {
  const records = [{ activityType: 'DRILL' as const, refId: null, occurredAt: 1, hours: 2 }];
  mockApiRequest.mockResolvedValue({ json: async () => ({ records }) });

  const { result } = await renderHook(() => useAttendanceRepository());

  await expect(result.current.getOwnRecords()).resolves.toEqual(records);
});

test('getOwnRecords reports a network failure instead of showing mock records as real history', async () => {
  const offline = new TypeError('Failed to fetch');
  mockApiRequest.mockRejectedValue(offline);

  const { result } = await renderHook(() => useAttendanceRepository());

  await expect(result.current.getOwnRecords()).rejects.toBe(offline);
});

test('getOwnRecords re-throws an ApiError instead of silently falling back to mock data', async () => {
  const forbidden = new ApiError({
    type: 'about:blank',
    title: 'Forbidden',
    status: 403,
    detail: 'Cedar denied attendance:list',
    traceId: 'trace-403',
  });
  mockApiRequest.mockRejectedValue(forbidden);

  const { result } = await renderHook(() => useAttendanceRepository());

  await expect(result.current.getOwnRecords()).rejects.toBe(forbidden);
});

test('record() queues on the offline outbox keyed by occurredAt, never calling the API directly', async () => {
  mockEnqueueAttendance.mockResolvedValue(undefined);
  const entry = {
    activityType: 'DRILL' as const,
    refId: null,
    occurredAt: 1_790_000_000,
    hours: 1,
  };

  const { result } = await renderHook(() => useAttendanceRepository());
  await result.current.record(entry);

  expect(mockEnqueueAttendance).toHaveBeenCalledWith(
    'attendance-1790000000',
    expect.stringMatching(/^Attendance — Drill, /),
    entry,
  );
  expect(mockApiRequest).not.toHaveBeenCalled();
});
