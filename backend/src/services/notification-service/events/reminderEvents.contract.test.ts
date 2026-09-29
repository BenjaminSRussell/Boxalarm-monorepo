import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { Context, DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * Producer -> consumer contracts for every reminder event notification-service consumes.
 * Each runs the real producer (scanner publish function, or the defect repository's outbox
 * write drained by the real @boxalarm/outbox publisher), wraps the PutEvents entry exactly
 * as an EventBridge rule -> SQS target delivers it (the whole event, envelope under
 * `detail`), and feeds it to the real consumer. Only the AWS clients are faked.
 */

interface SentCommand {
  readonly constructor: { name: string };
  readonly input: Record<string, unknown>;
}

interface Entry {
  Source: string;
  DetailType: string;
  Detail: string;
}

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const now = new Date('2026-09-29T08:00:00Z');
const originalEnv = { ...process.env };
let sequence = 0;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now, toFake: ['Date'] });
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
  process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-table';
  process.env.TRAINING_DYNAMO_TABLE_NAME = 'platform-table';
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('../dynamoClient.js');
  vi.doUnmock('../channelSender.js');
});

function fakeEventBridge(): { client: EventBridgeClient; entry: () => Entry } {
  const send = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'eb-1' }] });
  return {
    client: { send } as unknown as EventBridgeClient,
    entry: () => ((send.mock.calls[0]?.[0] as SentCommand).input.Entries as Entry[])[0]!,
  };
}

const producerDdb = {
  send: vi.fn().mockResolvedValue({}),
} as unknown as DynamoDBDocumentClient;

/** EventBridge -> SQS with no input transformer: the SQS body is the whole event. */
function asSqs(entry: Entry): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          version: '0',
          id: 'eb-1',
          'detail-type': entry.DetailType,
          source: entry.Source,
          detail: JSON.parse(entry.Detail) as unknown,
        }),
      },
    ],
  } as unknown as SQSEvent;
}

/** Runs a digest consumer against a capturing fake table; returns what it wrote. */
async function consume(
  modulePath: string,
  event: SQSEvent,
): Promise<Array<Record<string, unknown>>> {
  const send = vi.fn().mockResolvedValue({});
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
  const { handler } = (await import(modulePath)) as {
    handler: (event: SQSEvent) => Promise<void>;
  };
  await handler(event);
  const transact = send.mock.calls[0]?.[0] as SentCommand;
  expect(transact.constructor.name).toBe('TransactWriteCommand');
  return (transact.input.TransactItems as { Put: { Item: Record<string, unknown> } }[]).map(
    (t) => t.Put.Item,
  );
}

