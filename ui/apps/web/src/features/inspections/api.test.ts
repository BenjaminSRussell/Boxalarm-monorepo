import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { AuthTokenSource } from '../../lib/apiClient';
import { listHydrants, uploadPrePlanFile } from './api';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});
afterAll(() => server.close());

const tokens: AuthTokenSource = {
  getAccessToken: () => Promise.resolve('access-token'),
  renewSilently: () => Promise.resolve(null),
};

const UPLOAD_URL =
  'https://boxalarm-dev-platform-assets.s3.us-east-1.amazonaws.com/D/PRE_PLAN/P/a.pdf';

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

// jsdom's File cannot be streamed through undici's fetch, so the S3 PUT is asserted against
// a stubbed fetch rather than msw.
test('uploadPrePlanFile PUTs the file body to the presigned URL', async () => {
  const file = new File(['diagram'], 'a.pdf');
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  await uploadPrePlanFile(UPLOAD_URL, file);

  expect(fetchMock).toHaveBeenCalledWith(UPLOAD_URL, { method: 'PUT', body: file });
});

test('uploadPrePlanFile rejects when S3 refuses the upload (expired URL), so the save is not reported as done', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));

  await expect(uploadPrePlanFile(UPLOAD_URL, new File(['diagram'], 'a.pdf'))).rejects.toThrow(
    'Uploading a.pdf failed (HTTP 403).',
  );
});
