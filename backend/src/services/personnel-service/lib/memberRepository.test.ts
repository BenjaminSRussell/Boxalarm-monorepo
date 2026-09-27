import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {},
}));

vi.mock('aws-xray-sdk-core', () => ({
  captureAWSv3Client: (client: unknown) => client,
}));

vi.mock('@aws-sdk/lib-dynamodb', () => {
  class FakeCommand {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    DynamoDBDocumentClient: { from: () => ({ send: sendMock }) },
    GetCommand: FakeCommand,
    PutCommand: FakeCommand,
    QueryCommand: FakeCommand,
    TransactWriteCommand: FakeCommand,
  };
});

const { createMember, getMember, listMembers, updateMemberRoles, updateMemberStatus } =
  await import('./memberRepository.js');

const PRINCIPAL = { deptId: 'NICHOLS' };

interface FakeCommandCall {
  readonly input: {
    readonly Item?: Record<string, unknown>;
    readonly Key?: Record<string, unknown>;
    readonly IndexName?: string;
    readonly ExpressionAttributeValues?: Record<string, unknown>;
    readonly ConditionExpression?: string;
    readonly ExclusiveStartKey?: Record<string, unknown>;
    readonly TransactItems?: ReadonlyArray<{
      readonly Update?: {
        Key: Record<string, unknown>;
        ConditionExpression: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
      readonly Put?: { Item: Record<string, unknown>; ConditionExpression?: string };
    }>;
  };
}

function lastCall(): FakeCommandCall {
  const call = sendMock.mock.calls.at(-1)?.[0] as FakeCommandCall | undefined;
  if (!call) {
    throw new Error('send was not called');
  }
  return call;
}

function allCalls(): FakeCommandCall[] {
  return sendMock.mock.calls.map(([call]) => call as FakeCommandCall);
}

describe('memberRepository', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  describe('createMember', () => {
    const input = {
      firstName: 'Jamie',
      lastName: 'Rios',
      phone: '203-555-0100',
      email: 'jamie@example.com',
      joinDate: '2026-01-01',
      rank: 'FIREFIGHTER',
      agencyId: 'NFD-0099',
    };

    it('creates a dept-scoped MEMBER item defaulted to PROBATIONARY status (AC1)', async () => {
      sendMock.mockResolvedValueOnce({});
      const member = await createMember('table', PRINCIPAL, input, 'actor-1', 'sub-jamie');

      expect(member.status).toBe('PROBATIONARY');
      expect(member.memberId).toBe('sub-jamie');
      expect(member.deptId).toBe('NICHOLS');
      const items = lastCall().input.TransactItems ?? [];
      const memberPut = items[0]?.Put;
      expect(memberPut?.Item.pk).toBe(`DEPT#NICHOLS#MEMBER#${member.memberId}`);
      expect(memberPut?.Item.sk).toBe('METADATA');
      expect(memberPut?.Item.gsi3pk).toBe('DEPT#NICHOLS#MEMBER');
    });

    it('conditions the MEMBER write on the pk not already existing', async () => {
      sendMock.mockResolvedValueOnce({});
      await createMember('table', PRINCIPAL, input, 'actor-1', 'sub-jamie');
      const items = lastCall().input.TransactItems ?? [];
      expect(items[0]?.Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
    });

    it('writes an AUDIT_LOG_ENTRY alongside the MEMBER item in the same transaction (P9)', async () => {
      sendMock.mockResolvedValueOnce({});
      const member = await createMember('table', PRINCIPAL, input, 'actor-1', 'sub-jamie');
      const items = lastCall().input.TransactItems ?? [];
      expect(items).toHaveLength(2);
      const auditPut = items[1]?.Put;
      expect(auditPut?.Item.entityType).toBe('AUDIT_LOG_ENTRY');
      expect(auditPut?.Item.action).toBe('CREATE');
      expect(auditPut?.Item.mutatedEntityId).toBe(member.memberId);
      expect(auditPut?.Item.actorId).toBe('actor-1');
      expect(auditPut?.Item.pk).toMatch(/^DEPT#NICHOLS#AUDIT#\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('getMember', () => {
    it('reads by dept-scoped pk and METADATA sk, mapping the item back to a Member', async () => {
      sendMock.mockResolvedValueOnce({
        Item: {
          memberId: 'm1',
          deptId: 'NICHOLS',
          firstName: 'Jamie',
          lastName: 'Rios',
          phone: 'x',
          email: 'y',
          status: 'ACTIVE',
          joinDate: '2026-01-01',
          rank: 'FF',
          agencyId: 'A1',
          roles: ['MEMBER'],
          createdAt: 1,
          updatedAt: 1,
        },
      });
      const member = await getMember('table', PRINCIPAL, 'm1');
      expect(member?.memberId).toBe('m1');
      expect(lastCall().input.Key).toEqual({ pk: 'DEPT#NICHOLS#MEMBER#m1', sk: 'METADATA' });
    });

    it('returns undefined when no item is found (unknown id or another department, AC1/AC4 tenancy)', async () => {
      sendMock.mockResolvedValueOnce({});
      expect(await getMember('table', PRINCIPAL, 'missing')).toBeUndefined();
    });
  });

  describe('listMembers', () => {
    it('queries GSI3 scoped to the caller department (AC4)', async () => {
      sendMock.mockResolvedValueOnce({
        Items: [{ memberId: 'm1', deptId: 'NICHOLS', status: 'ACTIVE', roles: [] }],
      });
      const members = await listMembers('table', PRINCIPAL);
      expect(members).toHaveLength(1);
      expect(lastCall().input.IndexName).toBe('GSI3');
      expect(lastCall().input.ExpressionAttributeValues?.[':gsi3pk']).toBe('DEPT#NICHOLS#MEMBER');
    });

    it('returns an empty array when no members exist', async () => {
      sendMock.mockResolvedValueOnce({});
      expect(await listMembers('table', PRINCIPAL)).toEqual([]);
    });

    it('follows LastEvaluatedKey across pages so a roster larger than one page is not silently truncated (P2)', async () => {
      sendMock.mockResolvedValueOnce({
        Items: [{ memberId: 'm1', deptId: 'NICHOLS', status: 'ACTIVE', roles: [] }],
        LastEvaluatedKey: { pk: 'DEPT#NICHOLS#MEMBER#m1', sk: 'METADATA' },
      });
      sendMock.mockResolvedValueOnce({
        Items: [{ memberId: 'm2', deptId: 'NICHOLS', status: 'ACTIVE', roles: [] }],
      });
      const members = await listMembers('table', PRINCIPAL);
      expect(members.map((m) => m.memberId)).toEqual(['m1', 'm2']);
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(allCalls()[1]?.input.ExclusiveStartKey).toEqual({
        pk: 'DEPT#NICHOLS#MEMBER#m1',
        sk: 'METADATA',
      });
    });
  });

  describe('updateMemberStatus', () => {
    it('writes the MEMBER status update, AUDIT_LOG_ENTRY, and OUTBOX_ENTRY as one TransactWriteItems call (AC2, core-harm)', async () => {
      sendMock.mockResolvedValueOnce({});
      await updateMemberStatus('table', PRINCIPAL, 'm1', 'PROBATIONARY', 'ACTIVE', 'actor-1');

      expect(sendMock).toHaveBeenCalledTimes(1);
      const items = lastCall().input.TransactItems;
      expect(items).toHaveLength(3);
      const [memberUpdate, auditPut, outboxPut] = items ?? [];

      expect(memberUpdate?.Update?.Key).toEqual({ pk: 'DEPT#NICHOLS#MEMBER#m1', sk: 'METADATA' });
      expect(memberUpdate?.Update?.ConditionExpression).toBe('#status = :previousStatus');

      expect(auditPut?.Put?.Item.entityType).toBe('AUDIT_LOG_ENTRY');
      expect(auditPut?.Put?.Item.pk).toMatch(/^DEPT#NICHOLS#AUDIT#\d{4}-\d{2}-\d{2}$/);
      expect(auditPut?.Put?.Item.changedFields).toEqual({
        status: { old: 'PROBATIONARY', new: 'ACTIVE' },
      });
      expect(typeof auditPut?.Put?.Item.gsi3sk).toBe('string');

      expect(outboxPut?.Put?.Item.pk).toBe('DEPT#NICHOLS#OUTBOX#m1');
      expect(outboxPut?.Put?.Item.eventType).toBe('personnel.member.updated');
      expect(outboxPut?.Put?.Item.status).toBe('PENDING');
      expect(outboxPut?.Put?.Item.ttl).toBeUndefined();
      expect(outboxPut?.Put?.Item.payload).toEqual({
        memberId: 'm1',
        deptId: 'NICHOLS',
        previousStatus: 'PROBATIONARY',
        newStatus: 'ACTIVE',
        actorId: 'actor-1',
        changedAt: (outboxPut?.Put?.Item.payload as { changedAt: string }).changedAt,
      });
    });

    it('propagates the underlying error on a failed TransactWriteItems (fail-closed, no partial write)', async () => {
      sendMock.mockRejectedValueOnce(new Error('ConditionalCheckFailed'));
      await expect(
        updateMemberStatus('table', PRINCIPAL, 'm1', 'PROBATIONARY', 'ACTIVE', 'actor-1'),
      ).rejects.toThrow('ConditionalCheckFailed');
    });
  });

  describe('updateMemberRoles', () => {
    it('writes roles, the audit row, and a member.updated outbox entry carrying roles in one transaction', async () => {
      sendMock.mockResolvedValueOnce({});
      await updateMemberRoles(
        'table',
        PRINCIPAL,
        'm1',
        ['MEMBER'],
        ['MEMBER', 'OFFICER'],
        'actor-1',
      );

      expect(sendMock).toHaveBeenCalledTimes(1);
      const [memberUpdate, auditPut, outboxPut] = lastCall().input.TransactItems ?? [];

      expect(memberUpdate?.Update?.Key).toEqual({ pk: 'DEPT#NICHOLS#MEMBER#m1', sk: 'METADATA' });
      expect(memberUpdate?.Update?.ConditionExpression).toBe(
        'attribute_exists(pk) AND #roles = :previousRoles',
      );
      expect(memberUpdate?.Update?.ExpressionAttributeValues).toMatchObject({
        ':previousRoles': ['MEMBER'],
        ':roles': ['MEMBER', 'OFFICER'],
      });

      expect(auditPut?.Put?.Item.pk).toMatch(/^DEPT#NICHOLS#AUDIT#\d{4}-\d{2}-\d{2}$/);
      expect(auditPut?.Put?.Item.changedFields).toEqual({
        roles: { old: ['MEMBER'], new: ['MEMBER', 'OFFICER'] },
      });
      expect(auditPut?.Put?.Item.actorId).toBe('actor-1');

      const outbox = outboxPut?.Put?.Item;
      expect(outbox).toMatchObject({
        pk: 'DEPT#NICHOLS#OUTBOX#m1',
        entityType: 'OUTBOX_ENTRY',
        eventType: 'personnel.member.updated',
        source: 'personnel-service',
        correlationId: 'm1',
        schemaVersion: '1.0',
      });
      expect(typeof outbox?.eventId).toBe('string');
      expect(Number.isNaN(Date.parse(outbox?.eventTime as string))).toBe(false);
      expect(outbox?.payload).toEqual({
        deptId: 'NICHOLS',
        memberId: 'm1',
        roles: ['MEMBER', 'OFFICER'],
      });
    });

    it('propagates a failed transaction so the handler can answer 503', async () => {
      sendMock.mockRejectedValueOnce(new Error('TransactionCanceledException'));
      await expect(
        updateMemberRoles('table', PRINCIPAL, 'm1', ['MEMBER'], ['MEMBER', 'CHIEF'], 'actor-1'),
      ).rejects.toThrow('TransactionCanceledException');
    });
  });

  it('never writes a non-string value for any GSI key attribute (P6 regression guard)', async () => {
    sendMock.mockResolvedValueOnce({});
    await updateMemberStatus('table', PRINCIPAL, 'm1', 'PROBATIONARY', 'ACTIVE', 'actor-1');
    const items = lastCall().input.TransactItems ?? [];
    for (const item of items) {
      const record = item.Put?.Item ?? item.Update?.Key;
      if (!record) {
        continue;
      }
      for (const key of Object.keys(record)) {
        if (key.startsWith('gsi') || key === 'pk' || key === 'sk') {
          expect(typeof record[key]).toBe('string');
        }
      }
    }
  });
});
