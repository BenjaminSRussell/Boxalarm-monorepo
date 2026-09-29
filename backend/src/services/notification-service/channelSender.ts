import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import AWSXRay from 'aws-xray-sdk-core';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import {
  categoryConfig,
  CERT_EXPIRY_CATEGORY,
  itemLine,
  type DigestNotificationItem,
} from './reminders/categories.js';

export const CERT_EXPIRY_DIGEST_CHANNEL_ID = categoryConfig(CERT_EXPIRY_CATEGORY).pushChannelId;
const METRIC_NAMESPACE = 'Boxalarm/NotificationDigest';

function logSkip(event: string, correlationId: string, extra: Record<string, unknown>): void {
  console.error(
    JSON.stringify({ event, service: 'notification-service', correlationId, ...extra }),
  );
}

export interface DigestRecipient {
  readonly memberId: string;
  readonly email?: string | undefined;
}

export interface ChannelSenderConfig {
  readonly pushTopicArn?: string | undefined;
  readonly sesFromAddress?: string | undefined;
}

export function readChannelSenderConfig(env: NodeJS.ProcessEnv): ChannelSenderConfig {
  return {
    pushTopicArn: env.NOTIFICATION_PUSH_TOPIC_ARN,
    sesFromAddress: env.NOTIFICATION_SES_FROM_ADDRESS,
  };
}

let cachedSnsClient: SNSClient | undefined;
let cachedSesClient: SESv2Client | undefined;

export function createSnsClient(client?: SNSClient): SNSClient {
  cachedSnsClient ??= client ?? AWSXRay.captureAWSv3Client(new SNSClient({}));
  return cachedSnsClient;
}

export function createSesClient(client?: SESv2Client): SESv2Client {
  cachedSesClient ??= client ?? AWSXRay.captureAWSv3Client(new SESv2Client({}));
  return cachedSesClient;
}

export async function sendPushDigest(
  env: NodeJS.ProcessEnv,
  recipient: DigestRecipient,
  items: readonly DigestNotificationItem[],
  correlationId: string,
  client?: SNSClient,
  category: string = CERT_EXPIRY_CATEGORY,
): Promise<void> {
  const { pushTopicArn } = readChannelSenderConfig(env);
  if (!pushTopicArn) {
    throw new Error('NOTIFICATION_PUSH_TOPIC_ARN is required and was not set');
  }
  const config = categoryConfig(category);
  const sns = createSnsClient(client);
  await sns.send(
    new PublishCommand({
      TopicArn: pushTopicArn,
      Message: JSON.stringify({
        channelId: config.pushChannelId,
        memberId: recipient.memberId,
        notificationCategory: category,
        // The mobile app routes anything but an explicit 'digest' to its DND-bypassing
        // dispatch channel (pushChannel.ts categoryFromPushData); every reminder is 'digest'.
        category: 'digest',
        interruptionLevel: 'active',
        title: config.subject(items.length),
        body: items.map(itemLine).join('\n'),
        items,
        correlationId,
      }),
      MessageAttributes: {
        channelId: { DataType: 'String', StringValue: config.pushChannelId },
        memberId: { DataType: 'String', StringValue: recipient.memberId },
      },
    }),
  );
}

export async function sendEmailDigest(
  env: NodeJS.ProcessEnv,
  recipient: DigestRecipient,
  items: readonly DigestNotificationItem[],
  correlationId: string,
  client?: SESv2Client,
  category: string = CERT_EXPIRY_CATEGORY,
): Promise<void> {
  const { sesFromAddress } = readChannelSenderConfig(env);
  if (!sesFromAddress) {
    throw new Error('NOTIFICATION_SES_FROM_ADDRESS is required and was not set');
  }
  if (!recipient.email) {
    logSkip('notification.channel.email_skipped_no_address', correlationId, {
      memberId: recipient.memberId,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'EmailDigestSkippedNoAddress');
    return;
  }
  const ses = createSesClient(client);
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: sesFromAddress,
      Destination: { ToAddresses: [recipient.email] },
      Content: {
        Simple: {
          Subject: { Data: categoryConfig(category).subject(items.length) },
          Body: {
            Text: {
              Data: `${items.map(itemLine).join('\n')}\ncorrelationId:${correlationId}`,
            },
          },
        },
      },
    }),
  );
}
