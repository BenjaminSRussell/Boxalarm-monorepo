import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type { AuthTokenSource } from '../../lib/apiClient';
import { listHydrants } from './api';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const tokens: AuthTokenSource = {
  getAccessToken: () => Promise.resolve('access-token'),
  renewSilently: () => Promise.resolve(null),
};

test('listHydrants asks for the full department list (no dueBefore month filter)', async () => {
  let requestedUrl: URL | undefined;
  server.use(
    http.get('/api/v1/inspections/hydrants', ({ request }) => {
      requestedUrl = new URL(request.url);
      return HttpResponse.json({ hydrants: [] });
    }),
  );

  await expect(listHydrants(tokens)).resolves.toEqual([]);
  expect(requestedUrl?.searchParams.has('dueBefore')).toBe(false);
});
