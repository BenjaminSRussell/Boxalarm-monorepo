import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WithAuthorizationOptions } from '@boxalarm/authz';

/**
 * decide.ts sends actionType/resourceType to Verified Permissions verbatim, and the deployed
 * Cedar schema (infrastructure/components/authz/cedar-policies.ts) only declares
 * Boxalarm::-qualified types. An unqualified literal such as 'Apparatus' can never match a
 * policy, so the route would be an implicit DENY for every caller. This pins every
 * apparatus-service route handler to the namespaced form and to the action IDs the policy
 * store grants.
 */

const HANDLER_MODULES: Record<string, string> = {
  './getChecklistHandler.js': 'GetChecklist',
  './postChecks.js': 'SubmitApparatusCheck',
  './reportDefectHandler.js': 'ReportDefect',
  './serviceStatusHandler.js': 'UpdateServiceStatus',
  './getMaintenance.js': 'ViewMaintenanceHistory',
  './postMaintenance.js': 'LogMaintenanceRecord',
  './postScba.js': 'LogScbaRecord',
  './getScbaTestingSchedules.js': 'ViewScbaTestingSchedules',
  './postTestRecord.js': 'LogApparatusTestRecord',
  './getTestingSchedules.js': 'ViewTestingSchedules',
  './getComplianceHandler.js': 'GetComplianceReport',
  './inventory-list/handler.js': 'ListCompartmentInventory',
  './inventory-create/handler.js': 'CreateCompartmentItem',
  './inventory-quantity/handler.js': 'UpdateCompartmentItemQuantity',
};

async function optionsFor(modulePath: string): Promise<WithAuthorizationOptions[]> {
  const captured: WithAuthorizationOptions[] = [];
  vi.resetModules();
  vi.doMock('@boxalarm/authz', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@boxalarm/authz')>();
    return {
      ...actual,
      withAuthorization: (inner: never, options: WithAuthorizationOptions) => {
        captured.push(options);
        return actual.withAuthorization(inner, options);
      },
    };
  });
  await import(modulePath);
  return captured;
}

describe('apparatus-service Cedar action references', () => {
  afterEach(() => {
    vi.doUnmock('@boxalarm/authz');
    vi.resetModules();
  });

  it.each(Object.entries(HANDLER_MODULES))(
    '%s authorizes %s with Boxalarm::-namespaced action and resource types',
    async (modulePath, actionId) => {
      const captured = await optionsFor(modulePath);
      expect(captured).toHaveLength(1);
      const [options] = captured;
      expect(options?.actionType).toBe('Boxalarm::Action');
      expect(options?.actionId).toBe(actionId);
      expect(options?.resourceType).toMatch(/^Boxalarm::(Apparatus|Department)$/);
    },
  );
});
