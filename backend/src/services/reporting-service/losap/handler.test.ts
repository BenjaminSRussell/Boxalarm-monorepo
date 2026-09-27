import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedOptions {
  readonly actionType: string;
  readonly actionId: string;
  readonly resourceType: string;
  readonly resourceId: (event: {
    requestContext: { authorizer?: { lambda?: { deptId?: string } } };
  }) => string;
}

const capturedOptions: CapturedOptions[] = vi.hoisted(() => []);
const { logError, emitOutcomeMetric } = vi.hoisted(() => ({
  logError: vi.fn(),
  emitOutcomeMetric: vi.fn(),
}));

vi.mock('@boxalarm/authz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boxalarm/authz')>();
  return {
    ...actual,
    withAuthorization: (
      inner: (event: unknown, principal: unknown) => Promise<unknown>,
      options: CapturedOptions,
    ) => {
      capturedOptions.push(options);
      return async (event: { requestContext: { authorizer: { lambda: unknown } } }) =>
        inner(event, event.requestContext.authorizer.lambda);
    },
  };
});

vi.mock('../awsClients.js', () => ({
  readReportingServiceConfig: vi.fn(() => ({ tableName: 'platform-table' })),
  createDynamoDocClient: vi.fn(() => ({})),
}));

vi.mock('../logger.js', () => ({
  logError,
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@boxalarm/metrics', () => ({ emitOutcomeMetric }));

vi.mock('./repository.js', () => ({
  buildYearEndReport: vi.fn(),
}));

import { buildYearEndReport } from './repository.js';
import { handler } from './handler.js';

const principal = { sub: 'member-0001', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' };

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    queryStringParameters: { year: '2026' },
    requestContext: { authorizer: { lambda: principal } },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('losap year-end handler', () => {
  it('wires the GetLosapYearEnd action against the Department resource (AC5 attachment point)', () => {
    expect(capturedOptions[0]).toMatchObject({
      actionType: 'Boxalarm::Action',
      actionId: 'GetLosapYearEnd',
      resourceType: 'Boxalarm::Department',
    });
  });

  it('resolves the Cedar resourceId to the principal deptId', () => {
    expect(capturedOptions[0]?.resourceId(buildEvent())).toBe('NICHOLS');
  });

  it('returns 200 with the aggregated report on success (AC1)', async () => {
    vi.mocked(buildYearEndReport).mockResolvedValue({
      deptId: 'NICHOLS',
      year: 2026,
      members: [{ memberId: 'MBR-0001', totalPoints: 3, entryCount: 2, unreadableEntryCount: 0 }],
      hasData: true,
      totalUnreadableEntryCount: 0,
    });
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      deptId: 'NICHOLS',
      year: 2026,
      members: [{ memberId: 'MBR-0001', totalPoints: 3, entryCount: 2, unreadableEntryCount: 0 }],
      hasData: true,
      totalUnreadableEntryCount: 0,
    });
  });

  it('returns 200 with hasData=false and no error for a year with no data yet (AC4)', async () => {
    vi.mocked(buildYearEndReport).mockResolvedValue({
      deptId: 'NICHOLS',
      year: 2026,
      members: [{ memberId: 'MBR-0001', totalPoints: 0, entryCount: 0, unreadableEntryCount: 0 }],
      hasData: false,
      totalUnreadableEntryCount: 0,
    });
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect((JSON.parse(result.body) as { hasData: boolean }).hasData).toBe(false);
  });

  it('returns 400 with an RFC 7807 body when year is missing', async () => {
    const result = (await handler(buildEvent({ queryStringParameters: {} }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(400);
    expect(buildYearEndReport).not.toHaveBeenCalled();
    const body = JSON.parse(result.body) as { status: number; title: string; traceId: string };
    expect(body.status).toBe(400);
    expect(body.title).toBeTruthy();
    expect(body.traceId).toBeTruthy();
  });

  it('returns 400 with an RFC 7807 body when year is non-numeric', async () => {
    const result = (await handler(buildEvent({ queryStringParameters: { year: 'abc' } }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body) as { status: number; detail: string; traceId: string };
    expect(body.status).toBe(400);
    expect(body.detail).toContain('4-digit year');
    expect(body.traceId).toBeTruthy();
  });

  it('returns 400 with an RFC 7807 body when year is not a 4-digit integer', async () => {
    const result = (await handler(buildEvent({ queryStringParameters: { year: '2026.5' } }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body) as { status: number; detail: string; traceId: string };
    expect(body.status).toBe(400);
    expect(body.detail).toContain('4-digit year');
    expect(body.traceId).toBeTruthy();
  });

  it('returns 400 with an RFC 7807 body for a duplicated query param collapsed into one comma-joined string', async () => {
    const result = (await handler(
      buildEvent({ queryStringParameters: { year: '2026,2027' } }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body) as { status: number; traceId: string };
    expect(body.status).toBe(400);
    expect(body.traceId).toBeTruthy();
  });

  it('emits a business metric on success', async () => {
    vi.mocked(buildYearEndReport).mockResolvedValue({
      deptId: 'NICHOLS',
      year: 2026,
      members: [],
      hasData: false,
      totalUnreadableEntryCount: 0,
    });
    await handler(buildEvent());
    expect(emitOutcomeMetric).toHaveBeenCalledWith(
      'Boxalarm/ReportingService',
      'ReportingLosapYearEndSucceeded',
    );
  });

  it('emits a data-integrity metric when the report carries unreadable entries', async () => {
    vi.mocked(buildYearEndReport).mockResolvedValue({
      deptId: 'NICHOLS',
      year: 2026,
      members: [{ memberId: 'MBR-0001', totalPoints: 5, entryCount: 2, unreadableEntryCount: 1 }],
      hasData: true,
      totalUnreadableEntryCount: 1,
    });
    await handler(buildEvent());
    expect(emitOutcomeMetric).toHaveBeenCalledWith(
      'Boxalarm/ReportingService',
      'ReportingLosapYearEndDataIntegrity',
    );
  });

  it('returns 503, logs the original error, and emits a failure metric when aggregation fails', async () => {
    const failure = new Error('table unavailable');
    vi.mocked(buildYearEndReport).mockRejectedValue(failure);
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body) as { status: number; title: string; traceId: string };
    expect(body.status).toBe(503);
    expect(body.traceId).toBeTruthy();
    expect(logError).toHaveBeenCalledWith(
      'reporting.losap.year_end.failed',
      failure,
      expect.objectContaining({ deptId: 'NICHOLS', year: 2026 }),
    );
    expect(emitOutcomeMetric).toHaveBeenCalledWith(
      'Boxalarm/ReportingService',
      'ReportingLosapYearEndFailed',
      'Error',
    );
  });
});
