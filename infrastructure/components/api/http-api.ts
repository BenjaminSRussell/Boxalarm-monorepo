import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup, RETENTION_DAYS_BY_ENV } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { LAMBDA_HANDLER, lambdaCode } from "../shared/lambda-code";

export interface HttpApiArgs {
  env: string;
  userPoolId: pulumi.Input<string>;
  /** Web + mobile Cognito app client IDs (joined as COGNITO_ALLOWED_CLIENT_IDS). */
  allowedClientIds: pulumi.Input<string>[];
  /** Shared platform-service log group (one per env). */
  platformLogGroup: ServiceLogGroup;
  /** Override Cognito issuer; default is https://cognito-idp.{region}.amazonaws.com/{userPoolId}. */
  cognitoIssuer?: pulumi.Input<string>;
  /**
   * Stage-level steady-state request rate limit (requests/sec). Every request hits
   * the authorizer Lambda (authorizerResultTtlInSeconds: 0, never cached) before any
   * auth check, so an unthrottled stage lets an unauthenticated flood exhaust the
   * account's shared regional Lambda concurrency pool — which alerting-service also
   * draws from. Conservative default; later stories may need to tune it.
   */
  throttlingRateLimit?: number;
  /** Stage-level burst capacity (requests). See throttlingRateLimit. */
  throttlingBurstLimit?: number;
  /**
   * Reserved concurrency for the authorizer Lambda, so an unauthenticated request
   * flood against this Lambda cannot starve concurrency the alerting path needs.
   * Conservative default; later stories may need to tune it.
   */
  authorizerReservedConcurrency?: number;
}

/**
 * Shared HTTP API + REQUEST Lambda authorizer (E8-S1-INFRA). Routes and
 * integrations are owned by later stories; this component owns the API shell and
 * the authorizer: the bundled backend platform-service/authorizer (Cognito
 * access-token verification), or - only when no bundle exists - the deny-all stub.
 */

/**
 * The deny-all stub, served as index.js so it uses the same handler string as the bundle.
 * Only ever deployed when backend/dist has no authorizer bundle (lambdaCode warns).
 */
function denyAllAuthorizerCode(): pulumi.asset.Archive {
  return new pulumi.asset.AssetArchive({
    "index.js": new pulumi.asset.FileAsset(path.join(__dirname, "authorizer-handler.js")),
  });
}
export class HttpApi extends pulumi.ComponentResource {
  public readonly httpApi: aws.apigatewayv2.Api;
  public readonly authorizer: aws.apigatewayv2.Authorizer;
  public readonly authorizerLambda: ServiceLambda;
  public readonly invokePermission: aws.lambda.Permission;
  public readonly stage: aws.apigatewayv2.Stage;
  public readonly accessLogGroup: aws.cloudwatch.LogGroup;
  public readonly apiEndpoint: pulumi.Output<string>;

  constructor(name: string, args: HttpApiArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("HttpApi", args.env);

    super("boxalarm:api:HttpApi", name, {}, opts);
    const { env } = args;

    this.httpApi = new aws.apigatewayv2.Api(
      `${name}-api`,
      {
        name: `boxalarm-${env}-http-api`,
        protocolType: "HTTP",
      },
      { parent: this },
    );

    const cognitoIssuer =
      args.cognitoIssuer ??
      pulumi.interpolate`https://cognito-idp.${aws.getRegionOutput({}, { parent: this }).name}.amazonaws.com/${args.userPoolId}`;
    const allowedClientIds = pulumi.all(args.allowedClientIds).apply((ids) => ids.join(","));
    const throttlingRateLimit = args.throttlingRateLimit ?? 50;
    const throttlingBurstLimit = args.throttlingBurstLimit ?? 100;
    const authorizerReservedConcurrency = args.authorizerReservedConcurrency ?? 20;

    this.authorizerLambda = new ServiceLambda(
      `${name}-authorizer`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-authorizer`,
        handler: LAMBDA_HANDLER,
        // Until this was wired, the stub denied 100% of requests: every authenticated route
        // in the stack answered 403.
        code: lambdaCode("platform-service", "authorizer", denyAllAuthorizerCode),
        logGroup: args.platformLogGroup,
        environment: {
          COGNITO_USER_POOL_ID: args.userPoolId,
          COGNITO_ISSUER: cognitoIssuer,
          COGNITO_ALLOWED_CLIENT_IDS: allowedClientIds,
        },
        // Draws from the account's shared regional concurrency pool, which
        // alerting-service Lambdas also draw from — must not be unbounded on an
        // unauthenticated, uncached (authorizerResultTtlInSeconds: 0) path.
        reservedConcurrentExecutions: authorizerReservedConcurrency,
      },
      { parent: this },
    );

    this.authorizer = new aws.apigatewayv2.Authorizer(
      `${name}-authorizer`,
      {
        apiId: this.httpApi.id,
        name: `boxalarm-${env}-http-authorizer`,
        authorizerType: "REQUEST",
        authorizerUri: this.authorizerLambda.function.invokeArn,
        authorizerPayloadFormatVersion: "2.0",
        enableSimpleResponses: true,
        identitySources: ["$request.header.Authorization"],
        // Never cache an allow decision: a revoked session (the only control that ends
        // access - sessions never expire) must stop working on the next request.
        authorizerResultTtlInSeconds: 0,
      },
      { parent: this },
    );

    this.invokePermission = new aws.lambda.Permission(
      `${name}-authorizer-invoke`,
      {
        action: "lambda:InvokeFunction",
        function: this.authorizerLambda.function.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${this.httpApi.executionArn}/authorizers/*`,
      },
      { parent: this },
    );

