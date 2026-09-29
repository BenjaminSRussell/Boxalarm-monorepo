import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { describe, expect, it, vi } from 'vitest';
import {
  admitTokenInvalidation,
  MASS_INVALIDATION_LATCH_SECONDS,
  MASS_INVALIDATION_MAX_TOKENS,
  MASS_INVALIDATION_RECENT_TRIP_SECONDS,
  MASS_INVALIDATION_WINDOW_SECONDS,
  MassTokenInvalidationError,
} from './massInvalidationGuard.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

type Command = { constructor: { name: string }; input: Record<string, unknown> };

/** Get / Put / `ADD tokenHashes` UpdateItem over an in-memory (pk, sk) table, as DynamoDB would. */
function guardTable() {
  const items = new Map<string, Record<string, unknown>>();
  const id = (key: { pk: string; sk: string }) => `${key.pk}|${key.sk}`;
  const send = vi.fn((command: Command) => {
    const name = command.constructor.name;
    if (name === 'GetCommand') {
      return Promise.resolve({
        Item: items.get(id(command.input.Key as { pk: string; sk: string })),
      });
    }
    if (name === 'PutCommand') {
      const item = command.input.Item as { pk: string; sk: string };
      items.set(id(item), item);
      return Promise.resolve({});
    }
    const key = command.input.Key as { pk: string; sk: string };
    const existing = items.get(id(key)) ?? { ...key };
    const hashes = new Set((existing.tokenHashes as Set<string> | undefined) ?? []);
    const values = command.input.ExpressionAttributeValues as Record<string, unknown>;
    for (const hash of values[':hash'] as Set<string>) hashes.add(hash);
    const updated = { ...existing, tokenHashes: hashes, ttl: values[':ttl'] };
    items.set(id(key), updated);
    return Promise.resolve({ Attributes: { tokenHashes: new Set(hashes) } });
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, send, items };
}

const admit = (table: ReturnType<typeof guardTable>, token: string, nowMs: number) =>
  admitTokenInvalidation(table.client, 't', deptId, token, nowMs);

describe('admitTokenInvalidation (review M3, round 2 N4)', () => {
  // Aligned to a window start, so offsets below land where the test says.
  const windowStartMs =
    Math.floor(1_798_000_000 / MASS_INVALIDATION_WINDOW_SECONDS) *
    MASS_INVALIDATION_WINDOW_SECONDS *
    1000;

  it(`admits up to ${MASS_INVALIDATION_MAX_TOKENS} distinct tokens, then trips`, async () => {
    const table = guardTable();
    for (let i = 0; i < MASS_INVALIDATION_MAX_TOKENS; i += 1) {
      await expect(admit(table, `tok-${i}`, windowStartMs)).resolves.toBeUndefined();
    }
    await expect(admit(table, 'tok-x', windowStartMs)).rejects.toThrow(MassTokenInvalidationError);
  });

  it('counts a redelivered rejection of the same token once', async () => {
    const table = guardTable();
    for (let i = 0; i < MASS_INVALIDATION_MAX_TOKENS + 3; i += 1) {
      await expect(admit(table, 'same-token', windowStartMs)).resolves.toBeUndefined();
    }
  });

  it('a burst straddling a window boundary is still one burst', async () => {
    const table = guardTable();
    const endOfWindow = windowStartMs + MASS_INVALIDATION_WINDOW_SECONDS * 1000 - 1_000;
    for (let i = 0; i < MASS_INVALIDATION_MAX_TOKENS; i += 1) {
      await admit(table, `tok-${i}`, endOfWindow);
    }
    await expect(admit(table, 'tok-x', endOfWindow + 2_000)).rejects.toThrow(
      MassTokenInvalidationError,
    );
  });

  it('once tripped, the latch refuses every later invalidation, even in a fresh window, until it expires', async () => {
    const table = guardTable();
    for (let i = 0; i <= MASS_INVALIDATION_MAX_TOKENS; i += 1) {
      await admit(table, `tok-${i}`, windowStartMs).catch(() => undefined);
    }
    const latch = [...table.items.values()].find((item) => item.sk === 'TRIPPED');
    expect(latch?.ttl).toBe(windowStartMs / 1000 + MASS_INVALIDATION_LATCH_SECONDS);

    // Tone 3 (T+360s) and a much later redelivery: both refused, and nothing more is counted.
    const later = windowStartMs + 3 * MASS_INVALIDATION_WINDOW_SECONDS * 1000;
    await expect(admit(table, 'tok-late', later)).rejects.toThrow('guard is tripped');
    expect([...table.items.keys()].some((key) => key.endsWith(`WINDOW#${later / 1000}`))).toBe(
      false,
    );

    // Review round 3 R3-3: after the 1 h latch expires, the 24 h recent-trip record still admits
    // zero, so an unfixed misconfiguration cannot strip 3 more members every hour.
    const afterLatch = windowStartMs + (MASS_INVALIDATION_LATCH_SECONDS + 1) * 1000;
    await expect(admit(table, 'tok-after-latch', afterLatch)).rejects.toThrow(
      'within the last 24 hours',
    );
    const recent = [...table.items.values()].find((item) => item.sk === 'RECENT_TRIP');
    expect(recent?.ttl).toBe(windowStartMs / 1000 + MASS_INVALIDATION_RECENT_TRIP_SECONDS);

    // Refusals never extend it: once 24 h have passed (DynamoDB TTL deletion lags; the guard
    // checks expiry itself), invalidations are admitted again.
    const afterRecentTrip = windowStartMs + (MASS_INVALIDATION_RECENT_TRIP_SECONDS + 1) * 1000;
    await expect(admit(table, 'tok-next-day', afterRecentTrip)).resolves.toBeUndefined();
    expect(recent?.ttl).toBe(windowStartMs / 1000 + MASS_INVALIDATION_RECENT_TRIP_SECONDS);
  });

  it('a window two windows back no longer counts', async () => {
    const table = guardTable();
    for (let i = 0; i < MASS_INVALIDATION_MAX_TOKENS; i += 1) {
      await admit(table, `tok-${i}`, windowStartMs);
    }
    const twoWindowsLater = windowStartMs + 2 * MASS_INVALIDATION_WINDOW_SECONDS * 1000;
    await expect(admit(table, 'tok-x', twoWindowsLater)).resolves.toBeUndefined();
  });

  it('keys everything by department, stores only a short hash, and sets TTLs', async () => {
    const table = guardTable();
    await admitTokenInvalidation(
      table.client,
      'alerting-table',
      deptId,
      'raw-device-token',
      windowStartMs,
    );
    const update = table.send.mock.calls
      .map(([command]) => command)
      .find((command) => command.constructor.name === 'UpdateCommand')!;
    expect((update.input.Key as { pk: string }).pk).toBe('DEPT#NICHOLS#PUSH_TOKEN_INVALIDATION');
    const values = update.input.ExpressionAttributeValues as Record<string, unknown>;
    const [hash] = [...(values[':hash'] as Set<string>)];
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(table.send.mock.calls)).not.toContain('raw-device-token');
    expect(values[':ttl']).toBeGreaterThan(windowStartMs / 1000);
  });
});

describe('operator re-opening the guard (review round 3 R3-3)', () => {
  it('deleting both trip items re-admits invalidations immediately', async () => {
    const table = guardTable();
    const t0 = 1_798_000_000_000;
    for (let i = 0; i <= MASS_INVALIDATION_MAX_TOKENS; i += 1) {
      await admit(table, `tok-${i}`, t0).catch(() => undefined);
    }
    for (const key of [...table.items.keys()]) {
      if (key.endsWith('|TRIPPED') || key.endsWith('|RECENT_TRIP') || key.includes('WINDOW#')) {
        table.items.delete(key);
      }
    }
    await expect(admit(table, 'tok-fresh', t0 + 60_000)).resolves.toBeUndefined();
  });
});
