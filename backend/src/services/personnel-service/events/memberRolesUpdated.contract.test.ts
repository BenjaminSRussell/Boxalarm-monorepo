import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { createOutboxDrainHandler } from '@boxalarm/outbox';

/**
 * The whole chain a role change travels to reach mutual-aid targeting, with only the AWS
 * transports faked: updateMemberRoles' OUTBOX_ENTRY -> DynamoDB Streams NEW_IMAGE -> the
 * platform outbox drain (configured as platform-service/outbox-publisher/handler.ts is) ->
 * EventBridge -> SQS (whole event, no inputPath) -> alerting memberUpdatedHandler, which
 * must write `roles` onto the eligibility snapshot mutualAidPort.ts reads.
 */

interface SentCommand {
  readonly input: Record<string, unknown>;
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.doUnmock('../../alerting-service/eligibility/dynamoClient.js');
});

async function produceOutboxItem(): Promise<Record<string, unknown>> {
  const producerSend = vi.fn().mockResolvedValue({});
  vi.spyOn(DynamoDBDocumentClient, 'from').mockReturnValue({
    send: producerSend,
  } as unknown as DynamoDBDocumentClient);
  const { updateMemberRoles } = await import('../lib/memberRepository.js');
  await updateMemberRoles(
    'platform-table',
    { deptId: 'NICHOLS' },
    'mbr-7',
    ['MEMBER'],
    ['MEMBER', 'OFFICER', 'CHIEF'],
    'chief-1',
  );
  const transact = (producerSend.mock.calls[0]?.[0] as SentCommand).input as {
    TransactItems: Array<{ Put?: { Item: Record<string, unknown> } }>;
  };
  const outbox = transact.TransactItems.find(
    (item) => item.Put?.Item.entityType === 'OUTBOX_ENTRY',
  );
  if (!outbox?.Put) {
    throw new Error('updateMemberRoles wrote no OUTBOX_ENTRY');
  }
  return outbox.Put.Item;
}

async function drainToEventBridge(item: Record<string, unknown>) {
  const ebSend = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'eb-1' }] });
  const drain = createOutboxDrainHandler('platform-service', {
    eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
    ddbClient: { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient,
  });
  const streamEvent = {
    Records: [
      {
        eventName: 'INSERT',
        dynamodb: {
          SequenceNumber: '1',
          NewImage: marshall(item, { removeUndefinedValues: true }),
        },
      },
    ],
  } as unknown as DynamoDBStreamEvent;
  await drain(streamEvent, {} as never, () => undefined);
  expect(ebSend).toHaveBeenCalledOnce();
  const entries = (ebSend.mock.calls[0]?.[0] as SentCommand).input.Entries as Array<{
    Source: string;
    DetailType: string;
    Detail: string;
  }>;
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

describe('personnel.member.updated (roles) producer -> alerting consumer contract', () => {
  it('delivers roles to the alerting eligibility snapshot', async () => {
    const item = await produceOutboxItem();
    const entry = await drainToEventBridge(item);

    // The alerting rule matches on both (infrastructure alerting/push-tokens.ts).
    expect(entry.Source).toBe('personnel-service');
    expect(entry.DetailType).toBe('personnel.member.updated');

    const alertingSend = vi.fn().mockResolvedValue({});
    vi.doMock('../../alerting-service/eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send: alertingSend }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('../../alerting-service/eligibility/memberUpdatedHandler.js');
    const sqsEvent = {
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

    await expect(handler(sqsEvent)).resolves.toEqual({ batchItemFailures: [] });

    expect(alertingSend).toHaveBeenCalledOnce();
    const update = (alertingSend.mock.calls[0]?.[0] as SentCommand).input as {
      Key: Record<string, string>;
      UpdateExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
    expect(update.Key).toEqual({ pk: 'DEPT#NICHOLS#ELIGIBILITY', sk: 'MEMBER#mbr-7' });
    expect(update.UpdateExpression).toContain('roles = :roles');
    expect(update.ExpressionAttributeValues[':roles']).toEqual(['MEMBER', 'OFFICER', 'CHIEF']);
    // Roles are guarded by their own timestamp, not the snapshot-wide one.
    expect(update.ExpressionAttributeValues[':rolesUpdatedAt']).toBe(
      Date.parse(item.eventTime as string),
    );
  });
});
