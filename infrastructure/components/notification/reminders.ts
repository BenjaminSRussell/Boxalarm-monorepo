import * as pulumi from "@pulumi/pulumi";
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
  logGroup: ServiceLogGroup;
}

interface ReminderConsumerSpec {
  /** Resource-name stem and backend/scripts/lambda-manifest.mjs function key prefix. */
  key: string;
  source: string;
  detailTypes: string[];
  timeout: number;
  environment?: Record<string, pulumi.Input<string>>;
  statements: (tableArn: string, topicArn: string) => IamPolicyStatement[];
}

/** One TransactWrite of conditional Puts (pending rows + eventId marker): PutItem only. */
const pendingWriteOnly = (tableArn: string): IamPolicyStatement[] => [
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
 * roster (GSI3) and each officer's mute (GetItem), writes their inbox record (PutItem,
 * DeleteItem to release it if the push fails) and publishes to the notification push topic.
 * Like every notification Lambda, none of them touches the alerting plane.
 */
export class Reminders extends pulumi.ComponentResource {
  public readonly consumerLambdas: Record<string, ServiceLambda> = {};
  public readonly consumers: Record<string, QueueConsumer> = {};

  constructor(name: string, args: RemindersArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Reminders", args.env);
    super("boxalarm:notification:Reminders", name, {}, opts);
    const { env } = args;

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
        environment: { NOTIFICATION_PUSH_TOPIC_ARN: args.pushTopicArn },
        statements: (tableArn, topicArn) => [
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
            .all([args.platformTableArn, args.pushTopicArn])
            .apply(([tableArn, topicArn]) => spec.statements(tableArn, topicArn)),
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

    this.registerOutputs({ consumerLambdas: this.consumerLambdas });
  }
}
