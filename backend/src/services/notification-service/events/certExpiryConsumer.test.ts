import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function sqsEvent(payload: Record<string, unknown>, messageId = 'msg-1'): SQSEvent {
  return {
    Records: [
      {
        messageId,
        // What an EventBridge rule -> SQS target delivers: the event, envelope under detail.
        body: JSON.stringify({
          version: '0',
          id: 'eb-1',
          'detail-type': 'cert.expiry.due',
          source: 'training-service',
          detail: {
            eventId: 'evt-1',
            eventTime: '2026-09-15T00:00:00Z',
            eventType: 'cert.expiry.due',
            source: 'training-service',
            correlationId: 'CERT-1',
            schemaVersion: '1.0',
            payload,
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

function mockDdb(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
}

describe('certExpiryConsumer (entrypoint-test obligation)', () => {
  it('writes a member PENDING item and a role PENDING item in one transact (AC1/AC2 setup)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./certExpiryConsumer.js');

    await handler(
      sqsEvent({
        deptId: 'NICHOLS',
        memberId: 'MBR-1',
        certId: 'CERT-1',
        expiryDate: '2027-01-10',
      }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]?.[0] as {
      input: { TransactItems: { Put?: { Item: Record<string, unknown> } }[] };
    };
    const items = call.input.TransactItems.map((item) => item.Put?.Item);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipientType: 'MEMBER', recipientId: 'MBR-1' }),
        expect.objectContaining({ recipientType: 'ROLE', recipientId: 'TRAINING' }),
      ]),
    );
  });

  it('no-ops on a duplicate cert.expiry.due delivery for the same member/certId/day', async () => {
    const dedupConflict = Object.assign(new Error('dup'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi.fn().mockRejectedValueOnce(dedupConflict);
    mockDdb(send);
    const { handler } = await import('./certExpiryConsumer.js');

    await handler(
      sqsEvent({
        deptId: 'NICHOLS',
        memberId: 'MBR-1',
        certId: 'CERT-1',
        expiryDate: '2027-01-10',
      }),
    );

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rethrows on a malformed event body, never silently dropping the message', async () => {
    const send = vi.fn();
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./certExpiryConsumer.js');

    await expect(handler(sqsEvent({ deptId: 'NICHOLS' }))).rejects.toThrow(
      'cert.expiry.due event failed shape validation',
    );
    expect(send).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('logs the original error and rethrows on a genuine (non-conditional) write failure', async () => {
    const failure = Object.assign(new Error('boom'), { name: 'TransactionCanceledException' });
    const send = vi.fn().mockRejectedValueOnce(failure);
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./certExpiryConsumer.js');

    await expect(
      handler(
        sqsEvent({
          deptId: 'NICHOLS',
          memberId: 'MBR-1',
          certId: 'CERT-1',
          expiryDate: '2027-01-10',
        }),
      ),
    ).rejects.toThrow('boom');
    expect(errorSpy.mock.calls[0]?.[0] as string).toContain('boom');
    errorSpy.mockRestore();
  });

  it('rejects a bare (un-wrapped) envelope instead of reading it as if it were the event', async () => {
    const send = vi.fn();
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./certExpiryConsumer.js');

    const bare = {
      Records: [
        {
          messageId: 'msg-2',
          body: JSON.stringify({
            eventId: 'evt-1',
            eventType: 'cert.expiry.due',
            payload: {
              deptId: 'NICHOLS',
              memberId: 'MBR-1',
              certId: 'CERT-1',
              expiryDate: '2027-01-10',
            },
          }),
        },
      ],
    } as unknown as SQSEvent;

    await expect(handler(bare)).rejects.toThrow('cert.expiry.due event failed shape validation');
    expect(send).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('accepts the exact detail training-service publishes (producer/consumer contract)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./certExpiryConsumer.js');

    // Mirrors publishDueEvents.ts's Detail, including leadDays, which this consumer ignores.
    await handler(
      sqsEvent({
        deptId: 'NICHOLS',
        memberId: 'MBR-0034',
        certId: 'CERT-0091',
        expiryDate: '2026-10-14',
        leadDays: 30,
      }),
    );

    const call = send.mock.calls[0]?.[0] as {
      input: { TransactItems: { Put?: { Item: Record<string, unknown> } }[] };
    };
    expect(call.input.TransactItems[0]?.Put?.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#MEMBER#MBR-0034',
      certId: 'CERT-0091',
    });
  });

  it('records the eventId in the same transaction, so a redelivery is refused even on a later day', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./certExpiryConsumer.js');

    await handler(
      sqsEvent({
        deptId: 'NICHOLS',
        memberId: 'MBR-1',
        certId: 'CERT-1',
        expiryDate: '2027-01-10',
      }),
    );

    const call = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: { Put: { Item: Record<string, unknown>; ConditionExpression: string } }[];
      };
    };
    const marker = call.input.TransactItems.find((t) => t.Put.Item.sk === 'SEEN');
    expect(marker?.Put.Item.pk).toBe('DEPT#NICHOLS#NOTIF_EVENT#evt-1');
    for (const t of call.input.TransactItems) {
      expect(t.Put.ConditionExpression).toBe('attribute_not_exists(sk)');
    }
  });
});
