import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";

/** What every apparatus-service component needs. All apparatus data lives in the platform table. */
export interface ApparatusArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  /** platform-assets bucket; required by any route with `assetsPutPrefix`. */
  assetsBucketName?: pulumi.Input<string>;
  assetsBucketArn?: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/** One DynamoDB grant: `table` for base-table calls, `GSI2`/`GSI3` for index queries. */
export interface TableGrant {
  sid: string;
  actions: string[];
  on: ("table" | "GSI2" | "GSI3")[];
}

export interface ApparatusRouteSpec {
  /** backend/scripts/lambda-manifest.mjs function key under apparatus-service. */
  functionKey: string;
  routeKey: string;
  grants: TableGrant[];
  /** Handler is wrapped in @boxalarm/authz withAuthorization (needs the policy store). */
  cedar: boolean;
  /**
   * The handler presigns S3 PUTs into the platform-assets bucket under
   * {deptId}/{assetsPutPrefix}/...; the role gets s3:PutObject on exactly that prefix.
   */
  assetsPutPrefix?: string;
}

/**
 * One apparatus-service route: a ServiceLambda with exactly the table grants its handler
 * uses, routed through HttpApi.route (authorizer attached). DynamoDB authorizes each
 * TransactWriteItems item as its own PutItem/UpdateItem, so grants name those, never
 * TransactWriteItems. Any role that can UpdateItem the table also carries the audit-row
 * deny. PLATFORM_TABLE_NAME is the only table variable apparatus-service reads
 * (apparatusRepository.ts, dynamoClient.ts, client.ts, inventory/config.ts).
 */
export function apparatusRoute(
  parent: pulumi.ComponentResource,
  name: string,
  args: ApparatusArgs,
  spec: ApparatusRouteSpec,
): ServiceLambda {
  if (spec.assetsPutPrefix && (!args.assetsBucketName || !args.assetsBucketArn)) {
    throw new Error(`${spec.functionKey}: assetsPutPrefix needs assetsBucketName/assetsBucketArn`);
  }
  const statements = pulumi
    .all([args.platformTableArn, args.policyStoreArn, args.assetsBucketArn ?? ""])
    .apply(([tableArn, policyStoreArn, bucketArn]) => {
      const resolved: IamPolicyStatement[] = spec.grants.map((grant) => ({
        Sid: grant.sid,
        Effect: "Allow" as const,
        Action: grant.actions,
        Resource: grant.on.map((target) =>
          target === "table" ? tableArn : `${tableArn}/index/${target}`,
        ),
      }));
      const mutates = spec.grants.some(
        (grant) =>
          grant.on.includes("table") &&
          (grant.actions.includes("dynamodb:UpdateItem") ||
            grant.actions.includes("dynamodb:DeleteItem")),
      );
      if (mutates) {
        resolved.push(auditMutationDenyStatement(tableArn));
      }
      if (spec.cedar) {
        resolved.push(verifiedPermissionsPolicyStatement(policyStoreArn));
      }
      if (spec.assetsPutPrefix) {
        resolved.push({
          Sid: "AssetsPresignedPut",
          Effect: "Allow" as const,
          Action: ["s3:PutObject"],
          Resource: [`${bucketArn}/*/${spec.assetsPutPrefix}/*`],
        });
      }
      return resolved;
    });

  const lambda = new ServiceLambda(
    `${name}-${spec.functionKey}`,
    {
      env: args.env,
      serviceName: "apparatus-service",
      functionName: `boxalarm-${args.env}-apparatus-${spec.functionKey}`,
      handler: LAMBDA_HANDLER,
      code: lambdaCode("apparatus-service", spec.functionKey),
      logGroup: args.logGroup,
      environment: {
        PLATFORM_TABLE_NAME: args.platformTableName,
        ...(spec.cedar ? { VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId } : {}),
        ...(spec.assetsPutPrefix && args.assetsBucketName
          ? { PLATFORM_ASSETS_BUCKET_NAME: args.assetsBucketName }
          : {}),
      },
      additionalPolicyStatements: statements,
    },
    { parent },
  );
  args.httpApi.route(
    `${name}-${spec.functionKey}-route`,
    { routeKey: spec.routeKey, lambda },
    { parent },
  );
  return lambda;
}
