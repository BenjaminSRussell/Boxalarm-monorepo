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

function sqsEvent(
  payload: Record<string, unknown>,
  /** null omits eventTime from the envelope. */
  eventTime: string | null = '2026-09-29T14:03:00.000Z',
): SQSEvent {
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
            ...(eventTime === null ? {} : { eventTime }),
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
      const existing = rows.get(key);
      const staleBefore = (
        command.input.ExpressionAttributeValues as { ':staleBefore'?: number } | undefined
      )?.[':staleBefore'];
      // attribute_not_exists(sk) [OR (attribute_not_exists(sentAt) AND claimedAt < :staleBefore)]
      const takeover =
        staleBefore !== undefined &&
        existing !== undefined &&
        existing.sentAt === undefined &&
        (existing.claimedAt as number) < staleBefore;
      if (command.input.ConditionExpression && existing && !takeover) {
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

async function load(
  send: ReturnType<typeof vi.fn>,
  push: ReturnType<typeof vi.fn>,
  email: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
) {
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
  vi.doMock('../channelSender.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../channelSender.js')>();
    return { ...actual, sendPushDigest: push, sendEmailDigest: email };
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
      // It is also recorded for the digest, so it reaches every channel a minor defect does.
      expect(
        table.send.mock.calls.some(
          (call) => (call[0] as CommandLike).constructor.name === 'TransactWriteCommand',
        ),
      ).toBe(true);
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

  it('a failed push keeps the inbox record, releases only the push claim, and the redelivery re-pushes just that member', async () => {
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
    expect(
      inboxRows(table)
        .map((row) => row.memberId)
        .sort(),
    ).toEqual(['APP-1', 'LT-1']);
    expect(table.rows.has('DEPT#NICHOLS#MEMBER#LT-1|DEFECTPUSH#evt-9')).toBe(false);

    push.mockReset().mockResolvedValue(undefined);
    await handler(sqsEvent(defect({ outOfService: true })));

    expect(push.mock.calls.map((call) => (call[1] as { memberId: string }).memberId)).toEqual([
      'LT-1',
    ]);
    expect(inboxRows(table)).toHaveLength(2);
  });

  it('a push that fails on every receive (to the DLQ) never costs anyone their inbox record', async () => {
    const table = fakeTable();
    const push = vi.fn().mockRejectedValue(new Error('SNS throttled'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await load(table.send, push);

    for (let receive = 1; receive <= 5; receive += 1) {
      await expect(handler(sqsEvent(defect({ outOfService: true })))).rejects.toThrow();
    }

    expect(push).toHaveBeenCalledTimes(10);
    expect(
      inboxRows(table)
        .map((row) => row.memberId)
        .sort(),
    ).toEqual(['APP-1', 'LT-1']);
  });

  it('a mute read that keeps failing still leaves every inbox record in place', async () => {
    const table = fakeTable();
    const inner = table.send.getMockImplementation() as (command: CommandLike) => Promise<unknown>;
    table.send.mockImplementation((command: CommandLike) =>
      command.constructor.name === 'GetCommand'
        ? Promise.reject(new Error('GetItem throttled'))
        : inner(command),
    );
    const push = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await load(table.send, push);

    await expect(handler(sqsEvent(defect({ outOfService: true })))).rejects.toThrow();
    await expect(handler(sqsEvent(defect({ outOfService: true })))).rejects.toThrow();

    expect(push).not.toHaveBeenCalled();
    expect(inboxRows(table)).toHaveLength(2);
  });

  it('a handler that died after the inbox write but before pushing still pushes on redelivery', async () => {
    const table = fakeTable();
    const push = vi.fn().mockResolvedValue(undefined);
    const { handler } = await load(table.send, push);
    // Simulate the crashed first receive: both inbox records exist, no push claim does.
    await handler(sqsEvent(defect({ outOfService: true })));
    for (const key of [...table.rows.keys()].filter((k) => k.includes('DEFECTPUSH#'))) {
      table.rows.delete(key);
    }
    push.mockClear();

    await handler(sqsEvent(defect({ outOfService: true })));

    expect(push).toHaveBeenCalledTimes(2);
    expect(inboxRows(table)).toHaveLength(2);
  });

  it('a handler that died after claiming but before pushing: the redelivery takes the stale claim over', async () => {
    const table = fakeTable();
    const push = vi.fn().mockResolvedValue(undefined);
    const { handler, CLAIM_STALE_MS } = await load(table.send, push);
    const claimedAt = Date.now() - CLAIM_STALE_MS - 1_000;
    for (const member of ['APP-1', 'LT-1']) {
      table.rows.set(`DEPT#NICHOLS#MEMBER#${member}|DEFECTPUSH#evt-9`, {
        pk: `DEPT#NICHOLS#MEMBER#${member}`,
        sk: 'DEFECTPUSH#evt-9',
        claimedAt,
      });
    }

    await handler(sqsEvent(defect({ outOfService: true })));

    expect(push).toHaveBeenCalledTimes(2);
  });

  it('a fresh claim held by a concurrent invocation is not taken over (no double push)', async () => {
    const table = fakeTable();
    const push = vi.fn().mockResolvedValue(undefined);
    const { handler } = await load(table.send, push);
    table.rows.set('DEPT#NICHOLS#MEMBER#LT-1|DEFECTPUSH#evt-9', {
      pk: 'DEPT#NICHOLS#MEMBER#LT-1',
      sk: 'DEFECTPUSH#evt-9',
      claimedAt: Date.now(),
    });

    await handler(sqsEvent(defect({ outOfService: true })));

    expect(push.mock.calls.map((call) => (call[1] as { memberId: string }).memberId)).toEqual([
      'APP-1',
    ]);
  });

  it('rejects when the roster cannot be read, delivering to nobody', async () => {
    const send = vi
      .fn()
      .mockImplementation((command: CommandLike) =>
        command.constructor.name === 'QueryCommand'
          ? Promise.reject(new Error('roster unavailable'))
          : Promise.resolve({}),
      );
    const push = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await load(send, push);

    await expect(handler(sqsEvent(defect({ outOfService: true })))).rejects.toThrow(
      'roster unavailable',
    );
    expect(push).not.toHaveBeenCalled();
  });
});

describe('apparatusDefectConsumer — out-of-service email (review M1)', () => {
  it('emails every APPARATUS/OFFICER recipient at once, to their roster address', async () => {
    const table = fakeTable();
    const email = vi.fn().mockResolvedValue(undefined);
    const { handler } = await load(table.send, vi.fn().mockResolvedValue(undefined), email);

    await handler(sqsEvent(defect({ outOfService: true })));

    expect(email.mock.calls.map((call) => call[1] as unknown)).toEqual([
      { memberId: 'APP-1', email: 'app1@example.com' },
      { memberId: 'LT-1', email: 'lt1@example.com' },
    ]);
    expect(email.mock.calls.map((call) => String(call[5]))).toEqual([
      'apparatus-defect',
      'apparatus-defect',
    ]);
  });

  it('records the defect for the digest before the immediate send, so a failed email still arrives tomorrow', async () => {
    const table = fakeTable();
    const email = vi.fn().mockRejectedValue(new Error('SES down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await load(table.send, vi.fn().mockResolvedValue(undefined), email);

    await expect(handler(sqsEvent(defect({ outOfService: true })))).rejects.toThrow();

    const transact = table.send.mock.calls
      .map((call) => call[0] as CommandLike)
      .find((command) => command.constructor.name === 'TransactWriteCommand');
    const pks = (transact?.input.TransactItems as { Put: { Item: { pk: string } } }[]).map(
      (t) => t.Put.Item.pk,
    );
    expect(pks).toEqual([
      'DEPT#NICHOLS#ROLE#APPARATUS',
      'DEPT#NICHOLS#ROLE#OFFICER',
      'DEPT#NICHOLS#NOTIF_EVENT#evt-9',
    ]);
    // The failed email's claim is released; the sent push's is not.
    expect(table.rows.has('DEPT#NICHOLS#MEMBER#LT-1|DEFECTEMAIL#evt-9')).toBe(false);
    expect(table.rows.get('DEPT#NICHOLS#MEMBER#LT-1|DEFECTPUSH#evt-9')?.sentAt).toBeDefined();
  });

  it('a retried email is sent once more and the already-sent push is not repeated', async () => {
    const table = fakeTable();
    const push = vi.fn().mockResolvedValue(undefined);
    const email = vi.fn().mockRejectedValueOnce(new Error('SES down')).mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await load(table.send, push, email);

    await expect(handler(sqsEvent(defect({ outOfService: true })))).rejects.toThrow();
    await handler(sqsEvent(defect({ outOfService: true })));

    expect(push).toHaveBeenCalledTimes(2);
    expect(email).toHaveBeenCalledTimes(3);
  });

  it('respects an email mute without affecting the push', async () => {
    const table = fakeTable({ 'NOTIFPREF#LT-1#apparatus-defect': { push: false, email: true } });
    const push = vi.fn().mockResolvedValue(undefined);
    const email = vi.fn().mockResolvedValue(undefined);
    const { handler } = await load(table.send, push, email);

    await handler(sqsEvent(defect({ outOfService: true })));

    expect(push).toHaveBeenCalledTimes(2);
    expect(email.mock.calls.map((call) => (call[1] as { memberId: string }).memberId)).toEqual([
      'APP-1',
    ]);
  });
});

describe('apparatusDefectConsumer — nobody to tell', () => {
  it('logs and emits the no-recipient metric the chief alarm watches', async () => {
    const table = fakeTable();
    const inner = table.send.getMockImplementation() as (command: CommandLike) => Promise<unknown>;
    table.send.mockImplementation((command: CommandLike) =>
      command.constructor.name === 'QueryCommand'
        ? Promise.resolve({ Items: [{ memberId: 'FF-1', roles: ['MEMBER'] }] })
        : inner(command),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await load(table.send, vi.fn());

    await handler(sqsEvent(defect({ outOfService: true })));

    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes('notification.apparatusDefect.no_recipients'),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0]).includes('ApparatusDefectImmediateNoRecipients'),
      ),
    ).toBe(true);
  });
});

describe('apparatusDefectConsumer — malformed', () => {
  it.each([null, 'not-a-date'])(
    'rejects an event whose eventTime is %s rather than keying the inbox on the clock',
    async (eventTime) => {
      const send = vi.fn();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { handler } = await load(send, vi.fn());

      await expect(handler(sqsEvent(defect({ outOfService: true }), eventTime))).rejects.toThrow(
        'apparatus.defect.reported event failed shape validation',
      );
      expect(send).not.toHaveBeenCalled();
    },
  );

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
