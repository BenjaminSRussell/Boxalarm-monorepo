import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
  process.env.APNS_SECRET_ID = 'apns-secret';
  process.env.FCM_SECRET_ID = 'fcm-secret';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.doUnmock('../httpProviderAdapter.js');
  vi.doUnmock('./pushProviderAdapter.js');
  vi.doUnmock('../../eligibility/dynamoClient.js');
});

function sqsEvent(channel: string, memberId = 'mbr-1', isTest = false): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          eventId: 'evt-1',
          eventTime: '2026-09-06T00:00:00Z',
          eventType: 'alerting.dispatch.normalized',
          source: 'alert-fanout-service',
          correlationId: 'dispatch-1',
          schemaVersion: '1.0',
          payload: {
            deptId: 'NICHOLS',
            dispatchId: 'dispatch-1',
            memberId,
            channel,
            channelTier: 'primary',
            toneSequence: 1,
            isTest,
            incidentType: 'structure-fire',
            address: '12 Main St',
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

function mockDeps(sendPush: ReturnType<typeof vi.fn>, send: ReturnType<typeof vi.fn>): void {
  // The push worker must reach APNs/FCM directly; the generic adapter throws if it is used.
  vi.doMock('../httpProviderAdapter.js', () => ({
    sendPush: vi.fn().mockRejectedValue(new Error('push must not use the HTTP adapter')),
  }));
  vi.doMock('./pushProviderAdapter.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./pushProviderAdapter.js')>()),
    sendPush,
  }));
  vi.doMock('../../eligibility/dynamoClient.js', () => ({
    createDynamoClient: () => ({ send }),
    readAlertingConfig: () => ({ tableName: 'alerting-table' }),
  }));
}

/** The dispatch push the worker builds from the fixture envelope for token tok-1. */
function expectedPush(isTest: boolean): [unknown, string, NodeJS.ProcessEnv, object] {
  const notification: unknown = expect.objectContaining({
    token: 'tok-1',
    alertKind: 'dispatch',
    dispatchId: 'dispatch-1',
    toneSequence: 1,
    title: 'structure-fire',
    body: 'structure-fire — 12 Main St',
    idempotencyKey: 'dispatch-1#1#mbr-1#PUSH',
    collapseKey: 'dispatch-1#1',
  });
  return [notification, 'FCM', process.env, { isTest }];
}

describe('push channel worker (entrypoint-test obligation)', () => {
  it('reports a malformed record as a batch item failure and never calls the provider', async () => {
    const sendPush = vi.fn();
    const send = vi.fn();
    mockDeps(sendPush, send);
    const { handler } = await import('./worker.js');

    const result = await handler({
      Records: [{ messageId: 'msg-1', body: 'not-json' }],
    } as unknown as SQSEvent);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-1' }]);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('reports only the poisoned record as a batch item failure in a mixed batch, leaving the valid record delivered', async () => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: { contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }] },
        });
      }
      return Promise.resolve({});
    });
    mockDeps(sendPush, send);
    const { handler } = await import('./worker.js');

    const goodEvent = sqsEvent('push');
    const mixedEvent: SQSEvent = {
      Records: [{ messageId: 'msg-poison', body: 'not-json' }, ...goodEvent.Records],
    } as unknown as SQSEvent;

    const result = await handler(mixedEvent);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-poison' }]);
    expect(sendPush).toHaveBeenCalledWith(...expectedPush(false));
  });

  it('sends a self-test/canary message (isTest=true, as fan-out stamps it) with the sandbox credentials', async () => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: { contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }] },
        });
      }
      return Promise.resolve({});
    });
    mockDeps(sendPush, send);
    const { handler } = await import('./worker.js');

    const result = await handler(sqsEvent('push', 'mbr-1', true));

    expect(result.batchItemFailures).toEqual([]);
    expect(sendPush).toHaveBeenCalledWith(...expectedPush(true));
  });

  it('reports a batch item failure for an envelope routed to this worker carrying a different channel', async () => {
    const sendPush = vi.fn();
    const send = vi.fn();
    mockDeps(sendPush, send);
    const { handler } = await import('./worker.js');

    const result = await handler(sqsEvent('sms'));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-1' }]);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('resolves the target from the eligibility snapshot and sends via the push provider on the happy path', async () => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: { contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }] },
        });
      }
      return Promise.resolve({});
    });
    mockDeps(sendPush, send);
    const { handler } = await import('./worker.js');

    const result = await handler(sqsEvent('push'));

    expect(result.batchItemFailures).toEqual([]);
    expect(sendPush).toHaveBeenCalledWith(...expectedPush(false));
  });

  it('logs a structured entry with correlationId/memberId/channel and reports a batch item failure when the eligibility read fails', async () => {
    const sendPush = vi.fn();
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.reject(new Error('DynamoDB throttled'));
      }
      return Promise.resolve({});
    });
    mockDeps(sendPush, send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./worker.js');

    const result = await handler(sqsEvent('push'));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-1' }]);
    expect(sendPush).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('alerting.channel.eligibility_read_failed'),
    );
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.correlationId).toBe('dispatch-1');
    expect(logged.memberId).toBe('mbr-1');
    expect(logged.channel).toBe('push');
    errorSpy.mockRestore();
  });
});
