import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { DescribeEventBusCommand, EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { HealthEvent, HealthResponse } from '@boxalarm/health';
import { SERVICES } from '../src/services/index.js';
import { handler as alerting } from '../src/services/alerting-service/health/handler.js';
import { handler as platform } from '../src/services/platform-service/health/handler.js';
import { handler as personnel } from '../src/services/personnel-service/health/handler.js';
import { handler as apparatus } from '../src/services/apparatus-service/health/handler.js';
import { handler as incident } from '../src/services/incident-service/health/handler.js';
import { handler as training } from '../src/services/training-service/health/handler.js';
import { handler as reporting } from '../src/services/reporting-service/health/handler.js';
import { handler as inspections } from '../src/services/inspections-service/health/handler.js';
import { handler as inventory } from '../src/services/inventory-service/health/handler.js';
import { handler as notification } from '../src/services/notification-service/health/handler.js';

/**
 * architecture.md §2 gives every service a GET health/liveness + health/readiness pair
 * (§4.3). Each service bundles one `health` Lambda serving both routes; this sweep proves
 * every service has one, that the manifest bundles it, and that it behaves the same way.
 */

const ddb = mockClient(DynamoDBClient);
const events = mockClient(EventBridgeClient);

type HealthHandler = (event: HealthEvent) => Promise<HealthResponse>;

const HANDLERS: Readonly<Record<string, HealthHandler>> = {
  'alerting-service': alerting,
  'platform-service': platform,
  'personnel-service': personnel,
  'apparatus-service': apparatus,
  'incident-service': incident,
  'training-service': training,
  'reporting-service': reporting,
  'inspections-service': inspections,
  'inventory-service': inventory,
  'notification-service': notification,
};

function loadHandler(service: string): HealthHandler {
  const handler = HANDLERS[service];
  if (!handler) {
    throw new Error(`no health handler imported for ${service}`);
  }
  return handler;
}

const SERVICE_NAMES = SERVICES.map((s) => s.name);

beforeEach(() => {
  ddb.reset();
  events.reset();
  process.env.HEALTH_TABLE_NAME = 'own-table';
  process.env.HEALTH_EVENT_BUS_NAME = 'platform-bus';
});

afterEach(() => {
  delete process.env.HEALTH_TABLE_NAME;
  delete process.env.HEALTH_EVENT_BUS_NAME;
});

interface ManifestEntry {
  readonly service: string;
  readonly function: string;
  readonly entry: string;
}

describe('per-service health Lambdas', () => {
  it.each(SERVICE_NAMES)('%s has a manifest entry bundling its health handler', async (service) => {
    const { LAMBDA_ENTRIES } = (await import(
      new URL('../scripts/lambda-manifest.mjs', import.meta.url).href
    )) as { LAMBDA_ENTRIES: readonly ManifestEntry[] };
    const entry = LAMBDA_ENTRIES.find((e) => e.service === service && e.function === 'health');
    expect(entry?.entry).toBe(`src/services/${service}/health/handler.ts`);
  });

  it.each(SERVICE_NAMES)('%s answers liveness 200 without touching AWS', async (service) => {
    const handler = loadHandler(service);
    const res = await handler({ routeKey: `GET /api/v1/x/health/liveness` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    expect(ddb.calls()).toHaveLength(0);
    expect(events.calls()).toHaveLength(0);
  });

  it.each(SERVICE_NAMES)(
    '%s answers readiness 200 from a read of its own table',
    async (service) => {
      ddb.on(GetItemCommand).resolves({});
      events.on(DescribeEventBusCommand).resolves({});
      const handler = loadHandler(service);

      const res = await handler({ routeKey: `GET /api/v1/x/health/readiness` });

      expect(res.statusCode).toBe(200);
      expect(ddb.commandCalls(GetItemCommand)[0]?.args[0].input.TableName).toBe('own-table');
      // Alerting-plane isolation: the alerting probe never reaches the LOB bus.
      expect(events.calls().length > 0).toBe(service !== 'alerting-service');
    },
  );

  it.each(SERVICE_NAMES)('%s answers readiness 503 when DynamoDB is down', async (service) => {
    ddb.on(GetItemCommand).rejects(new Error('ServiceUnavailable'));
    events.on(DescribeEventBusCommand).resolves({});
    const handler = loadHandler(service);
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      const res = await handler({ routeKey: `GET /api/v1/x/health/readiness` });
      expect(res.statusCode).toBe(503);
      expect(res.body).toBe(JSON.stringify({ status: 'unavailable' }));
    } finally {
      console.error = consoleError;
    }
  });
});
