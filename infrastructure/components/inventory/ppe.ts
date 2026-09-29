import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";
import { dailyScanner, PRE_DIGEST_SCANNER_SCHEDULE_EXPRESSION } from "./daily-scanner";

export interface PpeArgs {
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
 * api-gap P0-6: PPE assignment (F5.2) — GET/POST /api/v1/inventory/ppe/{memberId}
 * (Cedar ViewPpeAssignments for every role, IssuePpeAssignment for chief/admin/officer)
 * and the daily NFPA service-life expiry scanner that publishes ppe.expiry.due.
 *
 * ppe.expiry.due is consumed by notification-service (notification/reminders.ts), which
 * turns it into a ppe-expiry digest reminder for the holder and the APPARATUS role.
 */
export class Ppe extends pulumi.ComponentResource {
  public readonly getLambda: ServiceLambda;
  public readonly issueLambda: ServiceLambda;
  public readonly expiryScannerLambda: ServiceLambda;
  public readonly expiryScannerSchedule: aws.scheduler.Schedule;

  constructor(name: string, args: PpeArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Ppe", args.env);
    super("boxalarm:inventory:Ppe", name, {}, opts);
    const { env } = args;

    const httpEnvironment = {
      PLATFORM_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };

    this.getLambda = new ServiceLambda(
      `${name}-get`,
      {
        env,
        serviceName: "inventory-service",
        functionName: `boxalarm-${env}-inventory-ppe-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("inventory-service", "ppe-get"),
        logGroup: args.logGroup,
        environment: httpEnvironment,
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              // listPpeAssignmentsForMember: base-table Query on the member partition.
              Sid: "PpeGetQuery" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query"],
              Resource: [tableArn],
            },
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-get-route`,
      { routeKey: "GET /api/v1/inventory/ppe/{memberId}", lambda: this.getLambda },
      { parent: this },
    );

    this.issueLambda = new ServiceLambda(
      `${name}-issue`,
      {
        env,
        serviceName: "inventory-service",
        functionName: `boxalarm-${env}-inventory-ppe-issue`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("inventory-service", "ppe-issue"),
        logGroup: args.logGroup,
        environment: httpEnvironment,
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              // issuePpeAssignment: one transaction of two conditional Puts (assignment +
              // audit row). IAM authorizes each transaction item as its own PutItem —
              // dynamodb:TransactWriteItems is not an IAM action and grants nothing.
              Sid: "PpeIssueWrite" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:PutItem"],
              Resource: [tableArn],
            },
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-issue-route`,
      { routeKey: "POST /api/v1/inventory/ppe/{memberId}", lambda: this.issueLambda },
      { parent: this },
    );

    this.expiryScannerLambda = new ServiceLambda(
      `${name}-expiry-scanner`,
      {
        env,
        serviceName: "inventory-service",
        functionName: `boxalarm-${env}-inventory-ppe-expiry-scanner`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("inventory-service", "ppe-expiry-scanner"),
        logGroup: args.logGroup,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          PLATFORM_CONFIG_DYNAMO_TABLE_NAME: args.platformTableName,
          PLATFORM_EVENT_BUS_NAME: args.platformBusName,
          PPE_SCANNER_DEPT_ID: args.deptId,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.platformBusArn])
          .apply(([tableArn, busArn]) => [
            {
              // GetItem: readPpeExpiryLeadDays (CONFIG#ALERT_RULES). PutItem/UpdateItem:
              // publishDueEvent's per-day PPE_EXPIRY_FLAG dedup marker and its
              // publishedAt stamp.
              Sid: "PpeExpiryScannerTableAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
              Resource: [tableArn],
            },
            {
              // queryPpeAssignmentsDueInMonth: GSI2 (AP 13).
              Sid: "PpeExpiryScannerDueQuery" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query"],
              Resource: [`${tableArn}/index/GSI2`],
            },
            {
              Sid: "PpeExpiryScannerPublish" as const,
              Effect: "Allow" as const,
              Action: ["events:PutEvents"],
              Resource: busArn,
            },
            auditMutationDenyStatement(tableArn),
          ]),
      },
      { parent: this },
    );

    this.expiryScannerSchedule = dailyScanner(
      this,
      `${name}-expiry-scanner`,
      env,
      "inventory-ppe-expiry-scanner",
      this.expiryScannerLambda,
      // Its reminders feed the 12:00 UTC digest.
      PRE_DIGEST_SCANNER_SCHEDULE_EXPRESSION,
    ).schedule;

    this.registerOutputs({
      getLambda: this.getLambda,
      issueLambda: this.issueLambda,
      expiryScannerLambda: this.expiryScannerLambda,
    });
  }
}
