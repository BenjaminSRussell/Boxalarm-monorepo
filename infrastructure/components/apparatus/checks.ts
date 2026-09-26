import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { requireEnv } from "../shared/env";
import { ApparatusArgs, apparatusRoute } from "./apparatus-lambda";

/**
 * Truck checks (F4.2), defect reporting (F4.3) and the check-compliance report (F4.9).
 * The mobile offline outbox (ui/apps/mobile/src/sync/syncManager.ts) drains queued
 * checklist runs into POST .../checks and defect reports into POST .../defects, so a
 * failure on either is a member's check or defect that never reaches the department —
 * both Lambdas carry an Errors alarm, and the defect path's business-failure metrics
 * are alarmed too.
 *
 * NOT wired: the defect photo upload URL. reportDefectHandler.ts signs a CloudFront URL
 * (CLOUDFRONT_DISTRIBUTION_DOMAIN / _KEY_PAIR_ID / _PRIVATE_KEY_SECRET_ID), and CloudFront
 * is a global-edge service that residency-encryption.test.ts forbids (N6.1) — the same
 * gap certifications.ts documents for attachments. A defect without a photo works; one
 * that names a photo reaches readDefectPhotoUploadConfig() and fails with a 5xx before
 * the defect is written. The region-pinned replacement is api-gap P1 #13.
 */
export class Checks extends pulumi.ComponentResource {
  public readonly checklistLambda: ServiceLambda;
  public readonly submitCheckLambda: ServiceLambda;
  public readonly reportDefectLambda: ServiceLambda;
  public readonly complianceLambda: ServiceLambda;
  public readonly submitCheckErrorsAlarm: aws.cloudwatch.MetricAlarm;
  public readonly reportDefectErrorsAlarm: aws.cloudwatch.MetricAlarm;
  public readonly defectReportFailedAlarm: aws.cloudwatch.MetricAlarm;
  public readonly defectOosTransitionFailedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: ApparatusArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("ApparatusChecks", args.env);
    super("boxalarm:apparatus:Checks", name, {}, opts);
    const { env } = args;

    // getChecklistHandler.ts: resolveApparatusIdByUnitId queries GSI3;
    // resolveChecklistTemplateForUnit is a filtered base-table Scan (checklistResolution.ts)
    // — there is no template index, so Scan is what the handler needs.
    this.checklistLambda = apparatusRoute(this, name, args, {
      functionKey: "checklist-get",
      routeKey: "GET /api/v1/apparatus/{unitId}/checklist",
      cedar: true,
      grants: [
        { sid: "ChecklistApparatusLookup", actions: ["dynamodb:Query"], on: ["GSI3"] },
        { sid: "ChecklistTemplateScan", actions: ["dynamodb:Scan"], on: ["table"] },
      ],
    });

    // postChecks.ts: GSI3 lookup; a transaction of three Puts (run, idempotency lock,
    // audit row); on a replay, consistent GetItems of the lock and the existing run.
    this.submitCheckLambda = apparatusRoute(this, name, args, {
      functionKey: "checks-submit",
      routeKey: "POST /api/v1/apparatus/{unitId}/checks",
      cedar: true,
      grants: [
        { sid: "SubmitCheckApparatusLookup", actions: ["dynamodb:Query"], on: ["GSI3"] },
        {
          sid: "SubmitCheckWrite",
          actions: ["dynamodb:PutItem", "dynamodb:GetItem"],
          on: ["table"],
        },
      ],
    });

    // reportDefectHandler.ts: defectRepository's GSI3 lookup, the idempotency Query +
    // GetItem, then a transaction of Puts (defect, outbox row, idempotency marker). An
    // OUT_OF_SERVICE defect also runs repository.setServiceStatus (GSI3 lookup + a
    // transaction of Update METADATA + Put OOS#).
    this.reportDefectLambda = apparatusRoute(this, name, args, {
      functionKey: "defects-report",
      routeKey: "POST /api/v1/apparatus/{unitId}/defects",
      cedar: true,
      grants: [
        { sid: "ReportDefectQuery", actions: ["dynamodb:Query"], on: ["table", "GSI3"] },
        {
          sid: "ReportDefectWrite",
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
          on: ["table"],
        },
      ],
    });

    // getComplianceHandler.ts: repository.listApparatus and queryChecklistRunsInRange both
    // query GSI3; nothing touches the base table.
    this.complianceLambda = apparatusRoute(this, name, args, {
      functionKey: "compliance",
      routeKey: "GET /api/v1/apparatus/compliance",
      cedar: true,
      grants: [{ sid: "ComplianceQuery", actions: ["dynamodb:Query"], on: ["GSI3"] }],
    });

    const lambdaErrorsAlarm = (suffix: string, lambda: ServiceLambda) =>
      new aws.cloudwatch.MetricAlarm(
        `${name}-${suffix}-errors-alarm`,
        {
          name: `boxalarm-${env}-apparatus-${suffix}-errors`,
          namespace: "AWS/Lambda",
          metricName: "Errors",
          dimensions: { FunctionName: lambda.function.name },
          statistic: "Sum",
          period: 300,
          evaluationPeriods: 1,
          threshold: 0,
          comparisonOperator: "GreaterThanThreshold",
          treatMissingData: "notBreaching",
        },
        { parent: this },
      );
    this.submitCheckErrorsAlarm = lambdaErrorsAlarm("checks-submit", this.submitCheckLambda);
    this.reportDefectErrorsAlarm = lambdaErrorsAlarm("defects-report", this.reportDefectLambda);

    // EMF metrics reportDefectHandler.ts emits under Boxalarm/apparatus-service.
    const defectMetricAlarm = (suffix: string, metricName: string) =>
      new aws.cloudwatch.MetricAlarm(
        `${name}-${suffix}-alarm`,
        {
          name: `boxalarm-${env}-apparatus-${suffix}`,
          namespace: "Boxalarm/apparatus-service",
          metricName,
          statistic: "Sum",
          period: 300,
          evaluationPeriods: 1,
          threshold: 0,
          comparisonOperator: "GreaterThanThreshold",
          treatMissingData: "notBreaching",
        },
        { parent: this },
      );
    this.defectReportFailedAlarm = defectMetricAlarm("defect-report-failed", "DefectReportFailed");
    // The defect is saved but the apparatus is still shown IN_SERVICE.
    this.defectOosTransitionFailedAlarm = defectMetricAlarm(
      "defect-oos-transition-failed",
      "DefectOosTransitionFailed",
    );

    this.registerOutputs({
      checklistLambda: this.checklistLambda,
      submitCheckLambda: this.submitCheckLambda,
      reportDefectLambda: this.reportDefectLambda,
      complianceLambda: this.complianceLambda,
    });
  }
}
