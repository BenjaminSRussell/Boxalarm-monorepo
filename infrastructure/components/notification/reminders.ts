import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { QueueConsumer } from "../messaging/queue-consumer";
import { IamPolicyStatement } from "../observability/observability-policy";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface RemindersArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  platformBusName: pulumi.Input<string>;
  platformBusArn: pulumi.Input<string>;
  /** Digest's notification-owned standard topic; the only topic any consumer publishes to. */
  pushTopicArn: pulumi.Input<string>;
  /** Verified SES sender (digest.ts's); the defect consumer emails out-of-service units at once. */
  sesFromAddress: pulumi.Input<string>;
  /**
   * The chief's LOB notification topic (shared/chief-notifications.ts). An out-of-service
   * unit with nobody to tell pages the chief through it — never the alerting page topic.
   */
  chiefNotificationTopicArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
}

/** The metric namespace notification-service's consumers and digest emit into (EMF). */
const NOTIFICATION_METRIC_NAMESPACE = "Boxalarm/NotificationDigest";

interface GrantContext {
  tableArn: string;
  topicArn: string;
  fromAddress: string;
  sesIdentityArn: string;
}

interface ReminderConsumerSpec {
  /** Resource-name stem and backend/scripts/lambda-manifest.mjs function key prefix. */
  key: string;
  source: string;
  detailTypes: string[];
  timeout: number;
  environment?: Record<string, pulumi.Input<string>>;
  statements: (ctx: GrantContext) => IamPolicyStatement[];
}

/** One TransactWrite of conditional Puts (pending rows + eventId marker): PutItem only. */
const pendingWriteOnly = ({ tableArn }: GrantContext): IamPolicyStatement[] => [
  {
    Sid: "NotificationPendingWrite",
    Effect: "Allow",
    Action: ["dynamodb:PutItem"],
    Resource: [tableArn],
  },
];

/**
 * The reminder consumers that feed notification-service's digest (digest.ts) from the
 * platform bus — each an EventBridge rule -> its own standard SQS queue + DLQ (DLQ-depth
 * alarm, capped event-source concurrency) -> a consumer Lambda holding only the platform
 * table actions its handler makes:
 *
 *   apparatus.test.due        (both apparatus scanners)  -> apparatusTestDueConsumer.ts
 *   apparatus.defect.reported (apparatus-service outbox) -> apparatusDefectConsumer.ts
 *   inventory.reorder.due     (consumable scanner)       -> inventoryReorderDueConsumer.ts
 *   ppe.expiry.due            (PPE expiry scanner)       -> ppeExpiryConsumer.ts
 *
 * The defect consumer also delivers an out-of-service defect immediately: it reads the
 * roster (GSI3) and each officer's mutes (GetItem), writes their inbox record and per-channel
 * claim markers (PutItem; DeleteItem releases a claim whose send failed), publishes to the
 * notification push topic and sends the email through SES — as digest.ts's job does.
 * Like every notification Lambda, none of them touches the alerting plane.
 */
export class Reminders extends pulumi.ComponentResource {
  public readonly consumerLambdas: Record<string, ServiceLambda> = {};
  public readonly consumers: Record<string, QueueConsumer> = {};
  public readonly outOfServiceUnheardAlarm: aws.cloudwatch.MetricAlarm;

