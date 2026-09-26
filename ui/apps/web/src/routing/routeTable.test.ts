import { describe, expect, test } from 'vitest';
import { canAccessPath, firstGrantedNavPath, routesForRoles } from './routeTable';

describe('routeTable', () => {
  test('CHIEF nav includes dashboard, roster, audit-log; excludes settings', () => {
    const labels = routesForRoles(['CHIEF']).map((r) => r.label);
    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Live roster');
    expect(labels).toContain('Audit log');
    expect(labels).not.toContain('Settings');
    expect(labels).not.toContain('Certifications');
  });

  test('ADMIN nav includes settings and audit-log; excludes dashboard', () => {
    const labels = routesForRoles(['ADMIN']).map((r) => r.label);
    expect(labels).toContain('Settings');
    expect(labels).toContain('Audit log');
    expect(labels).toContain('Personnel');
    expect(labels).not.toContain('Dashboard');
    expect(labels).not.toContain('Live roster');
  });

  test('MEMBER has no PrimaryNav domain routes', () => {
    expect(routesForRoles(['MEMBER'])).toEqual([]);
    expect(firstGrantedNavPath(['MEMBER'])).toBeNull();
  });

  test('every role can reach its own notification inbox, which stays out of PrimaryNav', () => {
    for (const role of ['MEMBER', 'OFFICER', 'TRAINING', 'APPARATUS', 'ADMIN', 'CHIEF'] as const) {
      expect(canAccessPath('/notifications', [role])).toBe(true);
      expect(routesForRoles([role]).map((r) => r.navPath)).not.toContain('/notifications');
    }
  });

  test('canAccessPath enforces role grants including param routes', () => {
    expect(canAccessPath('/settings', ['ADMIN'])).toBe(true);
    expect(canAccessPath('/settings', ['CHIEF'])).toBe(false);
    expect(canAccessPath('/personnel/abc', ['OFFICER'])).toBe(true);
    expect(canAccessPath('/personnel/abc', ['MEMBER'])).toBe(false);
    expect(canAccessPath('/audit-log', ['CHIEF'])).toBe(true);
  });
});
