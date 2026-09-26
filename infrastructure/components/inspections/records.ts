import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { requireEnv } from "../shared/env";
import { InspectionsBaseArgs, dynamoGrant, inspectionsRoute } from "./shared";

export interface RecordsArgs extends InspectionsBaseArgs {
  assetsBucketName: pulumi.Input<string>;
  assetsBucketArn: pulumi.Input<string>;
}

/**
 * F6.3/F6.5: inspection schedule/history, scheduling and conducting an inspection, and mobile
 * field capture (offline-outbox tolerant, idempotency-keyed). All Cedar-gated.
 */
export class Records extends pulumi.ComponentResource {
  public readonly listLambda: ServiceLambda;
  public readonly recordLambda: ServiceLambda;
  public readonly fieldCaptureLambda: ServiceLambda;
  public readonly fieldCaptureFailedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: RecordsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Records", args.env);
    super("boxalarm:inspections:Records", name, {}, opts);
    const { env } = args;

    // listInspections: GSI2 due-window Query, one per month in the window.
    this.listLambda = inspectionsRoute(this, name, args, {
      fn: "inspections-list",
      routeKey: "GET /api/v1/inspections",
      environment: { PLATFORM_TABLE_NAME: args.platformTableName },
      cedar: true,
      statements: ({ tableArn }) => [
        dynamoGrant("InspectionsListQuery", ["dynamodb:Query"], [`${tableArn}/index/GSI2`]),
      ],
    });

    // recordInspection: schedule = GetItem (occupancy) + PutItem; conduct = UpdateItem.
    this.recordLambda = inspectionsRoute(this, name, args, {
      fn: "inspections-record",
      routeKey: "POST /api/v1/inspections",
      environment: { PLATFORM_TABLE_NAME: args.platformTableName },
      cedar: true,
      mutatesTable: true,
      statements: ({ tableArn }) => [
        dynamoGrant(
          "InspectionsRecord",
          ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
          [tableArn],
        ),
      ],
    });

    // submitFieldCapture: GetItem (existing record), then a transaction of Put (idempotency
    // lock) + ConditionCheck (occupancy) + Update (record); presigned photo PUTs under
    // {deptId}/INSPECTION_RECORD/.
    this.fieldCaptureLambda = inspectionsRoute(this, name, args, {
      fn: "field-capture",
      routeKey: "POST /api/v1/inspections/field-capture",
      environment: {
        PLATFORM_TABLE_NAME: args.platformTableName,
        PLATFORM_ASSETS_BUCKET_NAME: args.assetsBucketName,
      },
      cedar: true,
      mutatesTable: true,
      statements: ({ tableArn, bucketArn }) => [
        dynamoGrant(
          "FieldCaptureWrite",
          [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:ConditionCheckItem",
            "dynamodb:UpdateItem",
          ],
          [tableArn],
        ),
        dynamoGrant(
          "FieldCapturePutPhoto",
          ["s3:PutObject"],
          [`${bucketArn}/*/INSPECTION_RECORD/*`],
        ),
      ],
    });

    // A failed field capture is an offline outbox entry that could not sync — inspection
    // findings recorded on a phone that never reach the record — so it alarms.
    this.fieldCaptureFailedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-field-capture-failed-alarm`,
      {
        name: `boxalarm-${env}-inspections-field-capture-failed`,
        namespace: "Boxalarm/inspections",
        metricName: "InspectionFieldCaptureFailed",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
      },
      { parent: this },
    );

    this.registerOutputs({
      listLambda: this.listLambda,
      recordLambda: this.recordLambda,
      fieldCaptureLambda: this.fieldCaptureLambda,
    });
  }
}
