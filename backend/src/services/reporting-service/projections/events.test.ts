import { describe, expect, it } from 'vitest';
import { MalformedEventError, parseDomainEvent, projectionWrites } from './events.js';

const now = 1_700_000_000_000;

describe('projection event parsing', () => {
  it('reads an EventBridge envelope and the nested payload', () => {
    const parsed = parseDomainEvent(
      JSON.stringify({
        'detail-type': 'personnel.attendance.recorded',
        detail: {
          eventId: 'evt-1',
          eventType: 'personnel.attendance.recorded',
          payload: { deptId: 'NICHOLS', memberId: 'm-1', activityId: 'drill-1', losapPoints: 2 },
        },
      }),
    );
    expect(parsed.deptId).toBe('NICHOLS');
    expect(projectionWrites(parsed, now)).toEqual([
      {
        kind: 'update',
        sk: 'ATTENDANCE#drill-1#m-1',
        values: {
          entityType: 'REPORTING_ATTENDANCE',
          memberId: 'm-1',
          activityId: 'drill-1',
          activityType: 'UNKNOWN',
          losapPoints: 2,
        },
      },
    ]);
  });

  it('rejects a body that is not JSON', () => {
    expect(() => parseDomainEvent('not-json')).toThrow(MalformedEventError);
  });

  it('records a failed NERIS submission that will not retry as FAILED', () => {
    const writes = projectionWrites(
      {
        eventId: 'evt-2',
        eventType: 'neris.submission.failed',
        deptId: 'NICHOLS',
        payload: {
          incidentId: 'inc-1',
          willRetry: false,
          failureReason: 'schema',
          httpStatus: 400,
        },
      },
      now,
    );
    expect(writes[0]).toMatchObject({
      sk: 'NERIS#inc-1',
      values: { status: 'FAILED', failureReason: 'schema', httpStatus: 400 },
    });
  });

  it('keeps a retryable NERIS failure pending', () => {
    const writes = projectionWrites(
      {
        eventId: 'evt-3',
        eventType: 'neris.submission.failed',
        deptId: 'NICHOLS',
        payload: { departmentId: 'NICHOLS', incidentId: 'inc-1', willRetry: true },
      },
      now,
    );
    expect(writes[0]).toMatchObject({ values: { status: 'PENDING' } });
  });

  it('removes an apparatus rollup when the unit returns to service', () => {
    const writes = projectionWrites(
      {
        eventId: 'evt-4',
        eventType: 'apparatus.out_of_service',
        deptId: 'NICHOLS',
        payload: { unitId: 'E1', status: 'IN_SERVICE' },
      },
      now,
    );
    expect(writes).toEqual([{ kind: 'delete', sk: 'OOS#E1' }]);
  });

  it('stores a coverage gap and an expiring certification', () => {
    expect(
      projectionWrites(
        {
          eventId: 'evt-5',
          eventType: 'scheduling.coverage_gap.detected',
          deptId: 'NICHOLS',
          payload: { shiftId: 'shift-1', gapReason: 'no officer', requiredQuals: ['OFFICER'] },
        },
        now,
      )[0],
    ).toMatchObject({ sk: 'COVERAGE#shift-1' });
    expect(
      projectionWrites(
        {
          eventId: 'evt-6',
          eventType: 'cert.expiry.due',
          deptId: 'NICHOLS',
          payload: { memberId: 'm-1', certId: 'c-1', expiryDate: '2026-10-01' },
        },
        now,
      )[0],
    ).toMatchObject({ sk: 'CERT#c-1', values: { expiryDate: '2026-10-01' } });
  });

  it('marks a member unavailable from a mark-off event', () => {
    const writes = projectionWrites(
      {
        eventId: 'evt-7',
        eventType: 'personnel.availability.changed',
        deptId: 'NICHOLS',
        payload: { memberId: 'm-1', availabilityState: 'MARKED_OFF' },
      },
      now,
    );
    expect(writes[0]).toMatchObject({ sk: 'MEMBER#m-1', values: { available: false } });
  });

  it('writes nothing for a member.updated that carries no status (e.g. a role change)', () => {
    const parsed = parseDomainEvent(
      JSON.stringify({
        detail: {
          eventId: 'evt-9',
          eventType: 'personnel.member.updated',
          payload: { deptId: 'NICHOLS', memberId: 'm-1', roles: ['MEMBER', 'OFFICER'] },
        },
      }),
    );
    expect(projectionWrites(parsed, now)).toEqual([]);
  });

  it('rejects a member.updated with neither memberId nor status instead of skipping it', () => {
    const parsed = parseDomainEvent(
      JSON.stringify({
        detail: {
          eventId: 'evt-10',
          eventType: 'personnel.member.updated',
          payload: { deptId: 'NICHOLS' },
        },
      }),
    );
    expect(() => projectionWrites(parsed, now)).toThrow();
  });
});
