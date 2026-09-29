import { describe, expect, it, vi } from 'vitest';
import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { publishDueEvent } from './publishDueEvents.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const env = {
  PLATFORM_TABLE_NAME: 'platform-service',
  PLATFORM_EVENT_BUS_NAME: 'boxalarm-test-platform-bus',
};

describe('ppe.expiry.due contract (architecture.md:1788)', () => {
  it('matches the standard event envelope and the architecture-defined payload shape exactly', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'evt-1' }] });

    await publishDueEvent(
      { send: ddbSend } as unknown as DynamoDBDocumentClient,
      { send: ebSend } as unknown as EventBridgeClient,
      env,
      {
        deptId,
        memberId: 'MBR-0034',
        ppeItemId: 'TURNOUT-COAT',
        expiryDate: '2026-10-14',
        correlationId: 'trace-contract-1',
        now: new Date('2026-09-14T12:00:00Z'),
      },
    );

    const putEvents = ebSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putEvents.input.Entries?.[0]?.DetailType).toBe('ppe.expiry.due');
    const detail = JSON.parse(putEvents.input.Entries?.[0]?.Detail ?? '{}') as Record<
      string,
      unknown
    >;

    expect(Object.keys(detail).sort()).toEqual(
      [
        'correlationId',
        'eventId',
        'eventTime',
        'eventType',
        'payload',
        'schemaVersion',
        'source',
      ].sort(),
    );
    expect(typeof detail.eventId).toBe('string');
    expect(typeof detail.eventTime).toBe('string');
    expect(detail.eventType).toBe('ppe.expiry.due');
    expect(detail.correlationId).toBe('trace-contract-1');
    expect(detail.schemaVersion).toBe('1.0');
    expect(detail.payload).toEqual({
      memberId: 'MBR-0034',
      ppeItemId: 'TURNOUT-COAT',
      expiryDate: '2026-10-14',
      deptId: 'NICHOLS',
    });
    // architecture.md:1791's {memberId, ppeItemId, expiryDate} plus deptId, which every
    // department-scoped consumer (notification-service ppeExpiryConsumer.ts) needs.
    expect(Object.keys(detail.payload as Record<string, unknown>).sort()).toEqual(
      ['deptId', 'expiryDate', 'memberId', 'ppeItemId'].sort(),
    );
  });
});
