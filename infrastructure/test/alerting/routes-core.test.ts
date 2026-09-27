import { beforeEach, describe, expect, it } from "vitest";
import {
  BOUNDARY_ARN,
  TABLE_ARN,
  buildSchedulingChain,
  installMocks,
  isGranted,
  lambdaEnv,
  resourcesOfType,
  statementsForRole,
} from "./mock-harness";

const INGRESS = "boxalarm-dev-alerting-dispatches-create";

beforeEach(() => {
  installMocks();
});

describe(
  "RoutesCore dispatch-ingress IAM matches runFanOut's DynamoDB calls",
  { timeout: 30_000 },
  () => {
    it.each([
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:TransactWriteItems",
      "dynamodb:PutItem",
    ])("grants %s on the alerting table", async (action) => {
      await buildSchedulingChain();
      expect(isGranted(statementsForRole(INGRESS), action, TABLE_ARN)).toBe(true);
    });
  },
);

describe("RoutesCore active-dispatch list route", { timeout: 30_000 }, () => {
  const LIST = "boxalarm-dev-alerting-dispatches-list-active";

  it("grants Query on GSI2 only — no base-table read, no write, no Scan", async () => {
    await buildSchedulingChain();
    const statements = statementsForRole(LIST);
    expect(isGranted(statements, "dynamodb:Query", `${TABLE_ARN}/index/GSI2`)).toBe(true);
    const dynamoActions = statements
      .filter((s) => s.Effect === "Allow")
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .filter((a) => a.startsWith("dynamodb:"));
    expect(dynamoActions).toEqual(["dynamodb:Query"]);
    expect(isGranted(statements, "dynamodb:Query", TABLE_ARN)).toBe(false);
    expect(isGranted(statements, "dynamodb:Query", (r) => r.includes("platform"))).toBe(false);
  });

  it("sets every env var the handler reads and the alerting permissions boundary", async () => {
    await buildSchedulingChain();
    expect(lambdaEnv(LIST)).toMatchObject({
      ALERTING_TABLE_NAME: "boxalarm-dev-alerting-table",
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: "policy-store-id",
    });
    const role = resourcesOfType("aws:iam/role:Role").find((r) => r.inputs.name === LIST);
    expect(role?.inputs.permissionsBoundary).toBe(BOUNDARY_ARN);
  });

  it("routes GET /api/v1/alerting/dispatches through the authorizer", async () => {
    await buildSchedulingChain();
    const route = resourcesOfType("aws:apigatewayv2/route:Route").find(
      (r) => r.inputs.routeKey === "GET /api/v1/alerting/dispatches",
    );
    expect(route?.inputs.authorizationType).toBe("CUSTOM");
  });
});
