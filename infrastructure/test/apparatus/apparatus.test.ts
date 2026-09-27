import * as fs from "fs";
import * as path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { Registry } from "../../components/apparatus/registry";
import { Checks } from "../../components/apparatus/checks";
import { Records } from "../../components/apparatus/records";
import { Inventory } from "../../components/apparatus/inventory";
import {
  ACCOUNT_ID,
  REGION,
  alarmByName,
  installMocks,
  resourcesOfType,
  settle,
} from "../alerting/mock-harness";

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("apparatus-lg", {
    env: "dev",
    serviceName: "apparatus-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup: logGroup,
  });
  const args = {
    env: "dev",
    platformTableName: "boxalarm-dev-platform-service",
    platformTableArn: pulumi.output(TABLE),
    policyStoreArn: `arn:aws:verifiedpermissions::${ACCOUNT_ID}:policy-store/ps-1`,
    policyStoreId: "ps-1",
    assetsBucketName: "boxalarm-dev-platform-assets",
    assetsBucketArn: "arn:aws:s3:::boxalarm-dev-platform-assets",
    logGroup,
    httpApi,
  };
  new Registry("apparatus-registry", args);
  new Checks("apparatus-checks", args);
  new Records("apparatus-records", args);
  new Inventory("apparatus-inventory", args);
  await settle();
}

function apparatusRoutes() {
  return resourcesOfType("aws:apigatewayv2/route:Route").filter((r) =>
    (r.inputs.routeKey as string).includes(" /api/v1/apparatus"),
  );
}

/**
 * Every apparatus call the two apps make (method + path after the client's /api/v1/
 * prefix, path params normalized). Web: ui/apps/web/src/features/apparatus/api.ts. Mobile:
 * ui/apps/mobile/src/features/checks/apiChecksRepository.ts (list, checklist) and
 * ui/apps/mobile/src/sync/syncManager.ts (the offline outbox's checks/defects drain).
 */
const UI_CALLS = [
  "GET apparatus",
  "POST apparatus",
  "GET apparatus/{unitId}",
  "PUT apparatus/{unitId}/service-status",
  "GET apparatus/{unitId}/checklist",
  "POST apparatus/{unitId}/checks",
  "POST apparatus/{unitId}/defects",
  "GET apparatus/{unitId}/maintenance",
  "POST apparatus/{unitId}/maintenance",
  "POST apparatus/{unitId}/scba",
  "GET apparatus/scba/testing-schedules",
  "POST apparatus/{unitId}/tests",
  "GET apparatus/testing-schedules",
  "GET apparatus/{unitId}/inventory",
  "POST apparatus/{unitId}/inventory",
  "PUT apparatus/{unitId}/inventory/{itemId}",
  "GET apparatus/compliance",
] as const;

const UI_ROOT = path.resolve(__dirname, "../../../ui/apps");

