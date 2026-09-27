import { renderHook } from '@testing-library/react-native';
import Config from 'react-native-config';
import { useOptionalAuth } from '../auth/AuthContext';
import * as syncManager from './syncManager';
import { useSyncEngine } from './useSyncEngine';

jest.mock('../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('react-native-config', () => ({ __esModule: true, default: { API_BASE_URL: '' } }));
jest.mock('./syncManager', () => ({ configure: jest.fn() }));

const mockUseOptionalAuth = useOptionalAuth as jest.Mock;
const mockConfigure = syncManager.configure as jest.Mock;
const mockConfig = Config as unknown as { API_BASE_URL: string };

beforeEach(() => {
  mockConfigure.mockReset();
  mockConfig.API_BASE_URL = 'https://api.example.com';
});

test('configures the outbox with the signed-in token source, independent of any screen', async () => {
  const auth = { isAuthenticated: true, getAccessToken: jest.fn(), renewSilently: jest.fn() };
  mockUseOptionalAuth.mockReturnValue(auth);

  await renderHook(() => useSyncEngine());

  expect(mockConfigure).toHaveBeenCalledWith(auth, 'https://api.example.com');
});

test('signed out, the outbox is unconfigured so nothing is sent without a session', async () => {
  mockUseOptionalAuth.mockReturnValue({ isAuthenticated: false });

  await renderHook(() => useSyncEngine());

  expect(mockConfigure).toHaveBeenCalledWith(null, 'https://api.example.com');
});

test('a re-render with the same session does not reconfigure', async () => {
  mockUseOptionalAuth.mockReturnValue({ isAuthenticated: true });

  const { rerender } = await renderHook(() => useSyncEngine());
  await rerender({});

  expect(mockConfigure).toHaveBeenCalledTimes(1);
});
