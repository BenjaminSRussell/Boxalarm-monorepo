import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import {
  ALERT_PATH_MEMORY_MB,
  ALERTING_CHANNELS,
  AlertingChannel,
  ChannelQueue,
  DEFAULT_WORKER_TIMEOUT_SECONDS,
} from "./messaging-alerting";
import { grantAlertingCmk } from "./alerting-cmk";

/** Channels still on the generic HTTP vendor adapter (channels/httpProviderAdapter.ts). */
type VendorChannel = Exclude<AlertingChannel, "push">;

// OQ-3 (SMS/voice vendor selection) is open — placeholder endpoints until a vendor is
// chosen. Values are read verbatim by channels/httpProviderAdapter.ts at send time, which
// POSTs the member's target, the dispatch narrative and the Bearer provider secret. The
// placeholders therefore use the RFC 2606 reserved `.invalid` TLD, which can never resolve,
// so nothing is ever sent to a domain the project does not control. Push has no endpoint:
// it goes to APNs and FCM directly (see PushGatewaySecrets).
const PLACEHOLDER_ENDPOINT_URL: Record<VendorChannel, string> = {
  sms: "https://sms-provider.not-yet-selected.invalid",
  voice: "https://voice-provider.not-yet-selected.invalid",
};

/**
 * Push gateway credentials (architecture §Alerting: "Push uses APNs/FCM directly"). Values are
 * set out-of-band; the push worker (channels/push/pushCredentials.ts) reads them as JSON.
 *
 * APNs (`apns`, `apnsSandbox`) — token-based auth with an Apple .p8 key:
 *   {
 *     "teamId": "ABCDE12345",             // Apple Developer Team ID
 *     "keyId": "KEY1234567",              // APNs auth key ID
 *     "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
 *     "bundleId": "org.example.boxalarm", // apns-topic
 *     "environment": "production",        // optional; "sandbox" for dev-signed app builds
 *     "interruptionLevel": "critical"     // optional; "time-sensitive" until the Critical
 *   }                                     //   Alerts entitlement (#4) is granted
 *   The sandbox secret always targets api.sandbox.push.apple.com and is refused if it
 *   declares "production".
 *
 * FCM (`fcm`, `fcmSandbox`) — the Firebase service-account key JSON exactly as downloaded
 * (project_id, private_key_id, private_key, client_email, ...), for a service account with
 * the Firebase Cloud Messaging API Admin role. Sandbox sends are `validate_only`.
 *
 * Self-test and canary messages (isTest) read only the sandbox secrets and fail closed when
 * one is unset (architecture §1.3).
 */
export interface PushGatewaySecrets {
  apns: aws.secretsmanager.Secret;
  apnsSandbox: aws.secretsmanager.Secret;
  fcm: aws.secretsmanager.Secret;
  fcmSandbox: aws.secretsmanager.Secret;
}

/**
 * Reserved concurrency per channel worker. The SQS event source mapping's
 * maximumConcurrency is pinned to the same value: when pollers outrun reserved concurrency
 * the invocations are throttled, and each throttled receive counts toward maxReceiveCount,
 * pushing pages to the DLQ early.
 */
export const WORKER_RESERVED_CONCURRENCY = 5;

export interface ChannelWorkersArgs {
  env: string;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  channelQueues: Record<AlertingChannel, ChannelQueue>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
  /** Must match the value MessagingAlerting sized the queue visibility timeout from. */
  workerTimeoutSeconds?: number;
}

/**
 * Push/SMS/voice channel worker Lambdas (E1-S2/S3-INFRA). Each has its own queue, DLQ,
 * reserved concurrency and provider secrets — no worker can read another channel's queue
 * or secret (E1-S11-INFRA isolation). SMS/voice get `{CH}_PROVIDER_*` for the generic
 * vendor adapter; push gets the APNs/FCM gateway secrets. Self-test sandbox secrets
 * (E1-S8-INFRA) are provisioned alongside every production secret; the worker selects them
 * for `isTest` messages.
 */
export class ChannelWorkers extends pulumi.ComponentResource {
  public readonly workers: Record<AlertingChannel, ServiceLambda>;
  public readonly providerSecrets: Record<VendorChannel, aws.secretsmanager.Secret>;
  public readonly sandboxSecrets: Record<VendorChannel, aws.secretsmanager.Secret>;
  public readonly pushSecrets: PushGatewaySecrets;