describe("apparatus-service routes", { timeout: 30_000 }, () => {
  it("deploys a route for every apparatus call the web and mobile apps make, and no others", async () => {
    await build();
    const deployed = apparatusRoutes()
      .map((r) => (r.inputs.routeKey as string).replace(" /api/v1/", " "))
      .sort();
    expect(deployed).toEqual([...UI_CALLS].sort());
  });

  it("the UI call list still matches the client sources it was read from", () => {
    const web = fs.readFileSync(path.join(UI_ROOT, "web/src/features/apparatus/api.ts"), "utf8");
    for (const suffix of [
      "/service-status`",
      "/checklist`",
      "/maintenance`",
      "/scba`",
      "apparatus/scba/testing-schedules",
      "/tests`",
      "apparatus/testing-schedules",
      "/inventory`",
      "/inventory/${encodeURIComponent(itemId)}`",
      "apparatus/compliance",
    ]) {
      expect(web, suffix).toContain(suffix);
    }
    const outbox = fs.readFileSync(path.join(UI_ROOT, "mobile/src/sync/syncManager.ts"), "utf8");
    expect(outbox).toContain("unitPath(unitId, 'checks')");
    expect(outbox).toContain("unitPath(unitId, 'defects')");
    expect(outbox).toContain("return `apparatus/${encodeURIComponent(unitId)}/${suffix}`;");
    const checks = fs.readFileSync(
      path.join(UI_ROOT, "mobile/src/features/checks/apiChecksRepository.ts"),
      "utf8",
    );
    expect(checks).toContain("apiRequest('apparatus', tokens");
    expect(checks).toContain("unitPath(unitId, 'checklist')");
  });

  it("attaches the shared REQUEST authorizer to every apparatus route (none is open)", async () => {
    await build();
    const routes = apparatusRoutes();
    expect(routes.length).toBe(UI_CALLS.length);
    for (const route of routes) {
      expect(route.inputs.authorizationType, route.inputs.routeKey as string).toBe("CUSTOM");
      expect(route.inputs.authorizerId, route.inputs.routeKey as string).toBe(
        "http-api-authorizer-id",
      );
    }
  });

  it("logs every apparatus Lambda to the apparatus-service log group with Active tracing", async () => {
    await build();
    const fns = resourcesOfType("aws:lambda/function:Function").filter((r) =>
      (r.inputs.name as string).startsWith("boxalarm-dev-apparatus-"),
    );
    expect(fns.length).toBe(UI_CALLS.length);
    for (const fn of fns) {
      const env = (fn.inputs.environment as { variables: Record<string, string> }).variables;
      expect(env.SERVICE_NAME).toBe("apparatus-service");
      expect((fn.inputs.tracingConfig as { mode: string }).mode).toBe("Active");
    }
  });

  it("alarms on errors in the two routes the mobile offline outbox drains into", async () => {
    await build();
    for (const key of ["checks-submit", "defects-report"]) {
      const alarm = alarmByName(`boxalarm-dev-apparatus-${key}-errors`);
      expect(alarm.inputs.namespace).toBe("AWS/Lambda");
      expect(alarm.inputs.metricName).toBe("Errors");
      expect(alarm.inputs.dimensions).toEqual({ FunctionName: `boxalarm-dev-apparatus-${key}` });
      expect(alarm.inputs.threshold).toBe(0);
    }
  });

  it("alarms on the defect business-failure metrics under the namespace the handler emits", async () => {
    await build();
    const failed = alarmByName("boxalarm-dev-apparatus-defect-report-failed");
    expect(failed.inputs.namespace).toBe("Boxalarm/apparatus-service");
    expect(failed.inputs.metricName).toBe("DefectReportFailed");
    const oos = alarmByName("boxalarm-dev-apparatus-defect-oos-transition-failed");
    expect(oos.inputs.namespace).toBe("Boxalarm/apparatus-service");
    expect(oos.inputs.metricName).toBe("DefectOosTransitionFailed");
    expect(oos.inputs.treatMissingData).toBe("notBreaching");
  });

  it("rejects an absent or unknown env", () => {
    const logGroup = new ServiceLogGroup("apparatus-lg-bad", {
      env: "dev",
      serviceName: "apparatus-service",
    });
    const httpApi = new HttpApi("http-api-bad", {
      env: "dev",
      userPoolId: "pool-1",
      allowedClientIds: ["client-1"],
      platformLogGroup: logGroup,
    });
    const base = {
      platformTableName: "t",
      platformTableArn: TABLE,
      policyStoreArn: "arn:ps",
      policyStoreId: "ps-1",
      assetsBucketName: "b",
      assetsBucketArn: "arn:aws:s3:::b",
      logGroup,
      httpApi,
    };
    expect(() => new Registry("r-bad", { ...base, env: "" })).toThrow(/env is required/);
    expect(() => new Checks("c-bad", { ...base, env: "production" })).toThrow(/unknown env/);
    expect(() => new Records("m-bad", { ...base, env: "" })).toThrow(/env is required/);
    expect(() => new Inventory("i-bad", { ...base, env: "" })).toThrow(/env is required/);
  });
});
