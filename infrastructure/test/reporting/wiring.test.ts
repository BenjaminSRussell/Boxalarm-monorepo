import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";
import { PROJECTION_EVENT_TYPES, Reporting } from "../../components/reporting/reporting";
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
 * P1 #8: each reporting Lambda's env keys, IAM grants, routes and alarms, asserted against
 * what its backend handler actually reads and calls (the training/wiring.test.ts pattern) —
 * including the GSI ARNs its queries need, which a table-only grant silently denies.
 */

const { lambdaCodeCalls } = vi.hoisted(() => ({ lambdaCodeCalls: new Set<string>() }));

vi.mock("../../components/shared/lambda-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/shared/lambda-code")>();
  return {
    ...actual,
    lambdaCode: (service: string, functionName: string) => {
      lambdaCodeCalls.add(`${service}/${functionName}`);
      return actual.lambdaCode(service, functionName);
    },
  };
});

const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-platform-service`;
const GSI1 = `${TABLE}/index/GSI1`;
const GSI2 = `${TABLE}/index/GSI2`;
const GSI3 = `${TABLE}/index/GSI3`;
const INCIDENT = `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/boxalarm-dev-incident`;
const INCIDENT_GSI1 = `${INCIDENT}/index/GSI1`;
const INCIDENT_CMK = `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/incident-cmk`;
const BASELINE_FN = "boxalarm-dev-alerting-delivery-baseline";
const BASELINE_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${BASELINE_FN}`;
const WORKER_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:boxalarm-dev-reporting-export-worker`;
const BUCKET_OBJECTS = "arn:aws:s3:::boxalarm-dev-reporting-exports/*";
const CHIEF_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:boxalarm-dev-chief-notifications`;
const WRITES = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"];

beforeEach(() => {
  installMocks();
});

async function build() {
  const logGroup = new ServiceLogGroup("reporting-lg", {
    env: "dev",
    serviceName: "reporting-service",
  });
  const httpApi = new HttpApi("http-api", {
    env: "dev",
    userPoolId: "pool-1",
    allowedClientIds: ["client-1"],
    platformLogGroup: logGroup,
  });
  new Reporting("reporting", {
    env: "dev",
    platformTableName: "boxalarm-dev-platform-service",
    // Outputs, as index.ts passes them — proves index ARNs are resolved, not stringified.
    platformTableArn: pulumi.output(TABLE),
    incidentTableName: "boxalarm-dev-incident",
    incidentTableArn: pulumi.output(INCIDENT),
    incidentCmkArn: pulumi.output(INCIDENT_CMK),
    deliveryBaselineFunctionName: pulumi.output(BASELINE_FN),
    deliveryBaselineFunctionArn: pulumi.output(BASELINE_ARN),
    platformBusName: "boxalarm-dev-platform-bus",
    platformBusArn: `arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/boxalarm-dev-platform-bus`,
    chiefNotificationTopicArn: CHIEF_TOPIC,
    policyStoreArn: `arn:aws:verifiedpermissions::${ACCOUNT_ID}:policy-store/ps-1`,
    policyStoreId: "ps-1",
    logGroup,
    httpApi,
  });
  await settle();
}

/** routeKey → the Lambda function name its integration invokes. */
function routeTargets(): Map<string, string> {
  const integrations = resourcesOfType("aws:apigatewayv2/integration:Integration");
  const targets = new Map<string, string>();
  for (const route of resourcesOfType("aws:apigatewayv2/route:Route")) {
    const integrationId = String(route.inputs.target).replace("integrations/", "");
    const integration = integrations.find((i) => `${i.name}-id` === integrationId);
    const uri = String(integration?.inputs.integrationUri ?? "");
    const fn = /function:([^/]+)\/invocations$/.exec(uri)?.[1] ?? "";
    targets.set(String(route.inputs.routeKey), fn);
    expect(route.inputs.authorizationType, String(route.inputs.routeKey)).toBe("CUSTOM");
  }
  return targets;
}

