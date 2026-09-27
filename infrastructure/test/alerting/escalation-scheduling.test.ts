import { beforeEach, describe, expect, it } from "vitest";
import {
  SCHEDULING_LAMBDAS,
  buildSchedulingChain,
  installMocks,
  isGranted,
  lambdaEnv,
  resourcesOfType,
  statementsForRole,
} from "./mock-harness";

beforeEach(() => {
  installMocks();
});

describe(
  "Escalation schedule group — IAM scope and CreateSchedule GroupName agree",
  { timeout: 30_000 },
  () => {
    it.each(SCHEDULING_LAMBDAS)(
      "%s is told the dedicated group and may create schedules only inside it",
      async (functionName) => {
        await buildSchedulingChain();
        const [group] = resourcesOfType("aws:scheduler/scheduleGroup:ScheduleGroup");
        const groupName = group!.inputs.name as string;
        expect(groupName).toBe("boxalarm-dev-alerting-escalation");

        expect(lambdaEnv(functionName).ESCALATION_SCHEDULE_GROUP_NAME).toBe(groupName);

        const statements = statementsForRole(functionName);
        expect(
          isGranted(
            statements,
            "scheduler:CreateSchedule",
            `arn:aws:scheduler:us-east-1:123456789012:schedule/${groupName}/*`,
          ),
        ).toBe(true);
        // Least privilege: nothing grants the implicit `default` group.
        expect(
          isGranted(statements, "scheduler:CreateSchedule", (r) => r.includes("schedule/default/")),
        ).toBe(false);
      },
    );
  },
);

// Review MAJOR-2: a failed async evaluation was retried twice and then discarded, yet the
// re-publish of unsent pages and the mutual-aid rethrow depend on that retry landing.
describe(
  "Escalation and tone evaluator — failed async invocations are kept",
  { timeout: 30_000 },
  () => {
    it.each([
      ["boxalarm-dev-alerting-escalation", "escalation"],
      ["boxalarm-dev-alerting-tone-evaluator", "tone-evaluator"],
    ])("%s sends exhausted events to the escalation on-failure queue", async (functionName) => {
      await buildSchedulingChain();
      const [queue] = resourcesOfType("aws:sqs/queue:Queue").filter(
        (q) => q.inputs.name === "boxalarm-dev-alerting-escalation-onfailure",
      );
      expect(queue?.inputs.sqsManagedSseEnabled).toBe(true);
      const queueArn =
        "arn:aws:sqs:us-east-1:123456789012:boxalarm-dev-alerting-escalation-onfailure";

      const config = resourcesOfType(
        "aws:lambda/functionEventInvokeConfig:FunctionEventInvokeConfig",
      ).find((c) => c.inputs.functionName === functionName);
      expect(config?.inputs).toMatchObject({
        maximumRetryAttempts: 2,
        maximumEventAgeInSeconds: 3600,
        destinationConfig: { onFailure: { destination: queueArn } },
      });
      expect(isGranted(statementsForRole(functionName), "sqs:SendMessage", queueArn)).toBe(true);
    });
  },
);
