import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { Inbox } from "../../components/notification/inbox";
import { Digest, DIGEST_SCHEDULE_EXPRESSION } from "../../components/notification/digest";
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
 * notification-service Lambdas: each one's env keys and IAM grants, asserted against what
 * its backend handler actually reads and calls (inbox/handler.ts, preferences/handler.ts,
 * events/certExpiryConsumer.ts, digest/digestJob.ts, channelSender.ts) — including the
 * index ARNs its queries need, which a table-only grant silently denies.
 */

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const GSI1 = `${TABLE}/index/GSI1`;
const GSI2 = `${TABLE}/index/GSI2`;
const GSI3 = `${TABLE}/index/GSI3`;
const BUS_ARN = `arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/boxalarm-dev-platform-bus`;
const PUSH_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:boxalarm-dev-notification-push`;
const FROM = "notifications@nichols.example";

const INBOX = "boxalarm-dev-notification-inbox";
const PREFERENCES = "boxalarm-dev-notification-preferences";
const CONSUMER = "boxalarm-dev-notification-cert-expiry-consumer";
const DIGEST = "boxalarm-dev-notification-digest-job";

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("notification-lg", {
    env: "dev",
    serviceName: "notification-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup: logGroup,
  });
  const table = {
    platformTableName: "boxalarm-dev-platform-service",
    // An Output, as index.ts passes it — proves index ARNs are resolved, not stringified.
    platformTableArn: pulumi.output(TABLE),
  };
  new Inbox("inbox", {
    env: "dev",
    ...table,
    policyStoreArn: `arn:aws:verifiedpermissions::${ACCOUNT_ID}:policy-store/ps-1`,
    policyStoreId: "ps-1",
    logGroup,
    httpApi,
  });
  new Digest("digest", {
    env: "dev",
    deptId: "nichols-fd",
    ...table,
    platformBusName: "boxalarm-dev-platform-bus",
    platformBusArn: BUS_ARN,
    sesFromAddress: FROM,
    logGroup,
  });
  await settle();
}

function routeKeys(): string[] {
  return resourcesOfType("aws:apigatewayv2/route:Route").map((r) => r.inputs.routeKey as string);
}

describe("notification Lambdas: env and IAM match their handlers", { timeout: 30_000 }, () => {
  describe("routes", () => {
    it("deploys exactly the four inbox/preference routes the web and mobile clients call", async () => {
      await build();
      expect(routeKeys().sort()).toEqual([
        "GET /api/v1/notifications",
        "GET /api/v1/notifications/preferences",
        "POST /api/v1/notifications/{id}/read",
        "PUT /api/v1/notifications/preferences",
      ]);
      expect(routeKeys().some((k) => / \/notifications/.test(k))).toBe(false);
    });

    it("every route carries the shared CUSTOM authorizer", async () => {
      await build();
      for (const route of resourcesOfType("aws:apigatewayv2/route:Route")) {
        expect(route.inputs.authorizationType, route.inputs.routeKey as string).toBe("CUSTOM");
        expect(route.inputs.authorizerId).toBeTruthy();
      }
    });

    it("routes each path to the Lambda whose handler dispatches it", async () => {
      await build();
      const integrations = resourcesOfType("aws:apigatewayv2/integration:Integration");
      const uriFor = (routeKey: string) => {
        const route = resourcesOfType("aws:apigatewayv2/route:Route").find(
          (r) => r.inputs.routeKey === routeKey,
        );
        const integrationId = (route?.inputs.target as string).replace("integrations/", "");
        const integration = integrations.find((i) => `${i.name}-id` === integrationId);
        return integration?.inputs.integrationUri as string;
      };
      expect(uriFor("GET /api/v1/notifications")).toContain(`function:${INBOX}/`);
      expect(uriFor("POST /api/v1/notifications/{id}/read")).toContain(`function:${INBOX}/`);
      expect(uriFor("GET /api/v1/notifications/preferences")).toContain(`function:${PREFERENCES}/`);
      expect(uriFor("PUT /api/v1/notifications/preferences")).toContain(`function:${PREFERENCES}/`);
    });
  });

  describe("inbox", () => {
    it("can Query the base table (list) and GSI1 (mark-read lookup) and UpdateItem readAt", async () => {
      await build();
      const s = statementsForRole(INBOX);
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", GSI1)).toBe(true);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
    });

    it("holds no other data-plane action (least privilege)", async () => {
      await build();
      const s = statementsForRole(INBOX);
      for (const action of ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:GetItem"]) {
        expect(isGranted(s, action, TABLE), action).toBe(false);
      }
      expect(isGranted(s, "dynamodb:Query", GSI2)).toBe(false);
      expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(false);
    });
  });

  describe("preferences", () => {
    it("can Query and PutItem the base table and nothing else", async () => {
      await build();
      const s = statementsForRole(PREFERENCES);
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      for (const action of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:GetItem"]) {
        expect(isGranted(s, action, TABLE), action).toBe(false);
      }
    });
  });

  describe("cert-expiry consumer (EventBridge -> SQS)", () => {
    it("PutItems its two DIGEST_PENDING rows (TransactWrite items) and nothing else on the table", async () => {
      await build();
      const s = statementsForRole(CONSUMER);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      for (const action of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]) {
        expect(isGranted(s, action, TABLE), action).toBe(false);
      }
    });

    it("subscribes a platform-bus rule for the training scanner's cert.expiry.due events", async () => {
      await build();
      const rule = resourcesOfType("aws:cloudwatch/eventRule:EventRule").find(
        (r) => r.inputs.name === "boxalarm-dev-notification-cert-expiry-due",
      );
      expect(rule?.inputs.eventBusName).toBe("boxalarm-dev-platform-bus");
      // Must match what publishDueEvents.ts sends: Source training-service, DetailType
      // cert.expiry.due (training.expiry.due is the N-5 rename, accepted in advance).
      expect(JSON.parse(rule?.inputs.eventPattern as string)).toEqual({
        source: ["training-service"],
        "detail-type": ["cert.expiry.due", "training.expiry.due"],
      });
    });

    it("drains its queue with a concurrency cap, redrives to a DLQ, and alarms on DLQ depth", async () => {
      await build();
      const esm = esmFor(CONSUMER);
      expect(esm.inputs.eventSourceArn).toBe(
        `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:boxalarm-dev-notification-cert-expiry-queue`,
      );
      expect((esm.inputs.scalingConfig as { maximumConcurrency: number }).maximumConcurrency).toBe(
        5,
      );
      const queue = resourcesOfType("aws:sqs/queue:Queue").find(
        (q) => q.inputs.name === "boxalarm-dev-notification-cert-expiry-queue",
      );
      const redrive = JSON.parse(queue?.inputs.redrivePolicy as string) as {
        deadLetterTargetArn: string;
      };
      expect(redrive.deadLetterTargetArn).toBe(
        `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:boxalarm-dev-notification-cert-expiry-queue-dlq`,
      );
      expect(
        alarmByName("boxalarm-dev-notification-cert-expiry-queue-dlq-depth").inputs.threshold,
      ).toBe(0);
      expect(
        isGranted(statementsForRole(CONSUMER), "sqs:ReceiveMessage", (r) =>
          r.includes("cert-expiry-queue"),
        ),
      ).toBe(true);
    });

    it("keeps its Lambda timeout under the queue's 30s visibility timeout", async () => {
      await build();
      expect(lambdaByName(CONSUMER).inputs.timeout as number).toBeLessThan(30);
    });
  });

  describe("digest job", () => {
    it("can Query GSI3 (pending rows + roster), Get/Put/Delete the table, publish push, send email", async () => {
      await build();
      const s = statementsForRole(DIGEST);
      expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
      for (const action of ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]) {
        expect(isGranted(s, action, TABLE), action).toBe(true);
      }
      expect(isGranted(s, "sns:Publish", PUSH_TOPIC)).toBe(true);
      expect(
        isGranted(s, "ses:SendEmail", `arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${FROM}`),
      ).toBe(true);
      expect(
        isGranted(
          s,
          "ses:SendEmail",
          `arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/nichols.example`,
        ),
      ).toBe(true);
    });

    it("holds no base-table Query, UpdateItem, or wildcard SES/SNS grant", async () => {
      await build();
      const s = statementsForRole(DIGEST);
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(false);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(false);
      expect(isGranted(s, "ses:SendEmail", (r) => r.endsWith("*"))).toBe(false);
      expect(isGranted(s, "sns:Publish", (r) => r.includes("alerting") || r.endsWith("*"))).toBe(
        false,
      );
    });

    it("publishes push to its own standard (non-FIFO) topic, never the alerting FIFO topic", async () => {
      await build();
      const topic = resourcesOfType("aws:sns/topic:Topic").find(
        (t) => t.inputs.name === "boxalarm-dev-notification-push",
      );
      expect(topic).toBeDefined();
      expect(topic?.inputs.fifoTopic).toBeFalsy();
      expect(lambdaEnv(DIGEST).NOTIFICATION_PUSH_TOPIC_ARN).toBe(PUSH_TOPIC);
    });

    it("runs daily at 12:00 UTC with {deptId}, retries, dead-letters, and alarms", async () => {
      await build();
      const schedule = resourcesOfType("aws:scheduler/schedule:Schedule").find(
        (r) => r.inputs.name === "boxalarm-dev-notification-digest-daily",
      );
      expect(schedule?.inputs.scheduleExpression).toBe(DIGEST_SCHEDULE_EXPRESSION);
      expect(DIGEST_SCHEDULE_EXPRESSION).toBe("cron(0 12 * * ? *)");
      expect(schedule?.inputs.scheduleExpressionTimezone).toBe("UTC");
      const target = schedule?.inputs.target as {
        arn: string;
        input: string;
        retryPolicy?: { maximumRetryAttempts: number };
        deadLetterConfig?: { arn: string };
      };
      expect(target.arn).toBe(`arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${DIGEST}`);
      // digestJob.ts's isDigestJobPayload: the whole event is {deptId: string}.
      expect(JSON.parse(target.input)).toEqual({ deptId: "nichols-fd" });
      expect(target.retryPolicy?.maximumRetryAttempts).toBe(3);
      const dlqArn = `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:boxalarm-dev-notification-digest-dlq`;
      expect(target.deadLetterConfig?.arn).toBe(dlqArn);

      const scheduler = statementsForRole("boxalarm-dev-notification-digest-scheduler");
      expect(isGranted(scheduler, "lambda:InvokeFunction", target.arn)).toBe(true);
      expect(isGranted(scheduler, "sqs:SendMessage", dlqArn)).toBe(true);

      expect(alarmByName("boxalarm-dev-notification-digest-dlq-depth").inputs.threshold).toBe(0);
      expect(alarmByName("boxalarm-dev-notification-digest-errors").inputs.dimensions).toEqual({
        FunctionName: DIGEST,
      });
    });

    it("alarms on a dropped recipient, which the job swallows without failing", async () => {
      await build();
      const alarm = alarmByName("boxalarm-dev-notification-digest-recipient-failed");
      expect(alarm.inputs.namespace).toBe("Boxalarm/NotificationDigest");
      expect(alarm.inputs.metricName).toBe("DigestRecipientFailed");
      expect(alarm.inputs.threshold).toBe(0);
    });
  });

  it("every role holding UpdateItem/DeleteItem on the platform table carries the audit-row deny", async () => {
    await build();
    const roles = resourcesOfType("aws:iam/role:Role").map((r) => r.inputs.name as string);
    const mutating = roles.filter((role) => {
      const s = statementsForRole(role);
      return (
        isGranted(s, "dynamodb:UpdateItem", TABLE) || isGranted(s, "dynamodb:DeleteItem", TABLE)
      );
    });
    expect(mutating.sort()).toEqual([DIGEST, INBOX].sort());
    for (const role of mutating) {
      const deny = statementsForRole(role).find((st) => st.Sid === "DenyAuditMutations");
      expect(deny?.Effect, role).toBe("Deny");
    }
  });

  it("no notification Lambda reserves concurrency or touches the alerting plane", async () => {
    await build();
    for (const fn of [INBOX, PREFERENCES, CONSUMER, DIGEST]) {
      expect(lambdaByName(fn).inputs.reservedConcurrentExecutions, fn).toBeUndefined();
      const touchesAlerting = statementsForRole(fn).some((st) =>
        (Array.isArray(st.Resource) ? st.Resource : [st.Resource]).some((r) =>
          r.includes("alerting"),
        ),
      );
      expect(touchesAlerting, fn).toBe(false);
    }
  });

  // Env keys each handler's config readers require on its live path: readNotificationConfig
  // (PLATFORM_SERVICE_TABLE_NAME), @boxalarm/authz's readAuthzConfig
  // (VERIFIED_PERMISSIONS_POLICY_STORE_ID), and channelSender's readChannelSenderConfig.
  const VP = "VERIFIED_PERMISSIONS_POLICY_STORE_ID";
  const REQUIRED_ENV: Record<string, string[]> = {
    [INBOX]: ["PLATFORM_SERVICE_TABLE_NAME", VP],
    [PREFERENCES]: ["PLATFORM_SERVICE_TABLE_NAME", VP],
    [CONSUMER]: ["PLATFORM_SERVICE_TABLE_NAME"],
    [DIGEST]: [
      "PLATFORM_SERVICE_TABLE_NAME",
      "NOTIFICATION_PUSH_TOPIC_ARN",
      "NOTIFICATION_SES_FROM_ADDRESS",
    ],
  };

  it.each(Object.entries(REQUIRED_ENV))(
    "%s carries every env key its handler requires",
    async (fn, keys) => {
      await build();
      const env = lambdaEnv(fn);
      for (const key of keys) {
        expect(env[key], `${fn} ${key}`).toBeTruthy();
      }
    },
  );

  it("every Cedar-gated notification Lambda can call Verified Permissions", async () => {
    await build();
    for (const fn of [INBOX, PREFERENCES]) {
      expect(
        isGranted(statementsForRole(fn), "verifiedpermissions:IsAuthorizedWithToken", (r) =>
          r.includes("policy-store"),
        ),
        fn,
      ).toBe(true);
    }
  });
});
