import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SNSClient } from '@aws-sdk/client-sns';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { MutualAidPromptIncompleteError, requestMutualAid } from './mutualAidPort.js';

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function createFakeDdb(
  seed: readonly FakeItem[],
  options: {
    readonly failPromptForMemberId?: string;
    readonly failOutboxWrite?: boolean;
    /** Fails the outbox write this many times, then lets it through. */
    readonly failOutboxWriteTimes?: number;
  } = {},
): {
  send: DynamoDBDocumentClient['send'];
  items: Map<string, FakeItem>;
} {
  const items = new Map<string, FakeItem>();
  for (const item of seed) {
    items.set(`${item.pk}#${item.sk}`, item);
  }
  let outboxFailuresLeft = options.failOutboxWrite
    ? Number.POSITIVE_INFINITY
    : (options.failOutboxWriteTimes ?? 0);
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    if (name === 'QueryCommand') {
      const query = input as { ExpressionAttributeValues: Record<string, unknown> };
      const pk = query.ExpressionAttributeValues[':pk'];
      return Promise.resolve({ Items: [...items.values()].filter((item) => item.pk === pk) });
    }
    if (name === 'PutCommand') {
      const put = input as { Item: FakeItem; ConditionExpression?: string };
      const key = `${put.Item.pk}#${put.Item.sk}`;
      if (
        options.failPromptForMemberId &&
        put.Item.entityType === 'MUTUAL_AID_PROMPT' &&
        put.Item.memberId === options.failPromptForMemberId
      ) {
        throw new Error('ddb unavailable');
      }
      if (put.ConditionExpression && items.has(key)) {
        const error = new Error('conditional check failed');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      items.set(key, put.Item);
      return Promise.resolve({});
    }
    if (name === 'TransactWriteCommand') {
      const transactItems = input.TransactItems as ReadonlyArray<Record<string, unknown>>;
      const writesOutbox = transactItems.some(
        (txItem) =>
          (txItem.Put as { Item: FakeItem } | undefined)?.Item.entityType === 'OUTBOX_ENTRY',
      );
      if (writesOutbox && outboxFailuresLeft > 0) {
        outboxFailuresLeft -= 1;
        return Promise.reject(new Error('ddb unavailable'));
      }
      const eventRecordedUpdate = transactItems.find(
        (txItem) =>
          (txItem.Update as { ConditionExpression?: string } | undefined)?.ConditionExpression ===
          'attribute_exists(pk) AND attribute_not_exists(eventRecorded)',
      )?.Update as { Key: { pk: string; sk: string } } | undefined;
      if (eventRecordedUpdate) {
        const key = `${eventRecordedUpdate.Key.pk}#${eventRecordedUpdate.Key.sk}`;
        const singleton = items.get(key);
        if (!singleton || singleton.eventRecorded === true) {
          return Promise.reject(
            Object.assign(new Error('conditional check failed'), {
              name: 'TransactionCanceledException',
              CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
            }),
          );
        }
        items.set(key, { ...singleton, eventRecorded: true });
      }
      const failedIndex = transactItems.findIndex((txItem) => {
        const put = txItem.Put as { Item: FakeItem; ConditionExpression?: string } | undefined;
        return (
          put?.ConditionExpression === 'attribute_not_exists(pk)' &&
          items.has(`${put.Item.pk}#${put.Item.sk}`)
        );
      });
      if (failedIndex !== -1) {
        const error = new Error('conditional check failed');
        error.name = 'TransactionCanceledException';
        throw error;
      }
      for (const txItem of transactItems) {
        if (txItem.Put) {
          const put = txItem.Put as { Item: FakeItem };
          items.set(`${put.Item.pk}#${put.Item.sk}`, put.Item);
        }
      }
      return Promise.resolve({});
    }
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      return Promise.resolve({ Item: items.get(`${key.pk}#${key.sk}`) });
    }
    if (name === 'UpdateCommand') {
      const update = input as {
        Key: { pk: string; sk: string };
        ExpressionAttributeValues: Record<string, unknown>;
      };
      const key = `${update.Key.pk}#${update.Key.sk}`;
      const existing = items.get(key);
      if (existing)
        items.set(key, { ...existing, sentAt: update.ExpressionAttributeValues[':sentAt'] });
      return Promise.resolve({});
    }
    throw new Error(`fake ddb: unsupported command ${name}`);
  });
  return { send, items };
}

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const DISPATCH_TEXT = { incidentType: 'STRUCTURE_FIRE', address: '1 Main St', isTest: false };
const ELIGIBILITY_PK = 'DEPT#NICHOLS#ELIGIBILITY';

