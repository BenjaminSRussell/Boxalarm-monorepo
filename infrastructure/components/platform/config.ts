import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface ConfigArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * E8-S4-INFRA #256 config route. Valkey is deliberately not provisioned: no
 * Valkey client or VALKEY_ENDPOINT config exists anywhere in
 * backend/src/services/platform-service/config/cache.ts as of this batch —
 * createHandler() always falls back to its in-process memoryStore(). An
 * ElastiCache Serverless cache nothing reads from would be pure idle cost
 * against the usage-based-only constraint (CLAUDE.md), so this ships without
 * the VPC/Valkey/gateway-endpoint stack the ticket describes; wire it once
 * the backend cache client lands. No alerting-plane Lambda gets a VpcConfig
 * here either way (AC5).
 */
export class Config extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;

  constructor(name: string, args: ConfigArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Config", args.env);
    super("boxalarm:platform:Config", name, {}, opts);
    const { env } = args;

    this.lambda = new ServiceLambda(
      `${name}-lambda`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-config`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "config"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          // Granted verifiedpermissions:IsAuthorizedWithToken below — without this,
          // readAuthzConfig() throws on every withAuthorization() call.
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([pulumi.output(args.platformTableArn), pulumi.output(args.policyStoreArn)])
          .apply(([tableArn, policyStoreArn]) => [
            {
              // dynamodb:TransactWriteItems is not a real IAM action — DynamoDB
              // authorizes each item inside a transaction as its own PutItem/
              // UpdateItem/DeleteItem call. getDepartmentConfig does a GetItem;
              // putDepartmentConfig's TransactWriteCommand sends two Puts (the
              // config item and its outbox record), never an Update. Granting
              // UpdateItem+TransactWriteItems and no PutItem meant PUT
              // /platform/config was denied on every call.
              Sid: "ConfigTableAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
              Resource: tableArn,
            },
            auditMutationDenyStatement(tableArn),
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );

    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/platform/config/{configType}", lambda: this.lambda },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-put-route`,
      { routeKey: "PUT /api/v1/platform/config/{configType}", lambda: this.lambda },
      { parent: this },
    );

    this.registerOutputs({ lambda: this.lambda });
  }
}
