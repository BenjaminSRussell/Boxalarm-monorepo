import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import {
  TestDueScanners,
  TEST_DUE_SCANNER_SCHEDULE_EXPRESSION,
} from "../../components/apparatus/test-due-scanners";
import {
  ACCOUNT_ID,
  REGION,
  alarmByName,
  installMocks,
  isGranted,
  lambdaByName,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
} from "../alerting/mock-harness";

/**
 * The two daily apparatus test-due scanners: env and IAM asserted against what
 * testDueScanner/ and apparatusTestingScanner/ actually read and call, and their schedules
 * pinned before notification-service's 12:00 UTC digest.
 */

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const GSI2 = `${TABLE}/index/GSI2`;
const GSI3 = `${TABLE}/index/GSI3`;
const BUS = `arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/boxalarm-dev-platform-bus`;
const TEST_DUE = "boxalarm-dev-apparatus-test-due-scanner";
const SCBA = "boxalarm-dev-apparatus-scba-test-due-scanner";

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("apparatus-lg", {
    env: "dev",
    serviceName: "apparatus-service",
  });
  new TestDueScanners("scanners", {
    env: "dev",
    deptId: "nichols-fd",
    platformTableName: "boxalarm-dev-platform-service",
    platformTableArn: pulumi.output(TABLE),
    platformBusName: "boxalarm-dev-platform-bus",
    platformBusArn: BUS,
    logGroup,
  });
  await settle();
}

describe("apparatus test-due scanners", { timeout: 30_000 }, () => {
  it("the apparatus test scanner reads its lead-day config, Queries GSI2, writes its marker and publishes", async () => {
    await build();
    const s = statementsForRole(TEST_DUE);
    expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
    expect(isGranted(s, "dynamodb:Query", GSI2)).toBe(true);
    expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
    expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
    expect(isGranted(s, "events:PutEvents", BUS)).toBe(true);
  });

  it("the SCBA scanner Queries GSI2, writes its marker and publishes, with no config read", async () => {
    await build();
    const s = statementsForRole(SCBA);
    expect(isGranted(s, "dynamodb:Query", GSI2)).toBe(true);
    expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
    expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
    expect(isGranted(s, "events:PutEvents", BUS)).toBe(true);
    expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(false);
  });

  it.each([TEST_DUE, SCBA])("%s holds nothing else (least privilege)", async (fn) => {
    await build();
    const s = statementsForRole(fn);
    expect(isGranted(s, "dynamodb:DeleteItem", TABLE)).toBe(false);
    expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(false);
    expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(false);
    expect(isGranted(s, "events:PutEvents", (r) => r.endsWith("*"))).toBe(false);
    const deny = s.find((st) => st.Sid === "DenyAuditMutations");
    expect(deny?.Effect).toBe("Deny");
    const touchesAlerting = s.some((st) =>
      (Array.isArray(st.Resource) ? st.Resource : [st.Resource]).some((r) =>
        r.includes("alerting"),
      ),
    );
    expect(touchesAlerting).toBe(false);
    expect(lambdaByName(fn).inputs.reservedConcurrentExecutions).toBeUndefined();
  });

  it.each([
    [TEST_DUE, "APPARATUS_TEST_SCANNER_DEPT_ID"],
    [SCBA, "APPARATUS_SCANNER_DEPT_ID"],
  ])("%s carries the table, bus and its own deptId key", async (fn, deptKey) => {
    await build();
    const env = lambdaEnv(fn);
    expect(env.PLATFORM_TABLE_NAME).toBe("boxalarm-dev-platform-service");
    expect(env.PLATFORM_EVENT_BUS_NAME).toBe("boxalarm-dev-platform-bus");
    expect(env[deptKey]).toBe("nichols-fd");
  });

  describe.each([
    ["apparatus-test-due-scanner", TEST_DUE],
    ["apparatus-scba-test-due-scanner", SCBA],
  ])("%s daily schedule", (baseName, functionName) => {
    it("runs at 10:00 UTC, before the digest, retries, dead-letters and alarms", async () => {
      await build();
      const schedule = resourcesOfType("aws:scheduler/schedule:Schedule").find(
        (r) => r.inputs.name === `boxalarm-dev-${baseName}-daily`,
      );
      expect(schedule?.inputs.scheduleExpression).toBe(TEST_DUE_SCANNER_SCHEDULE_EXPRESSION);
      expect(TEST_DUE_SCANNER_SCHEDULE_EXPRESSION).toBe("cron(0 10 * * ? *)");
      expect(schedule?.inputs.scheduleExpressionTimezone).toBe("UTC");
      const target = schedule?.inputs.target as {
        arn?: string;
        input?: string;
        retryPolicy?: { maximumRetryAttempts: number };
        deadLetterConfig?: { arn: string };
      };
      expect(target.arn).toBe(`arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${functionName}`);
      expect(JSON.parse(target.input ?? "{}")).toEqual({ id: "<aws.scheduler.execution-id>" });
      expect(target.retryPolicy?.maximumRetryAttempts).toBe(3);
      const dlqArn = `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:boxalarm-dev-${baseName}-dlq`;
      expect(target.deadLetterConfig?.arn).toBe(dlqArn);

      const scheduler = statementsForRole(`boxalarm-dev-${baseName}-scheduler`);
      expect(isGranted(scheduler, "sqs:SendMessage", dlqArn)).toBe(true);
      expect(isGranted(scheduler, "lambda:InvokeFunction", target.arn!)).toBe(true);

      expect(alarmByName(`boxalarm-dev-${baseName}-dlq-depth`).inputs.threshold).toBe(0);
      expect(alarmByName(`boxalarm-dev-${baseName}-errors`).inputs.dimensions).toEqual({
        FunctionName: functionName,
      });
    });
  });
});
