import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';

/**
 * apparatus.defect.reported: a routine defect waits for the digest; one that takes the unit
 * out of service reaches APPARATUS + OFFICER inboxes now, with a non-critical push.
 */

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.doUnmock('../dynamoClient.js');
  vi.doUnmock('../channelSender.js');
});

const ROSTER = [
  { memberId: 'APP-1', roles: ['MEMBER', 'APPARATUS'], email: 'app1@example.com' },
  { memberId: 'LT-1', roles: ['MEMBER', 'OFFICER', 'APPARATUS'], email: 'lt1@example.com' },
  { memberId: 'FF-1', roles: ['MEMBER'], email: 'ff1@example.com' },
];

function defect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    defectId: 'DEF-1',
    apparatusId: 'APP-E1',
    unitLabel: 'E1',
    reportedByMemberId: 'FF-1',
    severity: 'MAJOR',
    outOfService: false,
    deptId: 'NICHOLS',
    ...overrides,
  };
}

function sqsEvent(payload: Record<string, unknown>): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          version: '0',
          id: 'eb-1',
          'detail-type': 'apparatus.defect.reported',
          source: 'apparatus-service',
          detail: {
            eventId: 'evt-9',
            eventTime: '2026-09-29T14:03:00.000Z',
            eventType: 'apparatus.defect.reported',
            source: 'apparatus-service',
            correlationId: 'trace-9',
            schemaVersion: '1.0',
            payload,
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

interface CommandLike {
  constructor: { name: string };
  input: Record<string, unknown>;
}

interface Table {
  rows: Map<string, Record<string, unknown>>;
  send: ReturnType<typeof vi.fn>;
}

/** A tiny in-memory table: conditional Puts, Deletes, the roster query and pref reads. */
function fakeTable(mutes: Record<string, { push: boolean; email: boolean }> = {}): Table {
  const rows = new Map<string, Record<string, unknown>>();
  const send = vi.fn().mockImplementation((command: CommandLike) => {
    const name = command.constructor.name;
    if (name === 'QueryCommand') {
      return Promise.resolve({ Items: ROSTER });
    }
    if (name === 'GetCommand') {
      const key = command.input.Key as { sk: string };
      const mute = mutes[key.sk];
      return Promise.resolve({
        Item: mute ? { memberId: 'x', category: 'x', channels: mute, updatedAt: 1 } : undefined,
      });
    }
    if (name === 'PutCommand') {
      const item = command.input.Item as { pk: string; sk: string };
      const key = `${item.pk}|${item.sk}`;
      if (command.input.ConditionExpression && rows.has(key)) {
        return Promise.reject(
          Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }),
        );
      }
      rows.set(key, item);
      return Promise.resolve({});
    }
    if (name === 'DeleteCommand') {
      const key = command.input.Key as { pk: string; sk: string };
      rows.delete(`${key.pk}|${key.sk}`);
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
  return { rows, send };
}

async function load(send: ReturnType<typeof vi.fn>, push: ReturnType<typeof vi.fn>) {
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
  vi.doMock('../channelSender.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../channelSender.js')>();
    return { ...actual, sendPushDigest: push };
  });
  return import('./apparatusDefectConsumer.js');
}

function inboxRows(table: Table): Record<string, unknown>[] {
  return [...table.rows.values()].filter((row) => row.entityType === 'NOTIFICATION');
}

describe('apparatusDefectConsumer — routine defect', () => {
  it('records it for the digest (APPARATUS + OFFICER), sending nothing now', async () => {
    const send = vi.fn().mockResolvedValue({});
    const push = vi.fn();
    const { handler } = await load(send, push);

    await handler(sqsEvent(defect()));

    expect(push).not.toHaveBeenCalled();
    const transact = send.mock.calls[0]?.[0] as CommandLike;
    expect(transact.constructor.name).toBe('TransactWriteCommand');
    const items = (
      transact.input.TransactItems as { Put: { Item: Record<string, unknown> } }[]
    ).map((t) => t.Put.Item);
    expect(items.map((i) => i.pk)).toEqual([
      'DEPT#NICHOLS#ROLE#APPARATUS',
      'DEPT#NICHOLS#ROLE#OFFICER',
      'DEPT#NICHOLS#NOTIF_EVENT#evt-9',
    ]);
    expect(items[0]?.item).toEqual({
      subjectId: 'DEF-1',
      title: 'E1',
      detail: 'major defect reported',
      link: { kind: 'apparatus', id: 'E1' },
    });
  });
});

