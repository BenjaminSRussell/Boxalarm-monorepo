import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { Reminders } from "../../components/notification/reminders";
import {
  ACCOUNT_ID,
  REGION,
  alarmByName,
  esmFor,
  installMocks,
  isGranted,
  lambdaByName,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
} from "../alerting/mock-harness";

/**
 * The reminder consumers: each rule matches exactly what its producer sends (Source +
 * DetailType), drains through its own queue + DLQ, and the Lambda holds only the platform
 * table actions its handler makes (events/*Consumer.ts, reminderIngest.ts).
 */

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const GSI2 = `${TABLE}/index/GSI2`;
const GSI3 = `${TABLE}/index/GSI3`;
const BUS_ARN = `arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/boxalarm-dev-platform-bus`;
const PUSH_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:boxalarm-dev-notification-push`;
const FROM = "notifications@nichols.example";
const SES_IDENTITY = `arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity`;

const fn = (key: string) => `boxalarm-dev-notification-${key}-consumer`;
const DIGEST_ONLY = ["apparatus-test-due", "inventory-reorder", "ppe-expiry"];
const ALL = [...DIGEST_ONLY, "apparatus-defect"];

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("notification-lg", {
    env: "dev",
    serviceName: "notification-service",
  });
  new Reminders("reminders", {
    env: "dev",
    platformTableName: "boxalarm-dev-platform-service",
    platformTableArn: pulumi.output(TABLE),
    platformBusName: "boxalarm-dev-platform-bus",
    platformBusArn: BUS_ARN,
    pushTopicArn: pulumi.output(PUSH_TOPIC),
    sesFromAddress: FROM,
    logGroup,
  });
  await settle();
}

describe("notification reminder consumers", { timeout: 30_000 }, () => {
  it.each([
    ["apparatus-test-due", "apparatus-service", ["apparatus.test.due"]],
    ["apparatus-defect", "apparatus-service", ["apparatus.defect.reported"]],
    ["inventory-reorder", "inventory-service", ["inventory.reorder.due"]],
    ["ppe-expiry", "inventory-service", ["ppe.expiry.due", "inventory.expiry.due"]],
  ])(
    "%s: a platform-bus rule matching its producer's Source and DetailType",
    async (key, source, types) => {
      await build();
      const rule = resourcesOfType("aws:cloudwatch/eventRule:EventRule").find(
        (r) => r.inputs.name === `boxalarm-dev-notification-${key}`,
      );
      expect(rule?.inputs.eventBusName).toBe("boxalarm-dev-platform-bus");
      expect(JSON.parse(rule?.inputs.eventPattern as string)).toEqual({
        source: [source],
        "detail-type": types,
      });
      const target = resourcesOfType("aws:cloudwatch/eventTarget:EventTarget").find(
        (t) => t.inputs.rule === `boxalarm-dev-notification-${key}`,
      );
      expect(target?.inputs.arn).toBe(
        `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:boxalarm-dev-notification-${key}-queue`,
      );
    },
  );

  it.each(ALL)(
    "%s: drains its own queue with a concurrency cap, redrives to a DLQ, and alarms on it",
    async (key) => {
      await build();
      const queueName = `boxalarm-dev-notification-${key}-queue`;
      const esm = esmFor(fn(key));
      expect(esm.inputs.eventSourceArn).toBe(`arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${queueName}`);
      expect((esm.inputs.scalingConfig as { maximumConcurrency: number }).maximumConcurrency).toBe(
        5,
      );
      const queue = resourcesOfType("aws:sqs/queue:Queue").find((q) => q.inputs.name === queueName);
      const redrive = JSON.parse(queue?.inputs.redrivePolicy as string) as {
        deadLetterTargetArn: string;
      };
      expect(redrive.deadLetterTargetArn).toBe(
        `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${queueName}-dlq`,
      );
      expect(alarmByName(`${queueName}-dlq-depth`).inputs.threshold).toBe(0);
      expect(
        isGranted(statementsForRole(fn(key)), "sqs:ReceiveMessage", (r) => r.includes(queueName)),
      ).toBe(true);
      expect(lambdaByName(fn(key)).inputs.timeout as number).toBeLessThan(30);
    },
  );

  it.each(DIGEST_ONLY)(
    "%s: PutItems its pending rows + eventId marker and nothing else",
    async (key) => {
      await build();
      const s = statementsForRole(fn(key));
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      for (const action of ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]) {
        expect(isGranted(s, action, TABLE), action).toBe(false);
      }
      for (const index of [TABLE, GSI2, GSI3]) {
        expect(isGranted(s, "dynamodb:Query", index), index).toBe(false);
      }
      expect(isGranted(s, "sns:Publish", (r) => r.length > 0)).toBe(false);
      expect(isGranted(s, "ses:SendEmail", (r) => r.length > 0)).toBe(false);
      expect(lambdaEnv(fn(key)).PLATFORM_SERVICE_TABLE_NAME).toBe("boxalarm-dev-platform-service");
    },
  );

  it("apparatus-defect: reads the roster and mutes, writes inbox rows and releasable claims, pushes on the notification topic and emails", async () => {
    await build();
    const s = statementsForRole(fn("apparatus-defect"));
    expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
    for (const action of ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]) {
      expect(isGranted(s, action, TABLE), action).toBe(true);
    }
    expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(false);
    expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(false);
    expect(isGranted(s, "sns:Publish", PUSH_TOPIC)).toBe(true);
    expect(isGranted(s, "sns:Publish", (r) => r.includes("alerting") || r.endsWith("*"))).toBe(
      false,
    );
    // Out-of-service units are emailed at once (review M1), on the digest's sender identity only.
    expect(isGranted(s, "ses:SendEmail", `${SES_IDENTITY}/${FROM}`)).toBe(true);
    expect(isGranted(s, "ses:SendEmail", `${SES_IDENTITY}/nichols.example`)).toBe(true);
    expect(isGranted(s, "ses:SendEmail", (r) => r.endsWith("*"))).toBe(false);
    expect(s.find((st) => st.Sid === "DenyAuditMutations")?.Effect).toBe("Deny");
    const env = lambdaEnv(fn("apparatus-defect"));
    expect(env.PLATFORM_SERVICE_TABLE_NAME).toBe("boxalarm-dev-platform-service");
    expect(env.NOTIFICATION_PUSH_TOPIC_ARN).toBe(PUSH_TOPIC);
    expect(env.NOTIFICATION_SES_FROM_ADDRESS).toBe(FROM);
  });

  it("no reminder consumer reserves concurrency or touches the alerting plane", async () => {
    await build();
    for (const key of ALL) {
      expect(lambdaByName(fn(key)).inputs.reservedConcurrentExecutions, key).toBeUndefined();
      const touchesAlerting = statementsForRole(fn(key)).some((st) =>
        (Array.isArray(st.Resource) ? st.Resource : [st.Resource]).some((r) =>
          r.includes("alerting"),
        ),
      );
      expect(touchesAlerting, key).toBe(false);
    }
  });
});
