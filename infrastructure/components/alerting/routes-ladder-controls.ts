import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { HttpApi } from "../api/http-api";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { AlertingRoute, verifiedPermissionsStatement } from "./route-lambda";
import { grantAlertingCmk } from "./alerting-cmk";
import { Escalation } from "./escalation";

export interface RoutesLadderControlsArgs {
  env: string;
  httpApi: HttpApi;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  alertingTopicArn: pulumi.Input<string>;
  /** Owns the Tone Evaluator Lambda the advance route invokes. */
  escalation: Escalation;
  logGroup: ServiceLogGroup;
  policyStoreId: pulumi.Input<string>;
  /** alerting-page topic (alarms.ts) — a failed officer control pages on-call. */
  pageTopicArn: pulumi.Input<string>;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

/**
 * Advance synchronously invokes the Tone Evaluator (timeout 30s) and waits for the tone to
 * fan out; 29s stays under the HTTP API's 30s integration ceiling. A longer evaluation keeps
 * running in the evaluator and the officer sees a gateway timeout, which the UI reports as
 * "outcome unknown".
 */
export const LADDER_ADVANCE_TIMEOUT_SECONDS = 29;
/** Trigger runs the mutual-aid port (eligibility query + officer prompts); the rest are 1-3 calls. */
export const LADDER_CONTROL_TIMEOUT_SECONDS = 15;

/**
 * Officer tone-ladder and mutual-aid controls (architecture.md §2, F1.13/F1.14): four
 * Cognito(admin) POST routes under /api/v1/alerting/dispatches/{dispatchId}/.
 *
 * Least privilege, alerting plane only — no grant here names any table but the alerting
 * table, and every role carries the alerting-plane permissions boundary:
 *  - advance: GetItem (the ladder precondition) + lambda:InvokeFunction on the Tone
 *    Evaluator. It holds no SNS, scheduler, or write grant: the tone is fanned out by the
 *    evaluator under the evaluator's own role, exactly as a scheduled tone is.
 *  - halt: GetItem + one transaction (UpdateItem on METADATA, PutItem of the audit row).
 *  - mutual-aid trigger: the mutual-aid port's reads and writes plus sns:Publish on the
 *    alerting topic for the officer prompts.
 *  - mutual-aid acknowledge: one conditional UpdateItem, and a GetItem on conflict.
 */
export class RoutesLadderControls extends pulumi.ComponentResource {
  public readonly advance: AlertingRoute;
  public readonly halt: AlertingRoute;
  public readonly mutualAidTrigger: AlertingRoute;
  public readonly mutualAidAcknowledge: AlertingRoute;
  public readonly mutualAidAlarms: aws.cloudwatch.MetricAlarm[];
  public readonly failureAlarm: aws.cloudwatch.MetricAlarm;

