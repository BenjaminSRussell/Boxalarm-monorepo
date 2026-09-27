import * as path from "path";
import { pathToFileURL } from "url";
import { beforeAll, describe, expect, it } from "vitest";
import { SERVICES, ServiceName } from "../../components/observability/services";
import { HEALTH_RESERVED_CONCURRENCY, ServiceHealth } from "../../components/api/service-health";
import {
  ACCOUNT_ID,
  REGION,
  STACK_CONFIG,
  installMocks,
  lambdaByName,
  lambdaEnv,
  resourcesOfType,
  settleStack,
  statementsForRole,
  type MockedResource,
  type PolicyStatement,
} from "../alerting/mock-harness";

/**
 * architecture.md §2 route table: every service has GET health/liveness and
 * health/readiness with auth "none" (§4.3). notification-service is the one deviation: the
 * table says /notifications, the deployed inbox is under /api/v1/notifications.
 */
const EXPECTED_PREFIX: Record<ServiceName, string> = {
  "alerting-service": "/api/v1/alerting",
  "platform-service": "/api/v1/platform",
  "personnel-service": "/api/v1/personnel",
  "apparatus-service": "/api/v1/apparatus",
  "incident-service": "/api/v1/incidents",
  "training-service": "/api/v1/training",
  "reporting-service": "/api/v1/reporting",
  "inspections-service": "/api/v1/inspections",
  "inventory-service": "/api/v1/inventory",
  "notification-service": "/api/v1/notifications",
};

const VENDOR_WEBHOOK_ROUTES = [
  "POST /api/v1/alerting/receipts/sms",
  "POST /api/v1/alerting/receipts/voice",
  "POST /api/v1/alerting/receipts/push",
];

/** Everything a health role may do beyond the shared observability statements. */
const READ_ONLY_ACTIONS = new Set([
  "dynamodb:GetItem",
  "dynamodb:Query",
  "kms:Decrypt",
  "kms:DescribeKey",
  "events:DescribeEventBus",
]);
const OBSERVABILITY_SIDS = new Set(["WriteOwnLogGroup", "XRayWrite", "CloudWatchMetrics"]);

const tableArn = (name: string) => `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${name}`;

const healthFunctionName = (service: ServiceName) =>
  `boxalarm-dev-${service.replace(/-service$/, "")}-health`;

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

let routes: MockedResource[];
let tables: Record<"platform" | "incident" | "alerting", string>;

beforeAll(async () => {
  installMocks(STACK_CONFIG);
  await import("../../index");
  await settleStack();
  routes = resourcesOfType("aws:apigatewayv2/route:Route");
  const tableNamed = (fragment: string) => {
    const table = resourcesOfType("aws:dynamodb/table:Table").find((t) =>
      (t.inputs.name as string).includes(fragment),
    );
    return tableArn(table!.inputs.name as string);
  };
  tables = {
    platform: tableNamed("platform"),
    incident: tableNamed("incident"),
    alerting: tableNamed("alerting"),
  };
}, 120_000);

function routeFor(routeKey: string): MockedResource {
  const route = routes.find((r) => r.inputs.routeKey === routeKey);
  if (!route) {
    throw new Error(`no route ${routeKey}`);
  }
  return route;
}

