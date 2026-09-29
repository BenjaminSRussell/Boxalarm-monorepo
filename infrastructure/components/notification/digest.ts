import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { QueueConsumer } from "../messaging/queue-consumer";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface DigestArgs {
  env: string;
  deptId: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  platformBusName: pulumi.Input<string>;
  platformBusArn: pulumi.Input<string>;
  /** Verified SES sender for notification email. Set per stack; never an alerting identity. */
  sesFromAddress: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
}

/** UTC. The training cert-expiry scanner is pinned to 10:00 UTC (certifications.ts). */
export const DIGEST_SCHEDULE_EXPRESSION = "cron(0 12 * * ? *)";

/** The metric namespace digestJob.ts / certExpiryConsumer.ts emit into (EMF). */
const DIGEST_METRIC_NAMESPACE = "Boxalarm/NotificationDigest";

/**
 * The chain that puts content in the inbox (architecture.md §1.1 service 10: "digest
 * batching is required, not optional"):
 *
 *   1. training-service's daily cert-expiry scanner publishes cert.expiry.due to
 *      boxalarm-{env}-platform-bus.
 *   2. A platform-bus rule -> SQS -> certExpiryConsumer.ts, which unwraps the EventBridge
 *      `detail` and records one DIGEST_PENDING row for the member and one for the
 *      TRAINING role, bucketed by UTC day (GSI3).
 *   3. digestJob.ts, invoked daily by EventBridge Scheduler with {deptId} after the
 *      scanner has run, groups the day's pending rows per recipient, sends one push + one
 *      email digest per recipient (honouring preference mutes), and writes the NOTIFICATION
 *      inbox record GET /api/v1/notifications reads.
 *
 * Failure-domain isolation from the alerting plane (N1.5): the consumer queue is its own
 * standard SQS queue off the LOB bus with a small maximumConcurrency cap; the push topic
 * is a standard (non-FIFO) notification-owned topic, never the alerting FIFO topic; email
 * goes through SES, which the alerting plane does not use. No reserved concurrency.
 *
 * The other reminder categories (apparatus test due, apparatus defect, consumable reorder,
 * PPE expiry) reach the same DIGEST_PENDING rows through reminders.ts's consumers; the job
 * routes each category to its roles (backend reminders/categories.ts). Nothing subscribes
 * to the push topic yet — no device-delivery Lambda for the non-critical channel exists in
 * backend/ — so a push is published and dropped; the email digest and the inbox record are
 * the delivered surfaces today.
 */
export class Digest extends pulumi.ComponentResource {
  public readonly pushTopic: aws.sns.Topic;
  public readonly certExpiryConsumerLambda: ServiceLambda;
  public readonly certExpiryConsumer: QueueConsumer;
  public readonly digestLambda: ServiceLambda;
  public readonly digestSchedule: aws.scheduler.Schedule;
  public readonly digestDlq: aws.sqs.Queue;
  public readonly digestDlqAlarm: aws.cloudwatch.MetricAlarm;
  public readonly digestErrorsAlarm: aws.cloudwatch.MetricAlarm;
  public readonly digestRecipientFailedAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: DigestArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Digest", args.env);
    super("boxalarm:notification:Digest", name, {}, opts);
    const { env } = args;

    const region = aws.getRegionOutput({}, { parent: this });
    const caller = aws.getCallerIdentityOutput({}, { parent: this });

    this.pushTopic = new aws.sns.Topic(
      `${name}-push-topic`,
      { name: `boxalarm-${env}-notification-push`, kmsMasterKeyId: "alias/aws/sns" },
      { parent: this },
    );

    // certExpiryConsumer.ts: one TransactWrite of two conditional Puts (member + role
    // DIGEST_PENDING rows). IAM authorizes each transaction item as its own PutItem.
    this.certExpiryConsumerLambda = new ServiceLambda(
      `${name}-cert-expiry-consumer`,
      {
        env,
        serviceName: "notification-service",
        functionName: `boxalarm-${env}-notification-cert-expiry-consumer`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("notification-service", "cert-expiry-consumer"),
        logGroup: args.logGroup,
        // Under the queue's default 30s visibility timeout, as AWS requires.
        timeout: 15,
        environment: { PLATFORM_SERVICE_TABLE_NAME: args.platformTableName },
        additionalPolicyStatements: pulumi.output(args.platformTableArn).apply((tableArn) => [
          {
            Sid: "NotificationPendingWrite" as const,
            Effect: "Allow" as const,
            Action: ["dynamodb:PutItem"],
            Resource: [tableArn],
          },
        ]),
      },
      { parent: this },
    );

    this.certExpiryConsumer = new QueueConsumer(
      `${name}-cert-expiry`,
      {
        env,
        busName: args.platformBusName,
        busArn: args.platformBusArn,
        ruleName: `boxalarm-${env}-notification-cert-expiry-due`,
        eventPattern: JSON.stringify({
          source: ["training-service"],
          "detail-type": ["cert.expiry.due", "training.expiry.due"],
        }),
        queueName: `boxalarm-${env}-notification-cert-expiry-queue`,
        lambda: this.certExpiryConsumerLambda.function,
        lambdaRole: this.certExpiryConsumerLambda.role,
        maxReceiveCount: 5,
      },
      { parent: this },
    );