  constructor(
    name: string,
    args: RoutesLadderControlsArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    requireEnv("RoutesLadderControls", args.env);
    super("boxalarm:alerting:RoutesLadderControls", name, {}, opts);
    const { env } = args;
    const tableArn = args.alertingTableArn as string;
    const vpStatement = verifiedPermissionsStatement();
    const common = {
      env,
      httpApi: args.httpApi,
      logGroup: args.logGroup,
      serviceName: "alerting-service" as const,
      handler: LAMBDA_HANDLER,
      reservedConcurrentExecutions: 3,
      permissionsBoundaryArn: args.permissionsBoundaryArn,
    };
    const baseEnvironment = {
      ALERTING_TABLE_NAME: args.alertingTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };

    // src/services/alerting-service/ladderControls/advanceHandler.handler
    this.advance = new AlertingRoute(
      `${name}-advance`,
      {
        ...common,
        functionName: `boxalarm-${env}-alerting-tone-ladder-advance`,
        code: lambdaCode("alerting-service", "tone-ladder-advance"),
        routeKey: "POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/advance",
        environment: {
          ...baseEnvironment,
          TONE_EVALUATOR_HANDLER_ARN: args.escalation.toneEvaluatorLambda.function.arn,
        },
        additionalPolicyStatements: args.escalation.toneEvaluatorLambda.function.arn.apply(
          (toneEvaluatorArn) => [
            {
              Sid: "AlertingTableLadderRead",
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem"],
              Resource: tableArn,
            },
            {
              Sid: "InvokeToneEvaluatorOnly",
              Effect: "Allow" as const,
              Action: ["lambda:InvokeFunction"],
              Resource: toneEvaluatorArn,
            },
            vpStatement,
          ],
        ),
        timeout: LADDER_ADVANCE_TIMEOUT_SECONDS,
      },
      { parent: this },
    );

    // src/services/alerting-service/ladderControls/haltHandler.handler
    this.halt = new AlertingRoute(
      `${name}-halt`,
      {
        ...common,
        functionName: `boxalarm-${env}-alerting-tone-ladder-halt`,
        code: lambdaCode("alerting-service", "tone-ladder-halt"),
        routeKey: "POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/halt",
        environment: baseEnvironment,
        additionalPolicyStatements: [
          {
            // TransactWriteItems authorizes nothing on its own: each item's action is
            // checked too (UpdateItem on METADATA, PutItem of the TONE_EVENT audit row).
            Sid: "AlertingTableHaltTransact",
            Effect: "Allow",
            Action: [
              "dynamodb:GetItem",
              "dynamodb:TransactWriteItems",
              "dynamodb:UpdateItem",
              "dynamodb:PutItem",
            ],
            Resource: tableArn,
          },
          vpStatement,
        ],
        timeout: LADDER_CONTROL_TIMEOUT_SECONDS,
      },
      { parent: this },
    );

    // src/services/alerting-service/ladderControls/mutualAidTriggerHandler.handler
    this.mutualAidTrigger = new AlertingRoute(
      `${name}-mutual-aid-trigger`,
      {
        ...common,
        functionName: `boxalarm-${env}-alerting-mutual-aid-trigger`,
        code: lambdaCode("alerting-service", "mutual-aid-trigger"),
        routeKey: "POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/trigger",
        environment: { ...baseEnvironment, ALERTING_TOPIC_ARN: args.alertingTopicArn },
        additionalPolicyStatements: pulumi.output(args.alertingTopicArn).apply((topicArn) => [
          {
            // requestMutualAid (escalation/mutualAidPort.ts): GetItem METADATA and each
            // existing prompt claim, the singleton TransactWriteItems (PutItem), Query of the
            // eligibility snapshot, conditional PutItem per officer prompt, UpdateItem marking
            // a prompt sent, PutItem of the outbox row.
            Sid: "AlertingTableMutualAidWrite",
            Effect: "Allow" as const,
            Action: [
              "dynamodb:GetItem",
              "dynamodb:Query",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:TransactWriteItems",
            ],
            Resource: tableArn,
          },
          {
            Sid: "AlertingTopicPublish",
            Effect: "Allow" as const,
            Action: ["sns:Publish"],
            Resource: topicArn,
          },
          vpStatement,
        ]),
        timeout: LADDER_CONTROL_TIMEOUT_SECONDS,
      },
      { parent: this },
    );

    // src/services/alerting-service/ladderControls/mutualAidAcknowledgeHandler.handler
    this.mutualAidAcknowledge = new AlertingRoute(
      `${name}-mutual-aid-acknowledge`,
      {
        ...common,
        functionName: `boxalarm-${env}-alerting-mutual-aid-acknowledge`,
        code: lambdaCode("alerting-service", "mutual-aid-acknowledge"),
        routeKey: "POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/acknowledge",
        environment: baseEnvironment,
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableMutualAidAcknowledge",
            Effect: "Allow",
            Action: ["dynamodb:UpdateItem", "dynamodb:GetItem"],
            Resource: tableArn,
          },
          vpStatement,
        ],
        timeout: LADDER_CONTROL_TIMEOUT_SECONDS,
      },
      { parent: this },
    );

    grantAlertingCmk(
      name,
      {
        advance: this.advance.lambda.role,
        halt: this.halt.lambda.role,
        mutualAidTrigger: this.mutualAidTrigger.lambda.role,
        mutualAidAcknowledge: this.mutualAidAcknowledge.lambda.role,
      },
      args.alertingCmkArn,
      { parent: this },
    );

    // The handlers turn every server-side failure into a problem response, so Lambda
    // `Errors` never moves; they emit this metric instead (ladderControls/shared.ts). An
    // officer's advance, halt or mutual-aid request that failed is a paging-path event.
    this.failureAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-failure-alarm`,
      {
        name: `boxalarm-${env}-alerting-ladder-control-failed`,
        namespace: "Boxalarm/Alerting",
        metricName: "LadderControlFailed",
        statistic: "Sum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 0,
        period: 60,
        evaluationPeriods: 1,
        treatMissingData: "notBreaching",
        alarmActions: [args.pageTopicArn],
      },
      { parent: this },
    );

    // Mutual aid must never fail silently (mutualAidPort.ts / toneEvaluatorHandler.ts):
    //  - MutualAidPromptFailed: an officer prompt could not be sent (the call is retried);
    //  - MutualAidRequestFailed: the automatic tone-3 request failed (the evaluation retries);
    //  - MutualAidNoOfficerReachable: recorded, but no officer has a push target to prompt.
    this.mutualAidAlarms = [
      ["prompt-failed", "MutualAidPromptFailed"],
      ["request-failed", "MutualAidRequestFailed"],
      ["no-officer-reachable", "MutualAidNoOfficerReachable"],
    ].map(
      ([suffix, metricName]) =>
        new aws.cloudwatch.MetricAlarm(
          `${name}-mutual-aid-${suffix}-alarm`,
          {
            name: `boxalarm-${env}-alerting-mutual-aid-${suffix}`,
            namespace: "Boxalarm/Alerting",
            metricName: metricName!,
            statistic: "Sum",
            comparisonOperator: "GreaterThanThreshold",
            threshold: 0,
            period: 60,
            evaluationPeriods: 1,
            treatMissingData: "notBreaching",
            alarmActions: [args.pageTopicArn],
          },
          { parent: this },
        ),
    );

    this.registerOutputs({
      advance: this.advance,
      halt: this.halt,
      mutualAidTrigger: this.mutualAidTrigger,
      mutualAidAcknowledge: this.mutualAidAcknowledge,
      failureAlarm: this.failureAlarm,
    });
  }
}