/** The Lambda function name behind a route's AWS_PROXY integration. */
function lambdaBehind(route: MockedResource): string {
  const integrationId = (route.inputs.target as string).replace(/^integrations\//, "");
  const integration = resourcesOfType("aws:apigatewayv2/integration:Integration").find(
    (i) => `${i.name}-id` === integrationId,
  );
  return /function:([^/]+)\/invocations$/.exec(integration!.inputs.integrationUri as string)![1]!;
}

function healthStatements(service: ServiceName): PolicyStatement[] {
  return statementsForRole(healthFunctionName(service)).filter(
    (s) => !OBSERVABILITY_SIDS.has(s.Sid ?? ""),
  );
}

describe("per-service health routes (full stack)", { timeout: 120_000 }, () => {
  it.each(SERVICES)(
    "%s has both health routes, unauthenticated, on its own health Lambda",
    (service) => {
      for (const probe of ["liveness", "readiness"]) {
        const route = routeFor(`GET ${EXPECTED_PREFIX[service]}/health/${probe}`);
        expect(route.inputs.authorizationType, probe).toBe("NONE");
        expect(route.inputs.authorizerId, probe).toBeUndefined();
        expect(lambdaBehind(route), probe).toBe(healthFunctionName(service));
      }
    },
  );

  it("every other route still goes through the Cognito authorizer", () => {
    const healthKeys = SERVICES.flatMap((s) =>
      ["liveness", "readiness"].map((p) => `GET ${EXPECTED_PREFIX[s]}/health/${p}`),
    );
    const open = routes
      .filter((r) => r.inputs.authorizationType !== "CUSTOM")
      .map((r) => r.inputs.routeKey as string)
      .sort();
    expect(open).toEqual([...healthKeys, ...VENDOR_WEBHOOK_ROUTES].sort());
  });

  it.each(SERVICES)("%s's health Lambda holds no write permission", (service) => {
    const statements = healthStatements(service);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(s.Effect, s.Sid).toBe("Allow");
      for (const action of asArray(s.Action)) {
        expect(READ_ONLY_ACTIONS.has(action), `${service} ${s.Sid}: ${action}`).toBe(true);
      }
      // Every table grant is pinned to named partitions, never the whole table.
      if (asArray(s.Action).some((a) => a.startsWith("dynamodb:"))) {
        const condition = s.Condition?.["ForAllValues:StringEquals"] ??
          s.Condition?.["ForAllValues:StringLike"] ?? { "dynamodb:LeadingKeys": [] };
        expect(asArray(condition["dynamodb:LeadingKeys"]!).length, s.Sid).toBeGreaterThan(0);
      }
    }
  });

  it.each(SERVICES)("%s's readiness reads only its own table", (service) => {
    const own =
      service === "alerting-service"
        ? tables.alerting
        : service === "incident-service"
          ? tables.incident
          : tables.platform;
    const dynamoResources = healthStatements(service)
      .filter((s) => asArray(s.Action).some((a) => a.startsWith("dynamodb:")))
      .flatMap((s) => asArray(s.Resource));
    expect(new Set(dynamoResources)).toEqual(new Set([own]));
    expect(lambdaEnv(healthFunctionName(service)).HEALTH_TABLE_NAME).toBeTruthy();
  });

  it.each(SERVICES)("%s's health Lambda reserves concurrency and a short timeout", (service) => {
    const fn = lambdaByName(healthFunctionName(service));
    expect(fn.inputs.reservedConcurrentExecutions).toBe(HEALTH_RESERVED_CONCURRENCY);
    expect(fn.inputs.timeout).toBe(5);
  });

  it("the sentinel GetItem is pinned to the partition the backend probe reads", () => {
    const sentinel = healthStatements("training-service").find(
      (s) => s.Sid === "HealthSentinelRead",
    );
    expect(sentinel?.Condition).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["DEPT#HEALTHCHECK#HEALTH"] },
    });
  });

  it("LOB health describes the platform bus; alerting health never touches it", () => {
    for (const service of SERVICES) {
      const env = lambdaEnv(healthFunctionName(service));
      const describesBus = healthStatements(service).some((s) =>
        asArray(s.Action).includes("events:DescribeEventBus"),
      );
      const isAlerting = service === "alerting-service";
      expect(describesBus, service).toBe(!isAlerting);
      expect(env.HEALTH_EVENT_BUS_NAME === undefined, service).toBe(isAlerting);
    }
  });

  it("alerting health reads the canary signal inside the alerting IAM boundary", () => {
    const fnName = healthFunctionName("alerting-service");
    const role = resourcesOfType("aws:iam/role:Role").find((r) => r.inputs.name === fnName);
    expect(role?.inputs.permissionsBoundary).toMatch(/alerting-plane-boundary$/);

    const query = healthStatements("alerting-service").find(
      (s) => s.Sid === "HealthPartitionQuery",
    );
    expect(query?.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#nichols-fd#CANARY#*"] },
    });
    // The CMK grant is decrypt-only, through DynamoDB.
    const kms = healthStatements("alerting-service").find((s) =>
      asArray(s.Action).includes("kms:Decrypt"),
    );
    expect(kms?.Condition).toEqual({
      StringEquals: { "kms:ViaService": [`dynamodb.${REGION}.amazonaws.com`] },
    });

    // canaryEnabled defaults off; 2-minute ticks x 3 is under the 10-minute floor.
    expect(lambdaEnv(fnName)).toMatchObject({
      CANARY_ENABLED: "false",
      CANARY_DEPT_ID: "nichols-fd",
      CANARY_MAX_AGE_SECONDS: "600",
    });
  });

  it("the invoke permission is scoped to the health paths", () => {
    const permission = resourcesOfType("aws:lambda/permission:Permission").find(
      (p) => p.name === "training-health-invoke",
    );
    expect(permission?.inputs.sourceArn).toMatch(/\/\*\/GET\/api\/v1\/training\/health\/\*$/);
  });

  it("every service's health Lambda is in the backend manifest", async () => {
    const manifestPath = path.resolve(__dirname, "../../../backend/scripts/lambda-manifest.mjs");
    const { LAMBDA_ENTRIES } = (await import(pathToFileURL(manifestPath).href)) as {
      LAMBDA_ENTRIES: { service: string; function: string }[];
    };
    for (const service of SERVICES) {
      expect(
        LAMBDA_ENTRIES.some((e) => e.service === service && e.function === "health"),
        service,
      ).toBe(true);
    }
  });
});

describe("ServiceHealth args", () => {
  it("rejects a route prefix outside /api/v1/<service>", () => {
    expect(
      () =>
        new ServiceHealth("bad", {
          env: "dev",
          serviceName: "training-service",
          routePrefix: "/notifications",
          httpApi: undefined as never,
          logGroup: undefined as never,
          tableName: "t",
          tableArn: "arn",
        }),
    ).toThrow(/routePrefix/);
  });
});
