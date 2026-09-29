import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { DeliverChannelMessageParams } from './deliverChannelMessage.js';

const TABLE_NAME = 'alerting-channels-test';

vi.mock('./push/pushProviderAdapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./push/pushProviderAdapter.js')>()),
  sendPush: vi.fn().mockResolvedValue({ outcome: 'sent' }),
}));

describe('deliverChannelMessage receipt write (real DynamoDB, exactly-once idempotency)', () => {
  let container: StartedLocalStackContainer;
  let client: DynamoDBDocumentClient;

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:4').start();
    const base = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await base.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    client = DynamoDBDocumentClient.from(base);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
  const baseParams: DeliverChannelMessageParams = {
    deptId,
    dispatchId: 'dispatch-ls-1',
    memberId: 'mbr-ls-1',
    channel: 'push',
    toneSequence: 1,
    contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }],
    message: 'structure-fire — 12 Main St',
    env: {},
  };

  it('claims the receipt with the real ConditionExpression and rejects a redelivered duplicate as a no-op', async () => {
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(client, TABLE_NAME, baseParams);
    await deliverChannelMessage(client, TABLE_NAME, baseParams);

    const item = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: 'DEPT#NICHOLS#DISPATCH#dispatch-ls-1', sk: 'RECEIPT#mbr-ls-1#PUSH#1' },
      }),
    );

    expect(item.Item).toMatchObject({
      entityType: 'DELIVERY_RECEIPT',
      idempotencyKey: 'dispatch-ls-1#1#mbr-ls-1#PUSH',
      deliveredAt: null,
      failureReason: null,
    });
    expect(item.Item?.sentAt).toBeLessThan(10_000_000_000);
  });

  it('recovers a claimed-but-failed receipt on redelivery against the real ConditionExpression', async () => {
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');
    const { sendPush } = await import('./push/pushProviderAdapter.js');
    const send = vi.mocked(sendPush);
    send.mockClear();

    const params: DeliverChannelMessageParams = {
      ...baseParams,
      dispatchId: 'dispatch-ls-2',
      memberId: 'mbr-ls-2',
    };

    send.mockRejectedValueOnce(new Error('provider 503'));
    await expect(deliverChannelMessage(client, TABLE_NAME, params)).rejects.toThrow('provider 503');

    send.mockResolvedValueOnce({ outcome: 'sent' });
    await deliverChannelMessage(client, TABLE_NAME, params);

    const item = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: 'DEPT#NICHOLS#DISPATCH#dispatch-ls-2', sk: 'RECEIPT#mbr-ls-2#PUSH#1' },
      }),
    );

    expect(item.Item?.failureReason).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
