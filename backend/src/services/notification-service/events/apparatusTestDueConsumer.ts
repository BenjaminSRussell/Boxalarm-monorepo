import { APPARATUS_TEST_DUE_CATEGORY } from '../reminders/categories.js';
import { createReminderConsumer, optionalString, requireString } from './reminderIngest.js';

const LABEL = 'apparatus.test.due';

const TEST_LABEL: Record<string, string> = {
  SCBA_FLOW: 'flow',
  SCBA_HYDRO: 'hydrostatic',
};

function testLabel(testType: string): string {
  return TEST_LABEL[testType] ?? testType.toLowerCase().replaceAll('_', ' ');
}

/**
 * apparatus.test.due -> an apparatus-test-due reminder for the APPARATUS role and the chief.
 * Two scanners publish it: testDueScanner (hose/ladder/pump/aerial — apparatusId, testType,
 * dueDate) and apparatusTestingScanner (SCBA flow/hydro — the same plus scbaUnitId and
 * cylinderId). The event names the apparatus by apparatusId, not the display unitId the
 * apparatus detail page is keyed on, so the item links to the apparatus list, whose
 * due-soon panel shows it.
 */
export const handler = createReminderConsumer({
  label: LABEL,
  acceptedEventTypes: new Set([LABEL]),
  logPrefix: 'notification.apparatusTestDue',
  metricPrefix: 'ApparatusTestDue',
  toReminder: ({ payload }) => {
    const apparatusId = requireString(payload, 'apparatusId', LABEL);
    const testType = requireString(payload, 'testType', LABEL);
    const dueDate = requireString(payload, 'dueDate', LABEL);
    const scbaUnitId = optionalString(payload, 'scbaUnitId');
    const what = scbaUnitId
      ? `SCBA ${scbaUnitId} ${testLabel(testType)} test`
      : `${testLabel(testType)} test`;
    return {
      deptId: requireString(payload, 'deptId', LABEL),
      category: APPARATUS_TEST_DUE_CATEGORY,
      item: {
        subjectId: `${scbaUnitId ?? apparatusId}:${testType}`,
        title: apparatusId,
        detail: `${what} due ${dueDate}`,
        dueDate,
        link: { kind: 'apparatus' },
      },
    };
  },
});
