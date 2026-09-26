import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";

const routeKeys: string[] = [];

beforeEach(() => {
  routeKeys.length = 0;
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:apigatewayv2/route:Route") {
        routeKeys.push(args.inputs.routeKey as string);
      }
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
        state.invokeArn = `${state.arn}-invoke`;
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
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("Config", () => {
  async function build() {
    const { Config } = await import("../../components/platform/config");
    const logGroup = new ServiceLogGroup("test-config-log-group", {
      env: "dev",
      serviceName: "platform-service",
    });
    const httpApi = new HttpApi("test-config-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    return new Config("test-config", {
      env: "dev",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      policyStoreId: pulumi.output("ps-1"),
      logGroup,
      httpApi,
    });
  }

  it("grants GetItem/PutItem on the platform table, never the non-functional TransactWriteItems", async () => {
    const cfg = await build();
    const policyJson = await resolve(cfg.lambda.rolePolicy.policy);
    const policy = JSON.parse(policyJson) as {
      Statement: Array<{ Sid: string; Action: string[] }>;
    };
    const statement = policy.Statement.find((s) => s.Sid === "ConfigTableAccess");
    expect(statement?.Action).toEqual(
      expect.arrayContaining(["dynamodb:GetItem", "dynamodb:PutItem"]),
    );
    expect(statement?.Action).not.toContain("dynamodb:UpdateItem");
    expect(policyJson).not.toContain("TransactWriteItems");
  });

  it("routes /platform/config/{configType}, the path parameter the handler reads", async () => {
    // config/handler.ts reads event.pathParameters.configType and 400s without it; the
    // web client calls platform/config/{configType}. A bare /platform/config route 404ed
    // the client and would 400 every request that did reach the handler.
    const cfg = await build();
    await resolve(cfg.lambda.function.arn);
    await new Promise((r) => setImmediate(r));
    expect(routeKeys.filter((k) => k.includes("/platform/config")).sort()).toEqual([
      "GET /api/v1/platform/config/{configType}",
      "PUT /api/v1/platform/config/{configType}",
    ]);
  });

  it("wires VERIFIED_PERMISSIONS_POLICY_STORE_ID into the config Lambda's environment", async () => {
    const cfg = await build();
    const env = await resolve(cfg.lambda.function.environment);
    expect(env?.variables?.VERIFIED_PERMISSIONS_POLICY_STORE_ID).toBe("ps-1");
  });

  it("throws on absent or unknown env", async () => {
    const { Config } = await import("../../components/platform/config");
    const logGroup = new ServiceLogGroup("test-config-log-group-bad", {
      env: "dev",
      serviceName: "platform-service",
    });
    const httpApi = new HttpApi("test-config-http-api-bad", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    expect(
      () =>
        new Config("test-config-bad", {
          env: "",
          platformTableName: pulumi.output("t"),
          platformTableArn: pulumi.output("arn"),
          policyStoreArn: pulumi.output("arn"),
          policyStoreId: pulumi.output("ps-1"),
          logGroup,
          httpApi,
        }),
    ).toThrow(/env is required/);
  });
});