  constructor(name: string, args: RemindersArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Reminders", args.env);
    super("boxalarm:notification:Reminders", name, {}, opts);
    const { env } = args;
    const region = aws.getRegionOutput({}, { parent: this });
    const caller = aws.getCallerIdentityOutput({}, { parent: this });

    const specs: ReminderConsumerSpec[] = [
      {
        key: "apparatus-test-due",
        source: "apparatus-service",
        detailTypes: ["apparatus.test.due"],
        timeout: 15,
        statements: pendingWriteOnly,
      },
      {
        key: "apparatus-defect",
        source: "apparatus-service",
        detailTypes: ["apparatus.defect.reported"],
        // Roster query plus a sequential inbox write + push per officer; still under the
        // queue's default 30s visibility timeout.
        timeout: 25,
        environment: {
          NOTIFICATION_PUSH_TOPIC_ARN: args.pushTopicArn,
          NOTIFICATION_SES_FROM_ADDRESS: args.sesFromAddress,
        },
        statements: ({ tableArn, topicArn, fromAddress, sesIdentityArn }) => [
          {
            Sid: "NotificationDefectTableAccess",
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
            Resource: [tableArn],
          },
          {
            Sid: "NotificationDefectRoster",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: [`${tableArn}/index/GSI3`],
          },
          auditMutationDenyStatement(tableArn),
          {
            Sid: "NotificationPushPublish",
            Effect: "Allow",
            Action: ["sns:Publish"],
            Resource: [topicArn],
          },
          {
            // SES authorizes SendEmail against the sending identity: the address itself, or
            // its domain when the domain is the verified identity (digest.ts).
            Sid: "NotificationEmailSend",
            Effect: "Allow",
            Action: ["ses:SendEmail"],
            Resource: [
              `${sesIdentityArn}/${fromAddress}`,
              `${sesIdentityArn}/${fromAddress.split("@")[1] ?? fromAddress}`,
            ],
          },
        ],
      },
      {
        key: "inventory-reorder",
        source: "inventory-service",
        detailTypes: ["inventory.reorder.due"],
        timeout: 15,
        statements: pendingWriteOnly,
      },
      {
        key: "ppe-expiry",
        source: "inventory-service",
        // inventory.expiry.due is architecture.md N-5's rename, accepted in advance.
        detailTypes: ["ppe.expiry.due", "inventory.expiry.due"],
        timeout: 15,
        statements: pendingWriteOnly,
      },
    ];

    for (const spec of specs) {
      const lambda = new ServiceLambda(
        `${name}-${spec.key}-consumer`,
        {
          env,
          serviceName: "notification-service",
          functionName: `boxalarm-${env}-notification-${spec.key}-consumer`,
          handler: LAMBDA_HANDLER,
          code: lambdaCode("notification-service", `${spec.key}-consumer`),
          logGroup: args.logGroup,
          timeout: spec.timeout,
          environment: {
            PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
            ...spec.environment,
          },
          additionalPolicyStatements: pulumi
            .all([
              args.platformTableArn,
              args.pushTopicArn,
              args.sesFromAddress,
              region.name,
              caller.accountId,
            ])
            .apply(([tableArn, topicArn, fromAddress, regionName, accountId]) =>
              spec.statements({
                tableArn,
                topicArn,
                fromAddress,
                sesIdentityArn: `arn:aws:ses:${regionName}:${accountId}:identity`,
              }),
            ),
        },
        { parent: this },
      );
      this.consumerLambdas[spec.key] = lambda;

      this.consumers[spec.key] = new QueueConsumer(
        `${name}-${spec.key}`,
        {
          env,
          busName: args.platformBusName,
          busArn: args.platformBusArn,
          ruleName: `boxalarm-${env}-notification-${spec.key}`,
          eventPattern: JSON.stringify({ source: [spec.source], "detail-type": spec.detailTypes }),
          queueName: `boxalarm-${env}-notification-${spec.key}-queue`,
          lambda: lambda.function,
          lambdaRole: lambda.role,
          maxReceiveCount: 5,
        },
        { parent: this },
      );
    }

    // apparatusDefectConsumer.ts emits ApparatusDefectImmediateNoRecipients when a unit is
    // reported out of service and no active APPARATUS or OFFICER holder exists to tell. The
    // handler succeeds, so neither the DLQ nor the Errors metric would ever show it.
    this.outOfServiceUnheardAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-oos-no-recipients-alarm`,
      {
        name: `boxalarm-${env}-notification-apparatus-oos-no-recipients`,
        alarmDescription:
          "An apparatus was reported out of service and no active APPARATUS or OFFICER member exists to notify.",
        namespace: NOTIFICATION_METRIC_NAMESPACE,
        metricName: "ApparatusDefectImmediateNoRecipients",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: [args.chiefNotificationTopicArn],
      },
      { parent: this },
    );

    this.registerOutputs({ consumerLambdas: this.consumerLambdas });
  }
}
