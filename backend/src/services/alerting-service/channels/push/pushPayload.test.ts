import { describe, expect, it } from 'vitest';
import {
  apnsCollapseId,
  apnsIdFor,
  buildApnsPayload,
  pushDataFields,
  type PushNotification,
} from './pushPayload.js';

const dispatch: PushNotification = {
  token: 'tok',
  alertKind: 'dispatch',
  dispatchId: 'dispatch-1',
  toneSequence: 1,
  title: 'STRUCTURE_FIRE',
  body: 'STRUCTURE_FIRE — 12 Main St',
  idempotencyKey: 'dispatch-1#1#mbr-1#PUSH',
  collapseKey: 'dispatch-1#1',
};

const prompt: PushNotification = {
  ...dispatch,
  alertKind: 'mutual_aid_prompt',
  toneSequence: undefined,
  title: 'MUTUAL AID REQUESTED',
  idempotencyKey: 'dispatch-1#MUTUALAID#officer-1#PUSH#SEND',
  collapseKey: 'dispatch-1#MUTUALAID',
};

describe('push payloads', () => {
  // The architecture reserves the non-critical push channel for notification-service (LOB
  // plane); nothing on the alerting plane — the mutual-aid prompt included — is non-critical.
  it.each([
    ['a dispatch page', dispatch],
    ['the officer mutual-aid prompt', prompt],
  ])('%s is a critical alert routed to the app’s dispatch-critical channel', (_label, n) => {
    const aps = buildApnsPayload(n, 'critical').aps as Record<string, unknown>;
    expect(aps['interruption-level']).toBe('critical');
    expect(aps.sound).toEqual({ critical: 1, name: 'default', volume: 1 });
    // The app treats anything but category 'digest' as critical (pushChannel.ts).
    expect(pushDataFields(n).category).toBe('dispatch');
  });

  it('the prompt carries no toneSequence; a dispatch page carries it as a string', () => {
    expect(pushDataFields(prompt)).not.toHaveProperty('toneSequence');
    expect(pushDataFields(dispatch).toneSequence).toBe('1');
  });

  it('keeps a short collapse id verbatim and hashes one over 64 bytes to 64 hex chars', () => {
    expect(apnsCollapseId('dispatch-1#2')).toBe('dispatch-1#2');
    const long = apnsCollapseId(`${'x'.repeat(70)}#2`);
    expect(long).toMatch(/^[0-9a-f]{64}$/);
  });

  it('apns-id is a stable UUID per exactly-once key', () => {
    expect(apnsIdFor('a#1#m#PUSH')).toBe(apnsIdFor('a#1#m#PUSH'));
    expect(apnsIdFor('a#1#m#PUSH')).not.toBe(apnsIdFor('a#2#m#PUSH'));
  });
});
