import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";
import { ALERTING_CHANNELS, AlertingChannel, ChannelQueue } from "./messaging-alerting";

const NON_PROD_ENVS = new Set(["dev", "qa", "staging"]);

export interface AlertingAlarmsArgs {
  env: string;
  channelQueues: Record<AlertingChannel, ChannelQueue>;
  fanOutFunctionName: pulumi.Input<string>;
  /** Fan-out stream ESM on-failure destination — a record here is a dispatch nobody was paged for. */
  fanOutOnFailureQueue: aws.sqs.Queue;
  escalationFunctionName: pulumi.Input<string>;
  toneEvaluatorFunctionName: pulumi.Input<string>;
  /** Async on-failure destination of escalation + tone evaluator — a record is a lost page. */
  escalationOnFailureQueue: aws.sqs.Queue;
  memberUpdatedDlq: aws.sqs.Queue;
  memberUpdatedFunctionName: pulumi.Input<string>;
}

/** Stack config key for the alerting-page email subscription. */
export const ALERTING_PAGE_EMAIL_CONFIG_KEY = "alertingPageEmail";

/**
 * Alerting-plane paging (E1-S11-INFRA): a dedicated standard SNS topic
 * (`alerting-page`, distinct from the FIFO delivery topic) that every alerting alarm
 * pages through, an alarm on every alert-path failure mode, and a per-channel
 * fault-injection SSM switch present in dev/qa/staging only (never prod).
 *
 * The page subscription is config-driven (`boxalarm-infra:alertingPageEmail`). Who carries
 * the pager is still open (#5), so this is a mechanism, not the final on-call route. It is
 * REQUIRED in prod — a prod stack whose alerting alarms page nobody fails preview — and
 * warned about at preview/up time in every other stack.
 */
/**
 * What a message in each channel DLQ means. Every page in a DLQ failed all its attempts. The
 * push text names the configuration faults that deliberately dead-letter instead of being
 * swallowed (review minor 2): a misconfigured stack must page, not fail quietly.
 */
const DLQ_ALARM_DESCRIPTION: Record<AlertingChannel, string> = {
  push:
    "A push page failed every attempt and was dead-lettered; the member got no push for that tone (SMS runs in parallel). " +
    "Check the push worker logs (alerting.channel.send_failed) for the gateway reason. Configuration faults dead-letter on purpose: " +
    "APNs DeviceTokenNotForTopic/BadTopic/TopicDisallowed (bundleId in the APNs secret does not match the app), " +
    "FCM SENDER_ID_MISMATCH (service account from a different Firebase project than the app), credentials still refused after the in-process retry " +
    "(rotated/revoked .p8 key or service account), a mass token invalidation being blocked (APNs secret environment does not match the app builds), " +
    "or an unset push secret. Fix the secret, then redrive the DLQ.",
  sms: "An SMS page failed every attempt and was dead-lettered; the member got no SMS for that tone. Check the sms worker logs (alerting.channel.send_failed), fix the provider, then redrive the DLQ.",
  voice:
    "A voice escalation failed every attempt and was dead-lettered; the member got no call for that tone. Check the voice worker logs (alerting.channel.send_failed), fix the provider, then redrive the DLQ.",
};

export class AlertingAlarms extends pulumi.ComponentResource {
  public readonly pageTopic: aws.sns.Topic;
  public readonly pageSubscription?: aws.sns.TopicSubscription;
  public readonly faultInjectionParameters: Partial<Record<AlertingChannel, aws.ssm.Parameter>>;

