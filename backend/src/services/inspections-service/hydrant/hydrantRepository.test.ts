import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  HydrantAlreadyExistsError,
  HydrantNotFoundError,
  createHydrant,
  listHydrants,
  queryHydrantsDueWithin,
  updateHydrant,
} from './hydrantRepository.js';
import type { CreateHydrantInput } from './hydrantRepository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

const createInput: CreateHydrantInput = {
  hydrantId: 'HYD-0231',
  latitude: 41.2417,
  longitude: -73.2004,
  size: '6-inch',
  flowRatingGpm: 1000,
  nextFlowTestDue: '2027-01-10',
  status: 'IN_SERVICE',
};

beforeEach(() => {
  ddbMock.reset();
  process.env.PLATFORM_TABLE_NAME = 'boxalarm-platform-table';
});

describe('createHydrant (AC1)', () => {
  it('writes the HYDRANT item with GSI2 due-date and GSI3 geohash keys populated', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const hydrant = await createHydrant(deptId, createInput);
    expect(hydrant.pk).toBe('DEPT#NICHOLS#HYDRANT#HYD-0231');
    expect(hydrant.sk).toBe('METADATA');
    expect(hydrant.gsi2pk).toBe('DEPT#NICHOLS#DUE#HYDRANT#2027-01');
    expect(hydrant.gsi2sk).toBe('2027-01-10#HYD-0231');
    expect(hydrant.gsi3pk).toMatch(/^DEPT#NICHOLS#HYDRANT#GEO#/);
    expect(hydrant.gsi3sk).toContain('#HYD-0231');
  });

  it('core-harm: writes the exact gsi2/gsi3 key literals so due-date scheduling and map resolution can find the hydrant', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await createHydrant(deptId, createInput);
    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const item = call?.args[0].input.TransactItems?.[0]?.Put?.Item as
      Record<string, unknown> | undefined;
    expect(item?.gsi2pk).toBe('DEPT#NICHOLS#DUE#HYDRANT#2027-01');
    expect(item?.gsi2sk).toBe('2027-01-10#HYD-0231');
    expect(item?.gsi3pk).toMatch(/^DEPT#NICHOLS#HYDRANT#GEO#[0-9b-hj-km-np-z]{5}$/);
    expect(item?.gsi3sk).toMatch(/^[0-9b-hj-km-np-z]{8}#HYD-0231$/);
  });

  it('writes the department list index item in the same transaction as the hydrant', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await createHydrant(deptId, createInput);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items?.[0]?.Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(items?.[1]?.Put?.Item).toEqual({
      pk: 'DEPT#NICHOLS#HYDRANT#HYD-0231',
      sk: 'LIST',
      entityType: 'HYDRANT_LIST_INDEX',
      hydrantId: 'HYD-0231',
      gsi3pk: 'DEPT#NICHOLS#HYDRANT',
      gsi3sk: 'HYD-0231',
    });
  });

  it('conditions the put on attribute_not_exists(pk) and maps a collision to HydrantAlreadyExistsError', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    await expect(createHydrant(deptId, createInput)).rejects.toThrow(HydrantAlreadyExistsError);
  });

  it('fails closed (rethrows) on an unrecognized DynamoDB failure', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error('simulated outage'));
    await expect(createHydrant(deptId, createInput)).rejects.toThrow('simulated outage');
  });
});

