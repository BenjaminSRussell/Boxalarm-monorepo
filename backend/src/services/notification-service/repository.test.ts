import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  asTransactionCancellation,
  buildDigestSentMarker,
  buildNotificationItem,
  buildPendingItem,
  buildEventSeenMarker,
  buildPreferenceItem,
  buildReminderPendingItem,
  CERT_EXPIRY_CATEGORY,
  DIGEST_BUCKET,
  isConditionalCheckFailed,
  parsePreferenceItem,
  TODAY_BUCKET,
} from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('TODAY_BUCKET', () => {
  it('formats a date as an ISO day bucket', () => {
    expect(TODAY_BUCKET(new Date('2026-09-15T12:34:56Z'))).toBe('2026-09-15');
  });
});

describe('buildPreferenceItem / parsePreferenceItem', () => {
  it('round-trips a per-channel preference item', () => {
    const item = buildPreferenceItem(
      DEPT_ID,
      'MBR-1',
      CERT_EXPIRY_CATEGORY,
      { push: true, email: false },
      1000,
    );
    expect(parsePreferenceItem(item as unknown as Record<string, unknown>)).toEqual({
      memberId: 'MBR-1',
      category: CERT_EXPIRY_CATEGORY,
      channels: { push: true, email: false },
      updatedAt: 1000,
    });
  });

  it('returns undefined for an absent item', () => {
    expect(parsePreferenceItem(undefined)).toBeUndefined();
  });
});

describe('buildNotificationItem', () => {
  it('builds a nullable-readAt inbox item scoped by member and dept', () => {
    const item = buildNotificationItem(
      DEPT_ID,
      'MBR-1',
      'NOTIF-1',
      CERT_EXPIRY_CATEGORY,
      [{ certId: 'CERT-1', expiryDate: '2027-01-10' }],
      2_000_000,
    );
    expect(item.pk).toBe('DEPT#NICHOLS#MEMBER#MBR-1');
    expect(item.sk).toBe('NOTIF#MBR-1#2000000#NOTIF-1');
    expect(item.readAt).toBeNull();
    expect(item.summary).toBe('1 item expiring');
    expect(item.gsi1pk).toBe('DEPT#NICHOLS#MEMBER#MBR-1');
    expect(item.gsi1sk).toBe('NOTIFICATION#NOTIF-1');
  });

  it('pluralizes the summary for multiple items', () => {
    const item = buildNotificationItem(
      DEPT_ID,
      'MBR-1',
      'NOTIF-1',
      CERT_EXPIRY_CATEGORY,
      [
        { certId: 'CERT-1', expiryDate: '2027-01-10' },
        { certId: 'CERT-2', expiryDate: '2027-02-01' },
      ],
      2_000_000,
    );
    expect(item.summary).toBe('2 items expiring');
  });
});

describe('buildPendingItem', () => {
  it('scopes a MEMBER pending item by certId for same-day idempotency', () => {
    const item = buildPendingItem(
      DEPT_ID,
      'MEMBER',
      'MBR-1',
      CERT_EXPIRY_CATEGORY,
      'CERT-1',
      '2027-01-10',
      '2026-09-15',
      1_500_000,
    );
    expect(item.pk).toBe('DEPT#NICHOLS#MEMBER#MBR-1');
    expect(item.sk).toBe('DIGEST_PENDING#cert-expiry#2026-09-15#CERT-1');
    expect(item.gsi3pk).toBe('DEPT#NICHOLS#DIGEST_PENDING#2026-09-15');
    expect(item.gsi3sk).toBe('MEMBER#MBR-1#CERT-1');
  });

  it('appends a unique suffix for a ROLE pending item so multiple members do not collide', () => {
    const item = buildPendingItem(
      DEPT_ID,
      'ROLE',
      'TRAINING',
      CERT_EXPIRY_CATEGORY,
      'CERT-1',
      '2027-01-10',
      '2026-09-15',
      1_500_000,
      'MBR-1',
    );
    expect(item.pk).toBe('DEPT#NICHOLS#ROLE#TRAINING');
    expect(item.sk).toBe('DIGEST_PENDING#cert-expiry#2026-09-15#CERT-1#MBR-1');
    expect(item.gsi3sk).toBe('ROLE#TRAINING#CERT-1#MBR-1');
  });
});

