import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { describe, expect, it, vi } from 'vitest';
import {
  admitTokenInvalidation,
  MASS_INVALIDATION_MAX_TOKENS,
  MASS_INVALIDATION_WINDOW_SECONDS,
  MassTokenInvalidationError,
} from './massInvalidationGuard.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

/** Applies `ADD tokenHashes :hash` per (pk, sk) like DynamoDB would, returning ALL_NEW. */
function windowTable() {
  const items = new Map<string, Set<string>>();
  const send = vi.fn((command: { input: Record<string, unknown> }) => {
    const key = command.input.Key as { pk: string; sk: string };
    const id = `${key.pk}|${key.sk}`;
    const hashes = items.get(id) ?? new Set<string>();
    const values = command.input.ExpressionAttributeValues as Record<string, Set<string>>;
    for (const hash of values[':hash']!) hashes.add(hash);
    items.set(id, hashes);
    return Promise.resolve({ Attributes: { tokenHashes: new Set(hashes) } });
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, send, items };
}

describe('admitTokenInvalidation (review M3)', () => {
  const now = 1_798_000_000_000;

  it(`admits up to ${MASS_INVALIDATION_MAX_TOKENS} distinct tokens per window, then refuses`, async () => {
    const table = windowTable();
    for (let i = 0; i < MASS_INVALIDATION_MAX_TOKENS; i += 1) {
      await expect(
        admitTokenInvalidation(table.client, 't', deptId, `tok-${i}`, now),
      ).resolves.toBeUndefined();
    }
    await expect(admitTokenInvalidation(table.client, 't', deptId, 'tok-x', now)).rejects.toThrow(
      MassTokenInvalidationError,
    );
  });

  it('counts a redelivered rejection of the same token once', async () => {
    const table = windowTable();
    for (let i = 0; i < MASS_INVALIDATION_MAX_TOKENS + 3; i += 1) {
      await expect(
        admitTokenInvalidation(table.client, 't', deptId, 'same-token', now),
      ).resolves.toBeUndefined();
    }
  });

  it('a new window starts a fresh count', async () => {
    const table = windowTable();
    for (let i = 0; i < MASS_INVALIDATION_MAX_TOKENS; i += 1) {
      await admitTokenInvalidation(table.client, 't', deptId, `tok-${i}`, now);
    }
    const later = now + MASS_INVALIDATION_WINDOW_SECONDS * 1000;
    await expect(
      admitTokenInvalidation(table.client, 't', deptId, 'tok-x', later),
    ).resolves.toBeUndefined();
  });

  it('keys the window by department, stores only a short hash, and sets a TTL', async () => {
    const table = windowTable();
    await admitTokenInvalidation(table.client, 'alerting-table', deptId, 'raw-device-token', now);
    const input = table.send.mock.calls[0]![0].input;
    expect((input.Key as { pk: string }).pk).toBe('DEPT#NICHOLS#PUSH_TOKEN_INVALIDATION');
    const values = input.ExpressionAttributeValues as Record<string, unknown>;
    const [hash] = [...(values[':hash'] as Set<string>)];
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(input)).not.toContain('raw-device-token');
    expect(values[':ttl']).toBeGreaterThan(now / 1000);
  });
});