describe("reporting Lambdas: env and IAM match their handlers", { timeout: 30_000 }, () => {
  it("routes every reporting path, behind the authorizer, to the Lambda whose handler serves it", async () => {
    await build();
    expect(Object.fromEntries(routeTargets())).toEqual({
      "GET /api/v1/reporting/losap/year-end": "boxalarm-dev-reporting-losap-year-end",
      "GET /api/v1/reporting/grants": "boxalarm-dev-reporting-grants",
      "GET /api/v1/reporting/membership-trends": "boxalarm-dev-reporting-membership-trends",
      "GET /api/v1/reporting/dashboard": "boxalarm-dev-reporting-dashboard",
      "GET /api/v1/reporting/response-times": "boxalarm-dev-reporting-response-times",
      "GET /api/v1/reporting/iso": "boxalarm-dev-reporting-iso",
      "POST /api/v1/reporting/export": "boxalarm-dev-reporting-export",
      "GET /api/v1/reporting/export/{jobId}": "boxalarm-dev-reporting-export",
      "GET /api/v1/reporting/cutover-decision": "boxalarm-dev-reporting-cutover-decision-get",
      "POST /api/v1/reporting/cutover-decision": "boxalarm-dev-reporting-cutover-decision-post",
    });
  });

  it("dashboard holds a base-table Query on the rollup partition and no write", async () => {
    await build();
    const s = statementsForRole("boxalarm-dev-reporting-dashboard");
    expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(true);
    for (const action of [...WRITES, "dynamodb:Scan"]) {
      expect(isGranted(s, action, TABLE), action).toBe(false);
    }
  });

  it("response-times queries incident GSI1 + base and can decrypt the incident CMK, nothing on the platform table", async () => {
    await build();
    const s = statementsForRole("boxalarm-dev-reporting-response-times");
    expect(isGranted(s, "dynamodb:Query", INCIDENT_GSI1)).toBe(true);
    expect(isGranted(s, "dynamodb:Query", INCIDENT)).toBe(true);
    expect(isGranted(s, "kms:Decrypt", INCIDENT_CMK)).toBe(true);
    expect(isGranted(s, "dynamodb:Query", (r) => r.startsWith(TABLE))).toBe(false);
  });

  it("ISO queries platform GSI2 (hydrants), GSI3 (events, apparatus) and base, plus incident GSI1", async () => {
    await build();
    const s = statementsForRole("boxalarm-dev-reporting-iso");
    for (const resource of [TABLE, GSI2, GSI3, INCIDENT, INCIDENT_GSI1]) {
      expect(isGranted(s, "dynamodb:Query", resource), resource).toBe(true);
    }
    expect(isGranted(s, "kms:Decrypt", INCIDENT_CMK)).toBe(true);
    for (const action of WRITES) {
      expect(isGranted(s, action, TABLE), action).toBe(false);
    }
  });

  it("export can Put/Get/Update its job row, invoke only the worker, and read (presign) only its own bucket", async () => {
    await build();
    const s = statementsForRole("boxalarm-dev-reporting-export");
    for (const action of ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem"]) {
      expect(isGranted(s, action, TABLE), action).toBe(true);
    }
    expect(isGranted(s, "dynamodb:Query", TABLE)).toBe(false);
    expect(isGranted(s, "lambda:InvokeFunction", WORKER_ARN)).toBe(true);
    expect(isGranted(s, "lambda:InvokeFunction", (r) => r !== WORKER_ARN)).toBe(false);
    expect(isGranted(s, "s3:GetObject", BUCKET_OBJECTS)).toBe(true);
    expect(isGranted(s, "s3:PutObject", BUCKET_OBJECTS)).toBe(false);
  });

  it("the export worker can read every report's sources, mark its job, and write only its bucket", async () => {
    await build();
    const s = statementsForRole("boxalarm-dev-reporting-export-worker");
    for (const resource of [TABLE, GSI1, GSI2, GSI3, INCIDENT, INCIDENT_GSI1]) {
      expect(isGranted(s, "dynamodb:Query", resource), resource).toBe(true);
    }
    expect(isGranted(s, "dynamodb:UpdateItem", TABLE)).toBe(true);
    expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(false);
    expect(isGranted(s, "kms:Decrypt", INCIDENT_CMK)).toBe(true);
    expect(isGranted(s, "s3:PutObject", BUCKET_OBJECTS)).toBe(true);
    expect(lambdaByName("boxalarm-dev-reporting-export-worker").inputs.timeout).toBe(300);
  });

  it("cutover GET reads its decision row and may invoke only alerting's delivery-baseline Lambda", async () => {
    await build();
    const s = statementsForRole("boxalarm-dev-reporting-cutover-decision-get");
    expect(isGranted(s, "dynamodb:GetItem", TABLE)).toBe(true);
    expect(isGranted(s, "lambda:InvokeFunction", BASELINE_ARN)).toBe(true);
    expect(isGranted(s, "lambda:InvokeFunction", (r) => r !== BASELINE_ARN)).toBe(false);
    for (const action of WRITES) {
      expect(isGranted(s, action, TABLE), action).toBe(false);
    }
  });

  it("cutover POST holds PutItem — the per-item grant its two-Put transaction needs — and nothing else", async () => {
    await build();
    const s = statementsForRole("boxalarm-dev-reporting-cutover-decision-post");
    expect(isGranted(s, "dynamodb:PutItem", TABLE)).toBe(true);
    for (const action of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:GetItem"]) {
      expect(isGranted(s, action, TABLE), action).toBe(false);
    }
  });

  it("the projections consumer can Put the dedup marker and Update/Delete rollups, fed by every projected detail-type", async () => {
    await build();
    const s = statementsForRole("boxalarm-dev-reporting-projections");
    for (const action of WRITES) {
      expect(isGranted(s, action, TABLE), action).toBe(true);
    }
    expect(
      isGranted(s, "sqs:ReceiveMessage", (r) => r.includes("reporting-projection-queue")),
    ).toBe(true);
    const esm = esmFor("boxalarm-dev-reporting-projections");
    expect(esm.inputs.functionResponseTypes).toEqual(["ReportBatchItemFailures"]);

    const rule = resourcesOfType("aws:cloudwatch/eventRule:EventRule").find(
      (r) => r.inputs.name === "boxalarm-dev-reporting-projections",
    );
    const pattern = JSON.parse(String(rule?.inputs.eventPattern)) as { "detail-type": string[] };

    // Drift guard against the backend's own set (projections/events.ts).
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../backend/src/services/reporting-service/projections/events.ts",
      ),
      "utf8",
    );
    const block = /PROJECTION_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? "";
    const backendTypes = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(backendTypes.length).toBeGreaterThan(5);
    expect([...PROJECTION_EVENT_TYPES].sort()).toEqual(backendTypes);
    expect([...pattern["detail-type"]].sort()).toEqual(backendTypes);
  });

  it("every reporting role holding UpdateItem/DeleteItem on the platform table carries the audit-row deny", async () => {
    await build();
    const roles = resourcesOfType("aws:iam/role:Role").map((r) => r.inputs.name as string);
    const mutating = roles.filter((role) => {
      const s = statementsForRole(role);
      return (
        isGranted(s, "dynamodb:UpdateItem", TABLE) || isGranted(s, "dynamodb:DeleteItem", TABLE)
      );
    });
    expect(mutating.sort()).toEqual([
      "boxalarm-dev-reporting-export",
      "boxalarm-dev-reporting-export-worker",
      "boxalarm-dev-reporting-projections",
    ]);
    for (const role of mutating) {
      const deny = statementsForRole(role).find((st) => st.Sid === "DenyAuditMutations");
      expect(deny?.Effect, role).toBe("Deny");
    }
  });

  it("no reporting role can Scan", async () => {
    await build();
    for (const role of resourcesOfType("aws:iam/role:Role").map((r) => r.inputs.name as string)) {
      expect(
        isGranted(statementsForRole(role), "dynamodb:Scan", () => true),
        role,
      ).toBe(false);
    }
  });

  it("the exports bucket blocks public access, encrypts, and expires objects after 7 days", async () => {
    await build();
    const block = resourcesOfType("aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock")[0];
    expect(block?.inputs).toMatchObject({
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    const lifecycle = resourcesOfType(
      "aws:s3/bucketLifecycleConfigurationV2:BucketLifecycleConfigurationV2",
    )[0];
    const rules = lifecycle?.inputs.rules as { expiration: { days: number } }[];
    expect(rules[0]?.expiration.days).toBe(7);
    expect(
      resourcesOfType(
        "aws:s3/bucketServerSideEncryptionConfigurationV2:BucketServerSideEncryptionConfigurationV2",
      ),
    ).toHaveLength(1);
  });

  it("alarms the chief on every export, export failures, worker crashes and a failed cutover write", async () => {
    await build();
    for (const [alarmName, metricName, namespace] of [
      [
        "boxalarm-dev-reporting-export-invoked",
        "ReportingExportAccepted",
        "Boxalarm/ReportingService",
      ],
      [
        "boxalarm-dev-reporting-export-failed",
        "ReportingExportFailed",
        "Boxalarm/ReportingService",
      ],
      [
        "boxalarm-dev-reporting-cutover-decision-post-failed",
        "ReportingCutoverDecisionPostFailed",
        "Boxalarm/ReportingService",
      ],
      ["boxalarm-dev-reporting-export-worker-errors", "Errors", "AWS/Lambda"],
    ] as const) {
      const alarm = alarmByName(alarmName);
      expect(alarm.inputs.metricName, alarmName).toBe(metricName);
      expect(alarm.inputs.namespace, alarmName).toBe(namespace);
      expect(alarm.inputs.alarmActions, alarmName).toEqual([CHIEF_TOPIC]);
    }
    expect(alarmByName("boxalarm-dev-reporting-projection-queue-dlq-depth").inputs.threshold).toBe(
      0,
    );
  });

  it("the alarmed metric names are ones the backend actually emits", async () => {
    const dir = path.resolve(__dirname, "../../../backend/src/services/reporting-service");
    const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8");
    const exportSource = read("export/handler.ts") + read("export/worker.ts");
    expect(exportSource).toContain("'Boxalarm/ReportingService'");
    expect(exportSource).toContain("'ReportingExportAccepted'");
    expect(exportSource).toContain("'ReportingExportFailed'");
    expect(read("cutoverDecision/post.ts")).toContain("'ReportingCutoverDecisionPostFailed'");
  });

  // Env keys each handler's config readers require on its live path (awsClients.ts
  // readReportingServiceConfig, client.ts readGrantsReportConfig, dynamoClient.ts
  // readPersonnel/AttendanceTableConfig, responseTimes readIncidentTableName, export/clients.ts,
  // cutoverDecision/deliveryBaseline.ts, and @boxalarm/authz's readAuthzConfig).
  const VP = "VERIFIED_PERMISSIONS_POLICY_STORE_ID";
  const REQUIRED_ENV: Record<string, string[]> = {
    "boxalarm-dev-reporting-losap-year-end": ["PLATFORM_SERVICE_TABLE_NAME", VP],
    "boxalarm-dev-reporting-grants": [
      "PERSONNEL_TABLE_NAME",
      "TRAINING_DYNAMO_TABLE_NAME",
      "PLATFORM_TABLE_NAME",
      VP,
    ],
    "boxalarm-dev-reporting-membership-trends": [
      "PERSONNEL_TABLE_NAME",
      "PLATFORM_SERVICE_TABLE_NAME",
      VP,
    ],
    "boxalarm-dev-reporting-dashboard": ["PLATFORM_SERVICE_TABLE_NAME", VP],
    "boxalarm-dev-reporting-response-times": ["INCIDENT_TABLE_NAME", VP],
    "boxalarm-dev-reporting-iso": ["PLATFORM_SERVICE_TABLE_NAME", "INCIDENT_TABLE_NAME", VP],
    "boxalarm-dev-reporting-export": [
      "PLATFORM_SERVICE_TABLE_NAME",
      "EXPORTS_BUCKET_NAME",
      "REPORTING_EXPORT_WORKER_FUNCTION_NAME",
      VP,
    ],
    // buildReport.ts reaches every report's config reader.
    "boxalarm-dev-reporting-export-worker": [
      "PLATFORM_SERVICE_TABLE_NAME",
      "PERSONNEL_TABLE_NAME",
      "TRAINING_DYNAMO_TABLE_NAME",
      "PLATFORM_TABLE_NAME",
      "INCIDENT_TABLE_NAME",
      "EXPORTS_BUCKET_NAME",
    ],
    "boxalarm-dev-reporting-cutover-decision-get": [
      "PLATFORM_SERVICE_TABLE_NAME",
      "DELIVERY_BASELINE_FUNCTION_NAME",
      VP,
    ],
    "boxalarm-dev-reporting-cutover-decision-post": ["PLATFORM_SERVICE_TABLE_NAME", VP],
    "boxalarm-dev-reporting-projections": ["PLATFORM_SERVICE_TABLE_NAME"],
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

  it("wires the export worker and delivery-baseline names the handlers invoke", async () => {
    await build();
    expect(lambdaEnv("boxalarm-dev-reporting-export").REPORTING_EXPORT_WORKER_FUNCTION_NAME).toBe(
      "boxalarm-dev-reporting-export-worker",
    );
    expect(lambdaEnv("boxalarm-dev-reporting-export").EXPORTS_BUCKET_NAME).toBe(
      "boxalarm-dev-reporting-exports",
    );
    expect(
      lambdaEnv("boxalarm-dev-reporting-cutover-decision-get").DELIVERY_BASELINE_FUNCTION_NAME,
    ).toBe(BASELINE_FN);
  });

  it("every Cedar-gated reporting Lambda can call Verified Permissions", async () => {
    await build();
    for (const [fn, keys] of Object.entries(REQUIRED_ENV)) {
      if (!keys.includes(VP)) {
        continue;
      }
      expect(
        isGranted(statementsForRole(fn), "verifiedpermissions:IsAuthorizedWithToken", (r) =>
          r.includes("policy-store"),
        ),
        fn,
      ).toBe(true);
    }
  });

  it("every reporting-service manifest entry is wired, and every wired key is in the manifest", async () => {
    await build();
    const manifestPath = path.resolve(__dirname, "../../../backend/scripts/lambda-manifest.mjs");
    const { LAMBDA_ENTRIES } = (await import(pathToFileURL(manifestPath).href)) as {
      LAMBDA_ENTRIES: { service: string; function: string }[];
    };
    // reporting-service/health is wired by components/api/service-health.ts, not Reporting;
    // test/api/service-health.test.ts covers it for every service.
    const manifest = LAMBDA_ENTRIES.filter(
      (e) => e.service === "reporting-service" && e.function !== "health",
    )
      .map((e) => `${e.service}/${e.function}`)
      .sort();
    const wired = [...lambdaCodeCalls].filter((k) => k.startsWith("reporting-service/")).sort();
    expect(wired).toEqual(manifest);
  });
});
