import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { requireEnv } from "../shared/env";
import { InspectionsBaseArgs, dynamoGrant, inspectionsRoute } from "./shared";

export interface OccupanciesArgs extends InspectionsBaseArgs {
  assetsBucketName: pulumi.Input<string>;
  assetsBucketArn: pulumi.Input<string>;
}

/**
 * F6.1/F6.2: occupancy records and their pre-incident plans.
 *
 * Occupancy handlers (occupancy/*.ts) read OCCUPANCY_TABLE_NAME; pre-plan handlers read
 * PLATFORM_TABLE_NAME — both are the platform table. List/get are dept-scoped reads with no
 * Cedar call (architecture: `Cognito`); create/update call IsAuthorizedWithToken for
 * WriteOccupancy. Pre-plan files go to the platform-assets bucket via S3 presigned URLs
 * signed with the Lambda's own role, so each role holds exactly the object action its URLs
 * need, scoped to the {deptId}/PRE_PLAN/ key prefix.
 */
export class Occupancies extends pulumi.ComponentResource {
  public readonly listLambda: ServiceLambda;
  public readonly createLambda: ServiceLambda;
  public readonly getLambda: ServiceLambda;
  public readonly updateLambda: ServiceLambda;
  public readonly prePlanGetLambda: ServiceLambda;
  public readonly prePlanPutLambda: ServiceLambda;

  constructor(name: string, args: OccupanciesArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Occupancies", args.env);
    super("boxalarm:inspections:Occupancies", name, {}, opts);
    const occupancyEnv = { OCCUPANCY_TABLE_NAME: args.platformTableName };
    const prePlanEnv = {
      PLATFORM_TABLE_NAME: args.platformTableName,
      PLATFORM_ASSETS_BUCKET_NAME: args.assetsBucketName,
    };

    // listOccupancies: GSI3 list-partition Query, then BatchGetItem on the METADATA rows.
    this.listLambda = inspectionsRoute(this, name, args, {
      fn: "occupancies-list",
      routeKey: "GET /api/v1/inspections/occupancies",
      environment: occupancyEnv,
      cedar: false,
      statements: ({ tableArn }) => [
        dynamoGrant("OccupanciesListQuery", ["dynamodb:Query"], [`${tableArn}/index/GSI3`]),
        dynamoGrant("OccupanciesListBatchGet", ["dynamodb:BatchGetItem"], [tableArn]),
      ],
    });

    // createOccupancy: one transaction of four Puts (METADATA, ADDR# and LIST index items,
    // audit row) — IAM authorizes each transaction item as PutItem.
    this.createLambda = inspectionsRoute(this, name, args, {
      fn: "occupancies-create",
      routeKey: "POST /api/v1/inspections/occupancies",
      environment: occupancyEnv,
      cedar: true,
      statements: ({ tableArn }) => [
        dynamoGrant("OccupanciesCreate", ["dynamodb:PutItem"], [tableArn]),
      ],
    });

    this.getLambda = inspectionsRoute(this, name, args, {
      fn: "occupancies-get",
      routeKey: "GET /api/v1/inspections/occupancies/{id}",
      environment: occupancyEnv,
      cedar: false,
      statements: ({ tableArn }) => [
        dynamoGrant("OccupanciesGet", ["dynamodb:GetItem"], [tableArn]),
      ],
    });

    // updateOccupancy: GetItem (pre-read), then a transaction of Update (METADATA) + Put (audit).
    this.updateLambda = inspectionsRoute(this, name, args, {
      fn: "occupancies-update",
      routeKey: "PUT /api/v1/inspections/occupancies/{id}",
      environment: occupancyEnv,
      cedar: true,
      mutatesTable: true,
      statements: ({ tableArn }) => [
        dynamoGrant(
          "OccupanciesUpdate",
          ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"],
          [tableArn],
        ),
      ],
    });

    // getPrePlan: one base-table Query; presigned GETs for the stored diagram/attachments.
    this.prePlanGetLambda = inspectionsRoute(this, name, args, {
      fn: "pre-plan-get",
      routeKey: "GET /api/v1/inspections/occupancies/{id}/pre-plan",
      environment: prePlanEnv,
      cedar: true,
      statements: ({ tableArn, bucketArn }) => [
        dynamoGrant("PrePlanGetQuery", ["dynamodb:Query"], [tableArn]),
        dynamoGrant("PrePlanGetObject", ["s3:GetObject"], [`${bucketArn}/*/PRE_PLAN/*`]),
      ],
    });

    // putPrePlan: Query (existing plan), then a transaction of ConditionCheck (occupancy
    // exists) + Put (plan) + Put (outbox); presigned PUTs for the files.
    this.prePlanPutLambda = inspectionsRoute(this, name, args, {
      fn: "pre-plan-put",
      routeKey: "PUT /api/v1/inspections/occupancies/{id}/pre-plan",
      environment: prePlanEnv,
      cedar: true,
      statements: ({ tableArn, bucketArn }) => [
        dynamoGrant(
          "PrePlanPut",
          ["dynamodb:Query", "dynamodb:ConditionCheckItem", "dynamodb:PutItem"],
          [tableArn],
        ),
        dynamoGrant("PrePlanPutObject", ["s3:PutObject"], [`${bucketArn}/*/PRE_PLAN/*`]),
      ],
    });

    this.registerOutputs({
      listLambda: this.listLambda,
      createLambda: this.createLambda,
      getLambda: this.getLambda,
      updateLambda: this.updateLambda,
      prePlanGetLambda: this.prePlanGetLambda,
      prePlanPutLambda: this.prePlanPutLambda,
    });
  }
}
