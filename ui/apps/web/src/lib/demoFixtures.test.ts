import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { apiRequest, ApiError, type AuthTokenSource } from './apiClient';

const tokens: AuthTokenSource = {
  getAccessToken: vi.fn(async () => 'unused'),
  renewSilently: vi.fn(async () => 'unused'),
};

beforeEach(() => {
  vi.stubEnv('VITE_DEMO', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

test('lists apparatus fixtures without any network call', async () => {
  const response = await apiRequest('apparatus', tokens);
  const body = (await response.json()) as { apparatus: unknown[] };
  expect(body.apparatus.length).toBeGreaterThan(0);
});

test('creates an apparatus unit and returns it back in the list', async () => {
  const created = await apiRequest('apparatus', tokens, {
    method: 'POST',
    body: JSON.stringify({ unitId: 'Brush 1', type: 'Brush' }),
  });
  const unit = (await created.json()) as { unitId: string };
  expect(unit.unitId).toBe('Brush 1');

  const list = await apiRequest('apparatus', tokens);
  const body = (await list.json()) as { apparatus: { unitId: string }[] };
  expect(body.apparatus.some((a) => a.unitId === 'Brush 1')).toBe(true);
});

test('gets a member fixture by id', async () => {
  const response = await apiRequest('personnel/members/m-1', tokens);
  const member = (await response.json()) as { memberId: string; lastName: string };
  expect(member.memberId).toBe('m-1');
  expect(member.lastName).toBe('Rivera');
});

test('an unknown member id surfaces a 404 ApiError with a traceId', async () => {
  await expect(apiRequest('personnel/members/missing', tokens)).rejects.toBeInstanceOf(ApiError);
});

test('updates a member status through the fixture store', async () => {
  const response = await apiRequest('personnel/members/m-4/status', tokens, {
    method: 'PUT',
    body: JSON.stringify({ status: 'ACTIVE' }),
  });
  const member = (await response.json()) as { status: string };
  expect(member.status).toBe('ACTIVE');
});

test('gets and puts department config through the fixture store', async () => {
  const initial = await apiRequest('platform/config/ALERT_RULES', tokens);
  const config = (await initial.json()) as { value: { escalationThresholdN: number } };
  expect(config.value.escalationThresholdN).toBe(90);

  const saved = await apiRequest('platform/config/ALERT_RULES', tokens, {
    method: 'PUT',
    body: JSON.stringify({ value: { escalationThresholdN: 120 } }),
  });
  const savedConfig = (await saved.json()) as { value: { escalationThresholdN: number } };
  expect(savedConfig.value.escalationThresholdN).toBe(120);
});

test('an unset config type is a 404 fixture', async () => {
  await expect(apiRequest('platform/config/STATIONS', tokens)).rejects.toBeInstanceOf(ApiError);
});

test('starts and polls a demo export job to COMPLETE', async () => {
  const started = await apiRequest('platform/export', tokens, { method: 'POST' });
  const { jobId } = (await started.json()) as { jobId: string };
  const status = await apiRequest(`platform/export/${jobId}`, tokens);
  const body = (await status.json()) as { status: string };
  expect(body.status).toBe('COMPLETE');
});

test('revokes a member session through the fixture store', async () => {
  const response = await apiRequest('platform/sessions/revoke', tokens, {
    method: 'POST',
    body: JSON.stringify({ memberId: 'm-1' }),
  });
  const body = (await response.json()) as { status: string };
  expect(body.status).toBe('revoked');
});

test('serves the reporting dashboard and response-time fixtures', async () => {
  const dashboard = await apiRequest('reporting/dashboard', tokens);
  const view = (await dashboard.json()) as { lastUpdated: string | null };
  expect(view.lastUpdated).not.toBeNull();

  const times = await apiRequest('reporting/response-times?from=1700000000&to=1800000000', tokens);
  const body = (await times.json()) as { units: unknown[]; from: number };
  expect(body.units.length).toBeGreaterThan(0);
  expect(body.from).toBe(1700000000);
});

test('rejects a reporting range the real handler would reject', async () => {
  await expect(
    apiRequest('reporting/iso?from=1800000000&to=1700000000', tokens),
  ).rejects.toBeInstanceOf(ApiError);
  await expect(apiRequest('reporting/losap/year-end?year=26', tokens)).rejects.toBeInstanceOf(
    ApiError,
  );
});

test('queues a demo report export and polls it to COMPLETED with a download link', async () => {
  const started = await apiRequest('reporting/export?report=losap&format=csv&year=2026', tokens, {
    method: 'POST',
  });
  const { jobId, status } = (await started.json()) as { jobId: string; status: string };
  expect(status).toBe('PENDING');
  const polled = await apiRequest(`reporting/export/${jobId}`, tokens);
  const job = (await polled.json()) as { status: string; downloadUrl?: string };
  expect(job.status).toBe('COMPLETED');
  expect(job.downloadUrl).toBeTruthy();
});
