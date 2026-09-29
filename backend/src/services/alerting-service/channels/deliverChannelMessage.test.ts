import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { DeliverChannelMessageParams } from './deliverChannelMessage.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

function fakeDdb(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

/**
 * One spy for every provider send: SMS/voice call the generic adapter directly, and push
 * (APNs/FCM) is forwarded onto the same spy as ('push', token, body, env, { isTest }) so the
 * send-guard tests below stay channel-agnostic.
 */
function mockAdapter(sendViaHttpProvider: ReturnType<typeof vi.fn>): void {
  vi.doMock('./httpProviderAdapter.js', () => ({ sendViaHttpProvider }));
  vi.doMock('./push/pushProviderAdapter.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./push/pushProviderAdapter.js')>()),
    sendPush: async (
      notification: { token: string; body: string },
      _platform: string,
      env: unknown,
      options: { isTest?: boolean },
    ) => {
      await sendViaHttpProvider('push', notification.token, notification.body, env, {
        isTest: options.isTest === true,
      });
      return { outcome: 'sent' as const };
    },
  }));
}

const baseParams: DeliverChannelMessageParams = {
  deptId,
  dispatchId: 'dispatch-1',
  memberId: 'mbr-1',
  channel: 'push',
  toneSequence: 1,
  contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }],
  message: 'structure-fire — 12 Main St',
  env: {},
};

afterEach(() => {
  vi.doUnmock('./httpProviderAdapter.js');
  vi.doUnmock('./push/pushProviderAdapter.js');
  vi.resetModules();
});

