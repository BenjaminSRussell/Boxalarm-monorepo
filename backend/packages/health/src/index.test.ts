import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { DescribeEventBusCommand, EventBridgeClient } from '@aws-sdk/client-eventbridge';
import {
  HEALTH_SENTINEL_PK,
  createHealthHandler,
  createLobHealthHandler,
  dynamoTableCheck,
  eventBusCheck,
  type ReadinessCheck,
} from './index.js';

const LIVENESS = { routeKey: 'GET /api/v1/training/health/liveness' };
const READINESS = { routeKey: 'GET /api/v1/training/health/readiness' };
const ENV = { HEALTH_TABLE_NAME: 'platform-table', HEALTH_EVENT_BUS_NAME: 'platform-bus' };

const ddb = mockClient(DynamoDBClient);
const events = mockClient(EventBridgeClient);

function check(result: boolean | Error): ReadinessCheck {
  return {
    name: 'fake',
    run: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ddb.reset();
  events.reset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('createHealthHandler', () => {
  it('answers liveness 200 without running any readiness check', async () => {
    const run = vi.fn();
    const handler = createHealthHandler({
      service: 'training-service',
      readinessChecks: [{ name: 'spy', run }],
    });

    const res = await handler(LIVENESS);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(run).not.toHaveBeenCalled();
  });

  it('answers readiness 200 only when every check passes', async () => {
    const handler = createHealthHandler({
      service: 'training-service',
      readinessChecks: [check(true), check(true)],
    });

    const res = await handler(READINESS);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ready' });
  });

  it.each([
    ['a check reports unhealthy', check(false)],
    ['a check throws', check(new Error('AccessDeniedException: arn:aws:dynamodb:secret'))],
  ])('answers 503 with a bare status when %s, logging the detail instead', async (_l, bad) => {
    const handler = createHealthHandler({
      service: 'training-service',
      readinessChecks: [check(true), bad],
    });

    const res = await handler(READINESS);

    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(JSON.stringify({ status: 'unavailable' }));
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({
      event: 'health.readiness.failed',
      service: 'training-service',
      check: 'fake',
    });
  });

  it('fails readiness when a check outlives the deadline', async () => {
    const hung: ReadinessCheck = {
      name: 'hung',
      run: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error));
        }),
    };
    const handler = createHealthHandler({
      service: 'training-service',
      readinessChecks: [hung],
      timeoutMs: 10,
    });

    const res = await handler(READINESS);

    expect(res.statusCode).toBe(503);
  });

  it('fails readiness when a check ignores the signal and never settles', async () => {
    const handler = createHealthHandler({
      service: 'training-service',
      readinessChecks: [{ name: 'deaf', run: () => new Promise<boolean>(() => undefined) }],
      timeoutMs: 10,
    });

    const res = await handler(READINESS);

    expect(res.statusCode).toBe(503);
  });

  it('matches on rawPath when there is no routeKey, and 404s any other path', async () => {
    const handler = createHealthHandler({ service: 's', readinessChecks: [] });

    expect((await handler({ rawPath: '/api/v1/x/health/liveness' })).statusCode).toBe(200);
    expect((await handler({ routeKey: 'GET /api/v1/x/health' })).statusCode).toBe(404);
    expect((await handler({})).statusCode).toBe(404);
  });
});

describe('dynamoTableCheck', () => {
  it('reads the sentinel key from HEALTH_TABLE_NAME and never writes', async () => {
    ddb.on(GetItemCommand).resolves({});

    await expect(
      dynamoTableCheck(ENV, new DynamoDBClient({})).run(new AbortController().signal),
    ).resolves.toBe(true);

    const input = ddb.commandCalls(GetItemCommand)[0]?.args[0].input;
    expect(input?.TableName).toBe('platform-table');
    expect(input?.Key).toEqual({ pk: { S: HEALTH_SENTINEL_PK }, sk: { S: 'PROBE' } });
    expect(HEALTH_SENTINEL_PK).toBe('DEPT#HEALTHCHECK#HEALTH');
    expect(ddb.calls()).toHaveLength(1);
  });

  it('rejects when HEALTH_TABLE_NAME is unset', async () => {
    await expect(
      dynamoTableCheck({}, new DynamoDBClient({})).run(new AbortController().signal),
    ).rejects.toThrow(/HEALTH_TABLE_NAME/);
  });
});

describe('eventBusCheck', () => {
  it('describes the bus named by HEALTH_EVENT_BUS_NAME', async () => {
    events.on(DescribeEventBusCommand).resolves({ Name: 'platform-bus' });

    await expect(
      eventBusCheck(ENV, new EventBridgeClient({})).run(new AbortController().signal),
    ).resolves.toBe(true);

    expect(events.commandCalls(DescribeEventBusCommand)[0]?.args[0].input).toEqual({
      Name: 'platform-bus',
    });
  });
});

describe('createLobHealthHandler', () => {
  it('is ready when the table and the bus both answer', async () => {
    ddb.on(GetItemCommand).resolves({});
    events.on(DescribeEventBusCommand).resolves({});

    const res = await createLobHealthHandler('training-service', ENV)(READINESS);

    expect(res.statusCode).toBe(200);
  });

  it('is unavailable when the bus is unreachable', async () => {
    ddb.on(GetItemCommand).resolves({});
    events.on(DescribeEventBusCommand).rejects(new Error('ResourceNotFoundException'));

    const res = await createLobHealthHandler('training-service', ENV)(READINESS);

    expect(res.statusCode).toBe(503);
  });
});
