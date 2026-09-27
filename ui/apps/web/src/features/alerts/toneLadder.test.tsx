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
import { AlertsRosterPage } from './AlertsRosterPage';
import type { DispatchAlert } from './types';

// F1.13/F1.14 officer controls on /alerts/roster, against the architecture.md §2 routes.

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
    profile: { sub: 'u1', 'cognito:groups': groups },
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

function renderPage(groups: string[] = ['OFFICER']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={['/alerts/roster?dispatchId=D-1']}>
          <Routes>
            <Route
              path="/alerts/roster"
              element={
                <RequireRole>
                  <AlertsRosterPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function dispatch(overrides: Partial<DispatchAlert> = {}): DispatchAlert {
  return {
    dispatchId: 'D-1',
    incidentType: 'Structure fire',
    address: '18 Nichols Ave',
    crossStreets: 'Main & Nichols',
    mapLink: null,
    narrative: 'Smoke showing',
    prePlan: null,
    toneLadder: { status: 'ACTIVE', currentToneSequence: 1, nextToneAt: null },
    mutualAid: null,
    ...overrides,
  };
}

/** The page's other panels, plus a dispatch GET that returns `current()` on every read. */
function usePage(current: () => DispatchAlert) {
  server.use(
    http.get('/api/v1/alerting/dispatches/D-1', () => HttpResponse.json(current())),
    http.get('/api/v1/alerting/dispatches/D-1/roster', () => HttpResponse.json({ members: [] })),
    http.get('/api/v1/alerting/dispatches/D-1/receipts', () => HttpResponse.json({ receipts: [] })),
    http.get('/api/v1/apparatus/riding-board/D-1', () =>
      HttpResponse.json({ dispatchId: 'D-1', apparatus: [] }),
    ),
  );
}

function problem(status: number, detail: string) {
  return HttpResponse.json(
    { type: 'about:blank', title: 'Problem', status, detail, traceId: 't-1' },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

test('an officer advances the ladder after confirming, sending the tone they were looking at', async () => {
  let state = dispatch();
  usePage(() => state);
  let sentBody: unknown;
  server.use(
    http.post('/api/v1/alerting/dispatches/D-1/tone-ladder/advance', async ({ request }) => {
      sentBody = await request.json();
      state = dispatch({
        toneLadder: { status: 'ACTIVE', currentToneSequence: 2, nextToneAt: null },
      });
      return HttpResponse.json({
        dispatchId: 'D-1',
        toneSequence: 2,
        outcome: 'FIRED_MANUAL_OVERRIDE',
      });
    }),
  );
  const user = userEvent.setup();
  renderPage();

  expect(await screen.findByText(/Tone 1 of 3 has fired/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Advance to tone 2' }));
  const dialog = await screen.findByRole('dialog', { name: 'Fire tone 2 now?' });
  expect(dialog.textContent).toMatch(/however many have already responded/);
  expect(sentBody).toBeUndefined();
  await user.click(within(dialog).getByRole('button', { name: 'Fire tone 2' }));

  expect(await screen.findByText('Tone 2 sent to every eligible member.')).toBeTruthy();
  expect(sentBody).toEqual({ expectedCurrentToneSequence: 1 });
  expect(await screen.findByText(/Tone 2 of 3 has fired/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Advance to tone 3' })).toBeTruthy();
});

test('cancelling the advance dialog sends nothing', async () => {
  usePage(() => dispatch());
  const advance = vi.fn();
  server.use(
    http.post('/api/v1/alerting/dispatches/D-1/tone-ladder/advance', () => {
      advance();
      return HttpResponse.json({});
    }),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Advance to tone 2' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(advance).not.toHaveBeenCalled();
});

test('a 409 (the ladder already moved) is shown in the dialog in the server’s words', async () => {
  usePage(() => dispatch());
  server.use(
    http.post('/api/v1/alerting/dispatches/D-1/tone-ladder/advance', () =>
      problem(409, 'Tone 2 has already fired. No additional tone was sent.'),
    ),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Advance to tone 2' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Fire tone 2' }));

  expect((await within(dialog).findByRole('alert')).textContent).toMatch(
    'Tone 2 has already fired. No additional tone was sent.',
  );
  expect(screen.queryByText(/sent to every eligible member/)).toBeNull();
});

test('an unknown outcome (502) or a network failure is never reported as success or as "nothing sent"', async () => {
  usePage(() => dispatch());
  let calls = 0;
  server.use(
    http.post('/api/v1/alerting/dispatches/D-1/tone-ladder/advance', () => {
      calls += 1;
      return calls === 1
        ? problem(502, 'Tone 2 may not have reached every member. Check the ladder.')
        : HttpResponse.error();
    }),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Advance to tone 2' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Fire tone 2' }));
  expect((await within(dialog).findByRole('alert')).textContent).toMatch(
    'Tone 2 may not have reached every member.',
  );

  await user.click(within(dialog).getByRole('button', { name: 'Fire tone 2' }));
  await waitFor(() =>
    expect(within(dialog).getByRole('alert').textContent).toMatch(
      /did not confirm this request. It may or may not have been received/,
    ),
  );
});

test('halt is confirmed as a destructive action, then the ladder shows halted with no advance/halt', async () => {
  let state = dispatch();
  usePage(() => state);
  server.use(
    http.post('/api/v1/alerting/dispatches/D-1/tone-ladder/halt', () => {
      state = dispatch({
        toneLadder: { status: 'HALTED_MANUAL', currentToneSequence: 1, nextToneAt: null },
      });
      return HttpResponse.json({
        dispatchId: 'D-1',
        toneLadder: { status: 'HALTED_MANUAL', currentToneSequence: 1 },
        changed: true,
      });
    }),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Halt tone ladder' }));
  const dialog = await screen.findByRole('dialog', { name: 'Halt the tone ladder?' });
  expect(dialog.textContent).toMatch(/cannot be advanced or resumed/);
  await user.click(within(dialog).getByRole('button', { name: 'Halt tone ladder' }));

  expect(await screen.findByText('Tone ladder halted after tone 1.')).toBeTruthy();
  expect(await screen.findByText(/Halted after tone 1/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Advance to tone/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Halt tone ladder' })).toBeNull();
  // Mutual aid stays available by hand on a halted ladder.
  expect(screen.getByRole('button', { name: 'Trigger mutual aid' })).toBeTruthy();
});

test('a completed ladder offers no advance or halt', async () => {
  usePage(() =>
    dispatch({ toneLadder: { status: 'COMPLETED', currentToneSequence: 3, nextToneAt: null } }),
  );
  renderPage();

  expect(await screen.findByText('All 3 tones have fired.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Advance to tone/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Halt tone ladder' })).toBeNull();
});

test('an active ladder with a scheduled tone says it is waiting on it', async () => {
  usePage(() =>
    dispatch({ toneLadder: { status: 'ACTIVE', currentToneSequence: 1, nextToneAt: 1798000180 } }),
  );
  renderPage();

  expect(await screen.findByText(/The next tone fires automatically/)).toBeTruthy();
  expect(screen.getByText(/Next tone check at/)).toBeTruthy();
});

// Review MINOR-R6: tone 3 was skipped because enough members responded - nothing is pending,
// but the officer can still page again by hand.
test('an active ladder with no tone left says so and still offers a manual advance', async () => {
  usePage(() =>
    dispatch({ toneLadder: { status: 'ACTIVE', currentToneSequence: 2, nextToneAt: null } }),
  );
  renderPage();

  expect(
    await screen.findByText(/No further tone is scheduled to fire automatically/),
  ).toBeTruthy();
  expect(screen.queryByText(/The next tone fires automatically/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Advance to tone 3' })).toBeTruthy();
});

test('triggering mutual aid reports how many officers were prompted, then offers acknowledgement', async () => {
  let state = dispatch();
  usePage(() => state);
  const mutualAid = {
    triggeredAt: 1798000100,
    reason: 'MANUAL',
    triggeredBy: 'u1',
    acknowledgedBy: null,
    acknowledgedAt: null,
    notes: null,
  };
  server.use(
    http.post('/api/v1/alerting/dispatches/D-1/mutual-aid/trigger', () => {
      state = dispatch({ mutualAid });
      return HttpResponse.json({
        dispatchId: 'D-1',
        created: true,
        officersNotified: 2,
        mutualAid,
      });
    }),
  );
  const user = userEvent.setup();
  renderPage();

  expect(
    await screen.findByText('Mutual aid has not been requested for this dispatch.'),
  ).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Trigger mutual aid' }));
  const dialog = await screen.findByRole('dialog', { name: 'Request mutual aid?' });
  expect(dialog.textContent).toMatch(/does not page the neighboring department/);
  await user.click(within(dialog).getByRole('button', { name: 'Request mutual aid' }));

  expect(
    await screen.findByText('Mutual aid requested. 2 officer(s) prompted to make the call.'),
  ).toBeTruthy();
  expect(await screen.findByText(/requested by an officer/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Trigger mutual aid' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Confirm mutual-aid call made' })).toBeTruthy();
});

test('a repeat trigger says every officer was already prompted; zero officers reached is called out', async () => {
  usePage(() => dispatch());
  let calls = 0;
  server.use(
    http.post('/api/v1/alerting/dispatches/D-1/mutual-aid/trigger', () => {
      calls += 1;
      return HttpResponse.json(
        calls === 1
          ? { dispatchId: 'D-1', created: true, officersNotified: 0, mutualAid: null }
          : { dispatchId: 'D-1', created: false, officersNotified: 0, mutualAid: null },
      );
    }),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Trigger mutual aid' }));
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Request mutual aid' }),
  );
  expect(
    await screen.findByText(/no officer has a push device registered - make the call now/),
  ).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Trigger mutual aid' }));
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Request mutual aid' }),
  );
  expect(
    await screen.findByText(
      'Mutual aid was already requested, and every reachable officer has already been prompted.',
    ),
  ).toBeTruthy();
});

// The trigger's 502 tells the officer to trigger again to reach missed officers, so the
// control must still be there once mutual aid is recorded.
test('an unconfirmed request offers re-sending prompts, and reports who was re-prompted', async () => {
  const requested = {
    triggeredAt: 1798000100,
    reason: 'TONE_3_PREDICATE_UNMET',
    triggeredBy: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
    notes: null,
  };
  usePage(() => dispatch({ mutualAid: requested }));
  server.use(
    http.post('/api/v1/alerting/dispatches/D-1/mutual-aid/trigger', () =>
      HttpResponse.json({
        dispatchId: 'D-1',
        created: false,
        officersNotified: 1,
        mutualAid: requested,
      }),
    ),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Re-send officer prompts' }));
  const dialog = await screen.findByRole('dialog', { name: 'Re-send the mutual-aid prompt?' });
  expect(dialog.textContent).toMatch(/not prompted twice/);
  await user.click(within(dialog).getByRole('button', { name: 'Re-send prompts' }));

  expect(
    await screen.findByText(
      'Mutual aid was already requested. The prompt was re-sent to 1 officer(s) who had not received it.',
    ),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Trigger mutual aid' })).toBeNull();
});

test('acknowledging the mutual-aid call sends the officer’s notes', async () => {
  const requested = {
    triggeredAt: 1798000100,
    reason: 'TONE_3_PREDICATE_UNMET',
    triggeredBy: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
    notes: null,
  };
  let state = dispatch({ mutualAid: requested });
  usePage(() => state);
  let sentBody: unknown;
  server.use(
    http.post('/api/v1/alerting/dispatches/D-1/mutual-aid/acknowledge', async ({ request }) => {
      sentBody = await request.json();
      const acked = {
        ...requested,
        acknowledgedBy: 'u1',
        acknowledgedAt: 1798000200,
        notes: 'Called Trumbull Center',
      };
      state = dispatch({ mutualAid: acked });
      return HttpResponse.json({ dispatchId: 'D-1', changed: true, mutualAid: acked });
    }),
  );
  const user = userEvent.setup();
  renderPage();

  expect(await screen.findByText(/automatic: still short after tone 3/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Confirm mutual-aid call made' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Confirm the mutual-aid call was made',
  });
  await user.type(within(dialog).getByLabelText(/Notes/), '  Called Trumbull Center ');
  await user.click(within(dialog).getByRole('button', { name: 'Confirm call made' }));

  expect(await screen.findByText('Mutual-aid call recorded.')).toBeTruthy();
  expect(sentBody).toEqual({ notes: 'Called Trumbull Center' });
  expect(
    await screen.findByText(/Call confirmed at .* by u1: Called Trumbull Center/),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Confirm mutual-aid call made' })).toBeNull();
});

test('an acknowledgement another officer already made keeps the dialog open with the reason', async () => {
  usePage(() =>
    dispatch({
      mutualAid: {
        triggeredAt: 1798000100,
        reason: 'MANUAL',
        triggeredBy: 'u2',
        acknowledgedBy: null,
        acknowledgedAt: null,
        notes: null,
      },
    }),
  );
  server.use(
    http.post('/api/v1/alerting/dispatches/D-1/mutual-aid/acknowledge', () =>
      problem(
        409,
        'Mutual aid was already acknowledged by another officer. Your notes were not saved.',
      ),
    ),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Confirm mutual-aid call made' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Confirm call made' }));

  expect((await within(dialog).findByRole('alert')).textContent).toMatch(
    /already acknowledged by another officer/,
  );
});

test('unreadable mutual-aid state is shown as unknown, not as "not requested"', async () => {
  const state = dispatch();
  delete state.mutualAid;
  usePage(() => state);
  renderPage();

  expect(await screen.findByText(/Mutual-aid status could not be loaded/)).toBeTruthy();
  expect(screen.queryByText('Mutual aid has not been requested for this dispatch.')).toBeNull();
});

test('a 403 on a control is explained, not swallowed', async () => {
  usePage(() => dispatch());
  server.use(
    http.post('/api/v1/alerting/dispatches/D-1/tone-ladder/halt', () => problem(403, 'Forbidden')),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Halt tone ladder' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Halt tone ladder' }));

  expect((await within(dialog).findByRole('alert')).textContent).toMatch(
    'You are not authorized to use the tone-ladder or mutual-aid controls.',
  );
});
