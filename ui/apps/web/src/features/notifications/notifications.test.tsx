import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import { NotificationBell } from './NotificationBell';
import { NotificationsPage } from './NotificationsPage';
import type { InboxNotification } from './types';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'member-1', 'cognito:groups': groups },
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

function renderWithProviders(
  element: React.ReactElement,
  path = '/notifications',
  groups: string[] = ['MEMBER'],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={path} element={<RequireRole>{element}</RequireRole>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const UNREAD: InboxNotification = {
  notificationId: 'n-1',
  category: 'cert-expiry',
  summary: '2 items expiring',
  items: [
    { certId: 'EMR-1', expiryDate: '2026-10-14' },
    { certId: 'FF2-1', expiryDate: '2026-10-30' },
  ],
  createdAt: Date.parse('2026-09-26T12:00:00Z'),
  readAt: null,
};

const READ: InboxNotification = {
  notificationId: 'n-2',
  category: 'cert-expiry-officer',
  summary: '1 item expiring',
  items: [{ certId: 'CPR-9', expiryDate: '2026-09-30' }],
  createdAt: Date.parse('2026-09-20T12:00:00Z'),
  readAt: Date.parse('2026-09-21T12:00:00Z'),
};

/** The certification-expiry preference group; every category has its own push/email pair. */
async function certGroup() {
  return within(await screen.findByRole('group', { name: 'Certification-expiry reminders' }));
}

const NO_PREFS = http.get('/api/v1/notifications/preferences', () =>
  HttpResponse.json({ preferences: [] }),
);

test('a MEMBER sees their inbox, digest items, and read state', async () => {
  server.use(
    http.get('/api/v1/notifications', () =>
      HttpResponse.json({ items: [UNREAD, READ], nextCursor: null }),
    ),
    NO_PREFS,
  );
  renderWithProviders(<NotificationsPage />);

  expect(await screen.findByText('Your certifications expiring')).toBeTruthy();
  expect(screen.getByText('EMR-1 expires 2026-10-14')).toBeTruthy();
  expect(screen.getByText('Department certifications expiring')).toBeTruthy();
  // Only the unread notification offers "Mark read".
  expect(screen.getAllByRole('button', { name: /^Mark ".*" from .* read$/ })).toHaveLength(1);
  expect(screen.getByText('Unread:')).toBeTruthy();
});

test('Mark read POSTs to /api/v1/notifications/{id}/read and refreshes the inbox', async () => {
  let readAt: number | null = null;
  const posted = vi.fn();
  server.use(
    http.get('/api/v1/notifications', () =>
      HttpResponse.json({ items: [{ ...UNREAD, readAt }], nextCursor: null }),
    ),
    http.post('/api/v1/notifications/:id/read', ({ params }) => {
      posted(params.id);
      readAt = Date.now();
      return HttpResponse.json({ notificationId: params.id, readAt });
    }),
    NO_PREFS,
  );
  renderWithProviders(<NotificationsPage />);

  const button = await screen.findByRole('button', { name: /^Mark ".*" from .* read$/ });
  await userEvent.click(button);

  await waitFor(() => expect(posted).toHaveBeenCalledWith('n-1'));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /^Mark ".*" from .* read$/ })).toBeNull(),
  );
  expect(screen.getByText(/· Read$/)).toBeTruthy();
});

test('a failed mark-read says so and keeps the notification unread', async () => {
  server.use(
    http.get('/api/v1/notifications', () =>
      HttpResponse.json({ items: [UNREAD], nextCursor: null }),
    ),
    http.post('/api/v1/notifications/:id/read', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
    NO_PREFS,
  );
  renderWithProviders(<NotificationsPage />);

  await userEvent.click(await screen.findByRole('button', { name: /^Mark ".*" from .* read$/ }));

  expect(await screen.findByText('Could not mark this notification read. Try again.')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Mark ".*" from .* read$/ })).toBeTruthy();
});

test('an empty inbox explains itself instead of showing a bare list', async () => {
  server.use(
    http.get('/api/v1/notifications', () => HttpResponse.json({ items: [], nextCursor: null })),
    NO_PREFS,
  );
  renderWithProviders(<NotificationsPage />);

  expect(await screen.findByText('No notifications')).toBeTruthy();
  expect(screen.getByText(/Dispatch alerts never appear in this inbox/)).toBeTruthy();
});

