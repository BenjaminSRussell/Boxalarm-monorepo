import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ReminderItem } from '../reminders/categories.js';

/**
 * The digest job across reminder categories: ROLE rows fan out to the members who hold
 * the role, each member gets one digest per category, and a category's mute key gates
 * its push/email (never the inbox record).
 */

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.doUnmock('../dynamoClient.js');
  vi.doUnmock('../channelSender.js');
  vi.restoreAllMocks();
});

interface CommandLike {
  constructor: { name: string };
  input: Record<string, unknown>;
}

type Row = Record<string, unknown>;

function item(subjectId: string, title = subjectId): ReminderItem {
  return { subjectId, title, detail: 'due 2026-10-01', dueDate: '2026-10-01' };
}

function roleRow(role: string, category: string, reminder: ReminderItem): Row {
  return {
    recipientType: 'ROLE',
    recipientId: role,
    category,
    subjectId: reminder.subjectId,
    item: reminder,
  };
}

function memberRow(memberId: string, category: string, reminder: ReminderItem): Row {
  return {
    recipientType: 'MEMBER',
    recipientId: memberId,
    category,
    subjectId: reminder.subjectId,
    item: reminder,
  };
}

const ROSTER = [
  { memberId: 'APP-OFFICER', roles: ['MEMBER', 'APPARATUS'], email: 'app@example.com' },
  { memberId: 'CHIEF-1', roles: ['MEMBER', 'CHIEF', 'APPARATUS'], email: 'chief@example.com' },
  { memberId: 'LT-1', roles: ['MEMBER', 'OFFICER'], email: 'lt@example.com' },
  { memberId: 'QM-1', roles: ['MEMBER', 'ADMIN'], email: 'qm@example.com' },
  { memberId: 'FF-1', roles: ['MEMBER'], email: 'ff@example.com' },
  { memberId: 'TRN-1', roles: ['MEMBER', 'TRAINING'], email: 'trn@example.com' },
];

interface Harness {
  push: ReturnType<typeof vi.fn>;
  email: ReturnType<typeof vi.fn>;
  puts: Row[];
  prefReads: string[];
}

async function run(
  pending: Row[],
  mutes: Record<string, { push: boolean; email: boolean }> = {},
  roster: Row[] = ROSTER,
): Promise<Harness & { processed: number }> {
  const puts: Row[] = [];
  const prefReads: string[] = [];
  const send = vi.fn().mockImplementation((command: CommandLike) => {
    const name = command.constructor.name;
    if (name === 'QueryCommand') {
      const values = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
      if (values[':gsi3pk'].includes('DIGEST_PENDING')) {
        return Promise.resolve({ Items: pending });
      }
      return Promise.resolve({ Items: roster });
    }
    if (name === 'GetCommand') {
      const key = command.input.Key as { pk: string; sk: string };
      if (key.sk === 'METADATA') {
        return Promise.resolve({ Item: { email: 'from-metadata@example.com' } });
      }
      prefReads.push(key.sk);
      const mute = mutes[key.sk];
      return Promise.resolve({
        Item: mute ? { memberId: 'x', category: 'x', channels: mute, updatedAt: 1 } : undefined,
      });
    }
    if (name === 'PutCommand') {
      puts.push(command.input.Item as Row);
    }
    return Promise.resolve({});
  });
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
  const push = vi.fn().mockResolvedValue(undefined);
  const email = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../channelSender.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../channelSender.js')>();
    return { ...actual, sendPushDigest: push, sendEmailDigest: email };
  });
  const { handler } = await import('./digestJob.js');
  const { processed } = await handler({ deptId: 'NICHOLS' });
  return { push, email, puts, prefReads, processed };
}

/** [memberId, category] for every push sent. */
function pushedTo(push: ReturnType<typeof vi.fn>): string[] {
  return push.mock.calls
    .map((call) => `${(call[1] as { memberId: string }).memberId}:${String(call[5])}`)
    .sort();
}

function inbox(puts: Row[]): Row[] {
  return puts.filter((row) => row.entityType === 'NOTIFICATION');
}