    // Caller activity record - status, route and authorizer error - to correlate against
    // the authorizer's own deny-reason metrics.
    this.accessLogGroup = new aws.cloudwatch.LogGroup(
      `${name}-access-logs`,
      {
        name: `/aws/apigateway/boxalarm-${env}-http-api-access`,
        retentionInDays: RETENTION_DAYS_BY_ENV[env],
      },
      { parent: this },
    );

    this.stage = new aws.apigatewayv2.Stage(
      `${name}-stage`,
      {
        apiId: this.httpApi.id,
        name: "$default",
        autoDeploy: true,
        // Every request invokes the authorizer Lambda from an unauthenticated caller
        // (no caching — authorizerResultTtlInSeconds: 0), so request volume maps 1:1
        // to Lambda invocations. Without a stage-level cap, a flood against this
        // public endpoint can drive account concurrency to the ceiling and throttle
        // alerting-service, which shares the same regional pool.
        defaultRouteSettings: {
          throttlingRateLimit,
          throttlingBurstLimit,
        },
        accessLogSettings: {
          destinationArn: this.accessLogGroup.arn,
          format: JSON.stringify({
            requestId: "$context.requestId",
            status: "$context.status",
            routeKey: "$context.routeKey",
            integrationErrorMessage: "$context.integrationErrorMessage",
            authorizerError: "$context.authorizer.error",
          }),
        },
      },
      { parent: this, dependsOn: [this.accessLogGroup] },
    );

    this.apiEndpoint = this.httpApi.apiEndpoint;

    this.registerOutputs({
      httpApi: this.httpApi,
      authorizer: this.authorizer,
      apiEndpoint: this.apiEndpoint,
      stage: this.stage,
    });
  }

  /**
   * Reusable wiring for a later INFRA child's own service Lambda: AWS_PROXY
   * integration + invoke permission + an authorizedRoute target. One call
   * replaces the integration/permission/route triple every route needs.
   */
  route(
    name: string,
    args: { routeKey: string; lambda: ServiceLambda },
    opts?: pulumi.ComponentResourceOptions,
  ): { route: aws.apigatewayv2.Route; integration: aws.apigatewayv2.Integration } {
    const integration = new aws.apigatewayv2.Integration(
      `${name}-integration`,
      {
        apiId: this.httpApi.id,
        integrationType: "AWS_PROXY",
        integrationUri: args.lambda.function.invokeArn,
        payloadFormatVersion: "2.0",
      },
      { parent: this, ...opts },
    );

    new aws.lambda.Permission(
      `${name}-invoke`,
      {
        action: "lambda:InvokeFunction",
        function: args.lambda.function.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${this.httpApi.executionArn}/*/*`,
      },
      { parent: this, ...opts },
    );

    const route = this.authorizedRoute(
      `${name}-route`,
      { routeKey: args.routeKey, target: pulumi.interpolate`integrations/${integration.id}` },
      opts,
    );

    return { route, integration };
  }

  /**
   * Mandatory route factory for later INFRA children (#6): every route must attach
   * this API's REQUEST authorizer. Open (NONE) routes are not permitted here.
   */
  authorizedRoute(
    name: string,
    args: {
      routeKey: string;
      target?: pulumi.Input<string>;
    },
    opts?: pulumi.ComponentResourceOptions,
  ): aws.apigatewayv2.Route {
    return new aws.apigatewayv2.Route(
      name,
      {
        apiId: this.httpApi.id,
        routeKey: args.routeKey,
        target: args.target,
        authorizationType: "CUSTOM",
        authorizerId: this.authorizer.id,
      },
      { parent: this, ...opts },
    );
  }
}
