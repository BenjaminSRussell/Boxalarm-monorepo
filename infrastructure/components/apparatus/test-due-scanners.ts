import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { auditMutationDenyStatement } from "../data/platform-table";
import { dailyScanner, PRE_DIGEST_SCANNER_SCHEDULE_EXPRESSION } from "../inventory/daily-scanner";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface TestDueScannersArgs {
  env: string;
  deptId: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  platformBusName: pulumi.Input<string>;
  platformBusArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
}

/**
 * Pinned with training's cert-expiry scanner (certifications.ts), two hours before
 * notification-service's 12:00 UTC digest, so a test that falls due today is in today's
 * digest rather than tomorrow's.
 */
export const TEST_DUE_SCANNER_SCHEDULE_EXPRESSION = PRE_DIGEST_SCANNER_SCHEDULE_EXPRESSION;

/**
 * F4.6/F4.7: the two daily apparatus scanners that publish apparatus.test.due to
 * boxalarm-{env}-platform-bus, which notification-service's apparatus-test-due consumer
 * turns into a digest reminder for the APPARATUS role and the chief:
 *
 *  - testDueScanner/handler.ts — hose/ladder/pump/aerial tests: GetItem on CONFIG#ALERT_RULES
 *    (lead days), one ranged GSI2 Query (DUE#APPARATUS_TEST), and per due test a conditional
 *    PutItem of the day's APPARATUS_TEST_DUE_FLAG marker, PutEvents, then an UpdateItem
 *    stamping publishedAt.
 *  - apparatusTestingScanner/handler.ts — SCBA flow/hydro: per-month GSI2 Queries
 *    (DUE#SCBA_TEST#{YYYY-MM}), then the same marker / PutEvents / publishedAt sequence.
 *
 * Both are single-department (their deptId comes from the stack, as the other scanners'
 * does) and use the shared daily-scanner failure handling: retries, a DLQ, DLQ-depth and
 * Errors alarms.
 */
export class TestDueScanners extends pulumi.ComponentResource {
  public readonly testDueScannerLambda: ServiceLambda;
  public readonly scbaTestDueScannerLambda: ServiceLambda;
  public readonly testDueScannerSchedule: aws.scheduler.Schedule;
  public readonly scbaTestDueScannerSchedule: aws.scheduler.Schedule;

  constructor(name: string, args: TestDueScannersArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("ApparatusTestDueScanners", args.env);
    super("boxalarm:apparatus:TestDueScanners", name, {}, opts);
    const { env } = args;

    const statements = (sidPrefix: string, readsConfig: boolean) =>
      pulumi.all([args.platformTableArn, args.platformBusArn]).apply(([tableArn, busArn]) => [
        {
          Sid: `${sidPrefix}TableAccess` as const,
          Effect: "Allow" as const,
          Action: [
            ...(readsConfig ? ["dynamodb:GetItem"] : []),
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
          ],
          Resource: [tableArn],
        },
        {
          Sid: `${sidPrefix}DueQuery` as const,
          Effect: "Allow" as const,
          Action: ["dynamodb:Query"],
          Resource: [`${tableArn}/index/GSI2`],
        },
        {
          Sid: `${sidPrefix}Publish` as const,
          Effect: "Allow" as const,
          Action: ["events:PutEvents"],
          Resource: busArn,
        },
        auditMutationDenyStatement(tableArn),
      ]);

    this.testDueScannerLambda = new ServiceLambda(
      `${name}-test-due`,
      {
        env,
        serviceName: "apparatus-service",
        functionName: `boxalarm-${env}-apparatus-test-due-scanner`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("apparatus-service", "test-due-scanner"),
        logGroup: args.logGroup,
        timeout: 60,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          PLATFORM_EVENT_BUS_NAME: args.platformBusName,
          APPARATUS_TEST_SCANNER_DEPT_ID: args.deptId,
        },
        additionalPolicyStatements: statements("ApparatusTestDueScanner", true),
      },
      { parent: this },
    );

    this.scbaTestDueScannerLambda = new ServiceLambda(
      `${name}-scba-test-due`,
      {
        env,
        serviceName: "apparatus-service",
        functionName: `boxalarm-${env}-apparatus-scba-test-due-scanner`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("apparatus-service", "scba-test-due-scanner"),
        logGroup: args.logGroup,
        timeout: 60,
        environment: {
          PLATFORM_TABLE_NAME: args.platformTableName,
          PLATFORM_EVENT_BUS_NAME: args.platformBusName,
          APPARATUS_SCANNER_DEPT_ID: args.deptId,
        },
        additionalPolicyStatements: statements("ScbaTestDueScanner", false),
      },
      { parent: this },
    );

    this.testDueScannerSchedule = dailyScanner(
      this,
      `${name}-test-due`,
      env,
      "apparatus-test-due-scanner",
      this.testDueScannerLambda,
      TEST_DUE_SCANNER_SCHEDULE_EXPRESSION,
    ).schedule;

    this.scbaTestDueScannerSchedule = dailyScanner(
      this,
      `${name}-scba-test-due`,
      env,
      "apparatus-scba-test-due-scanner",
      this.scbaTestDueScannerLambda,
      TEST_DUE_SCANNER_SCHEDULE_EXPRESSION,
    ).schedule;

    this.registerOutputs({
      testDueScannerLambda: this.testDueScannerLambda,
      scbaTestDueScannerLambda: this.scbaTestDueScannerLambda,
    });
  }
}
