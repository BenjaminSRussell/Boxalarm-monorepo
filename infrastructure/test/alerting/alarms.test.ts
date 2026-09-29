import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { AlertingAlarms } from "../../components/alerting/alarms";
import { MessagingAlerting } from "../../components/alerting/messaging-alerting";
import { alarmByName, installMocks, resourcesOfType, settle } from "./mock-harness";

const PAGE_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";

async function build(env = "dev") {
  const messaging = new MessagingAlerting("messaging-alerting", { env });
  const alarms = new AlertingAlarms("alerting-alarms", {
    env,
    channelQueues: messaging.channelQueues,
    fanOutFunctionName: "boxalarm-dev-alerting-fan-out",
    fanOutOnFailureQueue: new aws.sqs.Queue("fan-out-onfailure", {
      name: "boxalarm-dev-alerting-fan-out-onfailure",
    }),
    escalationFunctionName: "boxalarm-dev-alerting-escalation",
    toneEvaluatorFunctionName: "boxalarm-dev-alerting-tone-evaluator",
    escalationOnFailureQueue: new aws.sqs.Queue("escalation-onfailure", {
      name: "boxalarm-dev-alerting-escalation-onfailure",
    }),
    memberUpdatedDlq: new aws.sqs.Queue("member-updated-dlq", {
      name: "boxalarm-dev-alerting-member-updated-dlq",
    }),
    memberUpdatedFunctionName: "boxalarm-dev-alerting-member-updated-consumer",
  });
  await settle();
  return alarms;
}

describe("AlertingAlarms — page routing", { timeout: 30_000 }, () => {
  it("subscribes the configured email to alerting-page", async () => {
    installMocks({ "boxalarm-infra:alertingPageEmail": "oncall@example.test" });
    await build();
    const subscriptions = resourcesOfType("aws:sns/topicSubscription:TopicSubscription").filter(
      (s) => s.inputs.topic === PAGE_TOPIC_ARN,
    );
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.inputs).toMatchObject({
      protocol: "email",
      endpoint: "oncall@example.test",
    });
  });

  it("warns (rather than staying silent) when no page email is configured", async () => {
    installMocks();
    const warn = vi.spyOn(pulumi.log, "warn");
    await build();
    expect(
      resourcesOfType("aws:sns/topicSubscription:TopicSubscription").filter(
        (s) => s.inputs.topic === PAGE_TOPIC_ARN,
      ),
    ).toHaveLength(0);
    expect(warn.mock.calls.some(([message]) => String(message).includes("alertingPageEmail"))).toBe(
      true,
    );
    warn.mockRestore();
  });

  it("fails preview in prod when no page email is configured", async () => {
    installMocks({ "boxalarm-infra:env": "prod" });
    await expect(build("prod")).rejects.toThrow(/alertingPageEmail is required in prod/);
  });

  it("subscribes the configured email in prod", async () => {
    installMocks({
      "boxalarm-infra:env": "prod",
      "boxalarm-infra:alertingPageEmail": "oncall@example.test",
    });
    await build("prod");
    const subscriptions = resourcesOfType("aws:sns/topicSubscription:TopicSubscription").filter(
      (s) => s.inputs.topic === "arn:aws:sns:us-east-1:123456789012:boxalarm-prod-alerting-page",
    );
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.inputs).toMatchObject({
      protocol: "email",
      endpoint: "oncall@example.test",
    });
  });
});