  constructor(name: string, args: AlertingAlarmsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AlertingAlarms", args.env);
    super("boxalarm:alerting:AlertingAlarms", name, {}, opts);
    const { env } = args;

    this.pageTopic = new aws.sns.Topic(
      `${name}-page-topic`,
      { name: `boxalarm-${env}-alerting-page` },
      { parent: this },
    );

    const pageEmail = new pulumi.Config("boxalarm-infra").get(ALERTING_PAGE_EMAIL_CONFIG_KEY);
    if (pageEmail) {
      this.pageSubscription = new aws.sns.TopicSubscription(
        `${name}-page-email-subscription`,
        { topic: this.pageTopic.arn, protocol: "email", endpoint: pageEmail },
        { parent: this },
      );
    } else if (env === "prod") {
      throw new Error(
        `AlertingAlarms: boxalarm-infra:${ALERTING_PAGE_EMAIL_CONFIG_KEY} is required in prod — ` +
          `without it boxalarm-prod-alerting-page has no subscription and every alerting ` +
          `alarm pages nobody. Set it with \`pulumi config set ${ALERTING_PAGE_EMAIL_CONFIG_KEY} ` +
          `<address> --stack prod\`.`,
      );
    } else {
      pulumi.log.warn(
        `AlertingAlarms: boxalarm-infra:${ALERTING_PAGE_EMAIL_CONFIG_KEY} is not set — ` +
          `boxalarm-${env}-alerting-page has no subscription, so every alerting alarm fires ` +
          `into the void. Set it, or confirm on-call routing is subscribed out-of-band.`,
        this,
      );
    }

    const pageAlarm = (
      key: string,
      alarm: Omit<aws.cloudwatch.MetricAlarmArgs, "alarmActions" | "treatMissingData">,
    ): aws.cloudwatch.MetricAlarm =>
      new aws.cloudwatch.MetricAlarm(
        `${name}-${key}`,
        { ...alarm, treatMissingData: "notBreaching", alarmActions: [this.pageTopic.arn] },
        { parent: this },
      );

    const lambdaAlarm = (
      key: string,
      functionName: pulumi.Input<string>,
      metricName: "Errors" | "Throttles",
      alarmName: string,
    ) =>
      pageAlarm(key, {
        name: alarmName,
        namespace: "AWS/Lambda",
        metricName,
        dimensions: { FunctionName: functionName },
        statistic: "Sum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 0,
        period: 60,
        evaluationPeriods: 1,
      });

    // Fan-out: Errors, a stuck stream (IteratorAge), and any record that exhausted its
    // retries into the on-failure queue — each is a dispatch that may have paged nobody.
    lambdaAlarm(
      "fan-out-errors-alarm",
      args.fanOutFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-fan-out-errors`,
    );
    pageAlarm("fan-out-iterator-age-alarm", {
      name: `boxalarm-${env}-alerting-fan-out-iterator-age`,
      namespace: "AWS/Lambda",
      metricName: "IteratorAge",
      dimensions: { FunctionName: args.fanOutFunctionName },
      statistic: "Maximum",
      comparisonOperator: "GreaterThanThreshold",
      // 60s: a DISPATCH_ALERT unprocessed for a minute is already a missed tone-out.
      threshold: 60_000,
      period: 60,
      evaluationPeriods: 1,
    });
    pageAlarm("fan-out-onfailure-alarm", {
      name: `boxalarm-${env}-alerting-fan-out-onfailure-not-empty`,
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: args.fanOutOnFailureQueue.name },
      statistic: "Maximum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });

    // Escalation and tone-evaluator are invoked async by EventBridge Scheduler. After Lambda's
    // retries a failed event lands in the on-failure queue (escalation.ts); any message there
    // is a tone, voice escalation or mutual-aid request that did not complete.
    pageAlarm("escalation-onfailure-alarm", {
      name: `boxalarm-${env}-alerting-escalation-onfailure`,
      alarmDescription:
        "A voice escalation, tone 2/3 or mutual-aid request did not complete. Runbook: docs/runbooks/alerting-escalation-onfailure.md (redrive: infrastructure/scripts/redrive-escalation-onfailure.sh).",
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: args.escalationOnFailureQueue.name },
      statistic: "Maximum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });
    lambdaAlarm(
      "escalation-errors-alarm",
      args.escalationFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-escalation-errors`,
    );
    lambdaAlarm(
      "escalation-throttles-alarm",
      args.escalationFunctionName,
      "Throttles",
      `boxalarm-${env}-alerting-escalation-throttles`,
    );
    lambdaAlarm(
      "tone-evaluator-errors-alarm",
      args.toneEvaluatorFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-tone-evaluator-errors`,
    );
    lambdaAlarm(
      "tone-evaluator-throttles-alarm",
      args.toneEvaluatorFunctionName,
      "Throttles",
      `boxalarm-${env}-alerting-tone-evaluator-throttles`,
    );

    // A lost personnel.member.updated event means a member silently stops getting push.
    // (Replaces push-tokens' action-less member-updated-dlq-depth alarm; new physical name
    // so replacing it cannot delete the new alarm by name.)
    pageAlarm("member-updated-dlq-alarm", {
      name: `boxalarm-${env}-alerting-member-updated-dlq-not-empty`,
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: args.memberUpdatedDlq.name },
      statistic: "Maximum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });

    // The consumer throws on a bad record or a DynamoDB failure; the DLQ alarm only fires
    // after 5 receives, so page on the errors themselves too.
    lambdaAlarm(
      "member-updated-errors-alarm",
      args.memberUpdatedFunctionName,
      "Errors",
      `boxalarm-${env}-alerting-member-updated-consumer-errors`,
    );

    // Push token invalidations (review M3). APNs answers BadDeviceToken both for a dead token
    // and for one sent to the wrong APNs environment, so a burst of invalidations usually means
    // the stack's APNs secret `environment` (or bundle id) does not match the installed app
    // builds, not that members' phones died. Past 3 distinct tokens in the current and previous
    // 5-minute windows the worker trips a 1-hour latch: no further invalidations, and those
    // pages throw instead (MassInvalidationBlocked). Both are paged.
    pageAlarm("push-token-invalid-rate-alarm", {
      name: `boxalarm-${env}-alerting-push-token-invalid-rate`,
      alarmDescription:
        "More than 3 push tokens were rejected as invalid in 5 minutes. Usually a push gateway misconfiguration, not dead devices: check the APNs secret's environment (production for TestFlight/App Store builds, sandbox for Xcode-installed builds) and bundleId, and the FCM service account's project. Members whose token was invalidated get push again after re-opening the app.",
      namespace: "Boxalarm/AlertingChannel",
      metricName: "TokenInvalid",
      // deliverChannelMessage emits emitOutcomeMetric(ns, "TokenInvalid", "push") → Reason=push.
      dimensions: { Reason: "push" },
      statistic: "Sum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 3,
      period: 300,
      evaluationPeriods: 1,
    });
    pageAlarm("push-mass-invalidation-blocked-alarm", {
      name: `boxalarm-${env}-alerting-push-mass-invalidation-blocked`,
      alarmDescription:
        "The push worker refused to invalidate more device tokens (too many rejected at once) and is failing those pages instead. Fix the push gateway configuration (APNs environment/bundleId, FCM project); pages will retry and dead-letter until then. SMS still pages in parallel.",
      namespace: "Boxalarm/AlertingChannel",
      metricName: "MassInvalidationBlocked",
      dimensions: { Reason: "push" },
      statistic: "Sum",
      comparisonOperator: "GreaterThanThreshold",
      threshold: 0,
      period: 60,
      evaluationPeriods: 1,
    });

    for (const channel of ALERTING_CHANNELS) {
      const dlq = args.channelQueues[channel].dlq;

      // A worker that is consuming but stuck (hung vendor call) before anything reaches
      // the DLQ. A healthy queue never holds a message this long.
      pageAlarm(`${channel}-oldest-message-alarm`, {
        name: `boxalarm-${env}-alerting-${channel}-oldest-message-age`,
        namespace: "AWS/SQS",
        metricName: "ApproximateAgeOfOldestMessage",
        dimensions: { QueueName: args.channelQueues[channel].queue.name },
        statistic: "Maximum",
        comparisonOperator: "GreaterThanThreshold",
        threshold: 120,
        period: 60,
        evaluationPeriods: 2,
      });

      new aws.cloudwatch.MetricAlarm(
        `${name}-${channel}-dlq-alarm`,
        {
          name: `boxalarm-${env}-alerting-${channel}-dlq-not-empty`,
          alarmDescription: DLQ_ALARM_DESCRIPTION[channel],
          namespace: "AWS/SQS",
          metricName: "ApproximateNumberOfMessagesVisible",
          dimensions: { QueueName: dlq.name },
          statistic: "Maximum",
          comparisonOperator: "GreaterThanThreshold",
          threshold: 0,
          period: 60,
          evaluationPeriods: 1,
          treatMissingData: "notBreaching",
          alarmActions: [this.pageTopic.arn],
        },
        { parent: this },
      );

      new aws.cloudwatch.MetricAlarm(
        `${name}-${channel}-delivery-failure-alarm`,
        {
          name: `boxalarm-${env}-alerting-${channel}-delivery-failure-rate`,
          namespace: `Boxalarm/AlertingChannel`,
          metricName: "SendFailed",
          // Cross-seam contract: deliverChannelMessage.ts emits
          // emitOutcomeMetric("Boxalarm/AlertingChannel", "SendFailed", channel), and
          // @boxalarm/metrics publishes that reason under the `Reason` dimension (dimension
          // sets [] and ["Reason"]). There is no `channel` dimension — alarming on one
          // matched no series, so this alarm could never fire.
          dimensions: { Reason: channel },
          statistic: "Sum",
          comparisonOperator: "GreaterThanThreshold",
          threshold: 0,
          period: 60,
          evaluationPeriods: 1,
          treatMissingData: "notBreaching",
          alarmActions: [this.pageTopic.arn],
        },
        { parent: this },
      );
    }

    this.faultInjectionParameters = NON_PROD_ENVS.has(env)
      ? Object.fromEntries(
          ALERTING_CHANNELS.map((channel) => [
            channel,
            new aws.ssm.Parameter(
              `${name}-${channel}-fault-injection`,
              {
                name: `/boxalarm/${env}/alerting/${channel}/fault-injection`,
                type: "String",
                value: "off",
                description: `Non-prod fault-injection switch for the ${channel} worker`,
              },
              { parent: this },
            ),
          ]),
        )
      : {};

    this.registerOutputs({ pageTopic: this.pageTopic });
  }
}
