import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface EquipmentArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

interface Route {
  /** lambda-manifest.mjs function key; also the Lambda/role name suffix. */
  fn: string;
  routeKey: string;
  /** Table-level grants, scoped to exactly what the handler's repository calls. */
  table: (tableArn: string) => IamPolicyStatement[];
}

const allow = (sid: string, action: string[], resource: string[]): IamPolicyStatement => ({
  Sid: sid,
  Effect: "Allow",
  Action: action,
  Resource: resource,
});

// Per-Lambda least privilege, traced from equipment/equipmentRepository.ts and
// lifecycle/repository.ts. Equipment records live in the platform table (no dedicated
// inventory table exists). Every write that holds UpdateItem also carries the
// audit-row deny.
const ROUTES: readonly Route[] = [
  {
    // listEquipmentAssets: GSI3 (dept registry) or, for a member filter, GSI1 ("my X").
    fn: "equipment-list",
    routeKey: "GET /api/v1/inventory/equipment",
    table: (arn) => [
      allow("EquipmentListQuery", ["dynamodb:Query"], [`${arn}/index/GSI1`, `${arn}/index/GSI3`]),
    ],
  },
  {
    // getEquipmentAsset: base-table GetItem.
    fn: "equipment-get",
    routeKey: "GET /api/v1/inventory/equipment/{assetId}",
    table: (arn) => [allow("EquipmentGetRead", ["dynamodb:GetItem"], [arn])],
  },
  {
    // createEquipmentAsset: PutItem (asset) then PutItem (audit row).
    fn: "equipment-create",
    routeKey: "POST /api/v1/inventory/equipment",
    table: (arn) => [allow("EquipmentCreateWrite", ["dynamodb:PutItem"], [arn])],
  },
  {
    // setAssignment: conditional UpdateItem (asset) then PutItem (audit row).
    fn: "equipment-assignment",
    routeKey: "PUT /api/v1/inventory/equipment/{assetId}/assignment",
    table: (arn) => [
      allow("EquipmentAssignmentWrite", ["dynamodb:UpdateItem", "dynamodb:PutItem"], [arn]),
      auditMutationDenyStatement(arn),
    ],
  },
  {
    // setLocation: conditional UpdateItem (asset) then PutItem (audit row).
    fn: "equipment-location",
    routeKey: "PUT /api/v1/inventory/equipment/{assetId}/location",
    table: (arn) => [
      allow("EquipmentLocationWrite", ["dynamodb:UpdateItem", "dynamodb:PutItem"], [arn]),
      auditMutationDenyStatement(arn),
    ],
  },
  {
    // lifecycle: GetItem (current status), then conditional UpdateItem.
    fn: "equipment-lifecycle",
    routeKey: "PUT /api/v1/inventory/equipment/{assetId}/lifecycle",
    table: (arn) => [
      allow("EquipmentLifecycleWrite", ["dynamodb:GetItem", "dynamodb:UpdateItem"], [arn]),
      auditMutationDenyStatement(arn),
    ],
  },
];

/**
 * api-gap P0-6: inventory-service equipment registry (F5.1, F5.4) — list/get/register,
 * assignment, location and lifecycle. Every route is Cedar-gated in the handler
 * (withAuthorization): reads for every role, writes for chief/admin/officer
 * (cedar-policies.ts INVENTORY_*).
 */
export class Equipment extends pulumi.ComponentResource {
  public readonly lambdas: Record<string, ServiceLambda> = {};

  constructor(name: string, args: EquipmentArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Equipment", args.env);
    super("boxalarm:inventory:Equipment", name, {}, opts);
    const { env } = args;

    for (const route of ROUTES) {
      const lambda = new ServiceLambda(
        `${name}-${route.fn}`,
        {
          env,
          serviceName: "inventory-service",
          functionName: `boxalarm-${env}-inventory-${route.fn}`,
          handler: LAMBDA_HANDLER,
          code: lambdaCode("inventory-service", route.fn),
          logGroup: args.logGroup,
          environment: {
            PLATFORM_TABLE_NAME: args.platformTableName,
            VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
          },
          additionalPolicyStatements: pulumi
            .all([args.platformTableArn, args.policyStoreArn])
            .apply(([tableArn, policyStoreArn]) => [
              ...route.table(tableArn),
              verifiedPermissionsPolicyStatement(policyStoreArn),
            ]),
        },
        { parent: this },
      );
      args.httpApi.route(
        `${name}-${route.fn}-route`,
        { routeKey: route.routeKey, lambda },
        { parent: this },
      );
      this.lambdas[route.fn] = lambda;
    }

    this.registerOutputs({ lambdas: this.lambdas });
  }
}
