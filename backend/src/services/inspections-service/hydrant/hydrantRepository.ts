import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { getDocumentClient, readHydrantTableConfig } from './dynamoClient.js';
import { logError } from './logger.js';
import {
  HYDRANT_SK,
  buildHydrantDueGsi2Pk,
  buildHydrantGsi2Keys,
  buildHydrantGsi3Keys,
} from './hydrantKeys.js';
import type { HydrantStatus } from './hydrantKeys.js';

export type HydrantRecord = Readonly<Record<'pk' | 'sk', string>> & {
  readonly entityType: 'HYDRANT';
  readonly hydrantId: string;
  readonly deptId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly size: string;
  readonly flowRatingGpm: number;
  readonly lastFlowTestDate?: string;
  readonly nextFlowTestDue: string;
  readonly status: HydrantStatus;
  readonly gsi2pk: string;
  readonly gsi2sk: string;
  readonly gsi3pk: string;
  readonly gsi3sk: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export interface CreateHydrantInput {
  readonly hydrantId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly size: string;
  readonly flowRatingGpm: number;
  readonly nextFlowTestDue: string;
  readonly status: HydrantStatus;
}

export interface UpdateHydrantInput {
  readonly status?: HydrantStatus;
  readonly lastFlowTestDate?: string;
  readonly nextFlowTestDue?: string;
}

// architecture.md §3.3: GSI3's non-geo DEPT#{deptId}#HYDRANT partition is the department
// hydrant list. The METADATA item's gsi3 pair is its GEO bucket (map retrieval), so the list
// key rides on this per-hydrant index item instead.
const HYDRANT_LIST_SK = 'LIST';
const BATCH_GET_MAX_KEYS = 100;
const BATCH_GET_MAX_ATTEMPTS = 5;

export class HydrantAlreadyExistsError extends Error {
  constructor(hydrantId: string) {
    super(`hydrant "${hydrantId}" already exists`);
  }
}

export class HydrantNotFoundError extends Error {
  constructor(hydrantId: string) {
    super(`hydrant "${hydrantId}" was not found`);
  }
}

export async function createHydrant(
  deptId: VerifiedDeptId,
  input: CreateHydrantInput,
): Promise<HydrantRecord> {
  const { tableName } = readHydrantTableConfig(process.env);
  const now = Date.now();
  const gsi2 = buildHydrantGsi2Keys(deptId, input.nextFlowTestDue, input.hydrantId);
  const gsi3 = buildHydrantGsi3Keys(deptId, input.latitude, input.longitude, input.hydrantId);
  const item: HydrantRecord = {
    pk: buildDeptScopedPk(deptId, 'HYDRANT', input.hydrantId),
    sk: HYDRANT_SK,
    entityType: 'HYDRANT',
    hydrantId: input.hydrantId,
    deptId,
    latitude: input.latitude,
    longitude: input.longitude,
    size: input.size,
    flowRatingGpm: input.flowRatingGpm,
    nextFlowTestDue: input.nextFlowTestDue,
    status: input.status,
    ...gsi2,
    ...gsi3,
    createdAt: now,
    updatedAt: now,
  };

  const listIndexItem = {
    pk: item.pk,
    sk: HYDRANT_LIST_SK,
    entityType: 'HYDRANT_LIST_INDEX',
    hydrantId: input.hydrantId,
    gsi3pk: buildDeptScopedPk(deptId, 'HYDRANT'),
    gsi3sk: input.hydrantId,
  };

  try {
    await getDocumentClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          { Put: { TableName: tableName, Item: listIndexItem } },
        ],
      }),
    );
  } catch (error) {
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      throw new HydrantAlreadyExistsError(input.hydrantId);
    }
    throw error;
  }

  return item;
}

/**
 * Every hydrant in the caller's department, ordered by hydrantId: a GSI3 Query over the list
 * partition for the ids, then BatchGetItem on the METADATA rows (never a stale copy).
 */
