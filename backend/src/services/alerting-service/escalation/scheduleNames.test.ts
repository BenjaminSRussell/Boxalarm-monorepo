import { describe, expect, it } from 'vitest';
import { escalationScheduleName } from './scheduleEscalation.js';
import { toneScheduleName } from './toneLadder.js';

// Review MAJOR-R1: names were `...${toneSequence}`.slice(0, 64), which cut the tone off for
// real ids, so tone-2/3 schedules collided with tone 1 and were silently never created.
describe('EventBridge Scheduler names stay unique within 64 characters', () => {
  const deptId = 'nichols-volunteer-fire-department';
  const dispatchId = 'MANUAL-1798000000-3f9c2a7e-1b4d-4c8e-9a51-7d0e2f6b8c13';
  const memberId = '4a8f1c2e-7b3d-4e9a-8c61-2f5d0b7e9a34';

  it('gives each tone its own voice-escalation schedule for a Cognito-sub member', () => {
    const names = [1, 2, 3].map((tone) =>
      escalationScheduleName(deptId, dispatchId, memberId, tone),
    );
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
    expect(escalationScheduleName(deptId, dispatchId, memberId, 2)).toBe(names[1]);
    expect(escalationScheduleName(deptId, dispatchId, 'other-member', 2)).not.toBe(names[1]);
  });

  it('gives tone 2 and tone 3 their own evaluator schedule for a long deptId', () => {
    const two = toneScheduleName(deptId, dispatchId, 2);
    const three = toneScheduleName(deptId, dispatchId, 3);
    expect(two).not.toBe(three);
    expect(two.length).toBeLessThanOrEqual(64);
    expect(three.length).toBeLessThanOrEqual(64);
  });

  it('uses only characters EventBridge Scheduler allows in a name', () => {
    for (const name of [
      escalationScheduleName(deptId, dispatchId, memberId, 1),
      toneScheduleName(deptId, dispatchId, 3),
    ]) {
      expect(name).toMatch(/^[0-9a-zA-Z-_.]{1,64}$/);
    }
  });
});
