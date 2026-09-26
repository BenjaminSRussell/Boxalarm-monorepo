import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOccupancy,
  getOccupancyById,
  listOccupancies,
  updateOccupancy,
} from './repository.js';
import type { OccupancyServiceConfig } from './config.js';
import type { CreateOccupancyInput } from './validation.js';

const TABLE_NAME = 'boxalarm-test-platform-table';
const DEPT_ID = 'dept-001';
const PRINCIPAL = { deptId: DEPT_ID };

let container: StartedLocalStackContainer;
let ddbClient: DynamoDBClient;
let config: OccupancyServiceConfig;

function sampleCreateInput(overrides: Partial<CreateOccupancyInput> = {}): CreateOccupancyInput {
  return {
    address: '456 Oak Ave',
    normalizedAddress: '456 OAK AVE',
    occupancyType: 'MULTI_FAMILY',
    contacts: [{ name: 'Pat Smith', phone: '203-555-0100', role: 'OWNER' }],
    hazards: ['PROPANE_TANK'],
    latitude: 41.2415,
    longitude: -73.2004,
    ...overrides,
  };
}

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:3').start();
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
  process.env.OCCUPANCY_TABLE_NAME = TABLE_NAME;
  process.env.AWS_ENDPOINT_URL = container.getConnectionUri();

  ddbClient = new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' });
  await ddbClient.send(
    new CreateTableCommand({
      TableName: TABLE_NAME,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi3pk', AttributeType: 'S' },
        { AttributeName: 'gsi3sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI3',
          KeySchema: [
            { AttributeName: 'gsi3pk', KeyType: 'HASH' },
            { AttributeName: 'gsi3sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );

  config = { tableName: TABLE_NAME };
}, 120_000);

afterAll(async () => {
  ddbClient.destroy();
  await container.stop();
});

function documentClientForTest(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' }),
  );
}

describe('occupancy repository (real DynamoDB via LocalStack)', () => {
  it('creates an occupancy with normalizedAddress and geohash GSI3 keys populated (AC1)', async () => {
    const occupancyId = `OCC-${Date.now()}-1`;
    const record = await createOccupancy(
      config,
      PRINCIPAL,
      occupancyId,
      sampleCreateInput(),
      'MBR-0001',
      'trace-1',
    );
    expect(record.occupancyId).toBe(occupancyId);

    const doc = documentClientForTest();
    const raw = await doc.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${DEPT_ID}#OCCUPANCY#${occupancyId}`, sk: 'METADATA' },
      }),
    );
    expect(raw.Item?.normalizedAddress).toBe('456 OAK AVE');
    expect(raw.Item?.gsi3pk).toBe(
      `DEPT#${DEPT_ID}#OCCUPANCY#GEO#${(raw.Item?.gsi3sk as string).slice(0, 5)}`,
    );
    expect(typeof raw.Item?.gsi3sk).toBe('string');
    expect((raw.Item?.gsi3sk as string).endsWith(`#${occupancyId}`)).toBe(true);

    const queried = await doc.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': raw.Item?.gsi3pk as string },
      }),
    );
    expect(queried.Items).toHaveLength(1);
    expect(queried.Items?.[0]?.occupancyId).toBe(occupancyId);

    const addrIndex = await doc.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${DEPT_ID}#OCCUPANCY#${occupancyId}`, sk: 'ADDR#456 OAK AVE' },
      }),
    );
    expect(addrIndex.Item?.occupancyId).toBe(occupancyId);
    expect(addrIndex.Item?.gsi3pk).toBe(`DEPT#${DEPT_ID}#OCCUPANCY#ADDR#456 OAK AVE`);

    const auditQuery = await doc.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: {
          ':gsi3pk': `DEPT#${DEPT_ID}#AUDIT#ENTITY#OCCUPANCY#${occupancyId}`,
        },
      }),
    );
    expect(auditQuery.Items).toHaveLength(1);
    expect(auditQuery.Items?.[0]?.action).toBe('CREATE');
    expect(auditQuery.Items?.[0]?.actorId).toBe('MBR-0001');
  });

  it('round-trips through getOccupancyById (AC2)', async () => {
    const occupancyId = `OCC-${Date.now()}-2`;
    await createOccupancy(
      config,
      PRINCIPAL,
      occupancyId,
      sampleCreateInput(),
      'MBR-0001',
      'trace-2',
    );
    const found = await getOccupancyById(config, PRINCIPAL, occupancyId);
    expect(found).toMatchObject({
      occupancyId,
      address: '456 Oak Ave',
      occupancyType: 'MULTI_FAMILY',
      hazards: ['PROPANE_TANK'],
    });
  });

  it('creates an occupancy without coordinates and omits the GEO gsi3pk/gsi3sk pair', async () => {
    const occupancyId = `OCC-${Date.now()}-nogeo`;
    const { latitude, longitude, ...noCoords } = sampleCreateInput();
    void latitude;
    void longitude;
    const record = await createOccupancy(
      config,
      PRINCIPAL,
      occupancyId,
      noCoords,
      'MBR-0001',
      'trace-nogeo',
    );
    expect(record.latitude).toBeUndefined();
    expect(record.longitude).toBeUndefined();

    const doc = documentClientForTest();
    const raw = await doc.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${DEPT_ID}#OCCUPANCY#${occupancyId}`, sk: 'METADATA' },
      }),
    );
    expect(raw.Item?.gsi3pk).toBeUndefined();
    expect(raw.Item?.gsi3sk).toBeUndefined();
  });

  it('lists every occupancy in the department by address from the GSI3 list partition, never another department', async () => {
    const listDept = { deptId: `dept-list-${Date.now()}` };
    const otherDept = { deptId: `dept-other-${Date.now()}` };
    await createOccupancy(
      config,
      listDept,
      'OCC-L2',
      sampleCreateInput({ address: '9 Zeta St', normalizedAddress: '9 ZETA ST' }),
      'MBR-0001',
      'trace-l2',
    );
    const { latitude, longitude, ...noCoords } = sampleCreateInput({
      address: '1 Alpha Rd',
      normalizedAddress: '1 ALPHA RD',
    });
    void latitude;
    void longitude;
    await createOccupancy(config, listDept, 'OCC-L1', noCoords, 'MBR-0001', 'trace-l1');
    await createOccupancy(config, otherDept, 'OCC-X', sampleCreateInput(), 'MBR-0001', 'trace-x');
    await updateOccupancy(
      config,
      listDept,
      'OCC-L2',
      (await getOccupancyById(config, listDept, 'OCC-L2'))!,
      { hazards: ['UPDATED'] },
      'MBR-0001',
      'trace-l2-update',
    );

    const listed = await listOccupancies(config, listDept);

    expect(listed.map((record) => record.occupancyId)).toEqual(['OCC-L1', 'OCC-L2']);
    // Read from METADATA, so an update is reflected immediately — not a stale copy.
    expect(listed[1]?.hazards).toEqual(['UPDATED']);
  });

  it('returns an empty list for a department with no occupancies', async () => {
    await expect(listOccupancies(config, { deptId: `dept-empty-${Date.now()}` })).resolves.toEqual(
      [],
    );
  });

  it('returns undefined for an occupancy that does not exist', async () => {
    const found = await getOccupancyById(config, PRINCIPAL, 'OCC-does-not-exist');
    expect(found).toBeUndefined();
  });

  it('updates contacts/hazards and writes a paired AUDIT_LOG_ENTRY in one transaction (AC3)', async () => {
    const occupancyId = `OCC-${Date.now()}-3`;
    const existing = await createOccupancy(
      config,
      PRINCIPAL,
      occupancyId,
      sampleCreateInput(),
      'MBR-0001',
      'trace-3',
    );

    const updated = await updateOccupancy(
      config,
      PRINCIPAL,
      occupancyId,
      existing,
      { hazards: ['FLAMMABLE_STORAGE'] },
      'MBR-0034',
      'trace-3-update',
    );
    expect(updated.hazards).toEqual(['FLAMMABLE_STORAGE']);

    const doc = documentClientForTest();
    const stored = await doc.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${DEPT_ID}#OCCUPANCY#${occupancyId}`, sk: 'METADATA' },
      }),
    );
    expect(stored.Item?.hazards).toEqual(['FLAMMABLE_STORAGE']);

    const auditQuery = await doc.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: {
          ':gsi3pk': `DEPT#${DEPT_ID}#AUDIT#ENTITY#OCCUPANCY#${occupancyId}`,
        },
      }),
    );
    expect(auditQuery.Items).toHaveLength(2);
    const auditItem = auditQuery.Items?.find((entry) => entry.action === 'UPDATE');
    expect(auditItem?.entityType).toBe('AUDIT_LOG_ENTRY');
    expect(auditItem?.actorId).toBe('MBR-0034');
    expect((auditItem?.changedFields as { hazards?: unknown })?.hazards).toEqual({
      old: ['PROPANE_TANK'],
      new: ['FLAMMABLE_STORAGE'],
    });
    expect(auditQuery.Items?.some((entry) => entry.action === 'CREATE')).toBe(true);
  });

  it('rejects an update to a non-existent occupancy without writing an orphaned audit entry (core-harm)', async () => {
    const missingId = `OCC-${Date.now()}-missing`;
    const fakeExisting = {
      occupancyId: missingId,
      address: 'nowhere',
      normalizedAddress: 'NOWHERE',
      occupancyType: 'OTHER',
      contacts: [],
      hazards: [] as string[],
      latitude: 0,
      longitude: 0,
    };
    await expect(
      updateOccupancy(
        config,
        PRINCIPAL,
        missingId,
        fakeExisting,
        { hazards: ['X'] },
        'MBR-1',
        'trace-missing',
      ),
    ).rejects.toThrow();

    const doc = documentClientForTest();
    const auditQuery = await doc.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: {
          ':gsi3pk': `DEPT#${DEPT_ID}#AUDIT#ENTITY#OCCUPANCY#${missingId}`,
        },
      }),
    );
    expect(auditQuery.Items).toHaveLength(0);
  });
});
