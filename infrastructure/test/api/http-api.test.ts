import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        const name = (args.inputs.name as string) ?? args.name;
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${name}`;
        state.invokeArn = `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${state.arn}/invocations`;
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
      if (args.token === "aws:index/getRegion:getRegion") {
        return { name: "us-east-1", description: "US East (N. Virginia)", id: "us-east-1" };
      }
      return args.inputs;
    },
  });
});

// FileAsset + nested ServiceLambda registerOutputs can resolve after assertions;
// give the mock monitor a turn to finish before beforeEach swaps it out.
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

async function settle(api: {
  urn: pulumi.Output<string>;
  httpApi: {
    id: pulumi.Output<string>;
    apiEndpoint: pulumi.Output<string>;
    executionArn: pulumi.Output<string>;
  };
  authorizer: { id: pulumi.Output<string>; authorizerUri: pulumi.Output<string | undefined> };
  stage: {
    id: pulumi.Output<string>;
    name: pulumi.Output<string>;
    defaultRouteSettings: pulumi.Output<
      { throttlingRateLimit?: number; throttlingBurstLimit?: number } | undefined
    >;
    accessLogSettings: pulumi.Output<{ destinationArn?: string; format?: string } | undefined>;
  };
  accessLogGroup: { id: pulumi.Output<string>; arn: pulumi.Output<string> };
  invokePermission: { id: pulumi.Output<string>; sourceArn: pulumi.Output<string | undefined> };
  authorizerLambda: {
    urn: pulumi.Output<string>;
    function: {
      arn: pulumi.Output<string>;
      invokeArn: pulumi.Output<string>;
      name: pulumi.Output<string>;
      environment: pulumi.Output<{ variables?: Record<string, string> } | undefined>;
    };
    role: { arn: pulumi.Output<string> };
    rolePolicy: { id: pulumi.Output<string> };
  };
  apiEndpoint: pulumi.Output<string>;
}): Promise<void> {
  await Promise.all([
    resolve(api.urn),
    resolve(api.httpApi.id),
    resolve(api.httpApi.apiEndpoint),
    resolve(api.httpApi.executionArn),
    resolve(api.authorizer.id),
    resolve(api.authorizer.authorizerUri as pulumi.Output<string>),
    resolve(api.stage.id),
    resolve(api.stage.name),
    resolve(api.stage.defaultRouteSettings),
    resolve(api.stage.accessLogSettings),
    resolve(api.accessLogGroup.id),
    resolve(api.accessLogGroup.arn),
    resolve(api.invokePermission.id),
    resolve(api.invokePermission.sourceArn as pulumi.Output<string>),
    resolve(api.authorizerLambda.urn),
    resolve(api.authorizerLambda.function.arn),
    resolve(api.authorizerLambda.function.invokeArn),
    resolve(api.authorizerLambda.function.name),
    resolve(api.authorizerLambda.function.environment),
    resolve(api.authorizerLambda.role.arn),
    resolve(api.authorizerLambda.rolePolicy.id),
    resolve(api.apiEndpoint),
  ]);
  await new Promise((r) => setImmediate(r));
}

describe("HttpApi", () => {
  it("creates an HTTP API with a fail-closed REQUEST Lambda authorizer (payload 2.0)", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { HttpApi } = await import("../../components/api/http-api");

    const logGroup = new ServiceLogGroup("platform-log-group-api", {
      env: "dev",
      serviceName: "platform-service",
    });

    const api = new HttpApi("http-api", {
      env: "dev",
      userPoolId: "us-east-1_pool",
      allowedClientIds: ["web-client-id", "mobile-client-id"],
      platformLogGroup: logGroup,
      cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
    });
    await settle(api);

    const [
      apiName,
      protocolType,
      authorizerName,
      authorizerType,
      payloadFormat,
      identitySources,
      enableSimpleResponses,
      authorizerUri,
      invokeArn,
      stageName,
      autoDeploy,
      defaultRouteSettings,
      principal,
      action,
      fnName,
      envVars,
      reservedConcurrentExecutions,
      authorizerResultTtlInSeconds,
      invokePermissionSourceArn,
      executionArn,
      accessLogSettings,
      accessLogGroupName,
    ] = await Promise.all([
      resolve(api.httpApi.name),
      resolve(api.httpApi.protocolType),
      resolve(api.authorizer.name),
      resolve(api.authorizer.authorizerType),
      resolve(api.authorizer.authorizerPayloadFormatVersion),
      resolve(api.authorizer.identitySources),
      resolve(api.authorizer.enableSimpleResponses),
      resolve(api.authorizer.authorizerUri as pulumi.Output<string>),
      resolve(api.authorizerLambda.function.invokeArn),
      resolve(api.stage.name),
      resolve(api.stage.autoDeploy),
      resolve(api.stage.defaultRouteSettings),
      resolve(api.invokePermission.principal),
      resolve(api.invokePermission.action),
      resolve(api.authorizerLambda.function.name),
      resolve(api.authorizerLambda.function.environment),
      resolve(api.authorizerLambda.function.reservedConcurrentExecutions),
      resolve(api.authorizer.authorizerResultTtlInSeconds),
      resolve(api.invokePermission.sourceArn as pulumi.Output<string>),
      resolve(api.httpApi.executionArn),
      resolve(api.stage.accessLogSettings),
      resolve(api.accessLogGroup.name),
    ]);

    expect(apiName).toBe("boxalarm-dev-http-api");
    expect(protocolType).toBe("HTTP");
    expect(authorizerType).toBe("REQUEST");
    expect(payloadFormat).toBe("2.0");
    expect(identitySources).toEqual(["$request.header.Authorization"]);
    expect(enableSimpleResponses).toBe(true);
    expect(authorizerUri).toBe(invokeArn);
    expect(stageName).toBe("$default");
    expect(autoDeploy).toBe(true);
    // Every request hits the authorizer Lambda uncached — the stage must throttle so
    // an unauthenticated flood can't exhaust the account's shared concurrency pool.
    expect(defaultRouteSettings?.throttlingRateLimit).toBe(50);
    expect(defaultRouteSettings?.throttlingBurstLimit).toBe(100);
    expect(reservedConcurrentExecutions).toBe(20);
    // Load-bearing: never cache an allow decision from this fail-closed stub (source
    // comment on the authorizer). A later edit setting this to e.g. 300 must fail here.
    expect(authorizerResultTtlInSeconds).toBe(0);
    // Scoped to this API's authorizers, not a bare wildcard.
    expect(invokePermissionSourceArn).toBe(`${executionArn}/authorizers/*`);
    // With a fail-closed authorizer denying every request, operators need a caller
    // activity record — status, route, and authorizer error at minimum.
    expect(accessLogGroupName).toBe("/aws/apigateway/boxalarm-dev-http-api-access");
    expect(accessLogSettings?.destinationArn).toBeDefined();
    const accessLogFormat = JSON.parse(accessLogSettings?.format ?? "{}");
    expect(accessLogFormat).toMatchObject({
      requestId: expect.stringContaining("requestId"),
      status: expect.stringContaining("status"),
      routeKey: expect.stringContaining("routeKey"),
      integrationErrorMessage: expect.stringContaining("integrationErrorMessage"),
      authorizerError: expect.stringContaining("authorizer.error"),
    });
    expect(principal).toBe("apigateway.amazonaws.com");
    expect(action).toBe("lambda:InvokeFunction");
    expect(fnName).toBe("boxalarm-dev-platform-authorizer");
    // The bundle's handler string: the backend authorizer when bundled, else the deny stub
    // (served as index.js under the same handler) - never the old stub-only wiring.
    expect(await resolve(api.authorizerLambda.function.handler)).toBe("index.handler");
    expect(envVars?.variables?.COGNITO_USER_POOL_ID).toBe("us-east-1_pool");
    expect(envVars?.variables?.COGNITO_ISSUER).toBe(
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
    );
    expect(envVars?.variables?.COGNITO_ALLOWED_CLIENT_IDS).toBe("web-client-id,mobile-client-id");
    expect(envVars?.variables?.SERVICE_NAME).toBe("platform-service");
    expect(authorizerName).toBe("boxalarm-dev-http-authorizer");

    const endpoint = await resolve(api.apiEndpoint);
    expect(endpoint).toContain("execute-api");
  });

  it("authorizedRoute always attaches CUSTOM + this authorizer (no open routes)", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { HttpApi } = await import("../../components/api/http-api");

    const logGroup = new ServiceLogGroup("platform-log-group-route", {
      env: "dev",
      serviceName: "platform-service",
    });
    const api = new HttpApi("http-api-route", {
      env: "dev",
      userPoolId: "us-east-1_pool",
      allowedClientIds: ["web-client-id"],
      platformLogGroup: logGroup,
    });
    await settle(api);

    const route = api.authorizedRoute("health-route", { routeKey: "GET /health" });
    const [authType, authorizerId, routeAuthorizerId] = await Promise.all([
      resolve(route.authorizationType),
      resolve(api.authorizer.id),
      resolve(route.authorizerId as pulumi.Output<string>),
    ]);
    expect(authType).toBe("CUSTOM");
    expect(routeAuthorizerId).toBe(authorizerId);
  });

  it("throws on absent env", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { HttpApi } = await import("../../components/api/http-api");

    const logGroup = new ServiceLogGroup("platform-log-group-api-bad", {
      env: "dev",
      serviceName: "platform-service",
    });

    expect(
      () =>
        new HttpApi("http-api-bad", {
          env: undefined as unknown as string,
          userPoolId: "pool",
          allowedClientIds: ["a"],
          platformLogGroup: logGroup,
        }),
    ).toThrow(/env is required/);
  });

  it("route() wires an AWS_PROXY integration to an authorized route for the given service Lambda", async () => {
    const { ServiceLogGroup } = await import("../../components/observability/service-log-group");
    const { ServiceLambda } = await import("../../components/observability/service-lambda");
    const { HttpApi } = await import("../../components/api/http-api");

    const logGroup = new ServiceLogGroup("platform-log-group-api-route", {
      env: "dev",
      serviceName: "platform-service",
    });
    const api = new HttpApi("http-api-route", {
      env: "dev",
      userPoolId: "pool",
      allowedClientIds: ["a"],
      platformLogGroup: logGroup,
    });
    await settle(api);

    const lambda = new ServiceLambda("route-lambda", {
      env: "dev",
      serviceName: "platform-service",
      functionName: "boxalarm-dev-platform-config",
      handler: "index.handler",
      code: new pulumi.asset.AssetArchive({}),
      logGroup,
    });
    const { route, integration } = api.route("config-route", {
      routeKey: "GET /api/v1/platform/config",
      lambda,
    });

    const [integrationType, routeKey, authType] = await Promise.all([
      resolve(integration.integrationType),
      resolve(route.routeKey),
      resolve(route.authorizationType),
    ]);
    expect(integrationType).toBe("AWS_PROXY");
    expect(routeKey).toBe("GET /api/v1/platform/config");
    expect(authType).toBe("CUSTOM");
  });
});
