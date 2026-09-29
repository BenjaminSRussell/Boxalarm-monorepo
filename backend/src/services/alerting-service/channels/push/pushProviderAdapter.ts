import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createChannelSecretsClient } from '../httpProviderAdapter.js';
import { sendViaApns, type Http2Transport } from './apnsAdapter.js';
import { sendViaFcm } from './fcmAdapter.js';
import { readPushSecretId, type PushPlatform } from './pushCredentials.js';
import type { PushNotification } from './pushPayload.js';
import type { PushSendResult } from './pushResult.js';

export type { PushNotification } from './pushPayload.js';
export type { PushSendResult } from './pushResult.js';

/** Same per-request budget as the SMS/voice adapter — the worker's Lambda timeout is 15s. */
export const PUSH_PROVIDER_REQUEST_TIMEOUT_MS = 4_000;

const APNS_DEVICE_TOKEN = /^[0-9a-f]{64}$/i;

/**
 * Which gateway a registered token belongs to. The app registers `{ platform: 'APNS' }` with
 * the raw APNs device token on iOS and `{ platform: 'FCM' }` on Android (personnel-service
 * registerToken.ts). An entry with no platform falls back on the token's shape: a raw APNs
 * token is 64 hex characters, an FCM registration token never is.
 */
export function resolvePushPlatform(platform: string | undefined, token: string): PushPlatform {
  const normalized = platform?.toUpperCase();
  if (normalized === 'APNS' || normalized === 'IOS') return 'APNS';
  if (normalized === 'FCM' || normalized === 'ANDROID') return 'FCM';
  return APNS_DEVICE_TOKEN.test(token) ? 'APNS' : 'FCM';
}

export interface SendPushOptions {
  /** Self-test/canary: sandbox credentials, APNs sandbox host, FCM validate_only. */
  readonly isTest?: boolean;
  readonly secretsClient?: SecretsManagerClient;
  /** Test seams. */
  readonly apnsTransport?: Http2Transport;
  readonly apnsOrigin?: string;
  readonly fcmOrigin?: string;
  readonly oauthTokenUrl?: string;
}

/**
 * Direct APNs / FCM push (architecture §Alerting: no third-party push vendor). Resolves the
 * credentials for exactly the platform being sent to, so a missing FCM secret never blocks
 * an iOS page and vice versa.
 */
export async function sendPush(
  notification: PushNotification,
  platform: PushPlatform,
  env: NodeJS.ProcessEnv,
  options: SendPushOptions = {},
): Promise<PushSendResult> {
  const isTest = options.isTest === true;
  const secretId = readPushSecretId(platform, env, { isTest });
  const secretsClient = createChannelSecretsClient(options.secretsClient);
  const common = { secretId, isTest, secretsClient, timeoutMs: PUSH_PROVIDER_REQUEST_TIMEOUT_MS };
  if (platform === 'APNS') {
    return sendViaApns(notification, {
      ...common,
      ...(options.apnsTransport ? { transport: options.apnsTransport } : {}),
      ...(options.apnsOrigin ? { origin: options.apnsOrigin } : {}),
    });
  }
  return sendViaFcm(notification, {
    ...common,
    ...(options.fcmOrigin ? { fcmOrigin: options.fcmOrigin } : {}),
    ...(options.oauthTokenUrl ? { oauthTokenUrl: options.oauthTokenUrl } : {}),
  });
}
