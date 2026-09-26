import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { publishDueEvent } from './publishDueEvents.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const env = {
  TRAINING_DYNAMO_TABLE_NAME: 'platform-service',
  PLATFORM_EVENT_BUS_NAME: 'boxalarm-test-platform-bus',
};

function fakeDdb(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function fakeEb(send: ReturnType<typeof vi.fn>): EventBridgeClient {
  return { send } as unknown as EventBridgeClient;
}

const baseParams = {
  deptId,
  memberId: 'MBR-0034',
  certId: 'CERT-0091',
  expiryDate: '2026-10-14',
  leadDays: 30,
  correlationId: 'trace-1',
  now: new Date('2026-09-14T12:00:00Z'),
};

describe('publishDueEvent', () => {
  it('writes the dedup marker, publishes exactly one well-formed cert.expiry.due event, then marks it published (AC2, contract)', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'evt-1' }] });
    const ddb = fakeDdb(ddbSend);
    const eb = fakeEb(ebSend);

    const outcome = await publishDueEvent(ddb, eb, env, baseParams);

    expect(outcome).toBe('Published');
    expect(ddbSend).toHaveBeenCalledTimes(2);
    const putCommand = ddbSend.mock.calls[0]?.[0] as PutCommand;
    expect(putCommand).toBeInstanceOf(PutCommand);
    expect(putCommand.input.ConditionExpression).toBe(
      'attribute_not_exists(pk) OR attribute_not_exists(publishedAt)',
    );
    expect(putCommand.input.Item?.pk).toBe('DEPT#NICHOLS#CERT_EXPIRY_FLAG#2026-09-14');
    expect(putCommand.input.Item?.sk).toBe('CERT#CERT-0091');
    expect(putCommand.input.Item?.publishedAt).toBeUndefined();

    const updateCommand = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCommand).toBeInstanceOf(UpdateCommand);
    expect(updateCommand.input.Key).toEqual({
      pk: 'DEPT#NICHOLS#CERT_EXPIRY_FLAG#2026-09-14',
      sk: 'CERT#CERT-0091',
    });
    expect(updateCommand.input.ConditionExpression).toBe('attribute_exists(pk)');

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putEvents).toBeInstanceOf(PutEventsCommand);
    const entry = putEvents.input.Entries?.[0];
    expect(entry?.EventBusName).toBe('boxalarm-test-platform-bus');
    expect(entry?.DetailType).toBe('cert.expiry.due');
    const detail = JSON.parse(entry?.Detail ?? '{}') as Record<string, unknown>;
    expect(typeof detail.eventId).toBe('string');
    expect(typeof detail.eventTime).toBe('string');
    expect(detail.eventType).toBe('cert.expiry.due');
    expect(detail.source).toBe('training-service');
    expect(detail.correlationId).toBe('trace-1');
    expect(detail.schemaVersion).toBe('1.0');
    expect(detail.payload).toEqual({
      deptId: 'NICHOLS',
      memberId: 'MBR-0034',
      certId: 'CERT-0091',
      expiryDate: '2026-10-14',
      leadDays: 30,
    });
  });

  it('skips publish and no-ops when the same-day dedup marker already exists and was already published (AC2 re-run guard)', async () => {
    const ddbSend = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
    const ebSend = vi.fn();
    const ddb = fakeDdb(ddbSend);
    const eb = fakeEb(ebSend);

    const outcome = await publishDueEvent(ddb, eb, env, baseParams);

    expect(outcome).toBe('SkippedDuplicate');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('logs and rethrows when the EventBridge send throws, leaving the recoverable marker without publishedAt', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const publishFailure = new Error('EventBridge unavailable');
    const ebSend = vi.fn().mockRejectedValue(publishFailure);
    const ddb = fakeDdb(ddbSend);
    const eb = fakeEb(ebSend);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(publishDueEvent(ddb, eb, env, baseParams)).rejects.toBe(publishFailure);

    expect(ddbSend).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'certificationExpiryScanner.publish.failed');
    expect(logged?.correlationId).toBe('trace-1');
    errorSpy.mockRestore();
  });

  it('logs and rethrows on a per-entry PutEvents failure, leaving the recoverable marker without publishedAt', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const ebSend = vi
      .fn()
      .mockResolvedValue({ Entries: [{ ErrorCode: 'InternalFailure', ErrorMessage: 'boom' }] });
    const ddb = fakeDdb(ddbSend);
    const eb = fakeEb(ebSend);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(publishDueEvent(ddb, eb, env, baseParams)).rejects.toThrow('boom');

    expect(ddbSend).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('still reports Published (and logs) when the post-publish markPublished update fails', async () => {
    const ddbSend = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('markPublished failed'));
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'evt-1' }] });
    const ddb = fakeDdb(ddbSend);
    const eb = fakeEb(ebSend);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = await publishDueEvent(ddb, eb, env, baseParams);

    expect(outcome).toBe('Published');
    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'certificationExpiryScanner.markPublished.failed');
    expect(logged?.correlationId).toBe('trace-1');
    errorSpy.mockRestore();
  });

  it('reuses the same eventId on a same-day re-run after markPublished failed, so a downstream eventId-keyed dedup no-ops the repeat publish (AC2)', async () => {
    const ddbSendFirstRun = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('markPublished failed'));
    const ebSendFirstRun = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'evt-1' }] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await publishDueEvent(fakeDdb(ddbSendFirstRun), fakeEb(ebSendFirstRun), env, baseParams);
    const firstEventId = (
      JSON.parse(
        (ebSendFirstRun.mock.calls[0]?.[0] as PutEventsCommand).input.Entries?.[0]?.Detail ?? '{}',
      ) as Record<string, unknown>
    ).eventId;

    const ddbSendRerun = vi.fn().mockResolvedValue({});
    const ebSendRerun = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'evt-2' }] });

    const outcome = await publishDueEvent(
      fakeDdb(ddbSendRerun),
      fakeEb(ebSendRerun),
      env,
      baseParams,
    );
    const secondEventId = (
      JSON.parse(
        (ebSendRerun.mock.calls[0]?.[0] as PutEventsCommand).input.Entries?.[0]?.Detail ?? '{}',
      ) as Record<string, unknown>
    ).eventId;

    expect(outcome).toBe('Published');
    expect(secondEventId).toBe(firstEventId);
    errorSpy.mockRestore();
  });

  it('throws (fail-closed) when PLATFORM_EVENT_BUS_NAME is not set', async () => {
    const ddbSend = vi.fn();
    const ebSend = vi.fn();
    const ddb = fakeDdb(ddbSend);
    const eb = fakeEb(ebSend);

    await expect(
      publishDueEvent(ddb, eb, { TRAINING_DYNAMO_TABLE_NAME: 'platform-service' }, baseParams),
    ).rejects.toThrow('PLATFORM_EVENT_BUS_NAME');
    expect(ddbSend).not.toHaveBeenCalled();
    expect(ebSend).not.toHaveBeenCalled();
  });
});
