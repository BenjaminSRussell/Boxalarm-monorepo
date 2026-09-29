import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { publishDueEvent } from './publishDueEvents.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const env = {
  PLATFORM_TABLE_NAME: 'platform-service',
  PLATFORM_EVENT_BUS_NAME: 'boxalarm-test-bus',
};
const NOW = new Date('2026-09-14T02:00:00Z');

function fakeDdb(options: {
  readonly dedupConflict?: boolean;
  readonly markPublishedError?: Error;
}): { readonly client: DynamoDBDocumentClient; readonly send: ReturnType<typeof vi.fn> } {
  const send = vi.fn((command: unknown) => {
    if (command instanceof PutCommand) {
      if (options.dedupConflict) {
        throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
      }
      return Promise.resolve({});
    }
    if (command instanceof UpdateCommand) {
      return options.markPublishedError
        ? Promise.reject(options.markPublishedError)
        : Promise.resolve({});
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, send };
}

function fakeEb(entries: { ErrorCode?: string; ErrorMessage?: string }[] = [{}]): {
  readonly client: EventBridgeClient;
  readonly send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ Entries: entries });
  return { client: { send } as unknown as EventBridgeClient, send };
}

const PARAMS = {
  deptId,
  apparatusId: 'APP-ENGINE-2',
  testType: 'HOSE',
  dueDate: '2027-05-01',
  correlationId: 'trace-1',
  now: NOW,
};

describe('publishDueEvent', () => {
  it('publishes apparatus.test.due with the dedup-marker-then-publish-then-mark-published shape (AC2)', async () => {
    const { client: ddb, send: ddbSend } = fakeDdb({});
    const { client: eb, send: ebSend } = fakeEb();

    const outcome = await publishDueEvent(ddb, eb, env, PARAMS);

    expect(outcome).toBe('Published');
    const putEvents = ebSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putEvents.input.Entries?.[0]?.DetailType).toBe('apparatus.test.due');
    const detail = JSON.parse(putEvents.input.Entries?.[0]?.Detail as string) as {
      eventType: string;
      payload: { apparatusId: string; testType: string; dueDate: string };
    };
    expect(detail.eventType).toBe('apparatus.test.due');
    expect(detail.payload).toEqual({
      apparatusId: 'APP-ENGINE-2',
      testType: 'HOSE',
      dueDate: '2027-05-01',
      deptId: 'NICHOLS',
    });
    expect(ddbSend.mock.calls.some((c: unknown[]) => c[0] instanceof UpdateCommand)).toBe(true);
  });

  it('skips publishing when the dedup marker already exists for today (dedup guard)', async () => {
    const { client: ddb } = fakeDdb({ dedupConflict: true });
    const { client: eb, send: ebSend } = fakeEb();

    const outcome = await publishDueEvent(ddb, eb, env, PARAMS);

    expect(outcome).toBe('SkippedDuplicate');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('rethrows on an EventBridge entry-level error', async () => {
    const { client: ddb } = fakeDdb({});
    const { client: eb } = fakeEb([{ ErrorCode: 'InternalFailure', ErrorMessage: 'boom' }]);

    await expect(publishDueEvent(ddb, eb, env, PARAMS)).rejects.toThrow('boom');
  });

  it('rethrows on an EventBridge send failure and logs the original error', async () => {
    const { client: ddb } = fakeDdb({});
    const failure = new Error('EventBridge unavailable');
    const eb = { send: vi.fn().mockRejectedValue(failure) } as unknown as EventBridgeClient;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(publishDueEvent(ddb, eb, env, PARAMS)).rejects.toBe(failure);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('testDueScanner.publish.failed'));
    errorSpy.mockRestore();
  });

  it('does not fail the publish when marking published afterwards errors', async () => {
    const { client: ddb } = fakeDdb({ markPublishedError: new Error('mark failed') });
    const { client: eb } = fakeEb();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = await publishDueEvent(ddb, eb, env, PARAMS);

    expect(outcome).toBe('Published');
    errorSpy.mockRestore();
  });
});