describe('requestMutualAid', () => {
  it('records the mutual-aid event once and prompts every eligible officer', async () => {
    const officer: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#officer-1',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'officer-1',
      active: true,
      quals: [],
      roles: ['OFFICER'],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const nonOfficer: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#mbr-1',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'mbr-1',
      active: true,
      quals: [],
      roles: [],
      contactChannels: [],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const { send, items } = createFakeDdb([officer, nonOfficer]);
    const snsSend = vi.fn().mockResolvedValue({});
    const sns = { send: snsSend } as unknown as SNSClient;

    const result = await requestMutualAid({
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET',
    });

    expect(result).toEqual({
      requested: true,
      officersNotified: 1,
      adapterUsed: 'OFFICER_MANUAL_PROMPT',
    });
    expect(items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#MUTUALAID#SINGLETON')).toMatchObject({
      entityType: 'MUTUAL_AID_EVENT',
      reason: 'TONE_3_PREDICATE_UNMET',
    });
    expect(items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#MAPROMPT#officer-1#PUSH')).toBeDefined();
    expect(items.has('DEPT#NICHOLS#DISPATCH#dispatch-1#MAPROMPT#mbr-1#PUSH')).toBe(false);
    expect(snsSend).toHaveBeenCalledTimes(1);

    const outboxEntry = [...items.values()].find((item) => item.entityType === 'OUTBOX_ENTRY');
    expect(outboxEntry).toMatchObject({
      eventType: 'alerting.mutual_aid.triggered',
      source: 'alerting-service',
      payload: {
        dispatchId: 'dispatch-1',
        reason: 'TONE_3_PREDICATE_UNMET',
        adapterUsed: 'OFFICER_MANUAL_PROMPT',
        officersNotified: 1,
      },
    });
  });

  it('prompts a chief as well as an officer, and nobody holding neither role', async () => {
    const snapshot = (memberId: string, roles: string[]): FakeItem => ({
      pk: ELIGIBILITY_PK,
      sk: `MEMBER#${memberId}`,
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId,
      active: true,
      quals: [],
      roles,
      contactChannels: [
        { channel: 'PUSH', token: `tok-${memberId}`, platform: 'ios', valid: true },
      ],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    });
    const { send, items } = createFakeDdb([
      snapshot('chief-1', ['MEMBER', 'CHIEF']),
      snapshot('officer-1', ['MEMBER', 'OFFICER']),
      snapshot('training-1', ['MEMBER', 'TRAINING', 'ADMIN']),
    ]);
    const snsSend = vi.fn().mockResolvedValue({});

    const result = await requestMutualAid({
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns: { send: snsSend } as unknown as SNSClient,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET',
    });

    expect(result.officersNotified).toBe(2);
    expect(items.has('DEPT#NICHOLS#DISPATCH#dispatch-1#MAPROMPT#chief-1#PUSH')).toBe(true);
    expect(items.has('DEPT#NICHOLS#DISPATCH#dispatch-1#MAPROMPT#officer-1#PUSH')).toBe(true);
    expect(items.has('DEPT#NICHOLS#DISPATCH#dispatch-1#MAPROMPT#training-1#PUSH')).toBe(false);
    expect(snsSend).toHaveBeenCalledTimes(2);
  });

  it('still reports success when the bridge outbox write fails (must never block or fail mutual aid)', async () => {
    const officer: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#officer-1',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'officer-1',
      active: true,
      quals: [],
      roles: ['OFFICER'],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const { send } = createFakeDdb([officer], { failOutboxWrite: true });
    const snsSend = vi.fn().mockResolvedValue({});
    const sns = { send: snsSend } as unknown as SNSClient;

    const result = await requestMutualAid({
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET',
    });

    expect(result).toEqual({
      requested: true,
      officersNotified: 1,
      adapterUsed: 'OFFICER_MANUAL_PROMPT',
    });
  });

  // Review MINOR-7: only the creating attempt wrote the event, so a failed write was lost -
  // every later pass saw "already requested".
  it('a later pass records the LOB event the first pass failed to write, exactly once', async () => {
    const officer: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#officer-1',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'officer-1',
      active: true,
      quals: [],
      roles: ['OFFICER'],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const { send, items } = createFakeDdb([officer], { failOutboxWriteTimes: 1 });
    const input = {
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns: { send: vi.fn().mockResolvedValue({}) } as unknown as SNSClient,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET' as const,
    };
    const outboxRows = () =>
      [...items.values()].filter((item) => item.entityType === 'OUTBOX_ENTRY');

    await requestMutualAid(input);
    expect(outboxRows()).toHaveLength(0);

    await requestMutualAid(input);
    expect(outboxRows()).toHaveLength(1);
    expect(items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#MUTUALAID#SINGLETON')?.eventRecorded).toBe(
      true,
    );

    await requestMutualAid(input);
    expect(outboxRows()).toHaveLength(1);
  });

  it('still notifies every other officer when one officer prompt fails (MAJOR #2 regression)', async () => {
    const officerOk: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#officer-ok',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'officer-ok',
      active: true,
      quals: [],
      roles: ['OFFICER'],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const officerFail: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#officer-fail',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'officer-fail',
      active: true,
      quals: [],
      roles: ['OFFICER'],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const { send } = createFakeDdb([officerOk, officerFail], {
      failPromptForMemberId: 'officer-fail',
    });
    const snsSend = vi.fn().mockResolvedValue({});
    const sns = { send: snsSend } as unknown as SNSClient;

    const input = {
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET' as const,
    };

    // The surviving officer is still prompted, but the failure is surfaced so the caller
    // retries instead of treating mutual aid as fully requested.
    await expect(requestMutualAid(input)).rejects.toBeInstanceOf(MutualAidPromptIncompleteError);
    expect(snsSend).toHaveBeenCalledTimes(1);
  });

  it('a retry after a failed prompt prompts only the officer who was missed', async () => {
    const officer = (memberId: string): FakeItem => ({
      pk: ELIGIBILITY_PK,
      sk: `MEMBER#${memberId}`,
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId,
      active: true,
      quals: [],
      roles: ['OFFICER'],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    });
    const { send } = createFakeDdb([officer('officer-a'), officer('officer-b')]);
    let failedOnce = false;
    const snsSend = vi.fn((command: { input: { Message: string } }) => {
      if (!failedOnce && command.input.Message.includes('officer-b')) {
        failedOnce = true;
        return Promise.reject(new Error('sns throttled'));
      }
      return Promise.resolve({});
    });
    const input = {
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns: { send: snsSend } as unknown as SNSClient,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET' as const,
    };

    await expect(requestMutualAid(input)).rejects.toBeInstanceOf(MutualAidPromptIncompleteError);
    const firstAttemptCalls = snsSend.mock.calls.length;
    const retry = await requestMutualAid(input);

    expect(retry).toEqual({
      requested: false,
      officersNotified: 1,
      adapterUsed: 'OFFICER_MANUAL_PROMPT',
    });
    const promptedOnRetry = snsSend.mock.calls
      .slice(firstAttemptCalls)
      .map((call) => call[0].input.Message);
    expect(promptedOnRetry).toHaveLength(1);
    expect(promptedOnRetry[0]).toContain('officer-b');
  });

  it('is a no-op the second time it is invoked for the same dispatch (singleton guard)', async () => {
    const existingEvent: FakeItem = {
      pk: 'DEPT#NICHOLS#DISPATCH#dispatch-1',
      sk: 'MUTUALAID#SINGLETON',
      entityType: 'MUTUAL_AID_EVENT',
      reason: 'TONE_3_PREDICATE_UNMET',
    };
    const { send } = createFakeDdb([existingEvent]);
    const snsSend = vi.fn();
    const sns = { send: snsSend } as unknown as SNSClient;

    const result = await requestMutualAid({
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET',
    });

    expect(result).toEqual({
      requested: false,
      officersNotified: 0,
      adapterUsed: 'OFFICER_MANUAL_PROMPT',
    });
    expect(snsSend).not.toHaveBeenCalled();
  });
});