test('an inbox load failure shows a retryable error, never an empty inbox', async () => {
  let fail = true;
  server.use(
    http.get('/api/v1/notifications', () =>
      fail
        ? HttpResponse.json(
            { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
            { status: 503 },
          )
        : HttpResponse.json({ items: [UNREAD], nextCursor: null }),
    ),
    NO_PREFS,
  );
  renderWithProviders(<NotificationsPage />);

  expect(await screen.findByText('Something went wrong loading this page')).toBeTruthy();
  expect(screen.queryByText('No notifications')).toBeNull();

  fail = false;
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Your certifications expiring')).toBeTruthy();
});

test('a 403 from the inbox renders the forbidden state', async () => {
  server.use(
    http.get('/api/v1/notifications', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Forbidden', status: 403, traceId: 't' },
        { status: 403 },
      ),
    ),
    NO_PREFS,
  );
  renderWithProviders(<NotificationsPage />);

  expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
});

test('Load older notifications follows nextCursor', async () => {
  const cursors: (string | null)[] = [];
  server.use(
    http.get('/api/v1/notifications', ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      cursors.push(cursor);
      return cursor === 'page-2'
        ? HttpResponse.json({ items: [READ], nextCursor: null })
        : HttpResponse.json({ items: [UNREAD], nextCursor: 'page-2' });
    }),
    NO_PREFS,
  );
  renderWithProviders(<NotificationsPage />);

  await userEvent.click(await screen.findByRole('button', { name: 'Load older notifications' }));

  expect(await screen.findByText('Department certifications expiring')).toBeTruthy();
  expect(cursors).toEqual([null, 'page-2']);
  expect(screen.queryByRole('button', { name: 'Load older notifications' })).toBeNull();
});

test('preferences: nothing stored means both channels on; unchecking push saves a push MUTE', async () => {
  const puts: unknown[] = [];
  server.use(
    http.get('/api/v1/notifications', () => HttpResponse.json({ items: [], nextCursor: null })),
    NO_PREFS,
    http.put('/api/v1/notifications/preferences', async ({ request }) => {
      const body = await request.json();
      puts.push(body);
      return HttpResponse.json(body);
    }),
  );
  renderWithProviders(<NotificationsPage />);

  const group = await certGroup();
  const push = group.getByRole('checkbox', { name: 'Push notification' });
  const email = group.getByRole('checkbox', { name: 'Email' });
  expect(push.getAttribute('aria-checked')).toBe('true');
  expect(email.getAttribute('aria-checked')).toBe('true');

  await userEvent.click(push);

  await waitFor(() =>
    expect(puts).toEqual([{ category: 'cert-expiry', channels: { push: true, email: false } }]),
  );
  expect(await screen.findByText('Preferences saved.')).toBeTruthy();
  expect(
    group.getByRole('checkbox', { name: 'Push notification' }).getAttribute('aria-checked'),
  ).toBe('false');
});

