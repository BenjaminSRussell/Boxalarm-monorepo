import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { NotificationPreferencesScreen } from './NotificationPreferencesScreen';

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
  memberId: 'MBR-0001',
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
});

test('renders the certification expiry preference from the API', async () => {
  mockApiRequest.mockImplementation(async (path: string) => {
    if (path === 'notifications/preferences') {
      return {
        json: async () => ({
          preferences: [{ category: 'cert-expiry', channels: { push: true, email: false } }],
        }),
      };
    }
    return { json: async () => ({}) };
  });

  const { findByLabelText } = await render(<NotificationPreferencesScreen />);

  // push: true is a MUTE, so the "notifications on" switch is off.
  const toggle = await findByLabelText('Certification expiry push notifications');
  expect(toggle.props.value).toBe(false);
});

test('with no stored preference nothing is muted, so the switch starts on', async () => {
  mockApiRequest.mockImplementation(async () => ({ json: async () => ({ preferences: [] }) }));

  const { findByLabelText } = await render(<NotificationPreferencesScreen />);

  const toggle = await findByLabelText('Certification expiry push notifications');
  await waitFor(() => expect(toggle.props.value).toBe(true));
});

test('turning the switch off saves a push mute under the cert-expiry category', async () => {
  let saved: unknown;
  mockApiRequest.mockImplementation(async (path: string, _tokens: unknown, init?: RequestInit) => {
    if (path === 'notifications/preferences' && init?.method === 'PUT') {
      saved = JSON.parse(String(init.body));
      return { json: async () => ({}) };
    }
    return { json: async () => ({ preferences: [] }) };
  });

  const { findByLabelText } = await render(<NotificationPreferencesScreen />);
  const toggle = await findByLabelText('Certification expiry push notifications');
  await waitFor(() => expect(toggle.props.value).toBe(true));

  await act(async () => {
    fireEvent(toggle, 'valueChange', false);
  });

  expect(saved).toEqual({ category: 'cert-expiry', channels: { push: true, email: false } });
  expect((await findByLabelText('Certification expiry push notifications')).props.value).toBe(
    false,
  );
});

test('shows an error message instead of hanging when the preferences fetch fails', async () => {
  mockApiRequest.mockRejectedValue(new Error('network error'));

  const { findByRole } = await render(<NotificationPreferencesScreen />);

  const alert = await findByRole('alert');
  expect(alert.props.children).toBe(
    'Notification preferences could not be loaded. Check your connection and try again.',
  );
});

test('a failed save reverts the optimistic toggle and tells the member (M11)', async () => {
  mockApiRequest.mockImplementation(async (path: string, _tokens: unknown, init?: RequestInit) => {
    if (path === 'notifications/preferences' && init?.method === 'PUT') {
      throw new Error('network error');
    }
    return {
      json: async () => ({
        preferences: [{ category: 'cert-expiry', channels: { push: false, email: false } }],
      }),
    };
  });

  const { findByLabelText, findByRole } = await render(<NotificationPreferencesScreen />);
  const toggle = await findByLabelText('Certification expiry push notifications');
  await waitFor(() => expect(toggle.props.value).toBe(true));

  await act(async () => {
    fireEvent(toggle, 'valueChange', false);
  });

  expect((await findByRole('alert')).props.children).toBe(
    'Your change was not saved. Check your connection and try again.',
  );
  expect((await findByLabelText('Certification expiry push notifications')).props.value).toBe(true);
});

test('lists only the reminders a MEMBER can receive', async () => {
  mockApiRequest.mockImplementation(async () => ({ json: async () => ({ preferences: [] }) }));

  const { findByLabelText, queryByLabelText } = await render(<NotificationPreferencesScreen />);

  expect(await findByLabelText('Your PPE expiry push notifications')).toBeTruthy();
  expect(queryByLabelText('Apparatus defects push notifications')).toBeNull();
  expect(queryByLabelText('Department PPE expiry push notifications')).toBeNull();
});

test('an apparatus officer can mute each apparatus reminder under its own category', async () => {
  mockUseOptionalAuth.mockReturnValue({ ...mockAuthValue, roles: ['MEMBER', 'APPARATUS'] });
  let saved: unknown;
  mockApiRequest.mockImplementation(async (path: string, _tokens: unknown, init?: RequestInit) => {
    if (path === 'notifications/preferences' && init?.method === 'PUT') {
      saved = JSON.parse(String(init.body));
      return { json: async () => ({}) };
    }
    return {
      json: async () => ({
        preferences: [{ category: 'inventory-reorder', channels: { push: true, email: false } }],
      }),
    };
  });

  const { findByLabelText } = await render(<NotificationPreferencesScreen />);

  expect(await findByLabelText('Apparatus tests due push notifications')).toBeTruthy();
  // The department PPE feed has its own switch, apart from the member's own PPE.
  expect(await findByLabelText('Department PPE expiry push notifications')).toBeTruthy();
  await waitFor(async () =>
    expect((await findByLabelText('Supply reorders push notifications')).props.value).toBe(false),
  );
  const defects = await findByLabelText('Apparatus defects push notifications');
  await act(async () => {
    fireEvent(defects, 'valueChange', false);
  });

  expect(saved).toEqual({ category: 'apparatus-defect', channels: { push: true, email: false } });
});

test('a training officer is told the department certification digest cannot be muted', async () => {
  mockUseOptionalAuth.mockReturnValue({ ...mockAuthValue, roles: ['MEMBER', 'TRAINING'] });
  mockApiRequest.mockImplementation(async () => ({ json: async () => ({ preferences: [] }) }));

  const { findByText } = await render(<NotificationPreferencesScreen />);

  expect(
    await findByText(/department-wide certification-expiry digest; it cannot be muted/),
  ).toBeTruthy();
});
