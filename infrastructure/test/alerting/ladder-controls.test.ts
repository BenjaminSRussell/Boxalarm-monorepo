import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { Escalation } from "../../components/alerting/escalation";
import {
  LADDER_ADVANCE_TIMEOUT_SECONDS,
  RoutesLadderControls,
} from "../../components/alerting/routes-ladder-controls";
import { HttpApi } from "../../components/api/http-api";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import {
  ACCOUNT_ID,
  BOUNDARY_ARN,
  CMK_ARN,
  REGION,
  TABLE_ARN,
  TOPIC_ARN,
  alarmByName,
  grantsFor,
  installMocks,
  isGranted,
  lambdaByName,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
  type PolicyStatement,
} from "./mock-harness";

/**
 * F1.13/F1.14 officer controls: each Lambda's env and IAM asserted against what its handler
 * (backend/src/services/alerting-service/ladderControls/*) reads and calls, and nothing more
 * — the alerting plane must never gain a grant on another table.
 */

const PAGE_TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:boxalarm-dev-alerting-page`;
const TONE_EVALUATOR_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:boxalarm-dev-alerting-tone-evaluator`;
const ADVANCE = "boxalarm-dev-alerting-tone-ladder-advance";
const HALT = "boxalarm-dev-alerting-tone-ladder-halt";
const TRIGGER = "boxalarm-dev-alerting-mutual-aid-trigger";
const ACKNOWLEDGE = "boxalarm-dev-alerting-mutual-aid-acknowledge";
const ALL = [ADVANCE, HALT, TRIGGER, ACKNOWLEDGE];

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("alerting-lg", {
    env: "dev",
    serviceName: "alerting-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup: new ServiceLogGroup("platform-lg", {
      env: "dev",
      serviceName: "platform-service",
    }),
  });
  const escalation = new Escalation("escalation", {
    env: "dev",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTopicArn: TOPIC_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    logGroup,
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  new RoutesLadderControls("routes-ladder-controls", {
    env: "dev",
    httpApi,
    // Outputs, as index.ts passes them.
    alertingTableArn: pulumi.output(TABLE_ARN),
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    alertingTopicArn: pulumi.output(TOPIC_ARN),
    escalation,
    logGroup,
    policyStoreId: "policy-store-id",
    pageTopicArn: PAGE_TOPIC_ARN,
    permissionsBoundaryArn: BOUNDARY_ARN,
  });
  await settle();
}

function dynamoActionsOn(statements: PolicyStatement[]): string[] {
  return statements
    .filter((s) => s.Effect === "Allow")
    .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
    .filter((action) => action.startsWith("dynamodb:"))
    .sort();
}

describe("officer ladder-control routes", { timeout: 30_000 }, () => {
  it("routes all four architecture paths through the Cognito authorizer", async () => {
    await build();
    const routes = resourcesOfType("aws:apigatewayv2/route:Route");
    for (const routeKey of [
      "POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/advance",
      "POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/halt",
      "POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/trigger",
      "POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/acknowledge",
    ]) {
      const route = routes.find((r) => r.inputs.routeKey === routeKey);
      expect(route, routeKey).toBeDefined();
      expect(route!.inputs.authorizationType, routeKey).toBe("CUSTOM");
    }
  });

  it("sets every env var the handlers read", async () => {
    await build();
    for (const fn of ALL) {
      expect(lambdaEnv(fn), fn).toMatchObject({
        ALERTING_TABLE_NAME: "boxalarm-dev-alerting-table",
        VERIFIED_PERMISSIONS_POLICY_STORE_ID: "policy-store-id",
      });
    }
    expect(lambdaEnv(ADVANCE).TONE_EVALUATOR_HANDLER_ARN).toBe(TONE_EVALUATOR_ARN);
    expect(lambdaEnv(TRIGGER).ALERTING_TOPIC_ARN).toBe(TOPIC_ARN);
  });

  it("advance reads the ladder and may invoke only the Tone Evaluator — it fans out nothing itself", async () => {
    await build();
    const s = statementsForRole(ADVANCE);
    expect(dynamoActionsOn(s)).toEqual(["dynamodb:GetItem"]);
    expect(isGranted(s, "dynamodb:GetItem", TABLE_ARN)).toBe(true);
    expect(grantsFor(s, "lambda:InvokeFunction", () => true).flatMap((g) => g.Resource)).toEqual([
      TONE_EVALUATOR_ARN,
    ]);
    expect(isGranted(s, "sns:Publish", () => true)).toBe(false);
    expect(isGranted(s, "scheduler:CreateSchedule", () => true)).toBe(false);
    expect(isGranted(s, "iam:PassRole", () => true)).toBe(false);
  });

  it("halt can make its conditional METADATA update + audit put transaction", async () => {
    await build();
    const s = statementsForRole(HALT);
    for (const action of [
      "dynamodb:GetItem",
      "dynamodb:TransactWriteItems",
      "dynamodb:UpdateItem",
      "dynamodb:PutItem",
    ]) {
      expect(isGranted(s, action, TABLE_ARN), action).toBe(true);
    }
    expect(isGranted(s, "sns:Publish", () => true)).toBe(false);
  });

  it("mutual-aid trigger holds the mutual-aid port's table calls and alerting-topic publish only", async () => {
    await build();
    const s = statementsForRole(TRIGGER);
    for (const action of [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      // Marks each officer prompt sent after it publishes (mutualAidPort.ts).
      "dynamodb:UpdateItem",
      "dynamodb:TransactWriteItems",
    ]) {
      expect(isGranted(s, action, TABLE_ARN), action).toBe(true);
    }
    expect(grantsFor(s, "sns:Publish", () => true).flatMap((g) => g.Resource)).toEqual([TOPIC_ARN]);
  });

  it("acknowledge can only update and read the table", async () => {
    await build();
    expect(dynamoActionsOn(statementsForRole(ACKNOWLEDGE))).toEqual([
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    ]);
  });

  it("every grant targets the alerting table/topic/evaluator only, with the CMK and the plane boundary", async () => {
    await build();
    for (const fn of ALL) {
      const s = statementsForRole(fn);
      const dataResources = s
        .filter((st) => st.Effect === "Allow")
        .flatMap((st) => (Array.isArray(st.Resource) ? st.Resource : [st.Resource]))
        .filter((r) => r.startsWith("arn:aws:dynamodb") || r.startsWith("arn:aws:sns"));
      for (const resource of dataResources) {
        expect([TABLE_ARN, TOPIC_ARN], `${fn}: ${resource}`).toContain(resource);
      }
      expect(isGranted(s, "kms:Decrypt", CMK_ARN), fn).toBe(true);
      const role = resourcesOfType("aws:iam/role:Role").find((r) => r.inputs.name === fn);
      expect(role?.inputs.permissionsBoundary, fn).toBe(BOUNDARY_ARN);
    }
  });

  it("advance waits for the evaluator but stays under the HTTP API's 30s ceiling", async () => {
    await build();
    expect(lambdaByName(ADVANCE).inputs.timeout).toBe(LADDER_ADVANCE_TIMEOUT_SECONDS);
    expect(LADDER_ADVANCE_TIMEOUT_SECONDS).toBeLessThan(30);
  });

  it("a failed control pages on-call through the alerting-page topic", async () => {
    await build();
    const alarm = alarmByName("boxalarm-dev-alerting-ladder-control-failed");
    expect(alarm.inputs).toMatchObject({
      namespace: "Boxalarm/Alerting",
      metricName: "LadderControlFailed",
      threshold: 0,
      alarmActions: [PAGE_TOPIC_ARN],
    });
    // The backend emits it with dimension sets [] and ["Reason"]; only [] matches no dims.
    expect(alarm.inputs.dimensions).toBeUndefined();
  });

  it.each([
    ["prompt-failed", "MutualAidPromptFailed"],
    ["request-failed", "MutualAidRequestFailed"],
    ["no-officer-reachable", "MutualAidNoOfficerReachable"],
  ])("pages on-call when mutual aid %s (%s)", async (suffix, metricName) => {
    await build();
    const alarm = alarmByName(`boxalarm-dev-alerting-mutual-aid-${suffix}`);
    expect(alarm.inputs).toMatchObject({
      namespace: "Boxalarm/Alerting",
      metricName,
      threshold: 0,
      alarmActions: [PAGE_TOPIC_ARN],
    });
    expect(alarm.inputs.dimensions).toBeUndefined();
  });

  it("the Tone Evaluator can ConditionCheck the halt in the automatic mutual-aid transaction", async () => {
    await build();
    const s = statementsForRole("boxalarm-dev-alerting-tone-evaluator");
    expect(isGranted(s, "dynamodb:ConditionCheckItem", TABLE_ARN)).toBe(true);
    expect(isGranted(s, "dynamodb:TransactWriteItems", TABLE_ARN)).toBe(true);
  });
});