test('preferences: a stored email mute renders Email unchecked', async () => {
  server.use(
    http.get('/api/v1/notifications', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get('/api/v1/notifications/preferences', () =>
      HttpResponse.json({
        preferences: [{ category: 'cert-expiry', channels: { push: false, email: true } }],
      }),
    ),
  );
  renderWithProviders(<NotificationsPage />);

  const group = await certGroup();
  expect(group.getByRole('checkbox', { name: 'Email' }).getAttribute('aria-checked')).toBe('false');
  expect(
    group.getByRole('checkbox', { name: 'Push notification' }).getAttribute('aria-checked'),
  ).toBe('true');
});

test('preferences: a failed save is reported and the toggle reverts to the stored value', async () => {
  server.use(
    http.get('/api/v1/notifications', () => HttpResponse.json({ items: [], nextCursor: null })),
    NO_PREFS,
    http.put('/api/v1/notifications/preferences', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
  );
  renderWithProviders(<NotificationsPage />);

  const group = await certGroup();
  await userEvent.click(group.getByRole('checkbox', { name: 'Email' }));

  expect(
    await screen.findByText('Your change was not saved. Check your connection and try again.'),
  ).toBeTruthy();
  await waitFor(() =>
    expect(group.getByRole('checkbox', { name: 'Email' }).getAttribute('aria-checked')).toBe(
      'true',
    ),
  );
});

test('preferences: a load failure shows an error, not default toggles', async () => {
  server.use(
    http.get('/api/v1/notifications', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get('/api/v1/notifications/preferences', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
  );
  renderWithProviders(<NotificationsPage />);

  expect(await screen.findByText('Something went wrong loading this page')).toBeTruthy();
  expect(screen.queryByRole('checkbox', { name: 'Push notification' })).toBeNull();
});

test('renders each reminder category with its title, what is due, and a link where the member may go', async () => {
  const items: InboxNotification[] = [
    {
      notificationId: 'n-oos',
      category: 'apparatus-defect',
      summary: '1 defect reported',
      items: [
        {
          subjectId: 'DEF-1',
          title: 'E1',
          detail: 'reported out of service',
          link: { kind: 'apparatus', id: 'E1' },
        },
      ],
      createdAt: Date.parse('2026-09-29T14:03:00Z'),
      readAt: null,
    },
    {
      notificationId: 'n-test',
      category: 'apparatus-test-due',
      summary: '1 test due',
      items: [
        {
          subjectId: 'APP-E1:HOSE',
          title: 'APP-E1',
          detail: 'hose test due 2026-10-20',
          dueDate: '2026-10-20',
          link: { kind: 'apparatus' },
        },
      ],
      createdAt: Date.parse('2026-09-29T12:00:00Z'),
      readAt: null,
    },
    {
      notificationId: 'n-reorder',
      category: 'inventory-reorder',
      summary: '1 item below reorder level',
      items: [
        {
          subjectId: 'GLOVES-L',
          title: 'Gloves (Large)',
          detail: '3 on hand, reorder at 5',
          link: { kind: 'consumables' },
        },
      ],
      createdAt: Date.parse('2026-09-29T12:00:00Z'),
      readAt: null,
    },
    {
      notificationId: 'n-ppe',
      category: 'ppe-expiry',
      summary: '1 PPE item expiring',
      items: [
        {
          subjectId: 'MBR-34:COAT',
          title: 'TURNOUT-COAT',
          detail: 'held by MBR-34, expires 2026-10-14',
          link: { kind: 'member', id: 'MBR-34' },
        },
      ],
      createdAt: Date.parse('2026-09-29T12:00:00Z'),
      readAt: null,
    },
  ];
  server.use(
    http.get('/api/v1/notifications', () => HttpResponse.json({ items, nextCursor: null })),
    NO_PREFS,
  );
  renderWithProviders(<NotificationsPage />, '/notifications', ['MEMBER', 'APPARATUS']);

  expect(await screen.findByText('Apparatus defects reported')).toBeTruthy();
  expect(screen.getByText('Apparatus tests due')).toBeTruthy();
  expect(screen.getByText('Supplies to reorder')).toBeTruthy();
  expect(screen.getByText('PPE expiring')).toBeTruthy();

  const oos = screen.getByRole('link', { name: 'E1 reported out of service' });
  expect(oos.getAttribute('href')).toBe('/apparatus/E1');
  expect(
    screen.getByRole('link', { name: 'APP-E1 hose test due 2026-10-20' }).getAttribute('href'),
  ).toBe('/apparatus');
  expect(
    screen
      .getByRole('link', { name: 'Gloves (Large) 3 on hand, reorder at 5' })
      .getAttribute('href'),
  ).toBe('/inventory');
  // An APPARATUS member cannot open /personnel/:id, so the PPE item is text, not a dead link.
  expect(screen.getByText('TURNOUT-COAT held by MBR-34, expires 2026-10-14')).toBeTruthy();
  expect(screen.queryByRole('link', { name: /TURNOUT-COAT/ })).toBeNull();
});

test('a MEMBER without the apparatus role sees reminder items as text, never links they cannot open', async () => {
  server.use(
    http.get('/api/v1/notifications', () =>
      HttpResponse.json({
        items: [
          {
            notificationId: 'n-test',
            category: 'apparatus-test-due',
            summary: '1 test due',
            items: [
              {
                subjectId: 'X',
                title: 'APP-E1',
                detail: 'hose test due',
                link: { kind: 'apparatus' },
              },
            ],
            createdAt: 1,
            readAt: null,
          },
        ],
        nextCursor: null,
      }),
    ),
    NO_PREFS,
  );
  renderWithProviders(<NotificationsPage />);

  expect(await screen.findByText('APP-E1 hose test due')).toBeTruthy();
  expect(screen.queryByRole('link', { name: /APP-E1/ })).toBeNull();
});

test('preferences: a MEMBER is offered only the reminders about their own records', async () => {
  server.use(
    http.get('/api/v1/notifications', () => HttpResponse.json({ items: [], nextCursor: null })),
    NO_PREFS,
  );
  renderWithProviders(<NotificationsPage />);

  await certGroup();
  const legends = screen.getAllByRole('group').map((g) => g.querySelector('legend')?.textContent);
  expect(legends).toEqual(['Certification-expiry reminders', 'PPE expiry reminders']);
});

test('preferences: an apparatus officer can mute each apparatus reminder category on its own key', async () => {
  const puts: unknown[] = [];
  server.use(
    http.get('/api/v1/notifications', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get('/api/v1/notifications/preferences', () =>
      HttpResponse.json({
        preferences: [{ category: 'inventory-reorder', channels: { push: true, email: false } }],
      }),
    ),
    http.put('/api/v1/notifications/preferences', async ({ request }) => {
      const body = await request.json();
      puts.push(body);
      return HttpResponse.json(body);
    }),
  );
  renderWithProviders(<NotificationsPage />, '/notifications', ['MEMBER', 'APPARATUS']);

  await certGroup();
  const legends = screen.getAllByRole('group').map((g) => g.querySelector('legend')?.textContent);
  expect(legends).toEqual([
    'Certification-expiry reminders',
    'PPE expiry reminders',
    'Apparatus test reminders',
    'Apparatus defect reports',
    'Supply reorder reminders',
  ]);

  const reorder = within(screen.getByRole('group', { name: 'Supply reorder reminders' }));
  expect(
    reorder.getByRole('checkbox', { name: 'Push notification' }).getAttribute('aria-checked'),
  ).toBe('false');

  const defects = within(screen.getByRole('group', { name: 'Apparatus defect reports' }));
  await userEvent.click(defects.getByRole('checkbox', { name: 'Email' }));

  await waitFor(() =>
    expect(puts).toEqual([
      { category: 'apparatus-defect', channels: { push: false, email: true } },
    ]),
  );
});

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(['MEMBER'])}>
        <MemoryRouter>
          <NotificationBell />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('bell: links to the inbox and labels the unread count', async () => {
  server.use(
    http.get('/api/v1/notifications', () =>
      HttpResponse.json({ items: [UNREAD, READ], nextCursor: null }),
    ),
  );
  renderBell();

  const link = await screen.findByRole('link', { name: 'Notifications, 1 unread' });
  expect(link.getAttribute('href')).toBe('/notifications');
  expect(within(link).getByText('1')).toBeTruthy();
});

test('bell: says "+" when every item on the first page is unread and more pages exist', async () => {
  server.use(
    http.get('/api/v1/notifications', () =>
      HttpResponse.json({ items: [UNREAD], nextCursor: 'more' }),
    ),
  );
  renderBell();

  expect(await screen.findByRole('link', { name: 'Notifications, 1+ unread' })).toBeTruthy();
});

test('bell: an unreachable inbox shows no count rather than a fabricated zero', async () => {
  server.use(
    http.get('/api/v1/notifications', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
  );
  renderBell();

  const link = await screen.findByRole('link', {
    name: 'Notifications (unread count unavailable)',
  });
  expect(link.textContent).toBe('');
});

test('bell: nothing unread says so', async () => {
  server.use(
    http.get('/api/v1/notifications', () => HttpResponse.json({ items: [READ], nextCursor: null })),
  );
  renderBell();

  expect(await screen.findByRole('link', { name: 'Notifications, none unread' })).toBeTruthy();
});