  constructor(name: string, args: ChannelWorkersArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("ChannelWorkers", args.env);
    super("boxalarm:alerting:ChannelWorkers", name, {}, opts);
    const { env } = args;

    const workers: Partial<Record<AlertingChannel, ServiceLambda>> = {};
    const providerSecrets: Partial<Record<VendorChannel, aws.secretsmanager.Secret>> = {};
    const sandboxSecrets: Partial<Record<VendorChannel, aws.secretsmanager.Secret>> = {};

    const pushSecret = (key: string, description: string) =>
      new aws.secretsmanager.Secret(
        `${name}-push-${key}-secret`,
        { name: `boxalarm-${env}-alerting-push-${key}-credentials`, description },
        { parent: this },
      );
    const pushSecrets: PushGatewaySecrets = {
      apns: pushSecret("apns", "APNs .p8 token-auth key (values set out-of-band)"),
      apnsSandbox: pushSecret(
        "apns-sandbox",
        "APNs sandbox credentials for self-test/canary (E1-S8)",
      ),
      fcm: pushSecret("fcm", "FCM service-account JSON (values set out-of-band)"),
      fcmSandbox: pushSecret(
        "fcm-sandbox",
        "FCM service-account JSON for validate_only self-test/canary (E1-S8)",
      ),
    };

    for (const channel of ALERTING_CHANNELS) {
      const queue = args.channelQueues[channel].queue;
      const credentials =
        channel === "push"
          ? pushWorkerCredentials(pushSecrets)
          : vendorWorkerCredentials(this, name, env, channel, providerSecrets, sandboxSecrets);

      const worker = new ServiceLambda(
        `${name}-${channel}-fn`,
        {
          env,
          serviceName: "alerting-service",
          functionName: `boxalarm-${env}-alerting-${channel}-worker`,
          handler: LAMBDA_HANDLER,
          code: lambdaCode("alerting-service", `${channel}-worker`),
          logGroup: args.logGroup,
          environment: {
            ALERTING_TABLE_NAME: args.alertingTableName,
            ...credentials.environment,
          },
          additionalPolicyStatements: pulumi
            .all([pulumi.all(credentials.secretArns), queue.arn])
            .apply(([secretArns, queueArn]) => [
              {
                // The SQS event source mapping polls as this role; without these,
                // CreateEventSourceMapping is rejected and the channel never drains.
                Sid: "ConsumeOwnChannelQueueOnly",
                Effect: "Allow" as const,
                Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
                Resource: queueArn,
              },
              {
                Sid: "AlertingTableWrite",
                Effect: "Allow" as const,
                Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"],
                Resource: args.alertingTableArn as string,
              },
              {
                Sid: "OwnProviderSecretOnly",
                Effect: "Allow" as const,
                Action: ["secretsmanager:GetSecretValue"],
                Resource: secretArns,
              },
            ]),
          reservedConcurrentExecutions: WORKER_RESERVED_CONCURRENCY,
          timeout: args.workerTimeoutSeconds ?? DEFAULT_WORKER_TIMEOUT_SECONDS,
          memorySize: ALERT_PATH_MEMORY_MB,
          permissionsBoundaryArn: args.permissionsBoundaryArn,
        },
        { parent: this },
      );

      new aws.lambda.EventSourceMapping(
        `${name}-${channel}-event-source`,
        {
          eventSourceArn: queue.arn,
          functionName: worker.function.name,
          functionResponseTypes: ["ReportBatchItemFailures"],
          scalingConfig: { maximumConcurrency: WORKER_RESERVED_CONCURRENCY },
        },
        { parent: this },
      );

      workers[channel] = worker;
    }

    this.workers = workers as Record<AlertingChannel, ServiceLambda>;
    this.providerSecrets = providerSecrets as Record<VendorChannel, aws.secretsmanager.Secret>;
    this.sandboxSecrets = sandboxSecrets as Record<VendorChannel, aws.secretsmanager.Secret>;
    this.pushSecrets = pushSecrets;

    grantAlertingCmk(
      name,
      Object.fromEntries(ALERTING_CHANNELS.map((channel) => [channel, this.workers[channel].role])),
      args.alertingCmkArn,
      { parent: this },
    );

    this.registerOutputs({ workers: this.workers });
  }
}

interface WorkerCredentials {
  environment: Record<string, pulumi.Input<string>>;
  /** Exactly the secrets this worker may read — nothing else. */
  secretArns: pulumi.Input<string>[];
}

/** Push: APNs + FCM gateway secrets and their sandbox twins; no vendor endpoint. */
function pushWorkerCredentials(secrets: PushGatewaySecrets): WorkerCredentials {
  return {
    environment: {
      APNS_SECRET_ID: secrets.apns.name,
      FCM_SECRET_ID: secrets.fcm.name,
      // Self-test and canary messages (isTest=true) must use the sandbox credentials, never
      // the prod ones (architecture §1.3).
      APNS_SANDBOX_SECRET_ID: secrets.apnsSandbox.name,
      FCM_SANDBOX_SECRET_ID: secrets.fcmSandbox.name,
    },
    secretArns: [
      secrets.apns.arn,
      secrets.apnsSandbox.arn,
      secrets.fcm.arn,
      secrets.fcmSandbox.arn,
    ],
  };
}

function vendorWorkerCredentials(
  parent: pulumi.Resource,
  name: string,
  env: string,
  channel: VendorChannel,
  providerSecrets: Partial<Record<VendorChannel, aws.secretsmanager.Secret>>,
  sandboxSecrets: Partial<Record<VendorChannel, aws.secretsmanager.Secret>>,
): WorkerCredentials {
  const providerSecret = new aws.secretsmanager.Secret(
    `${name}-${channel}-secret`,
    {
      name: `boxalarm-${env}-alerting-${channel}-provider-credentials`,
      description: `${channel} provider credentials (values set out-of-band)`,
    },
    { parent },
  );
  const sandboxSecret = new aws.secretsmanager.Secret(
    `${name}-${channel}-sandbox-secret`,
    {
      name: `boxalarm-${env}-alerting-${channel}-provider-sandbox-credentials`,
      description: `${channel} provider sandbox/loopback credentials for self-test (E1-S8)`,
    },
    { parent },
  );
  providerSecrets[channel] = providerSecret;
  sandboxSecrets[channel] = sandboxSecret;
  const channelUpper = channel.toUpperCase();
  return {
    environment: {
      [`${channelUpper}_PROVIDER_ENDPOINT_URL`]: PLACEHOLDER_ENDPOINT_URL[channel],
      [`${channelUpper}_PROVIDER_SECRET_ID`]: providerSecret.name,
      // Self-test and canary messages (isTest=true) must authenticate with the
      // sandbox/loopback credentials, never the prod ones (architecture §1.3).
      [`${channelUpper}_PROVIDER_SANDBOX_SECRET_ID`]: sandboxSecret.name,
    },
    secretArns: [providerSecret.arn, sandboxSecret.arn],
  };
}