describe('buildDigestSentMarker', () => {
  it('builds a per-recipient per-category per-day guard key', () => {
    const marker = buildDigestSentMarker(
      DEPT_ID,
      'MEMBER',
      'MBR-1',
      CERT_EXPIRY_CATEGORY,
      '2026-09-15',
      1_500_000,
    );
    expect(marker.pk).toBe('DEPT#NICHOLS#MEMBER#MBR-1');
    expect(marker.sk).toBe('DIGESTSENT#cert-expiry#2026-09-15');
  });
});

describe('asTransactionCancellation / isConditionalCheckFailed', () => {
  it('recognizes a TransactionCanceledException and its conditional-check reason', () => {
    const error = Object.assign(new Error('dup'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    expect(asTransactionCancellation(error)).toBeDefined();
    expect(isConditionalCheckFailed(error)).toBe(true);
  });

  it('treats an unrelated error as a real failure, not a duplicate', () => {
    const error = new Error('boom');
    expect(asTransactionCancellation(error)).toBeUndefined();
    expect(isConditionalCheckFailed(error)).toBe(false);
  });
});

describe('DIGEST_BUCKET', () => {
  it('buckets a reminder recorded before the 12:00 UTC digest under today', () => {
    expect(DIGEST_BUCKET(new Date('2026-09-15T10:00:00Z'))).toBe('2026-09-15');
    expect(DIGEST_BUCKET(new Date('2026-09-15T11:54:59Z'))).toBe('2026-09-15');
  });

  it('buckets one recorded at or after the cutoff under the next digest day, never a day already sent', () => {
    expect(DIGEST_BUCKET(new Date('2026-09-15T11:55:00Z'))).toBe('2026-09-16');
    expect(DIGEST_BUCKET(new Date('2026-09-15T23:59:59Z'))).toBe('2026-09-16');
    expect(DIGEST_BUCKET(new Date('2026-12-31T18:00:00Z'))).toBe('2027-01-01');
  });
});

describe('buildReminderPendingItem', () => {
  it('stores the category-typed item and keys the row by category, day and subject', () => {
    const item = buildReminderPendingItem(
      DEPT_ID,
      'ROLE',
      'APPARATUS',
      'apparatus-test-due',
      {
        subjectId: 'APP-E1:HOSE',
        title: 'E1',
        detail: 'HOSE test due 2026-10-01',
        dueDate: '2026-10-01',
        link: { kind: 'apparatus', id: 'E1' },
      },
      '2026-09-15',
      1_500_000,
    );
    expect(item.pk).toBe('DEPT#NICHOLS#ROLE#APPARATUS');
    expect(item.sk).toBe('DIGEST_PENDING#apparatus-test-due#2026-09-15#APP-E1:HOSE');
    expect(item.subjectId).toBe('APP-E1:HOSE');
    expect(item.dueDate).toBe('2026-10-01');
    expect(item.item.link).toEqual({ kind: 'apparatus', id: 'E1' });
    expect(item).not.toHaveProperty('certId');
  });
});

describe('buildEventSeenMarker', () => {
  it('keys the eventId under the department so a redelivery can be refused', () => {
    const marker = buildEventSeenMarker(DEPT_ID, 'evt-1', 1_000_000);
    expect(marker.pk).toBe('DEPT#NICHOLS#NOTIF_EVENT#evt-1');
    expect(marker.sk).toBe('SEEN');
    expect(marker.ttl).toBe(1000 + 7 * 24 * 60 * 60);
  });
});
