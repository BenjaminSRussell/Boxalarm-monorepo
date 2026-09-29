import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.doUnmock('../dynamoClient.js');
  vi.doUnmock('../channelSender.js');
});

function mockDdb(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
}

function mockChannelSender(
  sendPushDigest: ReturnType<typeof vi.fn>,
  sendEmailDigest: ReturnType<typeof vi.fn>,
): void {
  vi.doMock('../channelSender.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../channelSender.js')>();
    return { ...actual, sendPushDigest, sendEmailDigest };
  });
}

interface CommandLike {
  constructor: { name: string };
  input: Record<string, unknown>;
}

function pendingItem(recipientType: 'MEMBER' | 'ROLE', recipientId: string, certId: string) {
  return { recipientType, recipientId, certId, expiryDate: '2027-01-10' };
}

function keySk(command: CommandLike): string | undefined {
  return (command.input.Key as { sk?: string } | undefined)?.sk;
}

describe('digestJob handler (entrypoint-test obligation)', () => {
  it('rethrows on a malformed payload, never silently no-oping', async () => {
    const send = vi.fn();
    mockDdb(send);
    const { handler } = await import('./digestJob.js');

    await expect(handler({})).rejects.toThrow('digest job payload failed shape validation');
    expect(send).not.toHaveBeenCalled();
  });

  it('no-ops with zero sends when there are no pending items for today', async () => {
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        return Promise.resolve({ Items: [] });
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn();
    const sendEmailDigest = vi.fn();
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    const result = await handler({ deptId: 'NICHOLS' });

    expect(result).toEqual({ processed: 0 });
    expect(sendPushDigest).not.toHaveBeenCalled();
    expect(sendEmailDigest).not.toHaveBeenCalled();
  });

  it('rethrows (fail-closed, zero sends) when the DynamoDB query is unavailable', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    mockDdb(send);
    const sendPushDigest = vi.fn();
    const sendEmailDigest = vi.fn();
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./digestJob.js');

    await expect(handler({ deptId: 'NICHOLS' })).rejects.toThrow('DynamoDB unavailable');
    expect(sendPushDigest).not.toHaveBeenCalled();
    expect(sendEmailDigest).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('paginates the DIGEST_PENDING query across multiple pages rather than dropping the tail (P2)', async () => {
    let queryCalls = 0;
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        queryCalls += 1;
        if (queryCalls === 1) {
          return Promise.resolve({
            Items: [pendingItem('MEMBER', 'MBR-1', 'CERT-1')],
            LastEvaluatedKey: { pk: 'p', sk: 's' },
          });
        }
        return Promise.resolve({ Items: [pendingItem('MEMBER', 'MBR-2', 'CERT-2')] });
      }
      if (command.constructor.name === 'GetCommand') {
        const sk = keySk(command);
        if (sk === 'METADATA') {
          return Promise.resolve({ Item: { email: 'mbr@example.com' } });
        }
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn().mockResolvedValue(undefined);
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    const result = await handler({ deptId: 'NICHOLS' });

    expect(queryCalls).toBe(2);
    expect(result).toEqual({ processed: 2 });
    expect(sendPushDigest).toHaveBeenCalledTimes(2);
  });

  it('AC1: N cert.expiry.due items for one member on one day collapse into exactly 1 push + 1 email, not N', async () => {
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({
            Items: [
              pendingItem('MEMBER', 'MBR-1', 'CERT-1'),
              pendingItem('MEMBER', 'MBR-1', 'CERT-2'),
              pendingItem('MEMBER', 'MBR-1', 'CERT-3'),
            ],
          });
        }
        return Promise.resolve({ Items: [] });
      }
      if (command.constructor.name === 'GetCommand') {
        const sk = keySk(command);
        if (sk === 'METADATA') {
          return Promise.resolve({ Item: { email: 'mbr1@example.com' } });
        }
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn().mockResolvedValue(undefined);
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    const result = await handler({ deptId: 'NICHOLS' });

    expect(result).toEqual({ processed: 1 });
    expect(sendPushDigest).toHaveBeenCalledTimes(1);
    expect(sendEmailDigest).toHaveBeenCalledTimes(1);
    const items = sendPushDigest.mock.calls[0]?.[2] as unknown[];
    expect(items).toHaveLength(3);
  });

  it('AC4: a member with both channels muted gets zero push/email but the NOTIFICATION item is still written', async () => {
    const putItems: Record<string, unknown>[] = [];
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({ Items: [pendingItem('MEMBER', 'MBR-1', 'CERT-1')] });
        }
        return Promise.resolve({ Items: [] });
      }
      if (command.constructor.name === 'GetCommand') {
        const sk = keySk(command);
        if (sk === 'METADATA') {
          return Promise.resolve({ Item: { email: 'mbr1@example.com' } });
        }
        if (sk?.startsWith('NOTIFPREF#')) {
          return Promise.resolve({
            Item: {
              memberId: 'MBR-1',
              category: 'cert-expiry',
              channels: { push: true, email: true },
              updatedAt: 1,
            },
          });
        }
        return Promise.resolve({ Item: undefined });
      }
      if (command.constructor.name === 'PutCommand') {
        putItems.push(command.input.Item as Record<string, unknown>);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn().mockResolvedValue(undefined);
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    await handler({ deptId: 'NICHOLS' });

    expect(sendPushDigest).not.toHaveBeenCalled();
    expect(sendEmailDigest).not.toHaveBeenCalled();
    const notificationPut = putItems.find((item) => item.entityType === 'NOTIFICATION');
    expect(notificationPut).toBeDefined();
  });

  it('a member who mutes only push still receives the email digest (P13 — mute is per channel)', async () => {
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({ Items: [pendingItem('MEMBER', 'MBR-1', 'CERT-1')] });
        }
        return Promise.resolve({ Items: [] });
      }
      if (command.constructor.name === 'GetCommand') {
        const sk = keySk(command);
        if (sk === 'METADATA') {
          return Promise.resolve({ Item: { email: 'mbr1@example.com' } });
        }
        if (sk?.startsWith('NOTIFPREF#')) {
          return Promise.resolve({
            Item: {
              memberId: 'MBR-1',
              category: 'cert-expiry',
              channels: { push: true, email: false },
              updatedAt: 1,
            },
          });
        }
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn().mockResolvedValue(undefined);
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    await handler({ deptId: 'NICHOLS' });

    expect(sendPushDigest).not.toHaveBeenCalled();
    expect(sendEmailDigest).toHaveBeenCalledTimes(1);
  });

  it('AC2: the training officer digest is delivered unconditionally, never gated on the member preference path', async () => {
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({ Items: [pendingItem('ROLE', 'TRAINING', 'CERT-1')] });
        }
        return Promise.resolve({
          Items: [
            { memberId: 'OFFICER-1', roles: ['MEMBER', 'TRAINING'], email: 'officer1@example.com' },
          ],
        });
      }
      if (command.constructor.name === 'GetCommand') {
        const sk = keySk(command);
        if (sk?.startsWith('NOTIFPREF#')) {
          throw new Error('preference should never be read on the officer path');
        }
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn().mockResolvedValue(undefined);
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    const result = await handler({ deptId: 'NICHOLS' });

    expect(result).toEqual({ processed: 1 });
    expect(sendPushDigest).toHaveBeenCalledTimes(1);
    expect(sendEmailDigest).toHaveBeenCalledTimes(1);
    expect(sendPushDigest.mock.calls[0]?.[1]).toEqual({
      memberId: 'OFFICER-1',
      email: 'officer1@example.com',
    });
  });

  it('skips a recipient whose digest was already sent today (guard-check idempotency)', async () => {
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({ Items: [pendingItem('MEMBER', 'MBR-1', 'CERT-1')] });
        }
        return Promise.resolve({ Items: [] });
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const error = Object.assign(new Error('conditional check failed'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        });
        return Promise.reject(error);
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn();
    const sendEmailDigest = vi.fn();
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    await handler({ deptId: 'NICHOLS' });

    expect(sendPushDigest).not.toHaveBeenCalled();
    expect(sendEmailDigest).not.toHaveBeenCalled();
  });

  it('claims the DIGESTSENT slot atomically so two overlapping invocations never double-send the same member (V4/P2 TOCTOU fix)', async () => {
    const table = new Map<string, Record<string, unknown>>();
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({ Items: [pendingItem('MEMBER', 'MBR-1', 'CERT-1')] });
        }
        return Promise.resolve({ Items: [] });
      }
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { pk: string; sk: string };
        const item = table.get(`${key.pk}#${key.sk}`);
        return Promise.resolve({ Item: item });
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const items = command.input.TransactItems as {
          Put: { Item: { pk: string; sk: string }; ConditionExpression?: string };
        }[];
        for (const { Put } of items) {
          const key = `${Put.Item.pk}#${Put.Item.sk}`;
          if (Put.ConditionExpression === 'attribute_not_exists(sk)' && table.has(key)) {
            const error = Object.assign(new Error('conditional check failed'), {
              name: 'TransactionCanceledException',
              CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
            });
            return Promise.reject(error);
          }
        }
        for (const { Put } of items) {
          table.set(`${Put.Item.pk}#${Put.Item.sk}`, Put.Item);
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn().mockResolvedValue(undefined);
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    await Promise.all([handler({ deptId: 'NICHOLS' }), handler({ deptId: 'NICHOLS' })]);

    expect(sendPushDigest).toHaveBeenCalledTimes(1);
    expect(sendEmailDigest).toHaveBeenCalledTimes(1);
  });

  it('isolates a recipient whose roster-query fails, logs it, and still processes the next group (P5/V6)', async () => {
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({
            Items: [
              pendingItem('ROLE', 'TRAINING', 'CERT-1'),
              pendingItem('MEMBER', 'MBR-1', 'CERT-2'),
            ],
          });
        }
        if (gsi3pk[':gsi3pk'].includes('MEMBER')) {
          return Promise.reject(new Error('roster query unavailable'));
        }
        return Promise.resolve({ Items: [] });
      }
      if (command.constructor.name === 'GetCommand') {
        const sk = keySk(command);
        if (sk === 'METADATA') {
          return Promise.resolve({ Item: { email: 'mbr1@example.com' } });
        }
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn().mockResolvedValue(undefined);
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./digestJob.js');

    // The other group is still sent, then the run fails so Scheduler retries (review minor 2).
    await expect(handler({ deptId: 'NICHOLS' })).rejects.toThrow(
      'digest failed for 1 recipient(s); 1 sent',
    );
    expect(sendPushDigest).toHaveBeenCalledTimes(1);
    expect(
      errorSpy.mock.calls.some((call) =>
        (call[0] as string).includes('notification.digest.recipient_failed'),
      ),
    ).toBe(true);
    errorSpy.mockRestore();
  });

  it('isolates a recipient whose channel send fails, logs it, and still processes the next recipient (P5/P6/P12)', async () => {
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({
            Items: [
              pendingItem('MEMBER', 'MBR-FAIL', 'CERT-1'),
              pendingItem('MEMBER', 'MBR-OK', 'CERT-2'),
            ],
          });
        }
        return Promise.resolve({ Items: [] });
      }
      if (command.constructor.name === 'GetCommand') {
        const sk = keySk(command);
        if (sk === 'METADATA') {
          return Promise.resolve({ Item: { email: 'mbr@example.com' } });
        }
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi
      .fn()
      .mockImplementation((_env: unknown, recipient: { memberId: string }) => {
        if (recipient.memberId === 'MBR-FAIL') {
          return Promise.reject(new Error('SNS throttled'));
        }
        return Promise.resolve(undefined);
      });
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./digestJob.js');

    await expect(handler({ deptId: 'NICHOLS' })).rejects.toThrow(
      'digest failed for 1 recipient(s); 1 sent',
    );
    expect(sendPushDigest).toHaveBeenCalledTimes(2);
    expect(sendEmailDigest).toHaveBeenCalledTimes(1);
    expect(
      errorSpy.mock.calls.some((call) =>
        (call[0] as string).includes('notification.digest.send_failed'),
      ),
    ).toBe(true);
    expect(
      errorSpy.mock.calls.some((call) =>
        (call[0] as string).includes('notification.digest.recipient_failed'),
      ),
    ).toBe(true);
    errorSpy.mockRestore();
  });

  it('a Scheduler retry after a partial failure sends only the member who failed (review minor 2)', async () => {
    const table = new Map<string, Record<string, unknown>>();
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        return Promise.resolve({
          Items: [
            pendingItem('MEMBER', 'MBR-FAIL', 'CERT-1'),
            pendingItem('MEMBER', 'MBR-OK', 'CERT-2'),
          ],
        });
      }
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: keySk(command) === 'METADATA' ? { email: 'm@example.com' } : undefined,
        });
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const put = (
          command.input.TransactItems as { Put: { Item: { pk: string; sk: string } } }[]
        )[0]!.Put;
        const key = `${put.Item.pk}#${put.Item.sk}`;
        if (table.has(key)) {
          return Promise.reject(
            Object.assign(new Error('exists'), {
              name: 'TransactionCanceledException',
              CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
            }),
          );
        }
        table.set(key, put.Item);
        return Promise.resolve({});
      }
      if (command.constructor.name === 'DeleteCommand') {
        const key = command.input.Key as { pk: string; sk: string };
        table.delete(`${key.pk}#${key.sk}`);
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    let failOnce = true;
    const sendPushDigest = vi.fn().mockImplementation((_env: unknown, r: { memberId: string }) => {
      if (r.memberId === 'MBR-FAIL' && failOnce) {
        failOnce = false;
        return Promise.reject(new Error('SNS throttled'));
      }
      return Promise.resolve(undefined);
    });
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./digestJob.js');

    await expect(handler({ deptId: 'NICHOLS' })).rejects.toThrow();
    // The retry succeeds; MBR-OK's DIGESTSENT claim makes it a no-op for them.
    await expect(handler({ deptId: 'NICHOLS' })).resolves.toBeDefined();

    expect(
      sendPushDigest.mock.calls.map((call) => (call[1] as { memberId: string }).memberId),
    ).toEqual(['MBR-FAIL', 'MBR-OK', 'MBR-FAIL']);
  });
});
