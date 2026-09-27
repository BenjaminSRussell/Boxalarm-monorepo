import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { HttpApi } from "./http-api";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { ServiceName } from "../observability/services";
import { IamPolicyStatement } from "../observability/observability-policy";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

/**
 * Cross-repo literal: backend/packages/health HEALTH_SENTINEL_PK, the reserved non-tenant
 * partition every readiness probe reads (the item never exists). IAM pins GetItem to it.
 */
export const HEALTH_SENTINEL_PK = "DEPT#HEALTHCHECK#HEALTH";

/**
 * Two concurrent executions cover a prober plus a person checking by hand. The cap keeps an
 * unauthenticated flood on these routes from drawing down the account's shared regional
 * concurrency pool that alerting-service also draws from; excess requests are throttled.
 */
export const HEALTH_RESERVED_CONCURRENCY = 2;

/** Seconds. Readiness gives its checks a 2 s deadline (backend/packages/health). */
const HEALTH_TIMEOUT_SECONDS = 5;

export interface ServiceHealthArgs {
  env: string;
  serviceName: ServiceName;
  /** Where architecture.md §2 mounts this service's routes, e.g. "/api/v1/incidents". */
  routePrefix: string;
  httpApi: HttpApi;
  logGroup: ServiceLogGroup;
  /** The service's own table. Readiness reads only this table. */
  tableName: pulumi.Input<string>;
  tableArn: pulumi.Input<string>;
  /** The table's customer-managed key (alerting, incident); omit for AWS-managed encryption. */
  tableCmkArn?: pulumi.Input<string>;
  /** LOB bus the readiness probe describes. Omitted for alerting-service, which uses no bus. */
  eventBus?: { name: pulumi.Input<string>; arn: pulumi.Input<string> };
  /** Partition-key patterns readiness may also Query (alerting-service: its canary runs). */
  queryLeadingKeys?: pulumi.Input<string>[];
  environment?: Record<string, pulumi.Input<string>>;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * GET {routePrefix}/health/liveness and /health/readiness (architecture.md §2, §4.3) for one
 * service: one Lambda serves both routes.
 *
 * The routes carry no authorizer, as the architecture specifies (auth "none"). They are the
 * only unauthenticated routes besides the vendor webhooks. They skip HttpApi.route() and
 * build the route directly, as AlertingRoute does for `authorized: false`. The Lambda holds
 * read-only grants: GetItem pinned to the sentinel partition, an optional Query pinned to
 * the given partitions, Decrypt on the table key through DynamoDB only, and DescribeEventBus.
 * Throttling: the stage default per-route limit applies, and the Lambda's reserved
 * concurrency caps what a flood can take from the shared pool.
 */
export class ServiceHealth extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;
  public readonly integration: aws.apigatewayv2.Integration;
  public readonly livenessRoute: aws.apigatewayv2.Route;
  public readonly readinessRoute: aws.apigatewayv2.Route;

  constructor(name: string, args: ServiceHealthArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("ServiceHealth", args.env);
    if (!/^\/api\/v1\/[a-z-]+$/.test(args.routePrefix)) {
      throw new Error(
        `ServiceHealth: routePrefix must look like /api/v1/<service> (received ${JSON.stringify(args.routePrefix)})`,
      );
    }
    super("boxalarm:api:ServiceHealth", name, {}, opts);
    const { env, serviceName } = args;
    const shortName = serviceName.replace(/-service$/, "");

    const statements = pulumi
      .all([
        args.tableArn,
        args.tableCmkArn,
        args.eventBus?.arn,
        pulumi.all(args.queryLeadingKeys ?? []),
      ])
      .apply(([tableArn, cmkArn, busArn, queryLeadingKeys]) => {
        const out: IamPolicyStatement[] = [
          {
            Sid: "HealthSentinelRead",
            Effect: "Allow",
            Action: ["dynamodb:GetItem"],
            Resource: tableArn,
            Condition: {
              "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [HEALTH_SENTINEL_PK] },
            },
          },
        ];
        if (queryLeadingKeys.length > 0) {
          out.push({
            Sid: "HealthPartitionQuery",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: tableArn,
            Condition: {
              "ForAllValues:StringLike": { "dynamodb:LeadingKeys": queryLeadingKeys },
            },
          });
        }
        if (cmkArn) {
          const region = cmkArn.split(":")[3];
          out.push({
            Sid: "HealthTableKeyDecryptViaDynamoDb",
            Effect: "Allow",
            Action: ["kms:Decrypt", "kms:DescribeKey"],
            Resource: cmkArn,
            Condition: {
              StringEquals: { "kms:ViaService": [`dynamodb.${region}.amazonaws.com`] },
            },
          });
        }
        if (busArn) {
          out.push({
            Sid: "HealthDescribeEventBus",
            Effect: "Allow",
            Action: ["events:DescribeEventBus"],
            Resource: busArn,
          });
        }
        return out;
      });

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env,
        serviceName,
        functionName: `boxalarm-${env}-${shortName}-health`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode(serviceName, "health"),
        logGroup: args.logGroup,
        environment: {
          ...(args.environment ?? {}),
          HEALTH_TABLE_NAME: args.tableName,
          ...(args.eventBus ? { HEALTH_EVENT_BUS_NAME: args.eventBus.name } : {}),
        },
        additionalPolicyStatements: statements,
        reservedConcurrentExecutions: HEALTH_RESERVED_CONCURRENCY,
        timeout: HEALTH_TIMEOUT_SECONDS,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    const apiId = args.httpApi.httpApi.id;
    this.integration = new aws.apigatewayv2.Integration(
      `${name}-integration`,
      {
        apiId,
        integrationType: "AWS_PROXY",
        integrationUri: this.lambda.function.invokeArn,
        payloadFormatVersion: "2.0",
      },
      { parent: this },
    );
    const target = pulumi.interpolate`integrations/${this.integration.id}`;

    const unauthenticatedRoute = (probe: "liveness" | "readiness") =>
      new aws.apigatewayv2.Route(
        `${name}-${probe}-route`,
        {
          apiId,
          routeKey: `GET ${args.routePrefix}/health/${probe}`,
          target,
          authorizationType: "NONE",
        },
        { parent: this },
      );
    this.livenessRoute = unauthenticatedRoute("liveness");
    this.readinessRoute = unauthenticatedRoute("readiness");

    new aws.lambda.Permission(
      `${name}-invoke`,
      {
        action: "lambda:InvokeFunction",
        function: this.lambda.function.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${args.httpApi.httpApi.executionArn}/*/GET${args.routePrefix}/health/*`,
      },
      { parent: this },
    );

    this.registerOutputs({
      lambda: this.lambda,
      livenessRoute: this.livenessRoute,
      readinessRoute: this.readinessRoute,
    });
  }
}
