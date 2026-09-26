import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { Equipment } from "../../components/inventory/equipment";
import { Consumables } from "../../components/inventory/consumables";
import { Ppe } from "../../components/inventory/ppe";
import {
  ACCOUNT_ID,
  REGION,
  alarmByName,
  installMocks,
  isGranted,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
} from "../alerting/mock-harness";

/**
 * api-gap P0-6: each inventory-service Lambda's route, env keys and IAM grants, asserted
 * against what its backend handler actually reads and calls — including the GSI ARNs its
 * queries need, which a table-only grant silently denies.
 */

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const GSI1 = `${TABLE}/index/GSI1`;
const GSI2 = `${TABLE}/index/GSI2`;
const GSI3 = `${TABLE}/index/GSI3`;
const BUS = `arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/boxalarm-dev-platform-bus`;

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("inventory-lg", {
    env: "dev",
    serviceName: "inventory-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup: logGroup,
  });
  const common = {
    env: "dev",
    platformTableName: "boxalarm-dev-platform-service",
    // An Output, as index.ts passes it — proves index ARNs are resolved, not stringified.
    platformTableArn: pulumi.output(TABLE),
    policyStoreArn: `arn:aws:verifiedpermissions::${ACCOUNT_ID}:policy-store/ps-1`,
    policyStoreId: "ps-1",
    logGroup,
    httpApi,
  };
  const scanners = {
    ...common,
    deptId: "nichols-fd",
    platformBusName: "boxalarm-dev-platform-bus",
    platformBusArn: BUS,
  };
  new Equipment("inventory-equipment", common);
  new Consumables("inventory-consumables", scanners);
  new Ppe("inventory-ppe", scanners);
  await settle();
}

const fn = (suffix: string) => `boxalarm-dev-inventory-${suffix}`;

// Every inventory call the web (features/inventory/api.ts) and mobile
// (features/inventory/apiInventoryRepository.ts) clients make, with the web client's
// /api/v1/ prefix applied and path params normalized to the handler's names.
const ROUTES: Record<string, string> = {
  "GET /api/v1/inventory/equipment": fn("equipment-list"),
  "GET /api/v1/inventory/equipment/{assetId}": fn("equipment-get"),
  "POST /api/v1/inventory/equipment": fn("equipment-create"),
  "PUT /api/v1/inventory/equipment/{assetId}/assignment": fn("equipment-assignment"),
  "PUT /api/v1/inventory/equipment/{assetId}/location": fn("equipment-location"),
  "PUT /api/v1/inventory/equipment/{assetId}/lifecycle": fn("equipment-lifecycle"),
  "GET /api/v1/inventory/consumables": fn("consumables-list"),
  "GET /api/v1/inventory/ppe/{memberId}": fn("ppe-get"),
  "POST /api/v1/inventory/ppe/{memberId}": fn("ppe-issue"),
};