describe('digestJob across reminder categories', () => {
  it('routes apparatus-test-due to APPARATUS and CHIEF, once per member even with both roles', async () => {
    const test = item('APP-E1:HOSE', 'E1');
    const { push, puts } = await run([
      roleRow('APPARATUS', 'apparatus-test-due', test),
      roleRow('CHIEF', 'apparatus-test-due', test),
    ]);

    expect(pushedTo(push)).toEqual([
      'APP-OFFICER:apparatus-test-due',
      'CHIEF-1:apparatus-test-due',
    ]);
    const chiefItems = push.mock.calls.find(
      (call) => (call[1] as { memberId: string }).memberId === 'CHIEF-1',
    )?.[2] as ReminderItem[];
    expect(chiefItems).toHaveLength(1);
    expect(inbox(puts).map((row) => row.category)).toEqual([
      'apparatus-test-due',
      'apparatus-test-due',
    ]);
  });

  it('routes apparatus-defect to APPARATUS + OFFICER and inventory-reorder to APPARATUS + ADMIN', async () => {
    const { push } = await run([
      roleRow('APPARATUS', 'apparatus-defect', item('DEF-1')),
      roleRow('OFFICER', 'apparatus-defect', item('DEF-1')),
      roleRow('APPARATUS', 'inventory-reorder', item('GLOVES-L')),
      roleRow('ADMIN', 'inventory-reorder', item('GLOVES-L')),
    ]);

    expect(pushedTo(push)).toEqual([
      'APP-OFFICER:apparatus-defect',
      'APP-OFFICER:inventory-reorder',
      'CHIEF-1:apparatus-defect',
      'CHIEF-1:inventory-reorder',
      'LT-1:apparatus-defect',
      'QM-1:inventory-reorder',
    ]);
    expect(pushedTo(push)).not.toContain('FF-1:apparatus-defect');
  });

  it('sends one digest per member per category, batching that category’s items', async () => {
    const { push, email, processed } = await run([
      roleRow('APPARATUS', 'apparatus-test-due', item('APP-E1:HOSE')),
      roleRow('APPARATUS', 'apparatus-test-due', item('APP-E2:PUMP')),
      roleRow('APPARATUS', 'apparatus-test-due', item('APP-L1:AERIAL')),
    ]);

    // APP-OFFICER and CHIEF-1 hold APPARATUS: one push + one email each, three items.
    expect(processed).toBe(2);
    expect(push).toHaveBeenCalledTimes(2);
    expect(email).toHaveBeenCalledTimes(2);
    for (const call of push.mock.calls) {
      expect(call[2] as ReminderItem[]).toHaveLength(3);
    }
  });

  it('ppe-expiry reaches the holder and the APPARATUS role; the holder gets the item once', async () => {
    const ppe = item('APP-OFFICER:TURNOUT-COAT', 'TURNOUT-COAT');
    const { push } = await run([
      memberRow('FF-1', 'ppe-expiry', item('FF-1:HELMET', 'HELMET')),
      roleRow('APPARATUS', 'ppe-expiry', item('FF-1:HELMET', 'HELMET')),
      memberRow('APP-OFFICER', 'ppe-expiry', ppe),
      roleRow('APPARATUS', 'ppe-expiry', ppe),
    ]);

    expect(pushedTo(push)).toEqual([
      'APP-OFFICER:ppe-expiry',
      'CHIEF-1:ppe-expiry',
      'FF-1:ppe-expiry',
    ]);
    const holderItems = push.mock.calls.find(
      (call) => (call[1] as { memberId: string }).memberId === 'APP-OFFICER',
    )?.[2] as ReminderItem[];
    // Its own coat (once, though it is both holder and APPARATUS) plus FF-1's helmet.
    expect(holderItems.map((i) => i.subjectId).sort()).toEqual([
      'APP-OFFICER:TURNOUT-COAT',
      'FF-1:HELMET',
    ]);
  });

  it('respects a role recipient’s mute for that category only, and still writes the inbox record', async () => {
    const { push, email, puts, prefReads } = await run(
      [
        roleRow('APPARATUS', 'apparatus-test-due', item('APP-E1:HOSE')),
        roleRow('APPARATUS', 'inventory-reorder', item('GLOVES-L')),
      ],
      { 'NOTIFPREF#CHIEF-1#apparatus-test-due': { push: true, email: true } },
    );

    expect(prefReads).toContain('NOTIFPREF#CHIEF-1#apparatus-test-due');
    expect(pushedTo(push)).toEqual([
      'APP-OFFICER:apparatus-test-due',
      'APP-OFFICER:inventory-reorder',
      'CHIEF-1:inventory-reorder',
    ]);
    expect(email).toHaveBeenCalledTimes(3);
    expect(
      inbox(puts)
        .filter((row) => row.memberId === 'CHIEF-1')
        .map((row) => row.category),
    ).toEqual(['apparatus-test-due', 'inventory-reorder']);
  });

  it('a push-only mute still sends the email for that category', async () => {
    const { push, email } = await run([roleRow('ADMIN', 'inventory-reorder', item('GLOVES-L'))], {
      'NOTIFPREF#QM-1#inventory-reorder': { push: true, email: false },
    });

    expect(push).not.toHaveBeenCalled();
    expect(email).toHaveBeenCalledTimes(1);
  });

  it('uses the roster email for role recipients and METADATA only for named members', async () => {
    const { push } = await run([
      roleRow('ADMIN', 'inventory-reorder', item('GLOVES-L')),
      memberRow('FF-1', 'ppe-expiry', item('FF-1:HELMET')),
    ]);

    const recipients = push.mock.calls.map(
      (call) => call[1] as { memberId: string; email: string },
    );
    expect(recipients).toEqual(
      expect.arrayContaining([
        { memberId: 'QM-1', email: 'qm@example.com' },
        { memberId: 'FF-1', email: 'from-metadata@example.com' },
      ]),
    );
  });

  it('writes each inbox record with the category’s own summary and the items’ titles and links', async () => {
    const defect: ReminderItem = {
      subjectId: 'DEF-1',
      title: 'E1',
      detail: 'major defect reported',
      link: { kind: 'apparatus', id: 'E1' },
    };
    const { puts } = await run([roleRow('OFFICER', 'apparatus-defect', defect)]);

    const [notification] = inbox(puts);
    expect(notification).toMatchObject({
      memberId: 'LT-1',
      category: 'apparatus-defect',
      summary: '1 defect reported',
      items: [defect],
    });
  });

  it('still delivers a pending row recorded before categories existed (cert fields only)', async () => {
    const { push, puts } = await run([
      {
        recipientType: 'MEMBER',
        recipientId: 'FF-1',
        category: 'cert-expiry',
        certId: 'CERT-1',
        expiryDate: '2027-01-10',
      },
    ]);

    expect(pushedTo(push)).toEqual(['FF-1:cert-expiry']);
    expect(inbox(puts)[0]?.items).toEqual([
      expect.objectContaining({ subjectId: 'CERT-1', certId: 'CERT-1', expiryDate: '2027-01-10' }),
    ]);
  });

  it('delivers the TRAINING role’s cert copy under cert-expiry-officer, unmuted', async () => {
    const { push, prefReads } = await run(
      [
        {
          recipientType: 'ROLE',
          recipientId: 'TRAINING',
          category: 'cert-expiry',
          certId: 'CERT-1',
          expiryDate: '2027-01-10',
        },
      ],
      {},
    );

    expect(pushedTo(push)).toEqual(['TRN-1:cert-expiry-officer']);
    expect(prefReads).toEqual([]);
  });

  it('logs and counts a malformed pending row instead of dropping it silently', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { push } = await run([
      { recipientType: 'MEMBER', recipientId: 'FF-1', category: 'apparatus-test-due' },
      memberRow('FF-1', 'ppe-expiry', item('FF-1:HELMET')),
    ]);

    expect(pushedTo(push)).toEqual(['FF-1:ppe-expiry']);
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes('notification.digest.malformed_pending_row'),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((call) => String(call[0]).includes('DigestPendingRowMalformed')),
    ).toBe(true);
  });

  it('routes nothing to a role holder who is on leave or retired', async () => {
    const roster = [
      { memberId: 'ACTIVE-1', roles: ['APPARATUS'], status: 'ACTIVE', email: 'a@example.com' },
      { memberId: 'PROB-1', roles: ['APPARATUS'], status: 'PROBATIONARY', email: 'p@example.com' },
      { memberId: 'LOA-1', roles: ['APPARATUS'], status: 'LOA', email: 'l@example.com' },
      { memberId: 'RET-1', roles: ['APPARATUS'], status: 'RETIRED', email: 'r@example.com' },
    ];
    const { push } = await run(
      [roleRow('APPARATUS', 'inventory-reorder', item('GLOVES-L'))],
      {},
      roster,
    );

    expect(pushedTo(push)).toEqual(['ACTIVE-1:inventory-reorder', 'PROB-1:inventory-reorder']);
  });

  it('logs and counts a routed role nobody active holds, once per role and category', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const roster = [{ memberId: 'QM-1', roles: ['ADMIN'], email: 'qm@example.com' }];
    const { push } = await run(
      [
        roleRow('APPARATUS', 'inventory-reorder', item('GLOVES-L')),
        roleRow('APPARATUS', 'inventory-reorder', item('GLOVES-M')),
        roleRow('ADMIN', 'inventory-reorder', item('GLOVES-L')),
      ],
      {},
      roster,
    );

    expect(pushedTo(push)).toEqual(['QM-1:inventory-reorder']);
    const unheld = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('notification.digest.role_unheld'));
    expect(unheld).toHaveLength(1);
    expect(JSON.parse(unheld[0]!)).toMatchObject({
      role: 'APPARATUS',
      category: 'inventory-reorder',
    });
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes('DigestRoleUnheld'))).toBe(
      true,
    );
  });
});
