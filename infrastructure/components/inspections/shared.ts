import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";

/** Inputs every inspections-service component takes (all state lives in the platform table). */
export interface InspectionsBaseArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/** ARNs a route's grants are built from, resolved once. */
export interface ResolvedArns {
  tableArn: string;
  policyStoreArn: string;
  bucketArn: string;
}

export interface InspectionsRouteSpec {
  /** Manifest function key (backend/scripts/lambda-manifest.mjs) and name suffix. */
  fn: string;
  routeKey: string;
  environment: Record<string, pulumi.Input<string>>;
  /** DynamoDB/S3 grants for exactly what the handler calls. */
  statements: (arns: ResolvedArns) => IamPolicyStatement[];
  /** Handler is wrapped in Cedar (withAuthorization / IsAuthorizedWithToken). */
  cedar: boolean;
  /** Handler can UpdateItem the platform table, so it carries the audit-row deny. */
  mutatesTable?: boolean;
}

/**
 * One inspections-service route: a ServiceLambda with per-route least-privilege IAM, and an
 * authorized HttpApi route to it.
 */
export function inspectionsRoute(
  parent: pulumi.ComponentResource,
  name: string,
  args: InspectionsBaseArgs & { assetsBucketArn?: pulumi.Input<string> },
  spec: InspectionsRouteSpec,
): ServiceLambda {
  const lambda = new ServiceLambda(
    `${name}-${spec.fn}`,
    {
      env: args.env,
      serviceName: "inspections-service",
      functionName: `boxalarm-${args.env}-inspections-${spec.fn}`,
      handler: LAMBDA_HANDLER,
      code: lambdaCode("inspections-service", spec.fn),
      logGroup: args.logGroup,
      environment: {
        ...spec.environment,
        ...(spec.cedar ? { VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId } : {}),
      },
      additionalPolicyStatements: pulumi
        .all([args.platformTableArn, args.policyStoreArn, args.assetsBucketArn ?? ""])
        .apply(([tableArn, policyStoreArn, bucketArn]) => [
          ...spec.statements({ tableArn, policyStoreArn, bucketArn }),
          ...(spec.mutatesTable ? [auditMutationDenyStatement(tableArn)] : []),
          ...(spec.cedar ? [verifiedPermissionsPolicyStatement(policyStoreArn)] : []),
        ]),
    },
    { parent },
  );
  args.httpApi.route(`${name}-${spec.fn}-route`, { routeKey: spec.routeKey, lambda }, { parent });
  return lambda;
}

/** A single-Sid DynamoDB grant. */
export function dynamoGrant(
  sid: string,
  actions: string[],
  resources: string[],
): IamPolicyStatement {
  return { Sid: sid, Effect: "Allow", Action: actions, Resource: resources };
}
