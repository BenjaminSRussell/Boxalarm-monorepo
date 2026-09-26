import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";

export interface DailyScannerResources {
  schedule: aws.scheduler.Schedule;
  dlq: aws.sqs.Queue;
  dlqAlarm: aws.cloudwatch.MetricAlarm;
  errorsAlarm: aws.cloudwatch.MetricAlarm;
}

/**
 * Daily EventBridge Scheduler trigger for an inventory scanner Lambda, with the same
 * failure handling as training's cert-expiry scanner (certifications.ts): 3 retries,
 * a DLQ the scheduler role can write, a DLQ-depth alarm and a Lambda Errors alarm, so a
 * failing run (the scanners rethrow on any scan/publish failure) never goes unnoticed.
 *
 * `baseName` is the resource-name stem, e.g. "inventory-ppe-expiry-scanner", producing
 * boxalarm-{env}-{baseName}-daily / -dlq / -dlq-depth / -errors / -scheduler.
 *
 * The scanners' handlers take a ScheduledEvent and use `event.id` as their correlationId.
 * A Scheduler Lambda target receives only `input`, so the execution id is passed as `id`
 * via Scheduler's context-attribute substitution rather than leaving it undefined.
 */
export function dailyScanner(
  parent: pulumi.ComponentResource,
  name: string,
  env: string,
  baseName: string,
  lambda: ServiceLambda,
): DailyScannerResources {
  const opts = { parent };

  const dlq = new aws.sqs.Queue(`${name}-dlq`, { name: `boxalarm-${env}-${baseName}-dlq` }, opts);

  const dlqAlarm = new aws.cloudwatch.MetricAlarm(
    `${name}-dlq-depth-alarm`,
    {
      name: `boxalarm-${env}-${baseName}-dlq-depth`,
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: dlq.name },
      statistic: "Maximum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
    },
    opts,
  );

  const errorsAlarm = new aws.cloudwatch.MetricAlarm(
    `${name}-errors-alarm`,
    {
      name: `boxalarm-${env}-${baseName}-errors`,
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
    opts,
  );

  const schedulerRole = new aws.iam.Role(
    `${name}-scheduler-role`,
    {
      name: `boxalarm-${env}-${baseName}-scheduler`,
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
    opts,
  );

  new aws.iam.RolePolicy(
    `${name}-scheduler-role-policy`,
    {
      role: schedulerRole.id,
      policy: pulumi.all([lambda.function.arn, dlq.arn]).apply(([lambdaArn, dlqArn]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "InvokeScanner",
              Effect: "Allow",
              Action: "lambda:InvokeFunction",
              Resource: lambdaArn,
            },
            { Sid: "SchedulerDlq", Effect: "Allow", Action: "sqs:SendMessage", Resource: dlqArn },
          ],
        }),
      ),
    },
    opts,
  );

  const schedule = new aws.scheduler.Schedule(
    `${name}-schedule`,
    {
      name: `boxalarm-${env}-${baseName}-daily`,
      scheduleExpression: "rate(1 day)",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: lambda.function.arn,
        roleArn: schedulerRole.arn,
        input: JSON.stringify({ id: "<aws.scheduler.execution-id>" }),
        retryPolicy: { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 3600 },
        deadLetterConfig: { arn: dlq.arn },
      },
    },
    opts,
  );

  return { schedule, dlq, dlqAlarm, errorsAlarm };
}