describe("inventory Lambdas: routes, env and IAM match their handlers", { timeout: 30_000 }, () => {
  it("deploys exactly the routes the UI calls, each through the shared CUSTOM authorizer", async () => {
    await build();
    const routes = resourcesOfType("aws:apigatewayv2/route:Route");
    expect(routes.map((r) => r.inputs.routeKey).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const route of routes) {
      expect(route.inputs.authorizationType, route.inputs.routeKey as string).toBe("CUSTOM");
    }
  });

  it.each(Object.entries(ROUTES))("%s targets %s", async (routeKey, functionName) => {
    await build();
    const route = resourcesOfType("aws:apigatewayv2/route:Route").find(
      (r) => r.inputs.routeKey === routeKey,
    );
    const integration = resourcesOfType("aws:apigatewayv2/integration:Integration").find(
      (r) => `integrations/${r.name}-id` === route?.inputs.target,
    );
    expect(String(integration?.inputs.integrationUri)).toContain(`function:${functionName}/`);
  });

  describe("least privilege per handler", () => {
    const WRITES = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"];

    it("equipment list Queries GSI3 (registry) and GSI1 (member filter) and writes nothing", async () => {
      await build();
      const s = statementsForRole(fn("equipment-list"));
      expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", GSI1)).toBe(true);
      for (const action of [...WRITES, "dynamodb:GetItem"]) {
        expect(isGranted(s, action, TABLE), action).toBe(false);
      }
    });

    it("equipment get holds GetItem only", async () => {
      await build();
      const s = statementsForRole(fn("equipment-get"));
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
      for (const action of [...WRITES, "dynamodb:Query"]) {
        expect(isGranted(s, action, TABLE), action).toBe(false);
      }
    });

    it("equipment create holds PutItem (asset + audit row) only", async () => {
      await build();
      const s = statementsForRole(fn("equipment-create"));
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      for (const action of ["dynamodb:UpdateItem", "dynamodb:GetItem", "dynamodb:Query"]) {
        expect(isGranted(s, action, TABLE), action).toBe(false);
      }
    });

    it.each(["equipment-assignment", "equipment-location"])(
      "%s holds UpdateItem (asset) + PutItem (audit row), no reads",
      async (suffix) => {
        await build();
        const s = statementsForRole(fn(suffix));
        expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
        expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
        expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(false);
        expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(false);
      },
    );

    it("equipment lifecycle holds GetItem + UpdateItem", async () => {
      await build();
      const s = statementsForRole(fn("equipment-lifecycle"));
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(false);
    });

    it("consumables list Queries GSI3 only", async () => {
      await build();
      const s = statementsForRole(fn("consumables-list"));
      expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
      for (const action of [...WRITES, "dynamodb:Query", "dynamodb:GetItem"]) {
        expect(isGranted(s, action, TABLE), action).toBe(false);
      }
    });

    it("ppe get Queries the base table only", async () => {
      await build();
      const s = statementsForRole(fn("ppe-get"));
      expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
      for (const action of WRITES) {
        expect(isGranted(s, action, TABLE), action).toBe(false);
      }
    });

    it("ppe issue holds PutItem for both transaction items (not TransactWriteItems alone)", async () => {
      await build();
      const s = statementsForRole(fn("ppe-issue"));
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(false);
    });

    it("the PPE expiry scanner reads config, Queries GSI2, writes its marker and publishes", async () => {
      await build();
      const s = statementsForRole(fn("ppe-expiry-scanner"));
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:Query", GSI2)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
      expect(isGranted(s, "events:PutEvents", BUS)).toBe(true);
    });

    it("the consumable reorder scanner Queries GSI3, writes its marker and publishes", async () => {
      await build();
      const s = statementsForRole(fn("consumable-reorder-scanner"));
      expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
      expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
      expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
      expect(isGranted(s, "events:PutEvents", BUS)).toBe(true);
      expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(false);
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
    expect(mutating.length).toBe(5);
    for (const role of mutating) {
      const deny = statementsForRole(role).find((st) => st.Sid === "DenyAuditMutations");
      expect(deny?.Effect, role).toBe("Deny");
    }
  });

  // Env keys each handler's config readers require on its live path: readInventoryConfig
  // (PLATFORM_TABLE_NAME), @boxalarm/authz's readAuthzConfig, and the scanners'
  // readPlatformConfigDynamoConfig / readPlatformEventBusConfig / readScannerDeptId.
  const VP = "VERIFIED_PERMISSIONS_POLICY_STORE_ID";
  const REQUIRED_ENV: Record<string, string[]> = {
    ...Object.fromEntries(Object.values(ROUTES).map((f) => [f, ["PLATFORM_TABLE_NAME", VP]])),
    [fn("ppe-expiry-scanner")]: [
      "PLATFORM_TABLE_NAME",
      "PLATFORM_CONFIG_DYNAMO_TABLE_NAME",
      "PLATFORM_EVENT_BUS_NAME",
      "PPE_SCANNER_DEPT_ID",
    ],
    [fn("consumable-reorder-scanner")]: [
      "PLATFORM_TABLE_NAME",
      "PLATFORM_EVENT_BUS_NAME",
      "INVENTORY_REORDER_SCANNER_DEPT_ID",
    ],
  };

  it.each(Object.entries(REQUIRED_ENV))(
    "%s carries every env key its handler requires",
    async (functionName, keys) => {
      await build();
      const env = lambdaEnv(functionName);
      for (const key of keys) {
        expect(env[key], `${functionName} ${key}`).toBeTruthy();
      }
    },
  );

  it("every Cedar-gated inventory Lambda can call Verified Permissions", async () => {
    await build();
    for (const functionName of Object.values(ROUTES)) {
      expect(
        isGranted(
          statementsForRole(functionName),
          "verifiedpermissions:IsAuthorizedWithToken",
          (r) => r.includes("policy-store"),
        ),
        functionName,
      ).toBe(true);
    }
  });

  describe.each([
    ["inventory-ppe-expiry-scanner", fn("ppe-expiry-scanner")],
    ["inventory-consumable-reorder-scanner", fn("consumable-reorder-scanner")],
  ])("%s daily schedule", (baseName, functionName) => {
    it("retries, dead-letters to a DLQ the scheduler role can write, and alarms", async () => {
      await build();
      const schedule = resourcesOfType("aws:scheduler/schedule:Schedule").find(
        (r) => r.inputs.name === `boxalarm-dev-${baseName}-daily`,
      );
      const target = schedule?.inputs.target as {
        arn?: string;
        input?: string;
        retryPolicy?: { maximumRetryAttempts: number };
        deadLetterConfig?: { arn: string };
      };
      expect(target.arn).toBe(`arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${functionName}`);
      // The handler uses event.id as its correlationId; Scheduler fills it per run.
      expect(JSON.parse(target.input ?? "{}")).toEqual({ id: "<aws.scheduler.execution-id>" });
      expect(target.retryPolicy?.maximumRetryAttempts).toBe(3);
      const dlqArn = `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:boxalarm-dev-${baseName}-dlq`;
      expect(target.deadLetterConfig?.arn).toBe(dlqArn);

      const scheduler = statementsForRole(`boxalarm-dev-${baseName}-scheduler`);
      expect(isGranted(scheduler, "sqs:SendMessage", dlqArn)).toBe(true);
      expect(isGranted(scheduler, "lambda:InvokeFunction", target.arn!)).toBe(true);

      expect(alarmByName(`boxalarm-dev-${baseName}-dlq-depth`).inputs.threshold).toBe(0);
      const errors = alarmByName(`boxalarm-dev-${baseName}-errors`);
      expect(errors.inputs.metricName).toBe("Errors");
      expect(errors.inputs.dimensions).toEqual({ FunctionName: functionName });
    });
  });
});
