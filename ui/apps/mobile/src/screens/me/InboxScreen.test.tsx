import { fireEvent, render } from '@testing-library/react-native';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { InboxScreen } from './InboxScreen';

jest.mock('../../lib/apiClient', () => {
  const actual = jest.requireActual('../../lib/apiClient');
  return { ...actual, apiRequest: jest.fn() };
});
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));
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
  mockNavigate.mockReset();
  mockApiRequest.mockReset();
  mockUseOptionalAuth.mockReturnValue(mockAuthValue);
});

test('opening an unread notification marks it read', async () => {
  mockApiRequest.mockImplementation(async (path: string) => {
    if (path === 'notifications') {
      return {
        json: async () => ({
          items: [
            {
              notificationId: 'n-1',
              category: 'CERT_EXPIRY',
              summary: '1 item expiring',
              createdAt: 1,
              readAt: null,
            },
          ],
        }),
      };
    }
    return { json: async () => ({}) };
  });

  const { findByText } = await render(<InboxScreen />);

  const row = await findByText('1 item expiring');
  fireEvent.press(row);

  expect(mockApiRequest).toHaveBeenCalledWith(
    'notifications/n-1/read',
    mockAuthValue,
    expect.objectContaining({ method: 'POST' }),
  );
});

test('shows an error message instead of hanging when the notifications fetch fails', async () => {
  mockApiRequest.mockRejectedValue(new Error('network error'));

  const { findByRole } = await render(<InboxScreen />);

  const alert = await findByRole('alert');
  expect(alert.props.children).toBe(
    'Notifications could not be loaded. Check your connection and try again.',
  );
});

function inboxResponse(items: unknown[]) {
  return async (path: string) =>
    path === 'notifications' ? { json: async () => ({ items }) } : { json: async () => ({}) };
}

test('renders each reminder category by name with what is due', async () => {
  mockApiRequest.mockImplementation(
    inboxResponse([
      {
        notificationId: 'n-oos',
        category: 'apparatus-defect',
        summary: '1 defect reported',
        items: [{ subjectId: 'DEF-1', title: 'E1', detail: 'reported out of service' }],
        createdAt: 2,
        readAt: null,
      },
      {
        notificationId: 'n-test',
        category: 'apparatus-test-due',
        summary: '4 tests due',
        items: [
          { subjectId: 'a', title: 'APP-E1', detail: 'hose test due 2026-10-20' },
          { subjectId: 'b', title: 'APP-E2', detail: 'pump test due 2026-10-21' },
          { subjectId: 'c', title: 'APP-L1', detail: 'aerial test due 2026-10-22' },
          { subjectId: 'd', title: 'APP-T1', detail: 'ladder test due 2026-10-23' },
        ],
        createdAt: 1,
        readAt: 1,
      },
      {
        notificationId: 'n-cert',
        category: 'cert-expiry',
        summary: '1 item expiring',
        items: [{ certId: 'EMR-1', expiryDate: '2026-10-14' }],
        createdAt: 0,
        readAt: 1,
      },
    ]),
  );

  const { findByText, getByText, getByLabelText } = await render(<InboxScreen />);

  expect(await findByText('Apparatus defects reported · Unread')).toBeTruthy();
  expect(getByText('E1 reported out of service')).toBeTruthy();
  // Screen readers hear which unit, not just the category (review M3).
  expect(
    getByLabelText(
      'Unread: Apparatus defects reported, 1 defect reported. E1 reported out of service',
    ),
  ).toBeTruthy();
  expect(
    getByLabelText(
      'Apparatus tests due, 4 tests due. APP-E1 hose test due 2026-10-20. APP-E2 pump test due 2026-10-21. APP-L1 aerial test due 2026-10-22. and 1 more',
    ),
  ).toBeTruthy();
  expect(getByText('Apparatus tests due')).toBeTruthy();
  expect(getByText('APP-L1 aerial test due 2026-10-22')).toBeTruthy();
  expect(getByText('+1 more')).toBeTruthy();
  // A notification written before reminder categories still reads naturally.
  expect(getByText('EMR-1 expires 2026-10-14')).toBeTruthy();
});

test('a PPE reminder about the member’s own gear links to My PPE', async () => {
  mockApiRequest.mockImplementation(
    inboxResponse([
      {
        notificationId: 'n-ppe',
        category: 'ppe-expiry',
        summary: '1 PPE item expiring',
        items: [
          {
            subjectId: 'MBR-0001:COAT',
            title: 'TURNOUT-COAT',
            detail: 'expires 2026-10-14',
            link: { kind: 'member', id: 'MBR-0001' },
          },
        ],
        createdAt: 1,
        readAt: null,
      },
      {
        notificationId: 'n-ppe-dept',
        category: 'ppe-expiry',
        summary: '1 PPE item expiring',
        items: [
          {
            subjectId: 'MBR-0099:HELMET',
            title: 'HELMET',
            detail: 'held by MBR-0099, expires 2026-10-14',
            link: { kind: 'member', id: 'MBR-0099' },
          },
        ],
        createdAt: 0,
        readAt: null,
      },
    ]),
  );

  const { findAllByRole } = await render(<InboxScreen />);

  const links = await findAllByRole('link');
  expect(links).toHaveLength(1);
  fireEvent.press(links[0]!);
  expect(mockNavigate).toHaveBeenCalledWith('MyPpe');
});