describe('apparatusDefectConsumer — out-of-service defect (immediate path)', () => {
  it.each([
    ['outOfService: true', defect({ outOfService: true, severity: 'MAJOR' })],
    ['severity OUT_OF_SERVICE', defect({ severity: 'OUT_OF_SERVICE' })],
    ['severity CRITICAL', defect({ severity: 'CRITICAL' })],
  ])(
    '%s: writes every APPARATUS/OFFICER inbox and pushes now, no digest row',
    async (_c, payload) => {
      const table = fakeTable();
      const push = vi.fn().mockResolvedValue(undefined);
      const { handler } = await load(table.send, push);

      await handler(sqsEvent(payload));

      const inbox = inboxRows(table);
      expect(inbox.map((row) => row.memberId).sort()).toEqual(['APP-1', 'LT-1']);
      expect(inbox[0]).toMatchObject({
        category: 'apparatus-defect',
        notificationId: 'evt-9',
        createdAt: Date.parse('2026-09-29T14:03:00.000Z'),
        readAt: null,
        items: [expect.objectContaining({ title: 'E1', detail: 'reported out of service' })],
      });
      expect(push).toHaveBeenCalledTimes(2);
      // The push is the non-critical notification channel, category apparatus-defect.
      expect(push.mock.calls.map((call) => String(call[5]))).toEqual([
        'apparatus-defect',
        'apparatus-defect',
      ]);
      expect(
        table.send.mock.calls.some(
          (call) => (call[0] as CommandLike).constructor.name === 'TransactWriteCommand',
        ),
      ).toBe(false);
    },
  );

  it('a redelivery neither duplicates the inbox record nor pushes again', async () => {
    const table = fakeTable();
    const push = vi.fn().mockResolvedValue(undefined);
    const { handler } = await load(table.send, push);

    await handler(sqsEvent(defect({ outOfService: true })));
    await handler(sqsEvent(defect({ outOfService: true })));

    expect(inboxRows(table)).toHaveLength(2);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('respects an officer’s apparatus-defect push mute but still writes their inbox', async () => {
    const table = fakeTable({ 'NOTIFPREF#LT-1#apparatus-defect': { push: true, email: false } });
    const push = vi.fn().mockResolvedValue(undefined);
    const { handler } = await load(table.send, push);

    await handler(sqsEvent(defect({ outOfService: true })));

    expect(push.mock.calls.map((call) => (call[1] as { memberId: string }).memberId)).toEqual([
      'APP-1',
    ]);
    expect(
      inboxRows(table)
        .map((row) => row.memberId)
        .sort(),
    ).toEqual(['APP-1', 'LT-1']);
  });

  it('a failed push releases that inbox record and rejects, so the redelivery retries only them', async () => {
    const table = fakeTable();
    const push = vi
      .fn()
      .mockImplementation((_env: unknown, recipient: { memberId: string }) =>
        recipient.memberId === 'LT-1' ? Promise.reject(new Error('SNS down')) : Promise.resolve(),
      );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await load(table.send, push);

    await expect(handler(sqsEvent(defect({ outOfService: true })))).rejects.toThrow(
      'immediate defect delivery failed for 1 recipient(s)',
    );
    expect(inboxRows(table).map((row) => row.memberId)).toEqual(['APP-1']);

    push.mockReset().mockResolvedValue(undefined);
    await handler(sqsEvent(defect({ outOfService: true })));

    expect(push.mock.calls.map((call) => (call[1] as { memberId: string }).memberId)).toEqual([
      'LT-1',
    ]);
    expect(inboxRows(table)).toHaveLength(2);
  });

  it('rejects when the roster cannot be read, delivering to nobody', async () => {
    const send = vi.fn().mockRejectedValue(new Error('roster unavailable'));
    const push = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await load(send, push);

    await expect(handler(sqsEvent(defect({ outOfService: true })))).rejects.toThrow(
      'roster unavailable',
    );
    expect(push).not.toHaveBeenCalled();
  });
});

describe('apparatusDefectConsumer — malformed', () => {
  it('rejects a payload without outOfService-independent required fields', async () => {
    const send = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await load(send, vi.fn());

    await expect(handler(sqsEvent(defect({ unitLabel: undefined })))).rejects.toThrow(
      'apparatus.defect.reported event failed shape validation',
    );
    expect(send).not.toHaveBeenCalled();
  });
});
