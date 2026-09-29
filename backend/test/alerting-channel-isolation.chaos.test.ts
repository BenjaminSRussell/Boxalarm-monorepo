import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
  process.env.APNS_SECRET_ID = 'apns-secret';
  process.env.FCM_SECRET_ID = 'fcm-secret';
  process.env.SMS_PROVIDER_ENDPOINT_URL = 'https://sms.example';
  process.env.SMS_PROVIDER_SECRET_ID = 'sms-secret';
  process.env.VOICE_PROVIDER_ENDPOINT_URL = 'https://voice.example';
  process.env.VOICE_PROVIDER_SECRET_ID = 'voice-secret';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function dispatchEvent(channel: string, memberId = 'mbr-1'): SQSEvent {
  return {
    Records: [
      {
        messageId: `msg-${channel}`,
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
            channelTier: channel === 'voice' ? 'escalation' : 'primary',
            toneSequence: 1,
            incidentType: 'structure-fire',
            address: '12 Main St',
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

const CONTACT_CHANNELS = [
  { channel: 'PUSH', token: 'push-token', valid: true },
  { channel: 'SMS', phoneNumber: '+12035550100', valid: true },
  { channel: 'VOICE', phoneNumber: '+12035550100', valid: true },
];

function mockDeps(sendFor: Record<string, () => Promise<void>>): {
  sendMock: ReturnType<typeof vi.fn>;
  pushMock: ReturnType<typeof vi.fn>;
  ddbSendMock: ReturnType<typeof vi.fn>;
} {
  const ddbSendMock = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'GetCommand') {
      return Promise.resolve({ Item: { contactChannels: CONTACT_CHANNELS } });
    }
    return Promise.resolve({});
  });
  vi.doMock(
    '../src/services/alerting-service/eligibility/dynamoClient.js',
    async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import('../src/services/alerting-service/eligibility/dynamoClient.js')
        >();
      return { ...actual, createDynamoClient: () => ({ send: ddbSendMock }) };
    },
  );
  // SMS and voice reach the generic vendor adapter; push reaches the APNs/FCM gateway. Each is
  // its own spy, fault-injected through the same per-channel switch.
  const sendMock = vi.fn().mockImplementation((channel: string) => {
    const impl = sendFor[channel];
    return impl ? impl() : Promise.resolve(undefined);
  });
  vi.doMock('../src/services/alerting-service/channels/httpProviderAdapter.js', () => ({
    sendViaHttpProvider: sendMock,
  }));
  const pushMock = vi.fn().mockImplementation(async () => {
    const impl = sendFor.push;
    if (impl) await impl();
    return { outcome: 'sent' as const };
  });
  vi.doMock(
    '../src/services/alerting-service/channels/push/pushProviderAdapter.js',
    async (importOriginal) => ({
      ...(await importOriginal<
        typeof import('../src/services/alerting-service/channels/push/pushProviderAdapter.js')
      >()),
      sendPush: pushMock,
    }),
  );
  return { sendMock, pushMock, ddbSendMock };
}

function putCallsFor(ddbSendMock: ReturnType<typeof vi.fn>): number {
  return ddbSendMock.mock.calls.filter(
    (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'PutCommand',
  ).length;
}

describe('channel failure-domain isolation and no-SPOF chaos verification (E1-S11)', () => {
  it('push fault-injected to fail 100% does not affect sms delivery for the same dispatch (AC1)', async () => {
    const { sendMock, pushMock, ddbSendMock } = mockDeps({
      push: () => Promise.reject(new Error('push provider down')),
    });
    const { handler: pushHandler } =
      await import('../src/services/alerting-service/channels/push/worker.js');
    const { handler: smsHandler } =
      await import('../src/services/alerting-service/channels/sms/worker.js');

    await expect(pushHandler(dispatchEvent('push'))).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-push' }],
    });
    await expect(smsHandler(dispatchEvent('sms'))).resolves.toEqual({ batchItemFailures: [] });

    // The push attempt reached the APNs/FCM gateway (and failed there), not the SMS adapter.
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      'sms',
      '+12035550100',
      expect.any(String),
      expect.anything(),
      { isTest: false },
    );
    expect(putCallsFor(ddbSendMock)).toBe(2);
  });

  it('sms provider saturation/errors do not affect push or voice delivery (AC2 — independent queue/DLQ per channel)', async () => {
    const { sendMock, pushMock, ddbSendMock } = mockDeps({
      sms: () => Promise.reject(new Error('sms provider saturated')),
    });
    const { handler: pushHandler } =
      await import('../src/services/alerting-service/channels/push/worker.js');
    const { handler: smsHandler } =
      await import('../src/services/alerting-service/channels/sms/worker.js');
    const { handler: voiceHandler } =
      await import('../src/services/alerting-service/channels/voice/worker.js');

    await expect(smsHandler(dispatchEvent('sms'))).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-sms' }],
    });
    await expect(pushHandler(dispatchEvent('push'))).resolves.toEqual({ batchItemFailures: [] });
    await expect(voiceHandler(dispatchEvent('voice'))).resolves.toEqual({ batchItemFailures: [] });

    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'push-token', alertKind: 'dispatch', toneSequence: 1 }),
      'FCM',
      expect.anything(),
      { isTest: false },
    );
    expect(sendMock).not.toHaveBeenCalledWith(
      'push',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(sendMock).toHaveBeenCalledWith(
      'voice',
      '+12035550100',
      expect.any(String),
      expect.anything(),
      { isTest: false },
    );
    expect(putCallsFor(ddbSendMock)).toBe(3);
  });

  it('one channel provider removed entirely still lets delivery complete via a remaining channel (AC3 — no SPOF at the channel layer)', async () => {
    const { sendMock, pushMock, ddbSendMock } = mockDeps({
      voice: () => Promise.reject(new Error('ENOTFOUND voice.example')),
    });
    const { handler: pushHandler } =
      await import('../src/services/alerting-service/channels/push/worker.js');
    const { handler: voiceHandler } =
      await import('../src/services/alerting-service/channels/voice/worker.js');

    await expect(voiceHandler(dispatchEvent('voice'))).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-voice' }],
    });
    await expect(pushHandler(dispatchEvent('push'))).resolves.toEqual({ batchItemFailures: [] });

    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'push-token', alertKind: 'dispatch', toneSequence: 1 }),
      'FCM',
      expect.anything(),
      { isTest: false },
    );
    expect(sendMock).not.toHaveBeenCalledWith(
      'push',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(putCallsFor(ddbSendMock)).toBe(2);
  });
});