    // digestJob.ts: GSI3 Query (the day's DIGEST_PENDING rows, and the MEMBER roster for
    // TRAINING officers); GetItem (member METADATA email, NOTIFPREF mutes); PutItem (the
    // DIGESTSENT claim — a one-item TransactWrite — and the NOTIFICATION inbox row);
    // DeleteItem (releasing the claim when a send or inbox write fails).
    this.digestLambda = new ServiceLambda(
      `${name}-digest-job`,
      {
        env,
        serviceName: "notification-service",
        functionName: `boxalarm-${env}-notification-digest-job`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("notification-service", "digest-job"),
        logGroup: args.logGroup,
        // Recipients are processed sequentially (claim, reads, push, email, inbox write).
        timeout: 300,
        environment: {
          PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
          NOTIFICATION_PUSH_TOPIC_ARN: this.pushTopic.arn,
          NOTIFICATION_SES_FROM_ADDRESS: args.sesFromAddress,
        },
        additionalPolicyStatements: pulumi
          .all([
            args.platformTableArn,
            this.pushTopic.arn,
            args.sesFromAddress,
            region.name,
            caller.accountId,
          ])
          .apply(([tableArn, topicArn, fromAddress, regionName, accountId]) => {
            const domain = fromAddress.split("@")[1] ?? fromAddress;
            const identity = `arn:aws:ses:${regionName}:${accountId}:identity`;
            return [
              {
                Sid: "NotificationDigestQuery" as const,
                Effect: "Allow" as const,
                Action: ["dynamodb:Query"],
                Resource: [`${tableArn}/index/GSI3`],
              },
              {
                Sid: "NotificationDigestTableAccess" as const,
                Effect: "Allow" as const,
                Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
                Resource: [tableArn],
              },
              auditMutationDenyStatement(tableArn),
              {
                Sid: "NotificationPushPublish" as const,
                Effect: "Allow" as const,
                Action: ["sns:Publish"],
                Resource: [topicArn],
              },
              {
                // SES authorizes SendEmail against the sending identity: the address
                // itself, or its domain when the domain is the verified identity.
                Sid: "NotificationEmailSend" as const,
                Effect: "Allow" as const,
                Action: ["ses:SendEmail"],
                Resource: [`${identity}/${fromAddress}`, `${identity}/${domain}`],
              },
            ];
          }),
      },
      { parent: this },
    );

    this.digestDlq = new aws.sqs.Queue(
      `${name}-digest-dlq`,
      { name: `boxalarm-${env}-notification-digest-dlq` },
      { parent: this },
    );

    this.digestDlqAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-digest-dlq-depth-alarm`,
      {
        name: `boxalarm-${env}-notification-digest-dlq-depth`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensions: { QueueName: this.digestDlq.name },
        statistic: "Maximum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
      },
      { parent: this },
    );

    this.digestErrorsAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-digest-errors-alarm`,
      {
        name: `boxalarm-${env}-notification-digest-errors`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: { FunctionName: this.digestLambda.function.name },
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
      },
      { parent: this },
    );

    // digestJob.ts catches a single recipient's failure, logs it, emits
    // DigestRecipientFailed and moves on — the invocation still succeeds, so neither the
    // Errors alarm nor the DLQ would ever see a member whose digest was dropped.
    this.digestRecipientFailedAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-digest-recipient-failed-alarm`,
      {
        name: `boxalarm-${env}-notification-digest-recipient-failed`,
        namespace: DIGEST_METRIC_NAMESPACE,
        metricName: "DigestRecipientFailed",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
      },
      { parent: this },
    );

    const schedulerRole = new aws.iam.Role(
      `${name}-digest-scheduler-role`,
      {
        name: `boxalarm-${env}-notification-digest-scheduler`,
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "scheduler.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-digest-scheduler-role-policy`,
      {
        role: schedulerRole.id,
        policy: pulumi
          .all([this.digestLambda.function.arn, this.digestDlq.arn])
          .apply(([lambdaArn, dlqArn]) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "InvokeNotificationDigest",
                  Effect: "Allow",
                  Action: "lambda:InvokeFunction",
                  Resource: lambdaArn,
                },
                {
                  Sid: "NotificationDigestSchedulerDlq",
                  Effect: "Allow",
                  Action: "sqs:SendMessage",
                  Resource: dlqArn,
                },
              ],
            }),
          ),
      },
      { parent: this },
    );

    // digestJob.ts takes {deptId} as its whole event and rejects anything else. Retries
    // are safe: each recipient's DIGESTSENT claim makes a second same-day run a no-op for
    // anyone already sent.
    this.digestSchedule = new aws.scheduler.Schedule(
      `${name}-digest-schedule`,
      {
        name: `boxalarm-${env}-notification-digest-daily`,
        scheduleExpression: DIGEST_SCHEDULE_EXPRESSION,
        scheduleExpressionTimezone: "UTC",
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: this.digestLambda.function.arn,
          roleArn: schedulerRole.arn,
          input: JSON.stringify({ deptId: args.deptId }),
          retryPolicy: { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 3600 },
          deadLetterConfig: { arn: this.digestDlq.arn },
        },
      },
      { parent: this },
    );

    this.registerOutputs({
      pushTopic: this.pushTopic,
      certExpiryConsumerLambda: this.certExpiryConsumerLambda,
      digestLambda: this.digestLambda,
    });
  }
}
