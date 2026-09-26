import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";

const created: Array<{ type: string; inputs: Record<string, unknown> }> = [];

beforeEach(() => {
  created.length = 0;
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      created.push({ type: args.type, inputs: args.inputs as Record<string, unknown> });
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
        state.invokeArn = `${state.arn}-invoke`;
      }
      if (args.type === "aws:kms/key:Key") {
        state.arn = `arn:aws:kms:us-east-1:123456789012:key/${args.name}`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:apigatewayv2/api:Api") {
        state.apiEndpoint = `https://${args.name}.execute-api.us-east-1.amazonaws.com`;
        state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity") {
        return {
          accountId: "123456789012",
          arn: "arn:aws:iam::123456789012:root",
          userId: "AIDATEST",
        };
      }
      return args.inputs;
    },
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("Retention", () => {
  async function build() {
    const { Retention } = await import("../../components/platform/retention");
    const logGroup = new ServiceLogGroup("test-retention-log-group", {
      env: "dev",
      serviceName: "platform-service",
    });
    const httpApi = new HttpApi("test-retention-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    return new Retention("test-retention", {
      env: "dev",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      policyStoreId: pulumi.output("ps-1"),
      chiefNotificationTopicArn: pulumi.output("arn:aws:sns:us-east-1:123456789012:chief"),
      logGroup,
      httpApi,
    });
  }

  it("wires VERIFIED_PERMISSIONS_POLICY_STORE_ID into the disposal Lambda's environment", async () => {
    const retention = await build();
    const env = await resolve(retention.disposalLambda.function.environment);
    expect(env?.variables?.VERIFIED_PERMISSIONS_POLICY_STORE_ID).toBe("ps-1");
  });

  it("scopes kms:ScheduleKeyDeletion by the crypto-shred tag, not by two fixed CMK ARNs (AC3)", async () => {
    const retention = await build();
    const rolePolicyStatements = await resolve(retention.disposalLambda.rolePolicy.policy);
    const policy = JSON.parse(rolePolicyStatements) as {
      Statement: Array<{
        Sid: string;
        Action: string[];
        Resource: string | string[];
        Condition?: Record<string, Record<string, string[]>>;
      }>;
    };
    const shred = policy.Statement.find((s) => s.Sid === "CryptoShredArchiveKeysOnly");
    expect(shred?.Action).toEqual(["kms:ScheduleKeyDeletion"]);
    // Tag-scoped rather than pinned to the two CMKs provisioned here: the backend
    // shreds the per-item item.kmsKeyId, which a future archive-writer may mint
    // outside this component — tag scoping covers those keys without a companion
    // infra change, as long as they carry the same tag. Also scoped by env so one
    // env's disposal role can't schedule deletion of another env's CMKs — all stacks
    // share one account.
    expect(shred?.Condition).toEqual({
      StringEquals: {
        "aws:ResourceTag/boxalarm:crypto-shred": ["true"],
        "aws:ResourceTag/boxalarm:env": ["dev"],
      },
    });
  });

  it("tags both archive CMKs with the crypto-shred tag and env the disposal role's grant is scoped by", async () => {
    const retention = await build();
    const [incidentTags, receiptTags] = await Promise.all([
      resolve(retention.archivedIncidentCmk.tags),
      resolve(retention.archivedDeliveryReceiptCmk.tags),
    ]);
    expect(incidentTags?.["boxalarm:crypto-shred"]).toBe("true");
    expect(incidentTags?.["boxalarm:env"]).toBe("dev");
    expect(receiptTags?.["boxalarm:crypto-shred"]).toBe("true");
    expect(receiptTags?.["boxalarm:env"]).toBe("dev");
  });

  it("grants no alerting-table permission and no incident-table delete (AC4)", async () => {
    const retention = await build();
    const policyJson = await resolve(retention.disposalLambda.rolePolicy.policy);
    expect(policyJson).not.toContain("table/alerting");
    expect(policyJson).not.toContain("table/incident");
  });

  it("grants GetItem (per-candidate read) and PutItem (its own audit write), never BatchWriteItem", async () => {
    const retention = await build();
    const policyJson = await resolve(retention.disposalLambda.rolePolicy.policy);
    const policy = JSON.parse(policyJson) as {
      Statement: Array<{ Sid: string; Action: string[] }>;
    };
    const statement = policy.Statement.find((s) => s.Sid === "DisposalLobClassAccess");
    expect(statement?.Action).toEqual(
      expect.arrayContaining(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]),
    );
    expect(statement?.Action).not.toContain("dynamodb:BatchWriteItem");
  });

  it("denies mutation on audit keys via the shared deny helper", async () => {
    const retention = await build();
    const policyJson = await resolve(retention.disposalLambda.rolePolicy.policy);
    const policy = JSON.parse(policyJson) as { Statement: Array<{ Sid: string }> };
    expect(policy.Statement.some((s) => s.Sid === "DenyAuditMutations")).toBe(true);
  });

  async function routeKeys(): Promise<string[]> {
    const retention = await build();
    await resolve(retention.configLambda.function.arn);
    await resolve(retention.disposalLambda.function.arn);
    await new Promise((r) => setImmediate(r));
    return created
      .filter((r) => r.type === "aws:apigatewayv2/route:Route")
      .map((r) => r.inputs.routeKey as string)
      .sort();
  }

  it("routes disposal and the retention config GET/PUT the web Settings page calls", async () => {
    // configHandler.ts matches event.routeKey exactly; it was never bundled or routed,
    // so the Settings retention panel 404ed.
    expect(await routeKeys()).toEqual([
      "GET /api/v1/platform/retention",
      "POST /api/v1/platform/retention/disposal",
      "PUT /api/v1/platform/retention",
    ]);
  });

  it("points the config Lambda at the bundled retention-config handler with a least-privilege grant", async () => {
    const retention = await build();
    const [env, policyJson] = await Promise.all([
      resolve(retention.configLambda.function.environment),
      resolve(retention.configLambda.rolePolicy.policy),
    ]);
    expect(env?.variables?.PLATFORM_TABLE_NAME).toBe("platform-table");
    expect(env?.variables?.VERIFIED_PERMISSIONS_POLICY_STORE_ID).toBe("ps-1");
    const policy = JSON.parse(policyJson) as {
      Statement: Array<{ Sid: string; Action: string | string[] }>;
    };
    const access = policy.Statement.find((s) => s.Sid === "RetentionConfigAccess");
    expect(access?.Action).toEqual(["dynamodb:GetItem", "dynamodb:PutItem"]);
    expect(policy.Statement.some((s) => s.Sid === "DenyAuditMutations")).toBe(true);
  });

  it("creates no disposal schedule: disposal runs only on an explicit admin request", async () => {
    await routeKeys();
    expect(created.some((r) => r.type === "aws:scheduler/schedule:Schedule")).toBe(false);
  });

  it("alarms the chief topic on every disposal invocation, no volume threshold", async () => {
    const retention = await build();
    const [threshold, comparison, actions] = await Promise.all([
      resolve(retention.invokedAlarm.threshold),
      resolve(retention.invokedAlarm.comparisonOperator),
      resolve(retention.invokedAlarm.alarmActions),
    ]);
    expect(threshold).toBe(0);
    expect(comparison).toBe("GreaterThanThreshold");
    expect(actions).toContain("arn:aws:sns:us-east-1:123456789012:chief");
  });

  it("watches the backend's actual DisposalInvoked metric, not raw AWS/Lambda Invocations", async () => {
    const retention = await build();
    const [namespace, metricName] = await Promise.all([
      resolve(retention.invokedAlarm.namespace),
      resolve(retention.invokedAlarm.metricName),
    ]);
    // disposal.ts's emitDisposalInvoked() only fires from inside runDisposal's
    // finally block — i.e. when the business logic actually executes, not on every
    // raw Lambda invocation (including a failed-auth/404 request from the scheduler,
    // which previously paged the chief every single day regardless).
    expect(namespace).toBe("Boxalarm/platform");
    expect(metricName).toBe("DisposalInvoked");
  });
});
