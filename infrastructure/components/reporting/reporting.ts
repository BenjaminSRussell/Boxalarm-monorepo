import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface ReportingArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  /** Response-time analytics and the ISO report read incident RESPONSE# items (GSI1). */
  incidentTableName: pulumi.Input<string>;
  incidentTableArn: pulumi.Input<string>;
  /** The incident table is CMK-encrypted — every reader needs kms:Decrypt on it. */
  incidentCmkArn: pulumi.Input<string>;
  /**
   * alerting-service's deployed delivery-baseline Lambda. GET cutover-decision invokes it
   * with the caller's own token (cutoverDecision/deliveryBaseline.ts) rather than reading
   * the alerting table itself, so the alerting IAM boundary is untouched.
   */
  deliveryBaselineFunctionName: pulumi.Input<string>;
  deliveryBaselineFunctionArn: pulumi.Input<string>;
  /** Export and cutover-write alarms go to the chief, as platform export's do. */
  chiefNotificationTopicArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * The namespace the reporting handlers added in 2637573 emit to (dashboard, iso,
 * responseTimes, export, cutoverDecision: `METRICS_NAMESPACE = 'Boxalarm/ReportingService'`).
 * Not metricsNamespaceFor("reporting-service") — an alarm on that namespace would never fire.
 */
const REPORTING_METRICS_NAMESPACE = "Boxalarm/ReportingService";

/**
 * Report reads fan out one Query per incident / training event / apparatus unit, so the
 * 3 s Lambda default is too tight; 25 s stays under the HTTP API's 30 s integration cap.
 */
export const REPORT_TIMEOUT_SECONDS = 25;
/** The export worker renders a whole report off the request path (invoked async). */
export const EXPORT_WORKER_TIMEOUT_SECONDS = 300;

/** Query-only, no dynamodb:Scan — every reporting route reads GSIs on the platform table. */
const QUERY_STATEMENT = (tableArn: pulumi.Input<string>) =>
  pulumi.output(tableArn).apply((arn) => [
    {
      Sid: "ReportingQueryAccess" as const,
      Effect: "Allow" as const,
      Action: ["dynamodb:Query"],
      Resource: [arn, `${arn}/index/*`],
    },
  ]);

function queryStatement(sid: string, resources: string[]): IamPolicyStatement {
  return { Sid: sid, Effect: "Allow", Action: ["dynamodb:Query"], Resource: resources };
}

function incidentReadStatements(incidentArn: string, cmkArn: string): IamPolicyStatement[] {
  return [
    // responseTimes/repository.ts: incidents in range on GSI1, then RESPONSE# items per
    // incident on the base table.
    queryStatement("IncidentResponseQuery", [incidentArn, `${incidentArn}/index/GSI1`]),
    { Sid: "DecryptIncidentTable", Effect: "Allow", Action: ["kms:Decrypt"], Resource: cmkArn },
  ];
}

/**
 * reporting-service (E7-S3-INFRA #249, E7-S5-INFRA #251, E7-S7-INFRA #252, and the
 * E7-BACKEND routes: dashboard #94, response times #99, ISO #97, export #100, cutover
 * decision #40). Every service-scoped table env var (PLATFORM_SERVICE_TABLE_NAME,
 * PERSONNEL_TABLE_NAME, TRAINING_DYNAMO_TABLE_NAME, PLATFORM_TABLE_NAME) is the shared
 * platform table, per the architecture's single platform-table domain-per-service-name
 * convention (see personnel/members.ts's PERSONNEL_TABLE_NAME for the same pattern).
 *
 * #251's incident-table grant for the grants report's incident-volume figure is still not
 * wired: grants/handler.ts hardcodes `incidentVolume: { available: false, reason: 'E6-S1' }`,
 * so that Lambda makes no incident-table call a grant would authorize.
 */
