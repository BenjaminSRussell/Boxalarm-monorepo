import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { Occupancies } from "../../components/inspections/occupancies";
import { Hydrants } from "../../components/inspections/hydrants";
import { Records } from "../../components/inspections/records";
import { InspectionsMap } from "../../components/inspections/map";
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
 * Each inspections-service Lambda's env keys, IAM grants and route, asserted against what its
 * backend handler actually reads and calls — including GSI index ARNs, the per-item actions a
 * TransactWriteItems needs (it is not itself an IAM action), and the S3 object actions its
 * presigned URLs are signed with.
 */

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const GSI2 = `${TABLE}/index/GSI2`;
const GSI3 = `${TABLE}/index/GSI3`;
const BUCKET = "arn:aws:s3:::boxalarm-dev-platform-assets";
const PRE_PLAN_OBJECTS = `${BUCKET}/*/PRE_PLAN/*`;
const INSPECTION_OBJECTS = `${BUCKET}/*/INSPECTION_RECORD/*`;
const fn = (suffix: string) => `boxalarm-dev-inspections-${suffix}`;

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("inspections-lg", {
    env: "dev",
    serviceName: "inspections-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup: logGroup,
  });
  const base = {
    env: "dev",
    platformTableName: "boxalarm-dev-platform-service",
    // Outputs, as index.ts passes them — proves index/object ARNs are resolved, not stringified.
    platformTableArn: pulumi.output(TABLE),
    policyStoreArn: `arn:aws:verifiedpermissions::${ACCOUNT_ID}:policy-store/ps-1`,
    policyStoreId: "ps-1",
    logGroup,
    httpApi,
  };
  const assets = {
    assetsBucketName: pulumi.output("boxalarm-dev-platform-assets"),
    assetsBucketArn: pulumi.output(BUCKET),
  };
  new Occupancies("occupancies", { ...base, ...assets });
  new Hydrants("hydrants", base);
  new Records("records", { ...base, ...assets });
  new InspectionsMap("map", base);
  await settle();
}

// Method + path of every route the web client (ui/apps/web/src/features/inspections/api.ts,
// which prefixes /api/v1/) and mobile field capture call, mapped to the Lambda serving it.
const ROUTES: Record<string, string> = {
  "GET /api/v1/inspections/occupancies": fn("occupancies-list"),
  "POST /api/v1/inspections/occupancies": fn("occupancies-create"),
  "GET /api/v1/inspections/occupancies/{id}": fn("occupancies-get"),
  "PUT /api/v1/inspections/occupancies/{id}": fn("occupancies-update"),
  "GET /api/v1/inspections/occupancies/{id}/pre-plan": fn("pre-plan-get"),
  "PUT /api/v1/inspections/occupancies/{id}/pre-plan": fn("pre-plan-put"),
  "GET /api/v1/inspections/hydrants": fn("hydrants-list"),
  "POST /api/v1/inspections/hydrants": fn("hydrants-create"),
  "PUT /api/v1/inspections/hydrants/{hydrantId}": fn("hydrants-update"),
  "GET /api/v1/inspections": fn("inspections-list"),
  "POST /api/v1/inspections": fn("inspections-record"),
  "GET /api/v1/inspections/map": fn("map"),
  "POST /api/v1/inspections/field-capture": fn("field-capture"),
};