describe('updateHydrant (AC2)', () => {
  it('transacts the item update and an inspections.hydrant.updated outbox item, then returns the persisted record', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: 'DEPT#NICHOLS#HYDRANT#HYD-0231',
        sk: 'METADATA',
        status: 'OUT_OF_SERVICE',
        latitude: 41.2417,
        longitude: -73.2004,
      },
    });

    const result = await updateHydrant(deptId, 'HYD-0231', { status: 'OUT_OF_SERVICE' }, 'corr-1');
    expect(result.status).toBe('OUT_OF_SERVICE');

    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const items = call?.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.Update?.ConditionExpression).toBe('attribute_exists(pk)');
    expect(items[1]?.Put?.Item?.entityType).toBe('OUTBOX_ENTRY');
    expect(items[1]?.Put?.Item?.eventType).toBe('inspections.hydrant.updated');
    expect(items[1]?.Put?.Item?.correlationId).toBe('corr-1');
    expect(items[1]?.Put?.Item?.payload).toMatchObject({
      hydrantId: 'HYD-0231',
      status: 'OUT_OF_SERVICE',
      latitude: 41.2417,
      longitude: -73.2004,
    });
  });

  it('AC3: the persisted status field survives untransformed (OUT_OF_SERVICE stays OUT_OF_SERVICE)', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({
      Item: { pk: 'DEPT#NICHOLS#HYDRANT#HYD-0231', sk: 'METADATA', status: 'OUT_OF_SERVICE' },
    });
    const result = await updateHydrant(deptId, 'HYD-0231', { status: 'OUT_OF_SERVICE' }, 'corr-1');
    expect(result.status).toBe('OUT_OF_SERVICE');
  });

  it('recomputes gsi2pk/gsi2sk when nextFlowTestDue changes', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { status: 'IN_SERVICE' } });
    await updateHydrant(deptId, 'HYD-0231', { nextFlowTestDue: '2028-03-05' }, 'corr-1');
    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const update = call?.args[0].input.TransactItems?.[0]?.Update;
    expect(update?.ExpressionAttributeValues?.[':gsi2pk']).toBe('DEPT#NICHOLS#DUE#HYDRANT#2028-03');
    expect(update?.ExpressionAttributeValues?.[':gsi2sk']).toBe('2028-03-05#HYD-0231');
  });

  it('reads back the persisted item with ConsistentRead so a stale pre-update image can never be returned', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { status: 'OUT_OF_SERVICE' } });
    await updateHydrant(deptId, 'HYD-0231', { status: 'OUT_OF_SERVICE' }, 'corr-1');
    const call = ddbMock.commandCalls(GetCommand)[0];
    expect(call?.args[0].input.ConsistentRead).toBe(true);
  });

  it('throws HydrantNotFoundError instead of returning an undefined body when the read-back finds no item', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({});
    await expect(
      updateHydrant(deptId, 'HYD-0231', { status: 'OUT_OF_SERVICE' }, 'corr-1'),
    ).rejects.toThrow(HydrantNotFoundError);
  });

  it('maps a failed attribute_exists(pk) condition to HydrantNotFoundError (404 path)', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    await expect(
      updateHydrant(deptId, 'HYD-9999', { status: 'OUT_OF_SERVICE' }, 'corr-1'),
    ).rejects.toThrow(HydrantNotFoundError);
  });

  it('fails closed (rethrows) on a non-conditional transaction failure', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'None' }, { Code: 'ThrottlingError' }],
      }),
    );
    await expect(
      updateHydrant(deptId, 'HYD-0231', { status: 'OUT_OF_SERVICE' }, 'corr-1'),
    ).rejects.toThrow(TransactionCanceledException);
  });
});

describe('queryHydrantsDueWithin (AC4)', () => {
  it('returns [] for a department with zero due hydrants, without throwing', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = await queryHydrantsDueWithin(deptId, '2027-01');
    expect(result).toEqual([]);
  });

  it('queries GSI2 keyed on the month-bucketed due partition', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ hydrantId: 'HYD-0231' }] });
    const result = await queryHydrantsDueWithin(deptId, '2027-01');
    expect(result).toEqual([{ hydrantId: 'HYD-0231' }]);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call?.args[0].input.IndexName).toBe('GSI2');
    expect(call?.args[0].input.ExpressionAttributeValues).toEqual({
      ':gsi2pk': 'DEPT#NICHOLS#DUE#HYDRANT#2027-01',
    });
  });

  it('fails closed (rethrows) on a DynamoDB Query failure rather than swallowing it', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('simulated throttling'));
    await expect(queryHydrantsDueWithin(deptId, '2027-01')).rejects.toThrow('simulated throttling');
  });
});

describe('listHydrants (web Hydrants page)', () => {
  it('queries the GSI3 department list partition and returns the METADATA rows in list order', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ hydrantId: 'HYD-1' }], LastEvaluatedKey: { pk: 'x' } })
      .resolvesOnce({ Items: [{ hydrantId: 'HYD-2' }] });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        'boxalarm-platform-table': [
          { hydrantId: 'HYD-2', status: 'OUT_OF_SERVICE' },
          { hydrantId: 'HYD-1', status: 'IN_SERVICE' },
        ],
      },
    });

    const result = await listHydrants(deptId);

    expect(result.map((h) => h.hydrantId)).toEqual(['HYD-1', 'HYD-2']);
    const query = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(query?.IndexName).toBe('GSI3');
    expect(query?.ExpressionAttributeValues).toEqual({ ':gsi3pk': 'DEPT#NICHOLS#HYDRANT' });
    expect(ddbMock.commandCalls(QueryCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual({
      pk: 'x',
    });
    const keys =
      ddbMock.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.[
        'boxalarm-platform-table'
      ]?.Keys;
    expect(keys).toEqual([
      { pk: 'DEPT#NICHOLS#HYDRANT#HYD-1', sk: 'METADATA' },
      { pk: 'DEPT#NICHOLS#HYDRANT#HYD-2', sk: 'METADATA' },
    ]);
  });

  it('retries UnprocessedKeys and fails closed rather than returning a silently short list', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ hydrantId: 'HYD-1' }] });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'boxalarm-platform-table': [] },
      UnprocessedKeys: {
        'boxalarm-platform-table': { Keys: [{ pk: 'DEPT#NICHOLS#HYDRANT#HYD-1', sk: 'METADATA' }] },
      },
    });
    await expect(listHydrants(deptId)).rejects.toThrow('unprocessed');
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(5);
  });

  it('returns [] and issues no BatchGetItem for a department with no hydrants', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(listHydrants(deptId)).resolves.toEqual([]);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });
});
