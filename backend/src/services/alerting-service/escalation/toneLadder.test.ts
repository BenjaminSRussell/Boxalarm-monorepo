import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { isPredicateMet, scheduleDepartmentToneLadder } from './toneLadder.js';

describe('isPredicateMet', () => {
  it('is unmet when no member has responded', () => {
    expect(
      isPredicateMet([{ ackStatus: 'NONE', quals: [] }], { minResponders: 1, requiredQuals: [] }),
    ).toBe(false);
  });

  it('is met once minResponders acknowledge RESPONDING or DIRECT_TO_SCENE', () => {
    expect(
      isPredicateMet(
        [
          { ackStatus: 'RESPONDING', quals: [] },
          { ackStatus: 'DIRECT_TO_SCENE', quals: [] },
        ],
        { minResponders: 2, requiredQuals: [] },
      ),
    ).toBe(true);
  });

  it('requires a qualifying responder when requiredQuals is set — a head count alone is not enough', () => {
    const roster = [{ ackStatus: 'RESPONDING', quals: ['DRIVER'] }];
    expect(isPredicateMet(roster, { minResponders: 1, requiredQuals: ['INTERIOR'] })).toBe(false);
    expect(isPredicateMet(roster, { minResponders: 1, requiredQuals: ['DRIVER'] })).toBe(true);
  });

  it('NOT_RESPONDING never counts toward the predicate', () => {
    expect(
      isPredicateMet([{ ackStatus: 'NOT_RESPONDING', quals: [] }], {
        minResponders: 1,
        requiredQuals: [],
      }),
    ).toBe(false);
  });
});

describe('scheduleDepartmentToneLadder records the ladder times (architecture nextToneAt)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TONE_EVALUATOR_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:tone-evaluator';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.ESCALATION_SCHEDULE_GROUP_NAME = 'boxalarm-dev-alerting-escalation';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function fakes(updateError?: Error) {
    const scheduler = { send: vi.fn().mockResolvedValue({}) };
    const updates: Array<Record<string, unknown>> = [];
    const ddb = {
      send: vi.fn((command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === 'UpdateCommand') {
          updates.push(command.input);
          return updateError ? Promise.reject(updateError) : Promise.resolve({});
        }
        return Promise.resolve({ Item: undefined });
      }),
    };
    return {
      scheduler: scheduler as unknown as SchedulerClient,
      ddb: ddb as unknown as DynamoDBDocumentClient,
      updates,
    };
  }

  const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

  it('writes tone 2 as nextToneAt and keeps tone 3, once, and only on a ladder still before tone 2', async () => {
    const { scheduler, ddb, updates } = fakes();

    await scheduleDepartmentToneLadder(scheduler, ddb, 'alerting-table', deptId, 'dispatch-1');

    expect(updates).toHaveLength(1);
    const values = updates[0]!.ExpressionAttributeValues as Record<string, number>;
    expect(values[':tone3At']! - values[':tone2At']!).toBe(180);
    expect(updates[0]).toMatchObject({
      Key: { pk: 'DEPT#NICHOLS#DISPATCH#dispatch-1', sk: 'METADATA' },
      UpdateExpression: 'SET nextToneAt = :tone2At, tone3At = :tone3At',
    });
    expect(updates[0]!.ConditionExpression).toContain('attribute_not_exists(tone3At)');
    expect(updates[0]!.ConditionExpression).toContain('currentToneSequence < :two');
  });

  it.each([
    ['a retried fan-out (condition failed)', 'ConditionalCheckFailedException'],
    ['a table error', 'ProvisionedThroughputExceededException'],
  ])('never fails the paging path on %s', async (_label, errorName) => {
    const { scheduler, ddb } = fakes(
      Object.assign(new Error('update failed'), { name: errorName }),
    );

    await expect(
      scheduleDepartmentToneLadder(scheduler, ddb, 'alerting-table', deptId, 'dispatch-1'),
    ).resolves.toBeUndefined();
  });
});