describe("AlertingAlarms — every alert-path failure mode pages", { timeout: 30_000 }, () => {
  beforeEach(() => {
    installMocks();
  });

  it.each([
    [
      "boxalarm-dev-alerting-fan-out-errors",
      "Errors",
      { FunctionName: "boxalarm-dev-alerting-fan-out" },
    ],
    [
      "boxalarm-dev-alerting-fan-out-iterator-age",
      "IteratorAge",
      { FunctionName: "boxalarm-dev-alerting-fan-out" },
    ],
    [
      "boxalarm-dev-alerting-fan-out-onfailure-not-empty",
      "ApproximateNumberOfMessagesVisible",
      { QueueName: "boxalarm-dev-alerting-fan-out-onfailure" },
    ],
    [
      "boxalarm-dev-alerting-escalation-onfailure",
      "ApproximateNumberOfMessagesVisible",
      { QueueName: "boxalarm-dev-alerting-escalation-onfailure" },
    ],
    [
      "boxalarm-dev-alerting-escalation-errors",
      "Errors",
      { FunctionName: "boxalarm-dev-alerting-escalation" },
    ],
    [
      "boxalarm-dev-alerting-escalation-throttles",
      "Throttles",
      { FunctionName: "boxalarm-dev-alerting-escalation" },
    ],
    [
      "boxalarm-dev-alerting-tone-evaluator-errors",
      "Errors",
      { FunctionName: "boxalarm-dev-alerting-tone-evaluator" },
    ],
    [
      "boxalarm-dev-alerting-tone-evaluator-throttles",
      "Throttles",
      { FunctionName: "boxalarm-dev-alerting-tone-evaluator" },
    ],
    [
      "boxalarm-dev-alerting-member-updated-dlq-not-empty",
      "ApproximateNumberOfMessagesVisible",
      { QueueName: "boxalarm-dev-alerting-member-updated-dlq" },
    ],
    [
      "boxalarm-dev-alerting-member-updated-consumer-errors",
      "Errors",
      { FunctionName: "boxalarm-dev-alerting-member-updated-consumer" },
    ],
    ["boxalarm-dev-alerting-push-delivery-failure-rate", "SendFailed", { Reason: "push" }],
    ["boxalarm-dev-alerting-push-token-invalid-rate", "TokenInvalid", { Reason: "push" }],
    [
      "boxalarm-dev-alerting-push-mass-invalidation-blocked",
      "MassInvalidationBlocked",
      { Reason: "push" },
    ],
    ["boxalarm-dev-alerting-sms-delivery-failure-rate", "SendFailed", { Reason: "sms" }],
    ["boxalarm-dev-alerting-voice-delivery-failure-rate", "SendFailed", { Reason: "voice" }],
    [
      "boxalarm-dev-alerting-sms-oldest-message-age",
      "ApproximateAgeOfOldestMessage",
      { QueueName: "boxalarm-dev-alerting-sms-queue.fifo" },
    ],
  ])("%s", async (alarmName, metricName, dimensions) => {
    await build();
    const alarm = alarmByName(alarmName).inputs;
    expect(alarm.metricName).toBe(metricName);
    expect(alarm.dimensions).toEqual(dimensions);
    expect(alarm.alarmActions).toEqual([PAGE_TOPIC_ARN]);
  });

  // Review MINOR-R4: the page had no redrive path. The alarm names the runbook and script,
  // and both must exist where it says.
  it("points the escalation on-failure page at its runbook and redrive script", async () => {
    await build();
    const description = String(
      alarmByName("boxalarm-dev-alerting-escalation-onfailure").inputs.alarmDescription,
    );
    const repoRoot = path.resolve(__dirname, "../../..");
    for (const referenced of [
      "docs/runbooks/alerting-escalation-onfailure.md",
      "infrastructure/scripts/redrive-escalation-onfailure.sh",
    ]) {
      expect(description).toContain(referenced);
      expect(fs.existsSync(path.join(repoRoot, referenced)), referenced).toBe(true);
    }
  });

  // Review minor 2: production gateway misconfigurations dead-letter on purpose; the page must
  // say so, so on-call fixes the secret instead of chasing a vendor outage.
  it("the push DLQ page names the configuration faults that dead-letter on purpose", async () => {
    await build();
    const description = String(
      alarmByName("boxalarm-dev-alerting-push-dlq-not-empty").inputs.alarmDescription,
    );
    for (const cause of [
      "DeviceTokenNotForTopic",
      "SENDER_ID_MISMATCH",
      "credentials",
      "environment",
      "redrive",
    ]) {
      expect(description).toContain(cause);
    }
  });

  it("gives every alarm it owns a page action", async () => {
    await build();
    const alarms = resourcesOfType("aws:cloudwatch/metricAlarm:MetricAlarm");
    expect(alarms.length).toBeGreaterThan(0);
    for (const alarm of alarms) {
      expect(alarm.inputs.alarmActions, alarm.inputs.name as string).toEqual([PAGE_TOPIC_ARN]);
    }
  });
});
