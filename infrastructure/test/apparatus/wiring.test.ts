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
  installMocks,
  isGranted,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
} from "../alerting/mock-harness";

/**
 * Each apparatus-service Lambda's env keys and IAM grants, asserted against what its
 * backend handler reads and calls (traced through the handler into apparatusRepository.ts,
 * repository.ts, checklistResolution.ts, complianceReport.ts, defectRepository.ts and
 * inventory/compartmentItemRepository.ts) — including the GSI index ARNs its queries
 * need, which a table-only grant silently denies.
 */

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const GSI2 = `${TABLE}/index/GSI2`;
const GSI3 = `${TABLE}/index/GSI3`;
const POLICY_STORE = `arn:aws:verifiedpermissions::${ACCOUNT_ID}:policy-store/ps-1`;

type Target = typeof TABLE | typeof GSI2 | typeof GSI3;

interface Expected {
  /** Every (action, resource) the handler's live path calls. */
  grants: [string, Target][];
  cedar: boolean;
}

const q = (target: Target): [string, Target] => ["dynamodb:Query", target];
const put: [string, Target] = ["dynamodb:PutItem", TABLE];
const get: [string, Target] = ["dynamodb:GetItem", TABLE];
const update: [string, Target] = ["dynamodb:UpdateItem", TABLE];

const EXPECTED: Record<string, Expected> = {
  list: { grants: [q(GSI3)], cedar: false },
  create: { grants: [put], cedar: false },
  get: { grants: [q(GSI3), q(TABLE)], cedar: false },
  "service-status-update": { grants: [q(GSI3), q(TABLE), update, put], cedar: true },
  "checklist-get": { grants: [q(GSI3), ["dynamodb:Scan", TABLE]], cedar: true },
  "checks-submit": { grants: [q(GSI3), put, get], cedar: true },
  "defects-report": { grants: [q(GSI3), q(TABLE), get, put, update], cedar: true },
  compliance: { grants: [q(GSI3)], cedar: true },
  "maintenance-get": { grants: [q(TABLE)], cedar: true },
  "maintenance-log": { grants: [get, put], cedar: true },
  "scba-log": { grants: [q(GSI3), put], cedar: true },
  "scba-testing-schedules": { grants: [q(GSI2)], cedar: true },
  "tests-log": { grants: [q(GSI3), put], cedar: true },
  "testing-schedules": { grants: [q(GSI2), q(GSI3)], cedar: true },
  "inventory-list": { grants: [q(TABLE)], cedar: true },
  "inventory-create": { grants: [put], cedar: true },
  "inventory-quantity": { grants: [get, update, put], cedar: true },
};

const ALL_DYNAMO_ACTIONS = [
  "dynamodb:GetItem",
  "dynamodb:Query",
  "dynamodb:Scan",
  "dynamodb:PutItem",
  "dynamodb:UpdateItem",
  "dynamodb:DeleteItem",
  "dynamodb:ConditionCheckItem",
  "dynamodb:BatchWriteItem",
  "dynamodb:BatchGetItem",
];

const fnName = (key: string) => `boxalarm-dev-apparatus-${key}`;

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
    // An Output, as index.ts passes it — proves index ARNs are resolved, not stringified.
    platformTableArn: pulumi.output(TABLE),
    policyStoreArn: pulumi.output(POLICY_STORE),
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

describe("apparatus Lambdas: env and IAM match their handlers", { timeout: 30_000 }, () => {
  it("deploys exactly the seventeen apparatus route Lambdas", async () => {
    await build();
    const names = resourcesOfType("aws:lambda/function:Function")
      .map((r) => r.inputs.name as string)
      .filter((n) => n.startsWith("boxalarm-dev-apparatus-"))
      .sort();
    expect(names).toEqual(Object.keys(EXPECTED).map(fnName).sort());
  });

  it.each(Object.entries(EXPECTED))(
    "%s holds every grant its handler calls, and no other DynamoDB grant",
    async (key, expected) => {
      await build();
      const s = statementsForRole(fnName(key));
      for (const [action, target] of expected.grants) {
        expect(isGranted(s, action, target), `${action} on ${target}`).toBe(true);
      }
      for (const action of ALL_DYNAMO_ACTIONS) {
        for (const target of [TABLE, GSI2, GSI3, `${TABLE}/index/*`, "*"]) {
          const wanted = expected.grants.some(([a, t]) => a === action && t === target);
          if (!wanted) {
            expect(isGranted(s, action, target), `unexpected ${action} on ${target}`).toBe(false);
          }
        }
      }
      // A TransactWriteItems grant alone authorizes nothing; never rely on it.
      expect(isGranted(s, "dynamodb:TransactWriteItems", () => true)).toBe(false);
    },
  );

  it.each(Object.entries(EXPECTED))(
    "%s carries PLATFORM_TABLE_NAME, and the policy store id iff it is Cedar-gated",
    async (key, expected) => {
      await build();
      const env = lambdaEnv(fnName(key));
      expect(env.PLATFORM_TABLE_NAME).toBe("boxalarm-dev-platform-service");
      if (expected.cedar) {
        expect(env.VERIFIED_PERMISSIONS_POLICY_STORE_ID).toBe("ps-1");
      } else {
        expect(env.VERIFIED_PERMISSIONS_POLICY_STORE_ID).toBeUndefined();
      }
    },
  );

  it.each(Object.entries(EXPECTED))(
    "%s can call Verified Permissions iff it is Cedar-gated",
    async (key, expected) => {
      await build();
      const s = statementsForRole(fnName(key));
      expect(isGranted(s, "verifiedpermissions:IsAuthorizedWithToken", POLICY_STORE)).toBe(
        expected.cedar,
      );
    },
  );

  // Defect photos: a presigned S3 PUT into platform-assets, never CloudFront (N6.1).
  it("only defects-report may write assets, and only under {deptId}/defect/", async () => {
    await build();
    for (const key of Object.keys(EXPECTED)) {
      const s = statementsForRole(fnName(key));
      const put = s.filter((st) => st.Sid === "AssetsPresignedPut");
      if (key === "defects-report") {
        expect(put.map((st) => st.Resource)).toEqual([
          ["arn:aws:s3:::boxalarm-dev-platform-assets/*/defect/*"],
        ]);
        expect(lambdaEnv(fnName(key)).PLATFORM_ASSETS_BUCKET_NAME).toBe(
          "boxalarm-dev-platform-assets",
        );
      } else {
        expect(put, key).toEqual([]);
        expect(lambdaEnv(fnName(key)).PLATFORM_ASSETS_BUCKET_NAME, key).toBeUndefined();
      }
    }
  });

  it("every role holding UpdateItem on the platform table carries the audit-row deny", async () => {
    await build();
    const mutating = Object.keys(EXPECTED).filter((key) =>
      isGranted(statementsForRole(fnName(key)), "dynamodb:UpdateItem", TABLE),
    );
    expect(mutating.sort()).toEqual(
      ["defects-report", "inventory-quantity", "service-status-update"].sort(),
    );
    for (const key of mutating) {
      const deny = statementsForRole(fnName(key)).find((st) => st.Sid === "DenyAuditMutations");
      expect(deny?.Effect, key).toBe("Deny");
    }
  });

  it("no apparatus role can touch the alerting or incident tables", async () => {
    await build();
    for (const key of Object.keys(EXPECTED)) {
      const policy = JSON.stringify(statementsForRole(fnName(key)));
      expect(policy, key).not.toMatch(/table\/[^"]*(alerting|incident)/);
    }
  });
});
