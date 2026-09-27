import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

vi.mock('../eligibility/dynamoClient.js', () => ({
  createDynamoClient: vi.fn(),
  readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
}));

vi.mock('../fanout/snsClient.js', () => ({
  createSnsClient: vi.fn(() => ({})),
  readFanOutTopicConfig: vi.fn(() => ({ topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo' })),
}));

vi.mock('./scheduleEscalation.js', () => ({
  getSchedulerClient: vi.fn(() => ({})),
  createEscalationSchedule: vi.fn().mockResolvedValue('schedule-name'),
}));

interface MutualAidResult {
  readonly requested: boolean;
  readonly officersNotified: number;
  readonly adapterUsed: string;
}
const requestMutualAid = vi
  .fn<(...args: unknown[]) => Promise<MutualAidResult>>()
  .mockResolvedValue({
    requested: true,
    officersNotified: 1,
    adapterUsed: 'OFFICER_MANUAL_PROMPT',
  });
vi.mock('./mutualAidPort.js', () => ({
  requestMutualAid: (...args: unknown[]) => requestMutualAid(...args),
}));

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

/** Applies a `SET a = :x, b = :y` update expression. */
function applyMetadataUpdate(
  items: Map<string, FakeItem>,
  update: {
    Key: { pk: string; sk: string };
    UpdateExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  },
): void {
  const key = `${update.Key.pk}#${update.Key.sk}`;
  const next: FakeItem = { ...(items.get(key) ?? { pk: update.Key.pk, sk: update.Key.sk }) };
  for (const assignment of update.UpdateExpression.replace(/^SET /, '').split(',')) {
    const [attr, placeholder] = assignment.split('=').map((part) => part.trim());
    next[attr!] = update.ExpressionAttributeValues[placeholder!];
  }
  items.set(key, next);
}

function evaluateMetadataCondition(
  item: FakeItem | undefined,
  update: {
    ConditionExpression?: string;
    ExpressionAttributeValues: Record<string, unknown>;
  },
): boolean {
  if (!update.ConditionExpression) {
    return true;
  }
  if (!(':tone' in update.ExpressionAttributeValues)) {
    // A skip's nextToneAt update: the dispatch exists and its ladder is still ACTIVE.
    return (
      item !== undefined &&
      (item.toneLadderStatus === undefined ||
        item.toneLadderStatus === update.ExpressionAttributeValues[':active'])
    );
  }
  const current = item?.currentToneSequence;
  const status = item?.toneLadderStatus;
  const tone = update.ExpressionAttributeValues[':tone'];
  if (typeof current !== 'number' || typeof tone !== 'number') {
    return false;
  }
  if (current >= tone) {
    return false;
  }
  return (
    status !== update.ExpressionAttributeValues[':completed'] &&
    status !== update.ExpressionAttributeValues[':halted']
  );
}

function throwTransactionCanceled(reasons: ReadonlyArray<{ readonly Code: string }>): never {
  const error = new Error('Transaction cancelled');
  error.name = 'TransactionCanceledException';
  (
    error as unknown as { CancellationReasons: ReadonlyArray<{ readonly Code: string }> }
  ).CancellationReasons = reasons;
  throw error;
}

function publishedMemberIds(sns: { send: ReturnType<typeof vi.fn> }): string[] {
  return sns.send.mock.calls.map((call) => {
    const message = JSON.parse((call[0] as { input: { Message: string } }).input.Message) as {
      payload: { memberId: string };
    };
    return message.payload.memberId;
  });
}

function createFakeDdb(
  seed: readonly FakeItem[],
  options: {
    readonly failReceiptForMemberId?: string;
    readonly failReceiptTimes?: number;
    readonly failTransactTimes?: number;
    readonly failTransactReasons?: ReadonlyArray<{ readonly Code: string }>;
    readonly completeLadderBeforeTransact?: {
      readonly currentToneSequence: number;
      readonly toneLadderStatus: string;
    };
    /** Written just before the first transaction - a concurrent evaluation's commit. */
    readonly insertBeforeTransact?: FakeItem;
  } = {},
): {
  send: DynamoDBDocumentClient['send'];
  sns: { send: ReturnType<typeof vi.fn> };
  items: Map<string, FakeItem>;
} {
  const items = new Map<string, FakeItem>();
  for (const item of seed) {
    items.set(`${item.pk}#${item.sk}`, item);
  }
  let remainingReceiptFailures =
    options.failReceiptForMemberId === undefined
      ? 0
      : (options.failReceiptTimes ?? Number.POSITIVE_INFINITY);
  let remainingTransactFailures = options.failTransactTimes ?? 0;
  const sns = { send: vi.fn().mockResolvedValue({}) };
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      return Promise.resolve({ Item: items.get(`${key.pk}#${key.sk}`) });
    }
    if (name === 'QueryCommand') {
      const query = input as { ExpressionAttributeValues: Record<string, unknown> };
      const pk = query.ExpressionAttributeValues[':pk'];
      const prefix = query.ExpressionAttributeValues[':skPrefix'] as string | undefined;
      return Promise.resolve({
        Items: [...items.values()].filter(
          (item) => item.pk === pk && (!prefix || item.sk.startsWith(prefix)),
        ),
      });
    }
    if (name === 'PutCommand') {
      const put = input as { Item: FakeItem; ConditionExpression?: string };
      const key = `${put.Item.pk}#${put.Item.sk}`;
      if (
        remainingReceiptFailures > 0 &&
        put.Item.entityType === 'DELIVERY_RECEIPT' &&
        put.Item.memberId === options.failReceiptForMemberId
      ) {
        remainingReceiptFailures -= 1;
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
    if (name === 'UpdateCommand') {
      const update = input as {
        Key: { pk: string; sk: string };
        UpdateExpression: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
      if (update.UpdateExpression.includes('mutualAidPending')) {
        const key = `${update.Key.pk}#${update.Key.sk}`;
        const next: FakeItem = { ...(items.get(key) ?? { pk: update.Key.pk, sk: update.Key.sk }) };
        if (update.UpdateExpression.startsWith('REMOVE')) {
          delete next.mutualAidPending;
        } else {
          next.mutualAidPending = true;
        }
        items.set(key, next);
        return Promise.resolve({});
      }
      if (update.ExpressionAttributeValues && ':sentAt' in update.ExpressionAttributeValues) {
        const key = `${update.Key.pk}#${update.Key.sk}`;
        const receipt = items.get(key);
        if (receipt)
          items.set(key, { ...receipt, sentAt: update.ExpressionAttributeValues[':sentAt'] });
        return Promise.resolve({});
      }
      applyMetadataUpdate(
        items,
        input as {
          Key: { pk: string; sk: string };
          UpdateExpression: string;
          ExpressionAttributeValues: Record<string, unknown>;
        },
      );
      return Promise.resolve({});
    }
    if (name === 'TransactWriteCommand') {
      const transactItems = input.TransactItems as ReadonlyArray<Record<string, unknown>>;
      if (remainingTransactFailures > 0) {
        remainingTransactFailures -= 1;
        throwTransactionCanceled(
          options.failTransactReasons ?? [
            { Code: 'TransactionConflict' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        );
      }
      if (
        options.insertBeforeTransact &&
        !items.has(`${options.insertBeforeTransact.pk}#${options.insertBeforeTransact.sk}`)
      ) {
        items.set(
          `${options.insertBeforeTransact.pk}#${options.insertBeforeTransact.sk}`,
          options.insertBeforeTransact,
        );
      }
      if (options.completeLadderBeforeTransact) {
        const metadata = items.get(`${PK}#METADATA`);
        if (metadata) {
          items.set(`${PK}#METADATA`, { ...metadata, ...options.completeLadderBeforeTransact });
        }
      }
      const reasons = transactItems.map((txItem) => {
        const put = txItem.Put as { Item: FakeItem; ConditionExpression?: string } | undefined;
        if (
          put?.ConditionExpression === 'attribute_not_exists(pk)' &&
          items.has(`${put.Item.pk}#${put.Item.sk}`)
        ) {
          return { Code: 'ConditionalCheckFailed' };
        }
        if (put?.ConditionExpression === 'attribute_not_exists(pk) OR skipped = :skipped') {
          const current = items.get(`${put.Item.pk}#${put.Item.sk}`);
          if (current && current.skipped !== true) {
            return { Code: 'ConditionalCheckFailed' };
          }
        }
        const update = txItem.Update as
          | {
              Key: { pk: string; sk: string };
              ConditionExpression?: string;
              ExpressionAttributeValues: Record<string, unknown>;
            }
          | undefined;
        if (
          update &&
          !evaluateMetadataCondition(items.get(`${update.Key.pk}#${update.Key.sk}`), update)
        ) {
          return { Code: 'ConditionalCheckFailed' };
        }
        return { Code: 'None' };
      });
      if (reasons.some((reason) => reason.Code === 'ConditionalCheckFailed')) {
        throwTransactionCanceled(reasons);
      }
      for (const txItem of transactItems) {
        if (txItem.Put) {
          const put = txItem.Put as { Item: FakeItem };
          items.set(`${put.Item.pk}#${put.Item.sk}`, put.Item);
        }
        if (txItem.Update) {
          applyMetadataUpdate(
            items,
            txItem.Update as {
              Key: { pk: string; sk: string };
              UpdateExpression: string;
              ExpressionAttributeValues: Record<string, unknown>;
            },
          );
        }
      }
      return Promise.resolve({});
    }
    throw new Error(`fake ddb: unsupported command ${name}`);
  });
  return { send, sns, items };
}

const PK = 'DEPT#NICHOLS#DISPATCH#dispatch-1';
const ELIGIBILITY_PK = 'DEPT#NICHOLS#ELIGIBILITY';

const METADATA_ITEM: FakeItem = {
  pk: PK,
  sk: 'METADATA',
  entityType: 'DISPATCH_ALERT',
  dispatchId: 'dispatch-1',
  toneLadderStatus: 'ACTIVE',
  currentToneSequence: 1,
  incidentType: 'STRUCTURE_FIRE',
  address: '1 Main St',
};

const ELIGIBLE_MEMBER: FakeItem = {
  pk: ELIGIBILITY_PK,
  sk: 'MEMBER#mbr-1',
  entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
  memberId: 'mbr-1',
  active: true,
  quals: [],
  roles: [],
  contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
  availabilityState: 'AVAILABLE',
  snapshotUpdatedAt: 0,
};

describe('toneEvaluatorHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    requestMutualAid.mockClear();
    process.env.ESCALATION_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:escalation';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.ESCALATION_SCHEDULE_GROUP_NAME = 'boxalarm-dev-alerting-escalation';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('fires tone 2 and re-tones the full eligible roster when the predicate is unmet', async () => {
    const { send, sns, items } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const result = await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(result).toEqual({ outcome: 'FIRED' });
    expect(sns.send).toHaveBeenCalledTimes(1); // push only — no SMS contact channel registered
    const publishedMessage = JSON.parse(
      (sns.send.mock.calls[0]![0] as { input: { Message: string } }).input.Message,
    ) as { payload: { toneSequence: number } };
    expect(publishedMessage.payload.toneSequence).toBe(2);
    expect(items.get(`${PK}#TONE#2`)).toBeDefined();
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(2);

    const outboxEntry = [...items.values()].find((item) => item.entityType === 'OUTBOX_ENTRY');
    expect(outboxEntry).toMatchObject({
      eventType: 'alerting.tone.escalated',
      source: 'alerting-service',
      payload: {
        dispatchId: 'dispatch-1',
        toneSequence: 2,
        outcome: 'FIRED',
        eligibleMemberCount: 1,
      },
    });
  });

  it('does not re-fire a tone that already ran (at-least-once Scheduler delivery)', async () => {
    const { send, sns, items } = createFakeDdb([
      METADATA_ITEM,
      ELIGIBLE_MEMBER,
      {
        pk: PK,
        sk: 'TONE#2',
        entityType: 'TONE_EVENT_GUARD',
        dispatchId: 'dispatch-1',
        toneSequence: 2,
      },
    ]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const result = await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(result).toEqual({ outcome: 'SKIPPED_ALREADY_FIRED' });
    expect(sns.send).not.toHaveBeenCalled();
    void items;
  });

  it('skips firing when the responder predicate is already met', async () => {
    const roster: FakeItem = {
      pk: PK,
      sk: 'ROSTER#mbr-1',
      entityType: 'DISPATCH_ROSTER_ENTRY',
      memberId: 'mbr-1',
      ackStatus: 'RESPONDING',
      quals: [],
    };
    const { send, sns } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER, roster]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const result = await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(result).toEqual({ outcome: 'SKIPPED_PREDICATE_MET' });
    expect(sns.send).not.toHaveBeenCalled();
  });

  it('requests mutual aid when tone 3 fires with the predicate still unmet', async () => {
    const { send, sns } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const result = await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 3 });

    expect(result).toEqual({ outcome: 'FIRED' });
    expect(requestMutualAid).toHaveBeenCalledTimes(1);
    expect(requestMutualAid).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchId: 'dispatch-1',
        deptId: 'NICHOLS',
        reason: 'TONE_3_PREDICATE_UNMET',
      }),
    );
  });

  it('throws and does not advance tone state when a member publish fails (MAJOR #2 regression)', async () => {
    const failingMember: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#mbr-fail',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'mbr-fail',
      active: true,
      quals: [],
      roles: [],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const { send, sns, items } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER, failingMember], {
      failReceiptForMemberId: 'mbr-fail',
    });
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');

    await expect(
      handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 }),
    ).rejects.toThrow('ddb unavailable');

    // mbr-1's receipt still gets attempted concurrently despite mbr-fail's failure.
    expect(items.get(`${PK}#RECEIPT#mbr-1#push#2`)).toBeDefined();
    expect(items.get(`${PK}#RECEIPT#mbr-fail#push#2`)).toBeUndefined();
    // The tone must not be marked fired/advanced when a member's page failed to send.
    expect(items.get(`${PK}#TONE#2`)).toBeUndefined();
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(1);
    expect(items.get(`${PK}#METADATA`)?.toneLadderStatus).toBe('ACTIVE');
  });

  it('retries fireTone after a thrown first evaluation and pages remaining members', async () => {
    const failingMember: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#mbr-fail',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'mbr-fail',
      active: true,
      quals: [],
      roles: [],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const { send, sns, items } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER, failingMember], {
      failReceiptForMemberId: 'mbr-fail',
      failReceiptTimes: 1,
    });
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const payload = { deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 };

    await expect(handler(payload)).rejects.toThrow('ddb unavailable');
    expect(items.get(`${PK}#TONE#2`)).toBeUndefined();
    expect(items.get(`${PK}#RECEIPT#mbr-1#push#2`)).toBeDefined();
    expect(items.get(`${PK}#RECEIPT#mbr-fail#push#2`)).toBeUndefined();
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(1);

    const retry = await handler(payload);

    expect(retry).toEqual({ outcome: 'FIRED' });
    expect(items.get(`${PK}#RECEIPT#mbr-fail#push#2`)).toBeDefined();
    expect(items.get(`${PK}#TONE#2`)).toBeDefined();
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(2);
    expect(publishedMemberIds(sns)).toEqual(['mbr-1', 'mbr-fail']);
  });

  // Architecture nextToneAt (B6): moved to tone 3's time once tone 2 is evaluated, cleared
  // after tone 3. Review MINOR-R6: a skipped tone 3 left the ladder looking like it was still
  // waiting on an automatic tone that would never come.
  it.each([
    ['fires', [] as FakeItem[], 'FIRED'],
    [
      'skips',
      [
        {
          pk: PK,
          sk: 'ROSTER#mbr-1',
          entityType: 'DISPATCH_ROSTER_ENTRY',
          memberId: 'mbr-1',
          ackStatus: 'RESPONDING',
          quals: [],
        },
      ],
      'SKIPPED_PREDICATE_MET',
    ],
  ])(
    'moves nextToneAt to tone 3 when tone 2 %s, and clears it when tone 3 does',
    async (_label, roster, outcome) => {
      const { send, sns, items } = createFakeDdb([
        { ...METADATA_ITEM, nextToneAt: 1_798_000_180, tone3At: 1_798_000_360 },
        ELIGIBLE_MEMBER,
        ...roster,
      ]);
      const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
      const { createSnsClient } = await import('../fanout/snsClient.js');
      vi.mocked(createDynamoClient).mockReturnValue({
        send,
      } as unknown as DynamoDBDocumentClient);
      vi.mocked(createSnsClient).mockReturnValue(sns as never);
      const { handler } = await import('./toneEvaluatorHandler.js');

      await expect(
        handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 }),
      ).resolves.toEqual({ outcome });
      expect(items.get(`${PK}#METADATA`)?.nextToneAt).toBe(1_798_000_360);

      await expect(
        handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 3 }),
      ).resolves.toEqual({ outcome });
      expect(items.get(`${PK}#METADATA`)).toMatchObject({
        nextToneAt: null,
        toneLadderStatus: outcome === 'FIRED' ? 'COMPLETED' : 'ACTIVE',
      });
    },
  );

  // Review MINOR-R2: a member who responds between a partly failed tone and its retry must
  // not turn the retry into a predicate-met skip that abandons the unsent pages.
  it('a retry finishes a partly fired tone even after a member has responded', async () => {
    const failingMember: FakeItem = {
      ...ELIGIBLE_MEMBER,
      sk: 'MEMBER#mbr-fail',
      memberId: 'mbr-fail',
    };
    const { send, sns, items } = createFakeDdb(
      [{ ...METADATA_ITEM, currentToneSequence: 2 }, ELIGIBLE_MEMBER, failingMember],
      { failReceiptForMemberId: 'mbr-fail', failReceiptTimes: 1 },
    );
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const payload = { deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 3 };

    await expect(handler(payload)).rejects.toThrow('ddb unavailable');
    expect(items.get(`${PK}#FIRING#TONE#3`)).toMatchObject({ mutualAidDue: true });
    // mbr-1 was paged by tone 3 and responds before the retry.
    items.set(`${PK}#ROSTER#mbr-1`, {
      pk: PK,
      sk: 'ROSTER#mbr-1',
      entityType: 'DISPATCH_ROSTER_ENTRY',
      memberId: 'mbr-1',
      ackStatus: 'RESPONDING',
      quals: [],
    });

    await expect(handler(payload)).resolves.toEqual({ outcome: 'FIRED' });
    expect(publishedMemberIds(sns)).toEqual(['mbr-1', 'mbr-fail']);
    expect(items.get(`${PK}#TONE#3`)?.skipped).toBe(false);
    expect(items.get(`${PK}#METADATA`)).toMatchObject({
      currentToneSequence: 3,
      toneLadderStatus: 'COMPLETED',
    });
    // Mutual aid follows the first attempt's decision (tone 3, predicate unmet), both times.
    expect(requestMutualAid).toHaveBeenCalledTimes(2);
  });

  it('a skipped tone writes no firing marker, so a later manual advance decides afresh', async () => {
    const roster: FakeItem = {
      pk: PK,
      sk: 'ROSTER#mbr-1',
      entityType: 'DISPATCH_ROSTER_ENTRY',
      memberId: 'mbr-1',
      ackStatus: 'RESPONDING',
      quals: [],
    };
    const { send, sns, items } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER, roster]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(items.get(`${PK}#FIRING#TONE#2`)).toBeUndefined();
  });

  // A claim written by an attempt whose publish then failed must not suppress the page.
  it('re-publishes a receipt that was claimed but never marked sent', async () => {
    const unsentClaim: FakeItem = {
      pk: PK,
      sk: 'RECEIPT#mbr-1#push#2',
      entityType: 'DELIVERY_RECEIPT',
      memberId: 'mbr-1',
      idempotencyKey: 'dispatch-1#2#mbr-1#push',
    };
    const { send, sns, items } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER, unsentClaim]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(publishedMemberIds(sns)).toEqual(['mbr-1']);
    expect(items.get(`${PK}#RECEIPT#mbr-1#push#2`)?.sentAt).toEqual(expect.any(Number));
  });

  it('does not re-publish a receipt already marked sent', async () => {
    const sentClaim: FakeItem = {
      pk: PK,
      sk: 'RECEIPT#mbr-1#push#2',
      entityType: 'DELIVERY_RECEIPT',
      memberId: 'mbr-1',
      idempotencyKey: 'dispatch-1#2#mbr-1#push',
      sentAt: 1_700_000_000,
    };
    const { send, sns } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER, sentClaim]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(publishedMemberIds(sns)).toEqual([]);
  });

  it('returns SKIPPED_ALREADY_FIRED on a second successful evaluation of the same tone', async () => {
    const { send, sns, items } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const payload = { deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 };

    await expect(handler(payload)).resolves.toEqual({ outcome: 'FIRED' });
    expect(sns.send).toHaveBeenCalledTimes(1);
    expect(items.get(`${PK}#TONE#2`)).toBeDefined();

    await expect(handler(payload)).resolves.toEqual({ outcome: 'SKIPPED_ALREADY_FIRED' });
    expect(sns.send).toHaveBeenCalledTimes(1);
    expect(publishedMemberIds(sns)).toEqual(['mbr-1']);
  });

  it('does not evaluate a manually halted dispatch', async () => {
    const halted: FakeItem = { ...METADATA_ITEM, toneLadderStatus: 'HALTED_MANUAL' };
    const { send, sns } = createFakeDdb([halted, ELIGIBLE_MEMBER]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const result = await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(result).toEqual({ outcome: 'SKIPPED_MANUALLY_HALTED' });
    expect(sns.send).not.toHaveBeenCalled();
  });

  it('throws a TransactionCanceledException that is not a guard conflict so Scheduler retries', async () => {
    const { send, sns, items } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER], {
      failTransactTimes: 1,
      failTransactReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }, { Code: 'None' }],
    });
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');

    await expect(
      handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 }),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });

    expect(sns.send).toHaveBeenCalledTimes(1);
    expect(items.get(`${PK}#TONE#2`)).toBeUndefined();
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(1);
    expect(items.get(`${PK}#METADATA`)?.toneLadderStatus).toBe('ACTIVE');
  });

  it('retries after a thrown commit and still advances METADATA', async () => {
    const { send, sns, items } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER], {
      failTransactTimes: 1,
      failTransactReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }, { Code: 'None' }],
    });
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const payload = { deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 };

    await expect(handler(payload)).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect(items.get(`${PK}#TONE#2`)).toBeUndefined();
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(1);

    const retry = await handler(payload);

    expect(retry).toEqual({ outcome: 'FIRED' });
    expect(items.get(`${PK}#TONE#2`)).toBeDefined();
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(2);
    expect(items.get(`${PK}#METADATA`)?.toneLadderStatus).toBe('ACTIVE');
    expect(publishedMemberIds(sns)).toEqual(['mbr-1']);
  });

  it('writes the tone-2 fire-guard without regressing METADATA past tone 3 COMPLETED', async () => {
    const { send, sns, items } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER], {
      completeLadderBeforeTransact: {
        currentToneSequence: 3,
        toneLadderStatus: 'COMPLETED',
      },
    });
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const result = await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(result).toEqual({ outcome: 'FIRED' });
    expect(sns.send).toHaveBeenCalledTimes(1);
    expect(items.get(`${PK}#TONE#2`)).toBeDefined();
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(3);
    expect(items.get(`${PK}#METADATA`)?.toneLadderStatus).toBe('COMPLETED');
  });
});

