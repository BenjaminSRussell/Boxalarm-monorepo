import { beforeEach, describe, expect, it, vi } from 'vitest';

const { putExportJob, getExportJob, markExportJob, getSignedUrl, lambdaSend } = vi.hoisted(() => ({
  putExportJob: vi.fn(),
  getExportJob: vi.fn(),
  markExportJob: vi.fn(),
  getSignedUrl: vi.fn(),
  lambdaSend: vi.fn(),
}));

vi.mock('@boxalarm/authz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boxalarm/authz')>();
  return {
    ...actual,
    withAuthorization: (inner: (event: unknown, principal: unknown) => Promise<unknown>) => {
      return async (event: { requestContext: { authorizer: { lambda: unknown } } }) =>
        inner(event, event.requestContext.authorizer.lambda);
    },
  };
});

vi.mock('../awsClients.js', () => ({
  readReportingServiceConfig: vi.fn(() => ({ tableName: 'platform-table' })),
  createDynamoDocClient: vi.fn(() => ({})),
}));

vi.mock('../logger.js', () => ({ logError: vi.fn(), logger: { error: vi.fn() } }));
vi.mock('@boxalarm/metrics', () => ({ emitOutcomeMetric: vi.fn() }));

vi.mock('./repository.js', () => ({ putExportJob, getExportJob, markExportJob }));

vi.mock('./clients.js', () => ({
  createExportLambdaClient: () => ({ send: lambdaSend }),
  createExportS3Client: () => ({}),
  readExportsBucket: () => 'boxalarm-dev-exports-staging',
  readExportWorkerFunctionName: () => 'boxalarm-dev-reporting-export-worker',
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }));

import { handler } from './handler.js';

const principal = { sub: 'chief-1', deptId: 'NICHOLS', 'cognito:groups': 'CHIEF' };

function buildEvent(
  query: Record<string, string> = {},
  method = 'POST',
  pathParameters?: Record<string, string>,
) {
  return {
    headers: {},
    queryStringParameters: query,
    ...(pathParameters ? { pathParameters } : {}),
    requestContext: { http: { method }, authorizer: { lambda: principal } },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  lambdaSend.mockResolvedValue({});
  putExportJob.mockResolvedValue(undefined);
});

describe('reporting export handler', () => {
  it('accepts a CSV export and returns 202 without building the file inline', async () => {
    const result = (await handler(buildEvent({ report: 'dashboard', format: 'csv' }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(202);
    const body = JSON.parse(result.body) as { status: string; jobId: string };
    expect(body.status).toBe('PENDING');
    expect(body.jobId).toBeTruthy();
    expect(putExportJob).toHaveBeenCalledOnce();
    expect(lambdaSend).toHaveBeenCalledOnce();
    const invocation = lambdaSend.mock.calls[0]?.[0] as unknown as {
      input: { Payload: Uint8Array };
    };
    const payload = JSON.parse(Buffer.from(invocation.input.Payload).toString('utf8')) as {
      report: string;
      format: string;
    };
    expect(payload).toMatchObject({ report: 'dashboard', format: 'csv', deptId: 'NICHOLS' });
  });

  it('records a visible failure when the worker invoke fails', async () => {
    lambdaSend.mockRejectedValue(new Error('invoke denied'));
    const result = (await handler(
      buildEvent({ report: 'iso', format: 'pdf', from: '1', to: '2' }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(202);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'FAILED', detail: 'invoke denied' });
    expect(markExportJob).toHaveBeenCalledWith(
      expect.anything(),
      'platform-table',
      expect.anything(),
      expect.any(String),
      'FAILED',
      { detail: 'invoke denied' },
    );
  });

  it('returns a failed job instead of hiding it', async () => {
    getExportJob.mockResolvedValue({
      jobId: 'job-1',
      report: 'dashboard',
      format: 'csv',
      params: {},
      status: 'FAILED',
      requestedBy: 'chief-1',
      requestedAt: '2026-09-25T00:00:00.000Z',
      detail: 'render failed',
    });
    const result = (await handler(buildEvent({ jobId: 'job-1' }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'FAILED', detail: 'render failed' });
  });

  it('reads the job named by the {jobId} path parameter on GET /export/{jobId}', async () => {
    getExportJob.mockResolvedValue({
      jobId: 'job-3',
      report: 'iso',
      format: 'csv',
      params: {},
      status: 'PENDING',
      requestedBy: 'chief-1',
      requestedAt: '2026-09-25T00:00:00.000Z',
    });
    const result = (await handler(buildEvent({}, 'GET', { jobId: 'job-3' }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    expect(getExportJob).toHaveBeenCalledWith(
      expect.anything(),
      'platform-table',
      'NICHOLS',
      'job-3',
    );
    expect(putExportJob).not.toHaveBeenCalled();
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it('never starts a job from a GET that carries no jobId', async () => {
    const result = (await handler(buildEvent({ report: 'dashboard', format: 'csv' }, 'GET'))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
    expect(putExportJob).not.toHaveBeenCalled();
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it('returns a signed download link for a completed job', async () => {
    getExportJob.mockResolvedValue({
      jobId: 'job-2',
      report: 'losap',
      format: 'pdf',
      params: { year: '2026' },
      status: 'COMPLETED',
      requestedBy: 'chief-1',
      requestedAt: '2026-09-25T00:00:00.000Z',
      objectKey: 'NICHOLS/job-2/report.pdf',
    });
    getSignedUrl.mockResolvedValue('https://signed.example/report.pdf');
    const result = (await handler(buildEvent({ jobId: 'job-2' }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      status: 'COMPLETED',
      downloadUrl: 'https://signed.example/report.pdf',
    });
  });
});
