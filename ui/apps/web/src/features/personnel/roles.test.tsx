import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { MemberDetailPage } from './MemberDetailPage';
import { describeRoleChange } from './RolesSection';
import type { Member } from './types';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

function makeManager(groups: string[], sub: string): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub, 'cognito:groups': groups },
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

function renderDetail(groups: string[], sub = 'chief-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups, sub)}>
        <MemoryRouter initialEntries={['/personnel/m1']}>
          <Routes>
            <Route path="/personnel/:id" element={<MemberDetailPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function member(roles: Member['roles']): Member {
  return {
    memberId: 'm1',
    firstName: 'Sam',
    lastName: 'Lee',
    email: 'sam@example.com',
    phone: '203-555-0199',
    status: 'ACTIVE',
    joinDate: '2020-01-01',
    rank: 'Lt',
    agencyId: 'NFD-1',
    roles,
  };
}

/** Serves m1 and records every PUT /roles body; `reply` decides the response. */
function serveMember(stored: Member, reply?: (roles: string[]) => Response) {
  const puts: string[][] = [];
  server.use(
    http.get('/api/v1/personnel/members/m1', () => HttpResponse.json(stored)),
    http.put('/api/v1/personnel/members/m1/roles', async ({ request }) => {
      const { roles } = (await request.json()) as { roles: string[] };
      puts.push(roles);
      if (reply) return reply(roles);
      stored.roles = roles as Member['roles'];
      return HttpResponse.json({
        memberId: 'm1',
        roles,
        changed: true,
        takesEffect: 'within one hour',
      });
    }),
  );
  return puts;
}

test('a chief grants and removes roles through a confirm step that names the change', async () => {
  const puts = serveMember(member(['MEMBER', 'TRAINING']));
  const user = userEvent.setup();
  renderDetail(['CHIEF']);

  const form = await screen.findByRole('form', { name: 'Member roles' });
  const memberBox = within(form).getByRole('checkbox', { name: 'MEMBER' }) as HTMLInputElement;
  expect(memberBox.checked).toBe(true);
  expect(memberBox.disabled).toBe(true);
  expect(memberBox.getAttribute('aria-describedby')).toBe('member-role-note');

  await user.click(within(form).getByRole('checkbox', { name: 'OFFICER' }));
  await user.click(within(form).getByRole('checkbox', { name: 'TRAINING' }));
  await user.click(within(form).getByRole('button', { name: 'Review role changes' }));

  const dialog = await screen.findByRole('dialog', { name: 'Change roles for Sam Lee?' });
  expect(within(dialog).getByText(/Grant OFFICER, remove TRAINING\./)).toBeTruthy();
  expect(within(dialog).getByText(/within an hour/)).toBeTruthy();
  expect(puts).toEqual([]);

  await user.click(within(dialog).getByRole('button', { name: 'Save roles' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(puts).toEqual([['MEMBER', 'OFFICER']]);
  expect(screen.getByRole('status').textContent).toMatch(
    /Sam's app picks up the change within an hour, when it next refreshes/,
  );
  expect(
    (within(form).getByRole('checkbox', { name: 'OFFICER' }) as HTMLInputElement).checked,
  ).toBe(true);
});

test("shows the server's own words when the save fails, and keeps the dialog open", async () => {
  serveMember(member(['MEMBER']), () =>
    HttpResponse.json(
      {
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'member roles were only partly saved; retry the same request to finish',
        traceId: 't-1',
      },
      { status: 503 },
    ),
  );
  const user = userEvent.setup();
  renderDetail(['ADMIN']);

  const form = await screen.findByRole('form', { name: 'Member roles' });
  await user.click(within(form).getByRole('checkbox', { name: 'CHIEF' }));
  await user.click(within(form).getByRole('button', { name: 'Review role changes' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Save roles' }));

  expect((await within(dialog).findByRole('alert')).textContent).toBe(
    'member roles were only partly saved; retry the same request to finish',
  );
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('says so, and sends nothing, when no role was changed', async () => {
  const puts = serveMember(member(['MEMBER', 'OFFICER']));
  const user = userEvent.setup();
  renderDetail(['ADMIN']);

  const form = await screen.findByRole('form', { name: 'Member roles' });
  await user.click(within(form).getByRole('button', { name: 'Review role changes' }));

  expect(screen.getByRole('status').textContent).toBe('No changes to save.');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(puts).toEqual([]);
});

test('an officer sees the roles but cannot edit them', async () => {
  serveMember(member(['MEMBER', 'OFFICER']));
  renderDetail(['OFFICER']);

  await screen.findByRole('heading', { name: 'Roles' });
  expect(screen.getByText('MEMBER, OFFICER')).toBeTruthy();
  expect(screen.queryByRole('form', { name: 'Member roles' })).toBeNull();
});

test('a chief cannot edit their own roles', async () => {
  serveMember(member(['MEMBER', 'CHIEF']));
  renderDetail(['CHIEF'], 'm1');

  await screen.findByRole('heading', { name: 'Roles' });
  expect(screen.queryByRole('form', { name: 'Member roles' })).toBeNull();
  expect(screen.getByText(/You cannot change your own roles/)).toBeTruthy();
});

describe('describeRoleChange', () => {
  test.each([
    [['MEMBER'], ['MEMBER', 'OFFICER'], 'Grant OFFICER'],
    [['MEMBER', 'TRAINING'], ['MEMBER'], 'Remove TRAINING'],
    [
      ['MEMBER', 'TRAINING'],
      ['MEMBER', 'OFFICER', 'CHIEF'],
      'Grant OFFICER, CHIEF, remove TRAINING',
    ],
    [['MEMBER'], ['MEMBER'], ''],
  ] as const)('%j -> %j reads %j', (before, after, expected) => {
    expect(describeRoleChange(before, after)).toBe(expected);
  });
});