// POST /tone-ladder/advance (F1.14) invokes this same handler with `manualOverride`: the only
// difference from a scheduled evaluation is that the responder predicate does not gate the
// fire. Everything else — halt/completed checks, the TONE#{n} fire-guard, receipts, publishes
// and the METADATA advance — is the scheduled path.
describe('toneEvaluatorHandler manual override (POST /tone-ladder/advance)', () => {
  const originalEnv = { ...process.env };
  const RESPONDING: FakeItem = {
    pk: PK,
    sk: 'ROSTER#mbr-1',
    entityType: 'DISPATCH_ROSTER_ENTRY',
    memberId: 'mbr-1',
    ackStatus: 'RESPONDING',
    quals: [],
  };
  const manual = (toneSequence: number) => ({
    deptId: 'NICHOLS',
    dispatchId: 'dispatch-1',
    toneSequence,
    manualOverride: { triggeredBy: 'officer-7' },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    requestMutualAid.mockClear();
    process.env.ESCALATION_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:escalation';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.ESCALATION_SCHEDULE_GROUP_NAME = 'boxalarm-dev-alerting-escalation';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function load(
    seed: readonly FakeItem[],
    options: Parameters<typeof createFakeDdb>[1] = {},
  ) {
    const fake = createFakeDdb(seed, options);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({
      send: fake.send,
    } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(fake.sns as never);
    const { handler } = await import('./toneEvaluatorHandler.js');
    return { ...fake, handler };
  }

  it('fires the tone even though the responder predicate is met, and records who advanced it', async () => {
    const { handler, sns, items, send } = await load([METADATA_ITEM, ELIGIBLE_MEMBER, RESPONDING]);

    await expect(handler(manual(2))).resolves.toEqual({ outcome: 'FIRED_MANUAL_OVERRIDE' });

    // Same page a scheduled tone 2 publishes: one push, toneSequence 2 on the dedup key.
    expect(publishedMemberIds(sns)).toEqual(['mbr-1']);
    const publish = (sns.send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(JSON.parse(publish.Message as string)).toMatchObject({
      eventType: 'alerting.dispatch.normalized',
      payload: { toneSequence: 2, channel: 'push' },
    });
    expect(items.get(`${PK}#RECEIPT#mbr-1#push#2`)).toMatchObject({
      idempotencyKey: 'dispatch-1#2#mbr-1#push',
      toneSequence: 2,
    });
    expect(items.get(`${PK}#TONE#2`)).toBeDefined();
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(2);
    const audit = [...items.values()].find(
      (item) => item.entityType === 'TONE_EVENT' && item.sk.startsWith('TONE#2#'),
    );
    expect(audit).toMatchObject({ outcome: 'FIRED_MANUAL_OVERRIDE', triggeredBy: 'officer-7' });
    const outbox = [...items.values()].find((item) => item.entityType === 'OUTBOX_ENTRY');
    expect(outbox).toMatchObject({
      eventType: 'alerting.tone.escalated',
      payload: { toneSequence: 2, outcome: 'FIRED_MANUAL_OVERRIDE' },
    });
    // The halt check reads committed state, never a lagging replica.
    const metadataRead = vi
      .mocked(send)
      .mock.calls.map((call) => call[0] as unknown as { input: { Key?: { sk: string } } })
      .find((command) => command.input.Key?.sk === 'METADATA');
    expect(metadataRead?.input).toMatchObject({ ConsistentRead: true });
  });

  it('lets the later scheduled evaluation of the same tone self-skip (AP 5d: no double tone)', async () => {
    const { handler, sns } = await load([METADATA_ITEM, ELIGIBLE_MEMBER]);

    await handler(manual(2));
    const scheduled = await handler({
      deptId: 'NICHOLS',
      dispatchId: 'dispatch-1',
      toneSequence: 2,
    });

    expect(scheduled).toEqual({ outcome: 'SKIPPED_ALREADY_FIRED' });
    expect(sns.send).toHaveBeenCalledTimes(1);
  });

  it('a double-submitted advance of the same tone pages once', async () => {
    const { handler, sns } = await load([METADATA_ITEM, ELIGIBLE_MEMBER]);

    const [first, second] = await Promise.all([handler(manual(2)), handler(manual(2))]);

    expect([first.outcome, second.outcome].sort()).toEqual([
      'FIRED_MANUAL_OVERRIDE',
      'SKIPPED_ALREADY_FIRED',
    ]);
    // A concurrent twin may see the first's claim before it is marked sent and re-publish
    // (an unsent claim is never trusted - see publishToneChannel). Both publishes carry
    // the same deterministic MessageDeduplicationId, so SNS FIFO delivers the page once.
    const dedupIds = new Set(
      sns.send.mock.calls.map(
        (call) =>
          (call[0] as { input: { MessageDeduplicationId: string } }).input.MessageDeduplicationId,
      ),
    );
    expect(dedupIds.size).toBe(1);
    expect(new Set(publishedMemberIds(sns))).toEqual(new Set(['mbr-1']));
  });

  // Review CRITICAL-1: a predicate-met skip claims TONE#n; a later manual advance of that
  // tone was refused as "already fired" and paged nobody.
  it('fires a tone the timer skipped because the predicate was met', async () => {
    const { handler, sns, items } = await load([METADATA_ITEM, ELIGIBLE_MEMBER, RESPONDING]);
    const timer = { deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 };

    await expect(handler(timer)).resolves.toEqual({ outcome: 'SKIPPED_PREDICATE_MET' });
    expect(sns.send).not.toHaveBeenCalled();
    expect(items.get(`${PK}#TONE#2`)?.skipped).toBe(true);

    await expect(handler(manual(2))).resolves.toEqual({ outcome: 'FIRED_MANUAL_OVERRIDE' });
    expect(publishedMemberIds(sns)).toEqual(['mbr-1']);
    expect(items.get(`${PK}#TONE#2`)?.skipped).toBe(false);
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(2);
    // Review MINOR-8: the skip and the manual fire usually land in the same second; both audit
    // rows survive because the sort key carries the outcome.
    const auditOutcomes = [...items.values()]
      .filter((item) => item.entityType === 'TONE_EVENT' && item.toneSequence === 2)
      .map((item) => item.outcome)
      .sort();
    expect(auditOutcomes).toEqual(['FIRED_MANUAL_OVERRIDE', 'SKIPPED_PREDICATE_MET']);

    // Once fired it is a real guard: neither a timer retry nor another advance re-fires it.
    await expect(handler(timer)).resolves.toEqual({ outcome: 'SKIPPED_ALREADY_FIRED' });
    await expect(handler(manual(2))).resolves.toEqual({ outcome: 'SKIPPED_ALREADY_FIRED' });
  });

  // Review MINOR-R1: the timer's skip guard lands while the advance is paging. The advance has
  // already paged everyone, so it must still claim the tone - not answer "already fired".
  it('an advance racing the timer skip still claims the tone it paged', async () => {
    const { handler, sns, items } = await load([METADATA_ITEM, ELIGIBLE_MEMBER, RESPONDING], {
      insertBeforeTransact: {
        pk: PK,
        sk: 'TONE#2',
        entityType: 'TONE_EVENT_GUARD',
        toneSequence: 2,
        skipped: true,
      },
    });

    await expect(handler(manual(2))).resolves.toEqual({ outcome: 'FIRED_MANUAL_OVERRIDE' });
    expect(publishedMemberIds(sns)).toEqual(['mbr-1']);
    expect(items.get(`${PK}#TONE#2`)?.skipped).toBe(false);
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(2);
  });

  it('a timer retry of a skipped tone stays skipped (only a manual advance may fire it)', async () => {
    const { handler, sns } = await load([METADATA_ITEM, ELIGIBLE_MEMBER, RESPONDING]);
    const timer = { deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 };

    await handler(timer);
    await expect(handler(timer)).resolves.toEqual({ outcome: 'SKIPPED_ALREADY_FIRED' });
    expect(sns.send).not.toHaveBeenCalled();
  });

  // Review MAJOR-1: a failure paging one member must not also block mutual aid.
  it('still requests mutual aid for tone 3 when paging a member fails, then rethrows', async () => {
    const { handler, sns } = await load([
      { ...METADATA_ITEM, currentToneSequence: 2 },
      ELIGIBLE_MEMBER,
    ]);
    sns.send.mockRejectedValue(new Error('sns unavailable'));

    await expect(handler(manual(3))).rejects.toThrow('sns unavailable');
    expect(requestMutualAid).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'TONE_3_PREDICATE_UNMET' }),
    );
  });

  it('the scheduled tone 3 also requests mutual aid when paging a member fails, then rethrows', async () => {
    const { handler, sns, items } = await load([
      { ...METADATA_ITEM, currentToneSequence: 2 },
      ELIGIBLE_MEMBER,
    ]);
    sns.send.mockRejectedValueOnce(new Error('sns unavailable'));

    await expect(
      handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 3 }),
    ).rejects.toThrow('sns unavailable');
    expect(requestMutualAid).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'TONE_3_PREDICATE_UNMET' }),
    );
    expect(items.get(`${PK}#TONE#3`)).toBeUndefined();
  });

  it('a failed push page still sends the SMS page to that member', async () => {
    const withSms: FakeItem = {
      ...ELIGIBLE_MEMBER,
      contactChannels: [
        { channel: 'PUSH', token: 'tok', platform: 'ios', valid: true },
        // The producer-side SMS shape (see the open SMS target-shape split in #361).
        { channel: 'sms', token: '+12035550100', valid: true },
      ],
    };
    const { handler, sns } = await load([METADATA_ITEM, withSms]);
    sns.send.mockImplementation(
      (command: { input: { MessageAttributes: { channel: { StringValue: string } } } }) =>
        command.input.MessageAttributes.channel.StringValue === 'push'
          ? Promise.reject(new Error('push provider down'))
          : Promise.resolve({}),
    );

    await expect(handler(manual(2))).rejects.toThrow('push provider down');
    const channels = sns.send.mock.calls.map(
      (call) =>
        (call[0] as { input: { MessageAttributes: { channel: { StringValue: string } } } }).input
          .MessageAttributes.channel.StringValue,
    );
    expect(channels).toEqual(['push', 'sms']);
  });

  it('does not fire on a halted ladder', async () => {
    const { handler, sns } = await load([
      { ...METADATA_ITEM, toneLadderStatus: 'HALTED_MANUAL' },
      ELIGIBLE_MEMBER,
    ]);

    await expect(handler(manual(2))).resolves.toEqual({ outcome: 'SKIPPED_MANUALLY_HALTED' });
    expect(sns.send).not.toHaveBeenCalled();
  });

  it('advancing to tone 3 with the predicate unmet requests mutual aid like the scheduled tone 3', async () => {
    const { handler } = await load([{ ...METADATA_ITEM, currentToneSequence: 2 }, ELIGIBLE_MEMBER]);

    await expect(handler(manual(3))).resolves.toEqual({ outcome: 'FIRED_MANUAL_OVERRIDE' });
    expect(requestMutualAid).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'TONE_3_PREDICATE_UNMET' }),
    );
  });

  // A mutual-aid failure after the tone-3 commit was only logged, and the next retry stopped
  // at SKIPPED_ALREADY_FIRED - so the request was lost. Review MINOR-R3: blocking the commit
  // instead left a fully paged tone 3 showing as tone 2 for as long as one prompt failed.
  // The commit now records the prompts as pending, and a retry re-runs only the prompt pass.
  it('commits a fully paged tone 3 when mutual aid fails, and the retry re-prompts only', async () => {
    const { handler, items, sns } = await load([
      { ...METADATA_ITEM, currentToneSequence: 2 },
      ELIGIBLE_MEMBER,
    ]);
    const scheduled = { deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 3 };
    requestMutualAid.mockRejectedValueOnce(new Error('mutual aid prompt failed'));

    await expect(handler(scheduled)).rejects.toThrow('mutual aid prompt failed');
    expect(items.get(`${PK}#TONE#3`)).toMatchObject({ skipped: false, mutualAidPending: true });
    expect(items.get(`${PK}#METADATA`)).toMatchObject({
      currentToneSequence: 3,
      toneLadderStatus: 'COMPLETED',
    });
    expect(publishedMemberIds(sns)).toEqual(['mbr-1']);

    await expect(handler(scheduled)).resolves.toEqual({ outcome: 'SKIPPED_ALREADY_FIRED' });
    expect(requestMutualAid).toHaveBeenCalledTimes(2);
    expect(items.get(`${PK}#TONE#3`)?.mutualAidPending).toBeUndefined();
    expect(publishedMemberIds(sns)).toEqual(['mbr-1']);

    // Done: a further retry neither re-pages nor re-prompts.
    await expect(handler(scheduled)).resolves.toEqual({ outcome: 'SKIPPED_COMPLETED' });
    expect(requestMutualAid).toHaveBeenCalledTimes(2);
  });

  it('keeps the prompts pending while the re-prompt keeps failing', async () => {
    const { handler, items } = await load([
      { ...METADATA_ITEM, currentToneSequence: 2 },
      ELIGIBLE_MEMBER,
    ]);
    const scheduled = { deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 3 };
    requestMutualAid
      .mockRejectedValueOnce(new Error('mutual aid prompt failed'))
      .mockRejectedValueOnce(new Error('mutual aid prompt failed'));

    await expect(handler(scheduled)).rejects.toThrow('mutual aid prompt failed');
    await expect(handler(scheduled)).rejects.toThrow('mutual aid prompt failed');
    expect(items.get(`${PK}#TONE#3`)?.mutualAidPending).toBe(true);
  });

  it('does not commit tone 3 while a member page is unsent, even when mutual aid succeeded', async () => {
    const { handler, items, sns } = await load([
      { ...METADATA_ITEM, currentToneSequence: 2 },
      ELIGIBLE_MEMBER,
    ]);
    sns.send.mockRejectedValueOnce(new Error('sns unavailable'));

    await expect(handler(manual(3))).rejects.toThrow('sns unavailable');
    expect(requestMutualAid).toHaveBeenCalledTimes(1);
    expect(items.get(`${PK}#TONE#3`)).toBeUndefined();
  });

  it('advancing to tone 3 with the predicate met pages tone 3 but does not request mutual aid', async () => {
    const { handler, sns } = await load([
      { ...METADATA_ITEM, currentToneSequence: 2 },
      ELIGIBLE_MEMBER,
      RESPONDING,
    ]);

    await expect(handler(manual(3))).resolves.toEqual({ outcome: 'FIRED_MANUAL_OVERRIDE' });
    expect(sns.send).toHaveBeenCalledTimes(1);
    expect(requestMutualAid).not.toHaveBeenCalled();
  });

  it.each([
    ['tone 1', { toneSequence: 1, manualOverride: { triggeredBy: 'officer-7' } }],
    ['tone 4', { toneSequence: 4, manualOverride: { triggeredBy: 'officer-7' } }],
    ['no triggeredBy', { toneSequence: 2, manualOverride: { triggeredBy: ' ' } }],
    ['non-object override', { toneSequence: 2, manualOverride: 'officer-7' }],
  ])('rejects a malformed manual payload (%s) without paging', async (_label, extra) => {
    const { handler, sns } = await load([METADATA_ITEM, ELIGIBLE_MEMBER]);

    await expect(
      handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', ...extra }),
    ).rejects.toThrow('tone evaluator payload failed shape validation');
    expect(sns.send).not.toHaveBeenCalled();
  });
});