export class Reporting extends pulumi.ComponentResource {
  public readonly losapYearEndLambda: ServiceLambda;
  public readonly grantsLambda: ServiceLambda;
  public readonly membershipTrendsLambda: ServiceLambda;
  public readonly dashboardLambda: ServiceLambda;
  public readonly responseTimesLambda: ServiceLambda;
  public readonly isoLambda: ServiceLambda;
  public readonly exportsBucket: aws.s3.Bucket;
  public readonly exportWorkerLambda: ServiceLambda;
  public readonly exportLambda: ServiceLambda;
  public readonly cutoverDecisionGetLambda: ServiceLambda;
  public readonly cutoverDecisionPostLambda: ServiceLambda;
  public readonly exportInvokedAlarm: aws.cloudwatch.MetricAlarm;
  public readonly exportFailedAlarm: aws.cloudwatch.MetricAlarm;
  public readonly exportWorkerErrorsAlarm: aws.cloudwatch.MetricAlarm;
  public readonly cutoverDecisionPostFailedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: ReportingArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Reporting", args.env);
    super("boxalarm:reporting:Reporting", name, {}, opts);
    const { env } = args;

    const vpStatement = pulumi
      .output(args.policyStoreArn)
      .apply((policyStoreArn) => [verifiedPermissionsPolicyStatement(policyStoreArn)]);
    const baseEnvironment = {
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };

    const route = (key: string, routeKey: string, lambda: ServiceLambda) =>
      args.httpApi.route(`${name}-${key}-route`, { routeKey, lambda }, { parent: this });