describe('apparatus.test.due producers -> apparatusTestDueConsumer', () => {
  it('testDueScanner (hose/ladder/pump/aerial)', async () => {
    const { publishDueEvent } =
      await import('../../apparatus-service/testDueScanner/publishDueEvents.js');
    const eb = fakeEventBridge();
    await publishDueEvent(producerDdb, eb.client, process.env, {
      deptId,
      apparatusId: 'APP-E1',
      testType: 'HOSE',
      dueDate: '2026-10-20',
      correlationId: 'trace-1',
      now,
    });

    const rows = await consume('./apparatusTestDueConsumer.js', asSqs(eb.entry()));

    expect(rows.map((r) => r.pk)).toEqual([
      'DEPT#NICHOLS#ROLE#APPARATUS',
      'DEPT#NICHOLS#ROLE#CHIEF',
      expect.stringMatching(/^DEPT#NICHOLS#NOTIF_EVENT#/),
    ]);
    expect(rows[0]?.item).toMatchObject({ subjectId: 'APP-E1:HOSE', dueDate: '2026-10-20' });
  });

  it('apparatusTestingScanner (SCBA flow/hydro)', async () => {
    const { publishScbaTestDueEvent } =
      await import('../../apparatus-service/apparatusTestingScanner/publishDueEvents.js');
    const eb = fakeEventBridge();
    await publishScbaTestDueEvent(producerDdb, eb.client, process.env, {
      deptId,
      apparatusId: 'ENGINE-2',
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      testType: 'SCBA_HYDRO',
      dueDate: '2026-10-02',
      correlationId: 'trace-2',
      now,
    });

    const rows = await consume('./apparatusTestDueConsumer.js', asSqs(eb.entry()));

    expect(rows[0]?.item).toMatchObject({
      subjectId: 'SCBA-001:SCBA_HYDRO',
      detail: 'SCBA SCBA-001 hydrostatic test due 2026-10-02',
    });
  });
});

describe('inventory.reorder.due producer -> inventoryReorderDueConsumer', () => {
  it('consumableReorderScanner', async () => {
    const { publishReorderDueEvent } =
      await import('../../inventory-service/consumableReorderScanner/handler.js');
    const eb = fakeEventBridge();
    await publishReorderDueEvent(producerDdb, eb.client, process.env, 'platform-table', {
      deptId,
      itemId: 'GLOVES-L',
      itemName: 'Gloves (Large)',
      currentQty: 3,
      reorderThreshold: 5,
      correlationId: 'trace-3',
      now,
    });

    const rows = await consume('./inventoryReorderDueConsumer.js', asSqs(eb.entry()));

    expect(rows.map((r) => r.pk).slice(0, 2)).toEqual([
      'DEPT#NICHOLS#ROLE#APPARATUS',
      'DEPT#NICHOLS#ROLE#ADMIN',
    ]);
    expect(rows[0]?.item).toMatchObject({ title: 'Gloves (Large)' });
  });
});

describe('ppe.expiry.due producer -> ppeExpiryConsumer', () => {
  it('ppeExpiryScanner', async () => {
    const { publishDueEvent } =
      await import('../../inventory-service/ppeExpiryScanner/publishDueEvents.js');
    const eb = fakeEventBridge();
    await publishDueEvent(producerDdb, eb.client, process.env, {
      deptId,
      memberId: 'MBR-0034',
      ppeItemId: 'TURNOUT-COAT',
      expiryDate: '2026-10-14',
      correlationId: 'trace-4',
      now,
    });

    const rows = await consume('./ppeExpiryConsumer.js', asSqs(eb.entry()));

    expect(rows.map((r) => r.pk).slice(0, 2)).toEqual([
      'DEPT#NICHOLS#MEMBER#MBR-0034',
      'DEPT#NICHOLS#ROLE#APPARATUS',
    ]);
  });
});

describe('cert.expiry.due producer -> certExpiryConsumer', () => {
  it('certificationExpiryScanner', async () => {
    const { publishDueEvent } =
      await import('../../training-service/certificationExpiryScanner/publishDueEvents.js');
    const eb = fakeEventBridge();
    await publishDueEvent(producerDdb, eb.client, process.env, {
      deptId,
      memberId: 'MBR-0034',
      certId: 'CERT-0091',
      expiryDate: '2026-10-14',
      leadDays: 30,
      correlationId: 'trace-5',
      now,
    });

    const rows = await consume('./certExpiryConsumer.js', asSqs(eb.entry()));

    expect(rows.map((r) => r.pk).slice(0, 2)).toEqual([
      'DEPT#NICHOLS#MEMBER#MBR-0034',
      'DEPT#NICHOLS#ROLE#TRAINING',
    ]);
    expect(rows[0]).toMatchObject({ certId: 'CERT-0091', expiryDate: '2026-10-14' });
  });
});

describe('apparatus.defect.reported (outbox) -> apparatusDefectConsumer', () => {
  /** createDefect's outbox row, drained by the real platform outbox publisher. */
  async function reportedDefect(severity: 'MAJOR' | 'OUT_OF_SERVICE'): Promise<SQSEvent> {
    const ddbSend = vi.fn().mockImplementation((command: SentCommand) => {
      if (command.constructor.name === 'QueryCommand') {
        return Promise.resolve({
          Items: [{ pk: 'DEPT#NICHOLS#APPARATUS#APP-E1', apparatusId: 'APP-E1', unitId: 'E1' }],
        });
      }
      return Promise.resolve({});
    });
    const { createDefect } = await import('../../apparatus-service/defectRepository.js');
    await createDefect({ send: ddbSend } as unknown as DynamoDBDocumentClient, 'platform-table', {
      deptId,
      unitId: 'E1',
      description: 'Pump will not engage',
      severity,
      reportedByMemberId: 'FF-1',
      correlationId: 'trace-6',
    });
    const transact = ddbSend.mock.calls
      .map((call) => call[0] as SentCommand)
      .find((command) => command.constructor.name === 'TransactWriteCommand')!;
    const outbox = (
      transact.input.TransactItems as Array<{ Put?: { Item: Record<string, unknown> } }>
    ).find((item) => item.Put?.Item.entityType === 'OUTBOX_ENTRY')?.Put?.Item;
    if (!outbox) {
      throw new Error('createDefect wrote no OUTBOX_ENTRY');
    }

    const eb = fakeEventBridge();
    // Imported per test, after resetModules: the drain caches its clients at module level.
    const { createOutboxDrainHandler } = await import('@boxalarm/outbox');
    const drain = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: eb.client,
      ddbClient: { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient,
    });
    await drain(
      {
        Records: [
          {
            eventName: 'INSERT',
            dynamodb: {
              SequenceNumber: String((sequence += 1)),
              NewImage: marshall(outbox, { removeUndefinedValues: true }),
            },
          },
        ],
      } as unknown as DynamoDBStreamEvent,
      {} as Context,
      () => undefined,
    );
    const entry = eb.entry();
    expect(entry.Source).toBe('apparatus-service');
    expect(entry.DetailType).toBe('apparatus.defect.reported');
    return asSqs(entry);
  }

  it('a routine defect is recorded for the APPARATUS + OFFICER digest', async () => {
    const event = await reportedDefect('MAJOR');

    const rows = await consume('./apparatusDefectConsumer.js', event);

    expect(rows.map((r) => r.pk).slice(0, 2)).toEqual([
      'DEPT#NICHOLS#ROLE#APPARATUS',
      'DEPT#NICHOLS#ROLE#OFFICER',
    ]);
    expect(rows[0]?.item).toMatchObject({ title: 'E1', link: { kind: 'apparatus', id: 'E1' } });
  });

  it('an OUT_OF_SERVICE defect reaches the officers’ inboxes, email and push immediately', async () => {
    const event = await reportedDefect('OUT_OF_SERVICE');

    const writes: Array<Record<string, unknown>> = [];
    const send = vi.fn().mockImplementation((command: SentCommand) => {
      if (command.constructor.name === 'QueryCommand') {
        return Promise.resolve({
          Items: [{ memberId: 'LT-1', roles: ['MEMBER', 'OFFICER'], email: 'lt@example.com' }],
        });
      }
      if (command.constructor.name === 'PutCommand') {
        writes.push(command.input.Item as Record<string, unknown>);
      }
      return Promise.resolve({});
    });
    vi.doMock('../dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../dynamoClient.js')>();
      return {
        ...actual,
        createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      };
    });
    const push = vi.fn().mockResolvedValue(undefined);
    const email = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../channelSender.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../channelSender.js')>();
      return { ...actual, sendPushDigest: push, sendEmailDigest: email };
    });
    const { handler } = await import('./apparatusDefectConsumer.js');

    await handler(event);

    expect(writes.filter((w) => w.entityType === 'NOTIFICATION')).toEqual([
      expect.objectContaining({
        entityType: 'NOTIFICATION',
        pk: 'DEPT#NICHOLS#MEMBER#LT-1',
        category: 'apparatus-defect',
      }),
    ]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(1);
  });
});
