import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  evictPushCredentials,
  fcmAccessToken,
  loadFcmCredentials,
  PushProviderAuthError,
  type ApnsInterruptionLevel,
} from './pushCredentials.js';
import {
  apnsCollapseId,
  apnsExpiration,
  buildApnsPayload,
  PUSH_TTL_SECONDS,
  pushDataFields,
  type PushNotification,
} from './pushPayload.js';
import {
  isNonRetryableRefusal,
  nextRequestTimeout,
  PUSH_SEND_BUDGET_REQUESTS,
  type PushSendResult,
} from './pushResult.js';

export const FCM_ORIGIN = 'https://fcm.googleapis.com';

export interface SendViaFcmOptions {
  readonly secretId: string;
  readonly isTest: boolean;
  readonly secretsClient: SecretsManagerClient;
  readonly timeoutMs: number;
  /** Test seams: a local HTTP server in place of Google. */
  readonly fcmOrigin?: string;
  readonly oauthTokenUrl?: string;
}

/**
 * FCM HTTP v1 message. Android gets a HIGH-priority **data-only** message (architecture
 * §5.2): the app's background handler posts it on the `dispatch-critical` notifee channel
 * itself, so it is displayed even when the app is killed. The `apns` block only applies to an
 * iOS device that registered an FCM token before the app switched to raw APNs tokens — it
 * keeps those devices paged, critically, until they re-register.
 */
export function buildFcmRequest(
  notification: PushNotification,
  isTest: boolean,
  nowMs: number = Date.now(),
  apnsInterruptionLevel: ApnsInterruptionLevel = 'critical',
): Record<string, unknown> {
  return {
    // Self-test/canary: FCM validates the whole message (token included) but delivers nothing.
    ...(isTest ? { validate_only: true } : {}),
    message: {
      token: notification.token,
      data: pushDataFields(notification),
      android: { priority: 'HIGH', ttl: `${PUSH_TTL_SECONDS}s` },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-expiration': apnsExpiration(nowMs),
          'apns-push-type': 'alert',
          'apns-collapse-id': apnsCollapseId(notification.collapseKey),
        },
        payload: buildApnsPayload(notification, apnsInterruptionLevel),
      },
    },
  };
}

interface FcmErrorBody {
  readonly error?: {
    readonly status?: string;
    readonly message?: string;
    readonly details?: readonly {
      readonly errorCode?: string;
      readonly fieldViolations?: readonly { readonly field?: string }[];
    }[];
  };
}

function parseError(text: string): FcmErrorBody['error'] {
  try {
    return (JSON.parse(text) as FcmErrorBody).error;
  } catch {
    return undefined;
  }
}

/**
 * INVALID_ARGUMENT is a dead token only when it names the token; any other invalid argument
 * is a payload bug and must stay loud (throw → DLQ → alarm), never silently disable a
 * member's device.
 */
function isTokenArgumentError(error: FcmErrorBody['error']): boolean {
  const namesTokenField = (error?.details ?? []).some((detail) =>
    (detail.fieldViolations ?? []).some((violation) => violation.field === 'message.token'),
  );
  return namesTokenField || /registration token/i.test(error?.message ?? '');
}

/**
 * A credential refusal (FCM 401, a 403 that is not a sender mismatch, or the token endpoint
 * refusing the service account) evicts the cached secret and access token and is retried once
 * in-process with freshly read credentials; see sendViaApns.
 */
export async function sendViaFcm(
  notification: PushNotification,
  options: SendViaFcmOptions,
): Promise<PushSendResult> {
  const deadlineMs = Date.now() + PUSH_SEND_BUDGET_REQUESTS * options.timeoutMs;
  try {
    return await sendViaFcmOnce(notification, options, deadlineMs);
  } catch (error) {
    if (!(error instanceof PushProviderAuthError)) throw error;
    evictPushCredentials(options.secretId, error);
    try {
      return await sendViaFcmOnce(notification, options, deadlineMs);
    } catch (retryError) {
      if (!(retryError instanceof PushProviderAuthError)) throw retryError;
      evictPushCredentials(options.secretId, retryError);
      if (options.isTest) {
        return { outcome: 'test_refused', reason: `FCM_CREDENTIALS_REFUSED` };
      }
      throw retryError;
    }
  }
}

async function sendViaFcmOnce(
  notification: PushNotification,
  options: SendViaFcmOptions,
  deadlineMs: number,
): Promise<PushSendResult> {
  const credentials = await loadFcmCredentials(options.secretId, options.secretsClient);
  const accessToken = await fcmAccessToken(options.secretId, credentials, {
    timeoutMs: nextRequestTimeout(options.timeoutMs, deadlineMs),
    ...(options.oauthTokenUrl ? { tokenUrl: options.oauthTokenUrl } : {}),
  });
  const origin = options.fcmOrigin ?? FCM_ORIGIN;
  const response = await fetch(
    `${origin}/v1/projects/${encodeURIComponent(credentials.projectId)}/messages:send`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(
        buildFcmRequest(
          notification,
          options.isTest,
          Date.now(),
          credentials.apnsInterruptionLevel,
        ),
      ),
      signal: AbortSignal.timeout(nextRequestTimeout(options.timeoutMs, deadlineMs)),
    },
  );
  const text = await response.text();
  if (response.ok) {
    let name: unknown;
    try {
      name = (JSON.parse(text) as { name?: unknown }).name;
    } catch {
      name = undefined;
    }
    return { outcome: 'sent', ...(typeof name === 'string' ? { providerMessageId: name } : {}) };
  }
  const error = parseError(text);
  const errorCode =
    error?.details?.find((detail) => typeof detail.errorCode === 'string')?.errorCode ??
    error?.status ??
    'UNKNOWN';
  // Only the explicit code: a bare 404 can also mean a wrong project_id, and treating that as
  // a dead token would disable every member's device on a misconfiguration.
  if (errorCode === 'UNREGISTERED') {
    return { outcome: 'invalid_token', reason: 'FCM_UNREGISTERED' };
  }
  if (errorCode === 'INVALID_ARGUMENT' && isTokenArgumentError(error)) {
    return { outcome: 'invalid_token', reason: 'FCM_INVALID_ARGUMENT' };
  }
  const message = `FCM responded ${response.status} ${errorCode}`;
  if (response.status === 401 || (response.status === 403 && errorCode !== 'SENDER_ID_MISMATCH')) {
    throw new PushProviderAuthError(message, accessToken);
  }
  // A self-test refused for configuration (SENDER_ID_MISMATCH when the sandbox service account
  // is in another Firebase project, a payload INVALID_ARGUMENT…) is a test failure, not a page
  // to retry into the DLQ. Real pages keep throwing so a misconfigured stack pages on-call.
  if (options.isTest && isNonRetryableRefusal(response.status)) {
    return { outcome: 'test_refused', reason: `FCM_${errorCode}` };
  }
  throw new Error(message);
}