// F1.14: "halting also suppresses automatic mutual-aid triggering", race-safe — the check is
// a ConditionCheck on METADATA inside the singleton's own transaction. A manual trigger is
// allowed "at any time", halted or not.
describe('requestMutualAid and a halted tone ladder', () => {
  const OFFICER: FakeItem = {
    pk: ELIGIBILITY_PK,
    sk: 'MEMBER#officer-1',
    entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
    memberId: 'officer-1',
    active: true,
    quals: [],
    roles: ['OFFICER'],
    contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
    availabilityState: 'AVAILABLE',
    snapshotUpdatedAt: 0,
  };

  /** Evaluates both the singleton put and the METADATA halt ConditionCheck, like DynamoDB. */
  function haltAwareDdb(metadata: FakeItem | undefined, transactError?: Error) {
    const base = createFakeDdb(metadata ? [OFFICER, metadata] : [OFFICER]);
    const transacts: Array<ReadonlyArray<Record<string, unknown>>> = [];
    const send = vi.fn((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name !== 'TransactWriteCommand') {
        return base.send(command as never);
      }
      if (transactError) {
        return Promise.reject(transactError);
      }
      const txItems = (command as { input: { TransactItems: Array<Record<string, unknown>> } })
        .input.TransactItems;
      transacts.push(txItems);
      const reasons = txItems.map((txItem) => {
        const put = txItem.Put as { Item: FakeItem } | undefined;
        if (put && base.items.has(`${put.Item.pk}#${put.Item.sk}`)) {
          return { Code: 'ConditionalCheckFailed' };
        }
        if (txItem.ConditionCheck && metadata?.toneLadderStatus === 'HALTED_MANUAL') {
          return { Code: 'ConditionalCheckFailed' };
        }
        return { Code: 'None' };
      });
      if (reasons.some((reason) => reason.Code !== 'None')) {
        return Promise.reject(
          Object.assign(new Error('cancelled'), {
            name: 'TransactionCanceledException',
            CancellationReasons: reasons,
          }),
        );
      }
      for (const txItem of txItems) {
        const put = txItem.Put as { Item: FakeItem } | undefined;
        if (put) {
          base.items.set(`${put.Item.pk}#${put.Item.sk}`, put.Item);
        }
      }
      return Promise.resolve({});
    });
    return { send, items: base.items, transacts };
  }

  const halted: FakeItem = {
    pk: 'DEPT#NICHOLS#DISPATCH#dispatch-1',
    sk: 'METADATA',
    toneLadderStatus: 'HALTED_MANUAL',
  };

  function request(send: ReturnType<typeof vi.fn>, snsSend: ReturnType<typeof vi.fn>, extra = {}) {
    return requestMutualAid({
      ddb: { send } as unknown as DynamoDBDocumentClient,
      sns: { send: snsSend } as unknown as SNSClient,
      tableName: 'alerting-table',
      topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      dispatch: DISPATCH_TEXT,
      reason: 'TONE_3_PREDICATE_UNMET',
      ...extra,
    });
  }

  it('does not record or prompt an automatic trigger once the ladder is halted', async () => {
    const { send, items, transacts } = haltAwareDdb(halted);
    const snsSend = vi.fn().mockResolvedValue({});

    const result = await request(send, snsSend);

    expect(result).toEqual({
      requested: false,
      officersNotified: 0,
      adapterUsed: 'OFFICER_MANUAL_PROMPT',
      suppressedBy: 'HALTED_MANUAL',
    });
    expect(items.has('DEPT#NICHOLS#DISPATCH#dispatch-1#MUTUALAID#SINGLETON')).toBe(false);
    expect(snsSend).not.toHaveBeenCalled();
    expect(transacts[0]?.[1]).toMatchObject({
      ConditionCheck: {
        Key: { pk: 'DEPT#NICHOLS#DISPATCH#dispatch-1', sk: 'METADATA' },
        ExpressionAttributeValues: { ':halted': 'HALTED_MANUAL' },
      },
    });
  });

  it('still records an automatic trigger on an active ladder', async () => {
    const { send, items } = haltAwareDdb({ ...halted, toneLadderStatus: 'ACTIVE' });
    const snsSend = vi.fn().mockResolvedValue({});

    const result = await request(send, snsSend);

    expect(result).toMatchObject({ requested: true, officersNotified: 1 });
    expect(items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#MUTUALAID#SINGLETON')).toBeDefined();
  });

  it('lets an officer trigger manually on a halted ladder and records who did', async () => {
    const { send, items, transacts } = haltAwareDdb(halted);
    const snsSend = vi.fn().mockResolvedValue({});

    const result = await request(send, snsSend, { reason: 'MANUAL', triggeredBy: 'officer-7' });

    expect(result).toMatchObject({ requested: true, officersNotified: 1 });
    expect(transacts[0]).toHaveLength(1);
    expect(items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#MUTUALAID#SINGLETON')).toMatchObject({
      reason: 'MANUAL',
      triggeredBy: 'officer-7',
    });
    expect(snsSend).toHaveBeenCalledTimes(1);
  });

  it('rethrows a cancellation that recorded nothing instead of reporting "already requested"', async () => {
    const conflict = Object.assign(new Error('conflict'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
    });
    const { send } = haltAwareDdb(undefined, conflict);
    const snsSend = vi.fn();

    await expect(request(send, snsSend)).rejects.toBe(conflict);
    expect(snsSend).not.toHaveBeenCalled();
  });
});
