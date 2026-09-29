import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { publishScbaTestDueEvent } from './publishDueEvents.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const env = {
  PLATFORM_TABLE_NAME: 'platform-table',
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
  apparatusId: 'ENGINE-2',
  scbaUnitId: 'SCBA-001',
  cylinderId: 'CYL-0891',
  testType: 'SCBA_FLOW' as const,
  dueDate: '2026-09-20',
  correlationId: 'trace-1',
  now: new Date('2026-09-14T12:00:00Z'),
};

describe('publishScbaTestDueEvent', () => {
  it('writes the dedup marker, publishes exactly one well-formed apparatus.test.due event, then marks it published (AC3, contract)', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'evt-1' }] });

    const outcome = await publishScbaTestDueEvent(
      fakeDdb(ddbSend),
      fakeEb(ebSend),
      env,
      baseParams,
    );

    expect(outcome).toBe('Published');
    expect(ddbSend).toHaveBeenCalledTimes(2);
    const putCommand = ddbSend.mock.calls[0]?.[0] as PutCommand;
    expect(putCommand).toBeInstanceOf(PutCommand);
    expect(putCommand.input.Item?.pk).toBe('DEPT#NICHOLS#SCBA_TEST_DUE_FLAG#2026-09-14');
    expect(putCommand.input.Item?.sk).toBe('SCBA#SCBA-001#SCBA_FLOW');

    const updateCommand = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCommand).toBeInstanceOf(UpdateCommand);
    expect(updateCommand.input.ConditionExpression).toBe('attribute_exists(pk)');

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]?.[0] as PutEventsCommand;
    const entry = putEvents.input.Entries?.[0];
    expect(entry?.EventBusName).toBe('boxalarm-test-platform-bus');
    expect(entry?.DetailType).toBe('apparatus.test.due');
    const detail = JSON.parse(entry?.Detail ?? '{}') as Record<string, unknown>;
    expect(detail.eventType).toBe('apparatus.test.due');
    expect(detail.source).toBe('apparatus-service');
    expect(detail.correlationId).toBe('trace-1');
    expect(detail.schemaVersion).toBe('1.0');
    expect(detail.payload).toEqual({
      apparatusId: 'ENGINE-2',
      testType: 'SCBA_FLOW',
      dueDate: '2026-09-20',
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      deptId: 'NICHOLS',
    });
  });

  it('skips publish and no-ops when the same-day dedup marker already exists and was already published (AC3 re-run guard)', async () => {
    const ddbSend = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
    const ebSend = vi.fn();

    const outcome = await publishScbaTestDueEvent(
      fakeDdb(ddbSend),
      fakeEb(ebSend),
      env,
      baseParams,
    );

    expect(outcome).toBe('SkippedDuplicate');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('logs the original error and rethrows when the EventBridge send throws', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const publishFailure = new Error('EventBridge unavailable');
    const ebSend = vi.fn().mockRejectedValue(publishFailure);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      publishScbaTestDueEvent(fakeDdb(ddbSend), fakeEb(ebSend), env, baseParams),
    ).rejects.toBe(publishFailure);

    expect(ddbSend).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'apparatusTestingScanner.publish.failed');
    expect(logged?.correlationId).toBe('trace-1');
    errorSpy.mockRestore();
  });

  it('logs and rethrows on a per-entry PutEvents failure', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const ebSend = vi
      .fn()
      .mockResolvedValue({ Entries: [{ ErrorCode: 'InternalFailure', ErrorMessage: 'boom' }] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      publishScbaTestDueEvent(fakeDdb(ddbSend), fakeEb(ebSend), env, baseParams),
    ).rejects.toThrow('boom');
    errorSpy.mockRestore();
  });

  it('still reports Published (and logs) when the post-publish markPublished update fails', async () => {
    const ddbSend = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('markPublished failed'));
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'evt-1' }] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = await publishScbaTestDueEvent(
      fakeDdb(ddbSend),
      fakeEb(ebSend),
      env,
      baseParams,
    );

    expect(outcome).toBe('Published');
    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'apparatusTestingScanner.markPublished.failed');
    expect(logged?.correlationId).toBe('trace-1');
    errorSpy.mockRestore();
  });

  it('throws (fail-closed) when PLATFORM_EVENT_BUS_NAME is not set', async () => {
    const ddbSend = vi.fn();
    const ebSend = vi.fn();

    await expect(
      publishScbaTestDueEvent(
        fakeDdb(ddbSend),
        fakeEb(ebSend),
        { PLATFORM_TABLE_NAME: 'platform-table' },
        baseParams,
      ),
    ).rejects.toThrow('PLATFORM_EVENT_BUS_NAME');
    expect(ddbSend).not.toHaveBeenCalled();
    expect(ebSend).not.toHaveBeenCalled();
  });
});