export async function listHydrants(deptId: VerifiedDeptId): Promise<readonly HydrantRecord[]> {
  const { tableName } = readHydrantTableConfig(process.env);
  const client = getDocumentClient();

  const hydrantIds: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'HYDRANT') },
        ProjectionExpression: 'hydrantId',
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    for (const entry of page.Items ?? []) {
      if (typeof entry.hydrantId === 'string') {
        hydrantIds.push(entry.hydrantId);
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const byId = new Map<string, HydrantRecord>();
  for (let start = 0; start < hydrantIds.length; start += BATCH_GET_MAX_KEYS) {
    let keys: Record<string, unknown>[] = hydrantIds
      .slice(start, start + BATCH_GET_MAX_KEYS)
      .map((hydrantId) => ({
        pk: buildDeptScopedPk(deptId, 'HYDRANT', hydrantId),
        sk: HYDRANT_SK,
      }));
    for (let attempt = 1; keys.length > 0; attempt += 1) {
      if (attempt > BATCH_GET_MAX_ATTEMPTS) {
        throw new Error(`BatchGetItem left ${keys.length} hydrant keys unprocessed`);
      }
      const output = await client.send(
        new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys } } }),
      );
      for (const hydrant of (output.Responses?.[tableName] ?? []) as unknown as HydrantRecord[]) {
        byId.set(hydrant.hydrantId, hydrant);
      }
      keys = (output.UnprocessedKeys?.[tableName]?.Keys ?? []) as Record<string, unknown>[];
    }
  }

  return hydrantIds.flatMap((hydrantId) => {
    const hydrant = byId.get(hydrantId);
    return hydrant ? [hydrant] : [];
  });
}

export async function updateHydrant(
  deptId: VerifiedDeptId,
  hydrantId: string,
  patch: UpdateHydrantInput,
  correlationId: string,
): Promise<HydrantRecord> {
  const { tableName } = readHydrantTableConfig(process.env);
  const pk = buildDeptScopedPk(deptId, 'HYDRANT', hydrantId);
  const now = Date.now();

  const setClauses: string[] = ['updatedAt = :updatedAt'];
  const names: Record<string, string> = {};
  const values: Record<string, string | number> = { ':updatedAt': now };

  if (patch.status !== undefined) {
    setClauses.push('#status = :status');
    names['#status'] = 'status';
    values[':status'] = patch.status;
  }
  if (patch.lastFlowTestDate !== undefined) {
    setClauses.push('lastFlowTestDate = :lastFlowTestDate');
    values[':lastFlowTestDate'] = patch.lastFlowTestDate;
  }
  if (patch.nextFlowTestDue !== undefined) {
    const gsi2 = buildHydrantGsi2Keys(deptId, patch.nextFlowTestDue, hydrantId);
    setClauses.push('nextFlowTestDue = :nextFlowTestDue', 'gsi2pk = :gsi2pk', 'gsi2sk = :gsi2sk');
    values[':nextFlowTestDue'] = patch.nextFlowTestDue;
    values[':gsi2pk'] = gsi2.gsi2pk;
    values[':gsi2sk'] = gsi2.gsi2sk;
  }

  // buildOutboxRecord's item carries no ttl, deliberately (matches personnel-service's
  // OUTBOX_ENTRY precedent): an unpublished event must never be silently dropped by a timer.
  const preUpdate = await getDocumentClient().send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: HYDRANT_SK }, ConsistentRead: true }),
  );
  const existing = preUpdate?.Item as Partial<HydrantRecord> | undefined;
  const outboxRecord = buildOutboxRecord(
    deptId,
    'inspections-service',
    'inspections.hydrant.updated',
    correlationId,
    {
      hydrantId,
      deptId,
      ...(typeof existing?.latitude === 'number' ? { latitude: existing.latitude } : {}),
      ...(typeof existing?.longitude === 'number' ? { longitude: existing.longitude } : {}),
      ...patch,
    },
  );

  try {
    await getDocumentClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk: HYDRANT_SK },
              ConditionExpression: 'attribute_exists(pk)',
              UpdateExpression: `SET ${setClauses.join(', ')}`,
              ExpressionAttributeValues: values,
              ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: outboxRecord,
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      logError({
        event: 'hydrant.update.transact_failed',
        service: 'inspections-service',
        correlationId,
        hydrantId,
        reasons: error.CancellationReasons?.map((reason) => reason.Code),
        message: error.message,
      });
      if (error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        throw new HydrantNotFoundError(hydrantId);
      }
    }
    throw error;
  }

  const persisted = await getDocumentClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { pk, sk: HYDRANT_SK },
      ConsistentRead: true,
    }),
  );
  if (!persisted.Item) {
    throw new HydrantNotFoundError(hydrantId);
  }
  return persisted.Item as HydrantRecord;
}

export async function queryHydrantsDueWithin(
  deptId: VerifiedDeptId,
  yyyyMm: string,
): Promise<readonly HydrantRecord[]> {
  const { tableName } = readHydrantTableConfig(process.env);
  const result = await getDocumentClient().send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI2',
      KeyConditionExpression: 'gsi2pk = :gsi2pk',
      ExpressionAttributeValues: { ':gsi2pk': buildHydrantDueGsi2Pk(deptId, yyyyMm) },
    }),
  );
  return (result.Items ?? []) as unknown as readonly HydrantRecord[];
}