describe('deliverChannelMessage', () => {
  it('writes an immutable DELIVERY_RECEIPT keyed by dispatch/member/channel/tone, then sends via the adapter', async () => {
    const send = vi.fn().mockResolvedValue({});
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    mockAdapter(sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    // The claim, then SENT once the provider accepted it.
    expect(send).toHaveBeenCalledTimes(2);
    const putInput = (send.mock.calls[0]?.[0] as { input: { Item: Record<string, unknown> } })
      .input;
    expect(putInput.Item.sendState).toBe('CLAIMED');
    expect(
      (send.mock.calls[1]?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } })
        .input.ExpressionAttributeValues,
    ).toEqual({ ':sent': 'SENT' });
    expect(putInput.Item.pk).toBe('DEPT#NICHOLS#DISPATCH#dispatch-1');
    expect(putInput.Item.sk).toBe('RECEIPT#mbr-1#PUSH#1');
    expect(putInput.Item.idempotencyKey).toBe('dispatch-1#1#mbr-1#PUSH');
    expect(putInput.Item.gsi1pk).toBe('MEMBER#mbr-1');
    expect(putInput.Item.sentAt).toBeLessThan(10_000_000_000);
    expect(putInput.Item.gsi1sk).toBe(`RECEIPT#${putInput.Item.sentAt as number}#dispatch-1`);
    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'push',
      'tok-1',
      baseParams.message,
      baseParams.env,
      { isTest: false },
    );
  });

  it('no-ops without calling the provider when the idempotency key already exists for a prior successful attempt (duplicate skip)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'PutCommand') {
        return Promise.reject(
          new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
        );
      }
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { failureReason: null, deliveredAt: null } });
      }
      return Promise.resolve({});
    });
    const sendViaHttpProvider = vi.fn();
    mockAdapter(sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(sendViaHttpProvider).not.toHaveBeenCalled();
  });

  it('skips without a put when no target is registered for the channel', async () => {
    const send = vi.fn();
    const sendViaHttpProvider = vi.fn();
    mockAdapter(sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', {
      ...baseParams,
      contactChannels: [],
    });

    expect(send).not.toHaveBeenCalled();
    expect(sendViaHttpProvider).not.toHaveBeenCalled();
  });

  it('logs the original error, records failureReason on the claimed receipt, and rethrows when the provider adapter throws (no swallow, DLQ redrive takes over)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'UpdateCommand') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const sendViaHttpProvider = vi.fn().mockRejectedValue(new Error('push provider down'));
    mockAdapter(sendViaHttpProvider);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('push provider down');

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeDefined();
    const updateInput = (
      updateCall?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } }
    ).input;
    expect(updateInput.ExpressionAttributeValues[':reason']).toBe('push provider down');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('emits SendFailed under the Reason=<channel> dimension the infra delivery-failure alarm watches', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockAdapter(vi.fn().mockRejectedValue(new Error('push provider down')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('push provider down');

    // infrastructure/components/alerting/alarms.ts alarms on
    // Boxalarm/AlertingChannel SendFailed with dimensions { Reason: channel }.
    const emf = logSpy.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((entry) => entry !== undefined && 'SendFailed' in entry) as
      | {
          _aws: { CloudWatchMetrics: { Namespace: string; Dimensions: string[][] }[] };
          Reason: string;
        }
      | undefined;
    expect(emf).toBeDefined();
    expect(emf!._aws.CloudWatchMetrics[0]!.Namespace).toBe('Boxalarm/AlertingChannel');
    expect(emf!._aws.CloudWatchMetrics[0]!.Dimensions).toContainEqual(['Reason']);
    expect(emf!.Reason).toBe('push');
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('re-attempts the send on redelivery when the prior claim failed and was never delivered (P8 regression)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'PutCommand') {
        return Promise.reject(
          new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
        );
      }
      if (name === 'GetCommand') {
        return Promise.resolve({
          Item: { failureReason: 'push provider down', deliveredAt: null },
        });
      }
      return Promise.resolve({});
    });
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    mockAdapter(sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'push',
      'tok-1',
      baseParams.message,
      baseParams.env,
      { isTest: false },
    );
    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeDefined();
  });

  describe('a redelivery finding a claim with no failure recorded (review MINOR-R5)', () => {
    const now = () => Math.floor(Date.now() / 1000);

    function claimedGuard(existing: Record<string, unknown>, reclaim: 'ok' | 'lost' = 'ok') {
      return vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
        const name = command.constructor.name;
        if (name === 'PutCommand') {
          return Promise.reject(
            new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
          );
        }
        if (name === 'GetCommand') {
          return Promise.resolve({ Item: existing });
        }
        return reclaim === 'lost'
          ? Promise.reject(new ConditionalCheckFailedException({ message: 'lost', $metadata: {} }))
          : Promise.resolve({});
      });
    }

    it('retakes an abandoned claim (worker died mid-send) and sends', async () => {
      const abandonedAt = now() - 35;
      const send = claimedGuard({
        sendState: 'CLAIMED',
        sentAt: abandonedAt,
        failureReason: null,
        deliveredAt: null,
      });
      const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
      mockAdapter(sendViaHttpProvider);
      const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

      await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

      expect(sendViaHttpProvider).toHaveBeenCalledTimes(1);
      const get = send.mock.calls.find(
        (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'GetCommand',
      )?.[0] as { input: Record<string, unknown> };
      expect(get.input.ConsistentRead).toBe(true);
      const reclaim = send.mock.calls.find(
        (call) =>
          (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
      )?.[0] as { input: { ConditionExpression: string; ExpressionAttributeValues: object } };
      // Optimistic on the exact claim read, so only one of two redeliveries can take it.
      expect(reclaim.input.ConditionExpression).toContain('sentAt = :observedSentAt');
      expect(reclaim.input.ExpressionAttributeValues).toMatchObject({
        ':observedSentAt': abandonedAt,
      });
    });

    it.each([
      ['a fresh claim (a concurrent twin still sending)', { sendState: 'CLAIMED', sentAt: 0 }],
      ['a claim marked SENT', { sendState: 'SENT', sentAt: -100 }],
      ['a claim written before sendState existed', { sentAt: -100 }],
    ])('skips %s as a duplicate', async (_label, guard) => {
      const send = claimedGuard({
        ...guard,
        sentAt: now() + guard.sentAt,
        failureReason: null,
        deliveredAt: null,
      });
      const sendViaHttpProvider = vi.fn();
      mockAdapter(sendViaHttpProvider);
      const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

      await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

      expect(sendViaHttpProvider).not.toHaveBeenCalled();
    });

    it('a redelivery that loses the re-claim race does not send', async () => {
      const send = claimedGuard(
        { sendState: 'CLAIMED', sentAt: now() - 35, failureReason: null, deliveredAt: null },
        'lost',
      );
      const sendViaHttpProvider = vi.fn();
      mockAdapter(sendViaHttpProvider);
      const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

      await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

      expect(sendViaHttpProvider).not.toHaveBeenCalled();
    });
  });

  it('logs the original error and rethrows when the receipt write itself fails for a non-duplicate reason', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    const sendViaHttpProvider = vi.fn();
    mockAdapter(sendViaHttpProvider);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('DynamoDB unavailable');

    expect(sendViaHttpProvider).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('deliverChannelMessage — direct APNs/FCM push path', () => {
  type SendPushSpy = ReturnType<typeof vi.fn>;

  function mockPush(sendPush: SendPushSpy, sendViaHttpProvider = vi.fn()): void {
    vi.doMock('./httpProviderAdapter.js', () => ({ sendViaHttpProvider }));
    vi.doMock('./push/pushProviderAdapter.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./push/pushProviderAdapter.js')>()),
      sendPush,
    }));
  }

  function commandsNamed(send: ReturnType<typeof vi.fn>, name: string) {
    return send.mock.calls
      .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
      .filter((command) => command.constructor.name === name);
  }

  /** Guard claim succeeds; the eligibility snapshot read returns the given push entry. */
  function tableWithSnapshot(pushEntry: Record<string, unknown>) {
    return vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: { contactChannels: [pushEntry, { channel: 'sms', token: '+12035550100' }] },
        });
      }
      return Promise.resolve({});
    });
  }

  it('builds a critical dispatch push with a per-tone collapse key and the exactly-once idempotency key, routed by the registered platform', async () => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockPush(sendPush);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(vi.fn().mockResolvedValue({})), 'alerting-table', {
      ...baseParams,
      toneSequence: 2,
      title: 'structure-fire',
      contactChannels: [{ channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: true }],
    });

    expect(sendPush).toHaveBeenCalledWith(
      {
        token: 'tok-1',
        alertKind: 'dispatch',
        dispatchId: 'dispatch-1',
        toneSequence: 2,
        title: 'structure-fire',
        body: 'structure-fire — 12 Main St',
        idempotencyKey: 'dispatch-1#2#mbr-1#PUSH',
        collapseKey: 'dispatch-1#2',
      },
      'APNS',
      baseParams.env,
      { isTest: false },
    );
  });

  it('sends an Android (FCM) token via FCM', async () => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockPush(sendPush);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(vi.fn().mockResolvedValue({})), 'alerting-table', {
      ...baseParams,
      contactChannels: [{ channel: 'PUSH', platform: 'FCM', token: 'fcm-tok', valid: true }],
    });

    expect(sendPush.mock.calls[0]?.[1]).toBe('FCM');
  });

  it('sends the officer mutual-aid prompt as its own notification, with no toneSequence', async () => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockPush(sendPush);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(vi.fn().mockResolvedValue({})), 'alerting-table', {
      deptId,
      dispatchId: 'dispatch-1',
      memberId: 'officer-1',
      channel: 'push',
      alertKind: 'mutual_aid_prompt',
      title: 'MUTUAL AID REQUESTED',
      contactChannels: [{ channel: 'PUSH', token: 'tok-o', valid: true }],
      message: 'MUTUAL AID REQUESTED — structure-fire — 12 Main St',
      env: {},
    });

    expect(sendPush.mock.calls[0]?.[0]).toMatchObject({
      alertKind: 'mutual_aid_prompt',
      toneSequence: undefined,
      idempotencyKey: 'dispatch-1#MUTUALAID#officer-1#PUSH#SEND',
      collapseKey: 'dispatch-1#MUTUALAID',
    });
  });

  it('SMS stays on the generic vendor adapter and never touches APNs/FCM', async () => {
    const sendPush = vi.fn();
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    mockPush(sendPush, sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(vi.fn().mockResolvedValue({})), 'alerting-table', {
      ...baseParams,
      channel: 'sms',
      contactChannels: [{ channel: 'sms', token: '+12035550100' }],
    });

    expect(sendPush).not.toHaveBeenCalled();
    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'sms',
      '+12035550100',
      baseParams.message,
      baseParams.env,
      { isTest: false },
    );
  });

  it('a dead token is terminal: guard recorded FAILED, the contact entry marked invalid, nothing thrown (no redelivery)', async () => {
    const sendPush = vi
      .fn()
      .mockResolvedValue({ outcome: 'invalid_token', reason: 'APNS_BadDeviceToken' });
    mockPush(sendPush);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const send = tableWithSnapshot({
      channel: 'PUSH',
      platform: 'APNS',
      token: 'tok-1',
      valid: true,
    });
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).resolves.toBeUndefined();

    const updates = commandsNamed(send, 'UpdateCommand');
    const guardFailure = updates.find(
      (command) => (command.input.Key as { sk: string }).sk === 'RECEIPT#mbr-1#PUSH#1',
    );
    expect(guardFailure?.input.ExpressionAttributeValues).toEqual({
      ':reason': 'PUSH_TOKEN_INVALID APNS_BadDeviceToken',
      ':failed': 'FAILED',
    });
    // Never marked SENT.
    expect(
      updates.some(
        (command) =>
          (command.input.ExpressionAttributeValues as Record<string, unknown>)[':sent'] === 'SENT',
      ),
    ).toBe(false);
    const invalidation = updates.find(
      (command) => (command.input.Key as { sk: string }).sk === 'MEMBER#mbr-1',
    );
    expect(invalidation?.input.Key).toEqual({ pk: 'DEPT#NICHOLS#ELIGIBILITY', sk: 'MEMBER#mbr-1' });
    expect(
      (invalidation?.input.ExpressionAttributeValues as Record<string, unknown>)[
        ':contactChannels'
      ],
    ).toEqual([
      { channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: false },
      { channel: 'sms', token: '+12035550100' },
    ]);
    expect(logSpy.mock.calls.some(([line]) => String(line).includes('"TokenInvalid"'))).toBe(true);
    logSpy.mockRestore();
  });

  it('a self-test that hits a token rejection never invalidates the member’s real token', async () => {
    const sendPush = vi
      .fn()
      .mockResolvedValue({ outcome: 'invalid_token', reason: 'APNS_BadDeviceToken' });
    mockPush(sendPush);
    const send = tableWithSnapshot({ channel: 'PUSH', token: 'tok-1', valid: true });
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', { ...baseParams, isTest: true });

    expect(sendPush.mock.calls[0]?.[3]).toEqual({ isTest: true });
    const touchedSnapshot = [
      ...commandsNamed(send, 'UpdateCommand'),
      ...commandsNamed(send, 'GetCommand'),
    ].some((command) => (command.input.Key as { sk: string }).sk === 'MEMBER#mbr-1');
    expect(touchedSnapshot).toBe(false);
  });

  it('does not invalidate a token the member has since replaced', async () => {
    const sendPush = vi
      .fn()
      .mockResolvedValue({ outcome: 'invalid_token', reason: 'FCM_UNREGISTERED' });
    mockPush(sendPush);
    const send = tableWithSnapshot({ channel: 'PUSH', token: 'tok-new', valid: true });
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(
      commandsNamed(send, 'UpdateCommand').some(
        (command) => (command.input.Key as { sk: string }).sk === 'MEMBER#mbr-1',
      ),
    ).toBe(false);
  });

  it('a retryable provider error (429/5xx/timeout) is recorded FAILED and rethrown so SQS redelivers', async () => {
    const sendPush = vi.fn().mockRejectedValue(new Error('APNs responded 503 ServiceUnavailable'));
    mockPush(sendPush);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockResolvedValue({});
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('APNs responded 503');
    expect(commandsNamed(send, 'UpdateCommand')[0]?.input.ExpressionAttributeValues).toEqual({
      ':reason': 'APNs responded 503 ServiceUnavailable',
      ':failed': 'FAILED',
    });
    errorSpy.mockRestore();
  });
});
