import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { Context, DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';

/**
 * A status change made through the deployed route (PUT /members/{memberId}/status ->
 * members/updateStatus.ts -> updateMemberStatus) must reach both consumers that act on it,
 * with only the AWS transports faked:
 *  - session revocation (platform-service memberStatusRevocationHandler) reads `status` and
 *    ends every session on LOA/RETIRED;
 *  - the alerting eligibility snapshot (memberUpdatedHandler) reads `active`, which is what
 *    stops the member being paged.
 * The event used to carry only previousStatus/newStatus, so both silently did nothing.
 */

interface SentCommand {
  readonly input: Record<string, unknown>;
}

const originalEnv = { ...process.env };
// Unique per test: the drain skips a stream record whose sequence it has already published.
let sequence = 0;

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
  process.env.COGNITO_USER_POOL_ID = 'us-east-1_pool';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.doUnmock('../../alerting-service/eligibility/dynamoClient.js');
  vi.doUnmock('../../platform-service/session-revocation/cognitoRevocationClient.js');
});

async function statusChangeEvent(
  previousStatus: 'ACTIVE' | 'LOA',
  newStatus: 'ACTIVE' | 'LOA' | 'RETIRED',
): Promise<string> {
  const producerSend = vi.fn().mockResolvedValue({});
  vi.spyOn(DynamoDBDocumentClient, 'from').mockReturnValue({
    send: producerSend,
  } as unknown as DynamoDBDocumentClient);
  const { updateMemberStatus } = await import('../lib/memberRepository.js');
  await updateMemberStatus(
    'platform-table',
    { deptId: 'NICHOLS' },
    'mbr-7',
    previousStatus,
    newStatus,
    'chief-1',
  );
  const transact = (producerSend.mock.calls[0]?.[0] as SentCommand).input as {
    TransactItems: Array<{ Put?: { Item: Record<string, unknown> } }>;
  };
  const outbox = transact.TransactItems.find((item) => item.Put?.Item.entityType === 'OUTBOX_ENTRY')
    ?.Put?.Item;
  if (!outbox) {
    throw new Error('updateMemberStatus wrote no OUTBOX_ENTRY');
  }

  const ebSend = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'eb-1' }] });
  // Imported per test: the drain caches its first clients at module level, so a static
  // import would keep publishing to the first test's EventBridge fake.
  const { createOutboxDrainHandler } = await import('@boxalarm/outbox');
  const drain = createOutboxDrainHandler('platform-service', {
    eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
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
  const entry = (
    (ebSend.mock.calls[0]?.[0] as SentCommand).input.Entries as Array<{
      Source: string;
      DetailType: string;
      Detail: string;
    }>
  )[0]!;
  // EventBridge -> SQS with no inputPath: the SQS body is the whole EventBridge event.
  return JSON.stringify({
    version: '0',
    id: 'eb-1',
    'detail-type': entry.DetailType,
    source: entry.Source,
    detail: JSON.parse(entry.Detail) as unknown,
  });
}

function sqs(body: string): SQSEvent {
  return { Records: [{ messageId: 'msg-1', body }] } as unknown as SQSEvent;
}

async function revokedMembers(body: string): Promise<string[]> {
  const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../../platform-service/session-revocation/cognitoRevocationClient.js', () => ({
    createRevocationClient: () => ({}),
    readRevocationConfig: () => ({ userPoolId: 'us-east-1_pool' }),
    revokeMemberSession,
  }));
  const { handler } =
    await import('../../platform-service/session-revocation/memberStatusRevocationHandler.js');
  await handler(sqs(body), {} as Context, () => undefined);
  return revokeMemberSession.mock.calls.map((call) => (call[1] as { username: string }).username);
}

async function snapshotActive(body: string): Promise<unknown> {
  const alertingSend = vi.fn().mockResolvedValue({});
  vi.doMock('../../alerting-service/eligibility/dynamoClient.js', () => ({
    createDynamoClient: () => ({ send: alertingSend }),
    readAlertingConfig: () => ({ tableName: 'alerting-table' }),
  }));
  const { handler } = await import('../../alerting-service/eligibility/memberUpdatedHandler.js');
  await expect(handler(sqs(body))).resolves.toEqual({ batchItemFailures: [] });
  const update = (alertingSend.mock.calls[0]?.[0] as SentCommand).input as {
    Key: Record<string, string>;
    UpdateExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  };
  expect(update.Key).toEqual({ pk: 'DEPT#NICHOLS#ELIGIBILITY', sk: 'MEMBER#mbr-7' });
  expect(update.UpdateExpression).toContain('active = :active');
  return update.ExpressionAttributeValues[':active'];
}

describe('personnel.member.updated (status) producer -> revocation and alerting contract', () => {
  it.each(['LOA', 'RETIRED'] as const)(
    'a member set to %s is signed out and stops being paged',
    async (newStatus) => {
      const body = await statusChangeEvent('ACTIVE', newStatus);

      await expect(revokedMembers(body)).resolves.toEqual(['mbr-7']);
      await expect(snapshotActive(body)).resolves.toBe(false);
    },
  );

  it('a member returned to ACTIVE is paged again and not signed out', async () => {
    const body = await statusChangeEvent('LOA', 'ACTIVE');

    await expect(revokedMembers(body)).resolves.toEqual([]);
    await expect(snapshotActive(body)).resolves.toBe(true);
  });
});