describe(
  "inspections Lambdas: routes, env and IAM match their handlers",
  { timeout: 30_000 },
  () => {
    it("deploys exactly the 13 routes the UI calls, each behind the shared REQUEST authorizer", async () => {
      await build();
      const routes = resourcesOfType("aws:apigatewayv2/route:Route");
      expect(routes.map((r) => r.inputs.routeKey).sort()).toEqual(Object.keys(ROUTES).sort());
      for (const route of routes) {
        expect(route.inputs.authorizationType, route.inputs.routeKey as string).toBe("CUSTOM");
        expect(route.inputs.authorizerId, route.inputs.routeKey as string).toBeTruthy();
      }
    });

    it.each(Object.entries(ROUTES))("%s integrates with %s", async (routeKey, functionName) => {
      await build();
      const route = resourcesOfType("aws:apigatewayv2/route:Route").find(
        (r) => r.inputs.routeKey === routeKey,
      );
      const integrationId = (route?.inputs.target as string).replace("integrations/", "");
      const integration = resourcesOfType("aws:apigatewayv2/integration:Integration").find(
        (r) => `${r.name}-id` === integrationId,
      );
      expect(integration?.inputs.integrationUri as string).toContain(`function:${functionName}/`);
    });

    // Env keys each handler's config readers require: readOccupancyServiceConfig
    // (OCCUPANCY_TABLE_NAME), readOccupancyAuthorizationConfig / @boxalarm/authz readAuthzConfig
    // (VERIFIED_PERMISSIONS_POLICY_STORE_ID), readInspectionsTableConfig / readInspectionsConfig /
    // readHydrantTableConfig / readMapTableConfig (PLATFORM_TABLE_NAME) and readAssetsConfig
    // (PLATFORM_ASSETS_BUCKET_NAME).
    const VP = "VERIFIED_PERMISSIONS_POLICY_STORE_ID";
    const REQUIRED_ENV: Record<string, string[]> = {
      [fn("occupancies-list")]: ["OCCUPANCY_TABLE_NAME"],
      [fn("occupancies-create")]: ["OCCUPANCY_TABLE_NAME", VP],
      [fn("occupancies-get")]: ["OCCUPANCY_TABLE_NAME"],
      [fn("occupancies-update")]: ["OCCUPANCY_TABLE_NAME", VP],
      [fn("pre-plan-get")]: ["PLATFORM_TABLE_NAME", "PLATFORM_ASSETS_BUCKET_NAME", VP],
      [fn("pre-plan-put")]: ["PLATFORM_TABLE_NAME", "PLATFORM_ASSETS_BUCKET_NAME", VP],
      [fn("hydrants-list")]: ["PLATFORM_TABLE_NAME"],
      [fn("hydrants-create")]: ["PLATFORM_TABLE_NAME", VP],
      [fn("hydrants-update")]: ["PLATFORM_TABLE_NAME", VP],
      [fn("inspections-list")]: ["PLATFORM_TABLE_NAME", VP],
      [fn("inspections-record")]: ["PLATFORM_TABLE_NAME", VP],
      [fn("map")]: ["PLATFORM_TABLE_NAME", VP],
      [fn("field-capture")]: ["PLATFORM_TABLE_NAME", "PLATFORM_ASSETS_BUCKET_NAME", VP],
    };

    it.each(Object.entries(REQUIRED_ENV))(
      "%s carries every env key its handler requires, with resolved values",
      async (functionName, keys) => {
        await build();
        const env = lambdaEnv(functionName);
        for (const key of keys) {
          expect(env[key], `${functionName} ${key}`).toBeTruthy();
        }
        if (keys.includes("PLATFORM_ASSETS_BUCKET_NAME")) {
          expect(env.PLATFORM_ASSETS_BUCKET_NAME).toBe("boxalarm-dev-platform-assets");
        }
        // No leftover CloudFront signer config — N6.1 forbids the distribution it would need.
        expect(Object.keys(env).filter((k) => k.includes("CLOUDFRONT"))).toEqual([]);
      },
    );

    it("every Cedar-gated Lambda can call Verified Permissions; the dept-scoped reads cannot", async () => {
      await build();
      for (const [functionName, keys] of Object.entries(REQUIRED_ENV)) {
        expect(
          isGranted(
            statementsForRole(functionName),
            "verifiedpermissions:IsAuthorizedWithToken",
            (r) => r.includes("policy-store"),
          ),
          functionName,
        ).toBe(keys.includes(VP));
      }
    });

    describe("DynamoDB grants (per-item actions for transactions, index ARNs for GSI queries)", () => {
      const WRITES = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"];

      it("occupancies list: Query GSI3 + BatchGetItem, no writes", async () => {
        await build();
        const s = statementsForRole(fn("occupancies-list"));
        expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
        expect(isGranted(s, "dynamodb:BatchGetItem", TABLE)).toBe(true);
        for (const action of WRITES) expect(isGranted(s, action, TABLE), action).toBe(false);
      });

      it("occupancies create: PutItem only (four-Put transaction)", async () => {
        await build();
        const s = statementsForRole(fn("occupancies-create"));
        expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
        for (const action of ["dynamodb:UpdateItem", "dynamodb:GetItem", "dynamodb:Query"]) {
          expect(isGranted(s, action, TABLE), action).toBe(false);
        }
      });

      it("occupancies get: GetItem only", async () => {
        await build();
        const s = statementsForRole(fn("occupancies-get"));
        expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
        for (const action of WRITES) expect(isGranted(s, action, TABLE), action).toBe(false);
      });

      it("occupancies update: GetItem + UpdateItem + PutItem (audit row)", async () => {
        await build();
        const s = statementsForRole(fn("occupancies-update"));
        for (const action of ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"]) {
          expect(isGranted(s, action, TABLE), action).toBe(true);
        }
      });

      it("pre-plan put: Query + ConditionCheckItem + PutItem for the occupancy-guarded transaction", async () => {
        await build();
        const s = statementsForRole(fn("pre-plan-put"));
        for (const action of [
          "dynamodb:Query",
          "dynamodb:ConditionCheckItem",
          "dynamodb:PutItem",
        ]) {
          expect(isGranted(s, action, TABLE), action).toBe(true);
        }
        expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(false);
      });

      it("pre-plan get: base-table Query only", async () => {
        await build();
        const s = statementsForRole(fn("pre-plan-get"));
        expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
        for (const action of WRITES) expect(isGranted(s, action, TABLE), action).toBe(false);
      });

      it("hydrants list: Query GSI2 (due month) and GSI3 (department list) + BatchGetItem", async () => {
        await build();
        const s = statementsForRole(fn("hydrants-list"));
        expect(isGranted(s, "dynamodb:Query", GSI2)).toBe(true);
        expect(isGranted(s, "dynamodb:Query", GSI3)).toBe(true);
        expect(isGranted(s, "dynamodb:BatchGetItem", TABLE)).toBe(true);
        for (const action of WRITES) expect(isGranted(s, action, TABLE), action).toBe(false);
      });

      it("hydrants create: PutItem; update: GetItem + UpdateItem + PutItem (outbox row)", async () => {
        await build();
        expect(isGranted(statementsForRole(fn("hydrants-create")), "dynamodb:PutItem", TABLE)).toBe(
          true,
        );
        const s = statementsForRole(fn("hydrants-update"));
        for (const action of ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"]) {
          expect(isGranted(s, action, TABLE), action).toBe(true);
        }
      });

      it("inspections list: Query GSI2 only; map: Query GSI3 only", async () => {
        await build();
        const list = statementsForRole(fn("inspections-list"));
        expect(isGranted(list, "dynamodb:Query", GSI2)).toBe(true);
        expect(isGranted(list, "dynamodb:Query", TABLE)).toBe(false);
        const map = statementsForRole(fn("map"));
        expect(isGranted(map, "dynamodb:Query", GSI3)).toBe(true);
        expect(isGranted(map, "dynamodb:Query", TABLE)).toBe(false);
        for (const action of WRITES) {
          expect(isGranted(list, action, TABLE), action).toBe(false);
          expect(isGranted(map, action, TABLE), action).toBe(false);
        }
      });

      it("inspections record: GetItem (occupancy) + PutItem (schedule) + UpdateItem (conduct)", async () => {
        await build();
        const s = statementsForRole(fn("inspections-record"));
        for (const action of ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]) {
          expect(isGranted(s, action, TABLE), action).toBe(true);
        }
      });

      it("field capture: GetItem + PutItem (lock) + ConditionCheckItem + UpdateItem", async () => {
        await build();
        const s = statementsForRole(fn("field-capture"));
        for (const action of [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:ConditionCheckItem",
          "dynamodb:UpdateItem",
        ]) {
          expect(isGranted(s, action, TABLE), action).toBe(true);
        }
      });

      it("no inspections role holds DeleteItem, BatchWriteItem or Scan", async () => {
        await build();
        for (const functionName of Object.keys(REQUIRED_ENV)) {
          const s = statementsForRole(functionName);
          for (const action of [
            "dynamodb:DeleteItem",
            "dynamodb:BatchWriteItem",
            "dynamodb:Scan",
          ]) {
            expect(
              isGranted(s, action, () => true),
              `${functionName} ${action}`,
            ).toBe(false);
          }
        }
      });
    });

    describe("S3 grants (presigned URLs are signed with the Lambda's role)", () => {
      it("pre-plan put can PutObject and pre-plan get can GetObject, only under */PRE_PLAN/*", async () => {
        await build();
        const put = statementsForRole(fn("pre-plan-put"));
        const get = statementsForRole(fn("pre-plan-get"));
        expect(isGranted(put, "s3:PutObject", PRE_PLAN_OBJECTS)).toBe(true);
        expect(isGranted(get, "s3:GetObject", PRE_PLAN_OBJECTS)).toBe(true);
        expect(isGranted(put, "s3:GetObject", () => true)).toBe(false);
        expect(isGranted(get, "s3:PutObject", () => true)).toBe(false);
      });

      it("field capture can PutObject only under */INSPECTION_RECORD/*", async () => {
        await build();
        const s = statementsForRole(fn("field-capture"));
        expect(isGranted(s, "s3:PutObject", INSPECTION_OBJECTS)).toBe(true);
        expect(isGranted(s, "s3:PutObject", PRE_PLAN_OBJECTS)).toBe(false);
        expect(isGranted(s, "s3:GetObject", () => true)).toBe(false);
      });

      it("no other inspections role can touch the assets bucket, and none is bucket-wide", async () => {
        await build();
        const s3Users = [fn("pre-plan-put"), fn("pre-plan-get"), fn("field-capture")];
        for (const functionName of Object.keys(REQUIRED_ENV)) {
          const statements = statementsForRole(functionName);
          const s3Resources = statements
            .filter((st) => [st.Action].flat().some((a) => a.startsWith("s3:")))
            .flatMap((st) => [st.Resource].flat());
          if (!s3Users.includes(functionName)) {
            expect(s3Resources, functionName).toEqual([]);
          }
          expect(s3Resources, functionName).not.toContain(`${BUCKET}/*`);
          expect(s3Resources, functionName).not.toContain(BUCKET);
        }
      });
    });

    it("every role holding UpdateItem on the platform table carries the audit-row deny", async () => {
      await build();
      const roles = resourcesOfType("aws:iam/role:Role").map((r) => r.inputs.name as string);
      const mutating = roles.filter((role) =>
        isGranted(statementsForRole(role), "dynamodb:UpdateItem", TABLE),
      );
      expect(mutating.sort()).toEqual(
        [
          fn("occupancies-update"),
          fn("hydrants-update"),
          fn("inspections-record"),
          fn("field-capture"),
        ].sort(),
      );
      for (const role of mutating) {
        const deny = statementsForRole(role).find((st) => st.Sid === "DenyAuditMutations");
        expect(deny?.Effect, role).toBe("Deny");
      }
    });

    it("alarms when a field capture fails to persist (an offline outbox entry that never syncs)", async () => {
      await build();
      const alarm = alarmByName("boxalarm-dev-inspections-field-capture-failed");
      expect(alarm.inputs).toMatchObject({
        namespace: "Boxalarm/inspections",
        metricName: "InspectionFieldCaptureFailed",
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
      });
    });
  },
);
