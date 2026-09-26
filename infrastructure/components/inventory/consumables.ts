import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";
import { dailyScanner } from "./daily-scanner";

export interface ConsumablesArgs {
  env: string;
  deptId: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  platformBusName: pulumi.Input<string>;
  platformBusArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * api-gap P0-6: consumable stock (F5.3) — the Cedar-gated list route (ListConsumables,
 * every role) and the daily reorder scanner that publishes inventory.reorder.due.
 *
 * Not wired: PUT /api/v1/inventory/consumables/{itemId} (architecture §2, N-9) has no
 * handler in backend/, so there is nothing to deploy. inventory.reorder.due has no
 * EventBridge rule/consumer yet — notification-service's inventoryReorderDueConsumer is
 * undeployed — so events reach the bus and go nowhere until that service ships.
 */
export class Consumables extends pulumi.ComponentResource {
  public readonly listLambda: ServiceLambda;
  public readonly reorderScannerLambda: ServiceLambda;
  public readonly reorderScannerSchedule: aws.scheduler.Schedule;

  constructor(name: string, args: ConsumablesArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Consumables", args.env);
    super("boxalarm:inventory:Consumables", name, {}, opts);
    const { env } = args;

    this.listLambda = new ServiceLambda(
      `${name}-list`,
      {
        env,
        serviceName: "inventory-service",
        functionName: `boxalarm-${env}-inventory-consumables-list`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("inventory-service", "consumables-list"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              // listConsumables: GSI3 DEPT#{d}#CONSUMABLE (AP 36).
              Sid: "ConsumablesListQuery" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query"],
              Resource: [`${tableArn}/index/GSI3`],
            },
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-list-route`,
      { routeKey: "GET /api/v1/inventory/consumables", lambda: this.listLambda },
      { parent: this },
    );

    this.reorderScannerLambda = new ServiceLambda(
      `${name}-reorder-scanner`,
      {
        env,
        serviceName: "inventory-service",
        functionName: `boxalarm-${env}-inventory-consumable-reorder-scanner`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("inventory-service", "consumable-reorder-scanner"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          PLATFORM_EVENT_BUS_NAME: args.platformBusName,
          INVENTORY_REORDER_SCANNER_DEPT_ID: args.deptId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.platformBusArn])
          .apply(([tableArn, busArn]) => [
            {
              // queryConsumablesBelowThreshold: GSI3 with a stock <= threshold filter.
              Sid: "ReorderScannerQuery" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query"],
              Resource: [`${tableArn}/index/GSI3`],
            },
            {
              // publishReorderDueEvent: conditional PutItem of the per-day dedup marker,
              // then UpdateItem to stamp publishedAt once the event is on the bus.
              Sid: "ReorderScannerMarker" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
              Resource: [tableArn],
            },
            {
              Sid: "ReorderScannerPublish" as const,
              Effect: "Allow" as const,
              Action: ["events:PutEvents"],
              Resource: busArn,
            },
            auditMutationDenyStatement(tableArn),
          ]),
      },
      { parent: this },
    );

    this.reorderScannerSchedule = dailyScanner(
      this,
      `${name}-reorder-scanner`,
      env,
      "inventory-consumable-reorder-scanner",
      this.reorderScannerLambda,
    ).schedule;

    this.registerOutputs({
      listLambda: this.listLambda,
      reorderScannerLambda: this.reorderScannerLambda,
    });
  }
}