    this.losapYearEndLambda = new ServiceLambda(
      `${name}-losap-year-end`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-losap-year-end`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "losap-year-end"),
        logGroup: args.logGroup,
        timeout: REPORT_TIMEOUT_SECONDS,
        environment: { ...baseEnvironment, PLATFORM_SERVICE_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: pulumi
          .all([QUERY_STATEMENT(args.platformTableArn), vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    route("losap-year-end", "GET /api/v1/reporting/losap/year-end", this.losapYearEndLambda);

    this.grantsLambda = new ServiceLambda(
      `${name}-grants`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-grants`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "grants"),
        logGroup: args.logGroup,
        timeout: REPORT_TIMEOUT_SECONDS,
        environment: {
          ...baseEnvironment,
          PERSONNEL_TABLE_NAME: args.platformTableName,
          TRAINING_DYNAMO_TABLE_NAME: args.platformTableName,
          PLATFORM_TABLE_NAME: args.platformTableName,
        },
        additionalPolicyStatements: pulumi
          .all([QUERY_STATEMENT(args.platformTableArn), vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    route("grants", "GET /api/v1/reporting/grants", this.grantsLambda);

    this.membershipTrendsLambda = new ServiceLambda(
      `${name}-membership-trends`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-membership-trends`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "membership-trends"),
        logGroup: args.logGroup,
        timeout: REPORT_TIMEOUT_SECONDS,
        environment: {
          ...baseEnvironment,
          PERSONNEL_TABLE_NAME: args.platformTableName,
          PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
        },
        additionalPolicyStatements: pulumi
          .all([QUERY_STATEMENT(args.platformTableArn), vpStatement])
          .apply(([table, vp]) => [...table, ...vp]),
      },
      { parent: this },
    );
    route(
      "membership-trends",
      "GET /api/v1/reporting/membership-trends",
      this.membershipTrendsLambda,
    );

    // dashboard/repository.ts: one base-table Query on DEPT#{d}#REPORTING_ROLLUP.
    this.dashboardLambda = new ServiceLambda(
      `${name}-dashboard`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-dashboard`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "dashboard"),
        logGroup: args.logGroup,
        timeout: REPORT_TIMEOUT_SECONDS,
        environment: { ...baseEnvironment, PLATFORM_SERVICE_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, vpStatement])
          .apply(([tableArn, vp]) => [queryStatement("DashboardRollupQuery", [tableArn]), ...vp]),
      },
      { parent: this },
    );
    route("dashboard", "GET /api/v1/reporting/dashboard", this.dashboardLambda);

    this.responseTimesLambda = new ServiceLambda(
      `${name}-response-times`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-response-times`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "response-times"),
        logGroup: args.logGroup,
        timeout: REPORT_TIMEOUT_SECONDS,
        environment: { ...baseEnvironment, INCIDENT_TABLE_NAME: args.incidentTableName },
        additionalPolicyStatements: pulumi
          .all([args.incidentTableArn, args.incidentCmkArn, vpStatement])
          .apply(([incidentArn, cmkArn, vp]) => [
            ...incidentReadStatements(incidentArn, cmkArn),
            ...vp,
          ]),
      },
      { parent: this },
    );
    route("response-times", "GET /api/v1/reporting/response-times", this.responseTimesLambda);

    // iso/repository.ts: training events (GSI3) + attendees (base), apparatus (GSI3) +
    // TEST# items (base), hydrant due buckets (GSI2), and the response-time section from
    // the incident table.
    this.isoLambda = new ServiceLambda(
      `${name}-iso`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-iso`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "iso"),
        logGroup: args.logGroup,
        timeout: REPORT_TIMEOUT_SECONDS,
        environment: {
          ...baseEnvironment,
          PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
          INCIDENT_TABLE_NAME: args.incidentTableName,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.incidentTableArn, args.incidentCmkArn, vpStatement])
          .apply(([tableArn, incidentArn, cmkArn, vp]) => [
            queryStatement("IsoPlatformQuery", [
              tableArn,
              `${tableArn}/index/GSI2`,
              `${tableArn}/index/GSI3`,
            ]),
            ...incidentReadStatements(incidentArn, cmkArn),
            ...vp,
          ]),
      },
      { parent: this },
    );
    route("iso", "GET /api/v1/reporting/iso", this.isoLambda);

    // A reporting-owned bucket, not platform export's staging bucket: both key objects as
    // {deptId}/{jobId}/..., so sharing it would let this role presign a full-department
    // platform export. Same hardening and 7-day lifecycle (E7-S9 AC5, architecture §8).
    this.exportsBucket = new aws.s3.Bucket(
      `${name}-exports`,
      { bucket: `boxalarm-${env}-reporting-exports`, forceDestroy: false },
      { parent: this },
    );
    new aws.s3.BucketPublicAccessBlock(
      `${name}-exports-block`,
      {
        bucket: this.exportsBucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      { parent: this },
    );
    new aws.s3.BucketServerSideEncryptionConfigurationV2(
      `${name}-exports-sse`,
      {
        bucket: this.exportsBucket.id,
        rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
      },
      { parent: this },
    );
    new aws.s3.BucketLifecycleConfigurationV2(
      `${name}-exports-lifecycle`,
      {
        bucket: this.exportsBucket.id,
        rules: [
          {
            id: "expire-and-abort-multipart",
            status: "Enabled",
            expiration: { days: 7 },
            abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
          },
        ],
      },
      { parent: this },
    );

    // export/worker.ts → buildReport.ts can build any of the six reports, so it needs the
    // union of their reads: platform base + GSI1 (LOSAP/membership attendance), GSI2 (ISO
    // hydrants), GSI3 (events, apparatus, members); incident GSI1 + base; plus the
    // markExportJob UpdateItem and the rendered file's PutObject.
    this.exportWorkerLambda = new ServiceLambda(
      `${name}-export-worker`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-export-worker`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "export-worker"),
        logGroup: args.logGroup,
        timeout: EXPORT_WORKER_TIMEOUT_SECONDS,
        memorySize: 512,
        environment: {
          PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
          PERSONNEL_TABLE_NAME: args.platformTableName,
          TRAINING_DYNAMO_TABLE_NAME: args.platformTableName,
          PLATFORM_TABLE_NAME: args.platformTableName,
          INCIDENT_TABLE_NAME: args.incidentTableName,
          EXPORTS_BUCKET_NAME: this.exportsBucket.bucket,
        },
        additionalPolicyStatements: pulumi
          .all([
            args.platformTableArn,
            args.incidentTableArn,
            args.incidentCmkArn,
            this.exportsBucket.arn,
          ])
          .apply(([tableArn, incidentArn, cmkArn, bucketArn]) => [
            queryStatement("ExportPlatformQuery", [
              tableArn,
              `${tableArn}/index/GSI1`,
              `${tableArn}/index/GSI2`,
              `${tableArn}/index/GSI3`,
            ]),
            {
              Sid: "MarkExportJob",
              Effect: "Allow" as const,
              Action: ["dynamodb:UpdateItem"],
              Resource: tableArn,
            },
            auditMutationDenyStatement(tableArn),
            ...incidentReadStatements(incidentArn, cmkArn),
            {
              Sid: "WriteReportExport",
              Effect: "Allow" as const,
              Action: ["s3:PutObject", "s3:AbortMultipartUpload"],
              Resource: `${bucketArn}/*`,
            },
          ]),
      },
      { parent: this },
    );

    // export/handler.ts: putExportJob (PutItem), getExportJob (GetItem), markExportJob on a
    // failed worker invoke (UpdateItem); async-invokes the worker; presigns the finished
    // object (GetObject, which the signed URL is evaluated against).
    this.exportLambda = new ServiceLambda(
      `${name}-export`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-export`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "export"),
        logGroup: args.logGroup,
        timeout: REPORT_TIMEOUT_SECONDS,
        environment: {
          ...baseEnvironment,
          PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
          EXPORTS_BUCKET_NAME: this.exportsBucket.bucket,
          REPORTING_EXPORT_WORKER_FUNCTION_NAME: this.exportWorkerLambda.function.name,
        },
        additionalPolicyStatements: pulumi
          .all([
            args.platformTableArn,
            this.exportWorkerLambda.function.arn,
            this.exportsBucket.arn,
            vpStatement,
          ])
          .apply(([tableArn, workerArn, bucketArn, vp]) => [
            {
              Sid: "ExportJobTableAccess",
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
              Resource: tableArn,
            },
            auditMutationDenyStatement(tableArn),
            {
              Sid: "InvokeReportExportWorker",
              Effect: "Allow" as const,
              Action: ["lambda:InvokeFunction"],
              Resource: workerArn,
            },
            {
              Sid: "ReadReportExport",
              Effect: "Allow" as const,
              Action: ["s3:GetObject"],
              Resource: `${bucketArn}/*`,
            },
            ...vp,
          ]),
      },
      { parent: this },
    );
    // The architecture table lists a single `GET /api/v1/reporting/export` (docs/
    // architecture.md:396). Deployed instead as accept (POST) + status (GET {jobId}), the
    // same split as platform export (:307-308), so a status poll can never start a job.
    route("export-post", "POST /api/v1/reporting/export", this.exportLambda);
    route("export-get", "GET /api/v1/reporting/export/{jobId}", this.exportLambda);

    // cutoverDecision/get.ts: GetItem on DEPT#{d}#CUTOVER_DECISION / CURRENT, and — only when
    // ?from&to are given — the delivery-baseline Lambda invoke.
    this.cutoverDecisionGetLambda = new ServiceLambda(
      `${name}-cutover-decision-get`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-cutover-decision-get`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "cutover-decision-get"),
        logGroup: args.logGroup,
        timeout: REPORT_TIMEOUT_SECONDS,
        environment: {
          ...baseEnvironment,
          PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
          DELIVERY_BASELINE_FUNCTION_NAME: args.deliveryBaselineFunctionName,
        },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.deliveryBaselineFunctionArn, vpStatement])
          .apply(([tableArn, baselineArn, vp]) => [
            {
              Sid: "CutoverDecisionRead",
              Effect: "Allow" as const,
              Action: ["dynamodb:GetItem"],
              Resource: tableArn,
            },
            {
              Sid: "InvokeDeliveryBaseline",
              Effect: "Allow" as const,
              Action: ["lambda:InvokeFunction"],
              Resource: baselineArn,
            },
            ...vp,
          ]),
      },
      { parent: this },
    );
    route(
      "cutover-decision-get",
      "GET /api/v1/reporting/cutover-decision",
      this.cutoverDecisionGetLambda,
    );

    // cutoverDecision/repository.ts: TransactWriteItems of two Puts (CURRENT + the
    // append-only DECISION#{ts} history row). TransactWriteItems itself authorizes nothing —
    // each Put is authorized as dynamodb:PutItem.
    this.cutoverDecisionPostLambda = new ServiceLambda(
      `${name}-cutover-decision-post`,
      {
        env,
        serviceName: "reporting-service",
        functionName: `boxalarm-${env}-reporting-cutover-decision-post`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("reporting-service", "cutover-decision-post"),
        logGroup: args.logGroup,
        timeout: REPORT_TIMEOUT_SECONDS,
        environment: { ...baseEnvironment, PLATFORM_SERVICE_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, vpStatement])
          .apply(([tableArn, vp]) => [
            {
              Sid: "CutoverDecisionWrite",
              Effect: "Allow" as const,
              Action: ["dynamodb:PutItem"],
              Resource: tableArn,
            },
            ...vp,
          ]),
      },
      { parent: this },
    );
    route(
      "cutover-decision-post",
      "POST /api/v1/reporting/cutover-decision",
      this.cutoverDecisionPostLambda,
    );

    const chiefAlarmAction = [args.chiefNotificationTopicArn];
    const metricAlarm = (key: string, alarmName: string, metricName: string, period: number) =>
      new aws.cloudwatch.MetricAlarm(
        `${name}-${key}-alarm`,
        {
          name: `boxalarm-${env}-${alarmName}`,
          namespace: REPORTING_METRICS_NAMESPACE,
          metricName,
          statistic: "Sum",
          period,
          evaluationPeriods: 1,
          threshold: 0,
          comparisonOperator: "GreaterThanThreshold",
          treatMissingData: "notBreaching",
          alarmActions: chiefAlarmAction,
        },
        { parent: this },
      );

    // Same compensating control as platform export's ExportInvoked alarm: export is gated by
    // a Cedar role check alone (CLAUDE.md), so the chief hears about every one.
    this.exportInvokedAlarm = metricAlarm(
      "export-invoked",
      "reporting-export-invoked",
      "ReportingExportAccepted",
      60,
    );
    this.exportFailedAlarm = metricAlarm(
      "export-failed",
      "reporting-export-failed",
      "ReportingExportFailed",
      300,
    );
    // A failed accept/defer write on the N1.9 cutover gate must never pass silently.
    this.cutoverDecisionPostFailedAlarm = metricAlarm(
      "cutover-decision-post-failed",
      "reporting-cutover-decision-post-failed",
      "ReportingCutoverDecisionPostFailed",
      300,
    );
    // The worker marks its own failures FAILED, but a crash before that (timeout, OOM)
    // leaves the job PENDING forever — only the Lambda Errors metric sees it.
    this.exportWorkerErrorsAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-export-worker-errors-alarm`,
      {
        name: `boxalarm-${env}-reporting-export-worker-errors`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: this.exportWorkerLambda.function.name },
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: chiefAlarmAction,
      },
      { parent: this },
    );

    this.registerOutputs({
      losapYearEndLambda: this.losapYearEndLambda,
      grantsLambda: this.grantsLambda,
      membershipTrendsLambda: this.membershipTrendsLambda,
      dashboardLambda: this.dashboardLambda,
      responseTimesLambda: this.responseTimesLambda,
      isoLambda: this.isoLambda,
      exportsBucket: this.exportsBucket,
      exportWorkerLambda: this.exportWorkerLambda,
      exportLambda: this.exportLambda,
      cutoverDecisionGetLambda: this.cutoverDecisionGetLambda,
      cutoverDecisionPostLambda: this.cutoverDecisionPostLambda,
    });
  }
}
