import { connect, constants, type ClientHttp2Session, type OutgoingHttpHeaders } from 'node:http2';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  apnsProviderToken,
  discardApnsProviderToken,
  loadApnsCredentials,
} from './pushCredentials.js';
import {
  apnsCollapseId,
  apnsIdFor,
  buildApnsPayload,
  type PushNotification,
} from './pushPayload.js';
import type { PushSendResult } from './pushResult.js';

export const APNS_PRODUCTION_ORIGIN = 'https://api.push.apple.com';
export const APNS_SANDBOX_ORIGIN = 'https://api.sandbox.push.apple.com';

export interface Http2Response {
  readonly status: number;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly body: string;
}

export type Http2Transport = (
  origin: string,
  headers: OutgoingHttpHeaders,
  body: string,
  timeoutMs: number,
) => Promise<Http2Response>;

// One HTTP/2 connection per origin, reused across warm invocations as Apple recommends —
// a TLS handshake per page would spend a chunk of the 4s budget.
const sessions = new Map<string, ClientHttp2Session>();

function sessionFor(origin: string): ClientHttp2Session {
  const existing = sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed) {
    return existing;
  }
  const session = connect(origin);
  const forget = () => {
    if (sessions.get(origin) === session) sessions.delete(origin);
  };
  session.on('error', forget);
  session.on('goaway', forget);
  session.on('close', forget);
  // A cached idle connection must never hold a Lambda (or a test process) open.
  session.unref();
  sessions.set(origin, session);
  return session;
}

export function resetApnsSessions(): void {
  for (const session of sessions.values()) session.destroy();
  sessions.clear();
}

/** node:http2 POST with a hard deadline covering connect, send and response. */
export const http2Transport: Http2Transport = (origin, headers, body, timeoutMs) =>
  new Promise<Http2Response>((resolve, reject) => {
    const session = sessionFor(origin);
    const request = session.request({ ':method': 'POST', ...headers });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        request.close(constants.NGHTTP2_CANCEL);
        // A hung connection must not be reused by the redelivery.
        session.destroy();
        sessions.delete(origin);
        reject(new Error(`APNs request timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    let status = 0;
    let responseHeaders: Record<string, unknown> = {};
    const chunks: Buffer[] = [];
    request.on('response', (incoming) => {
      status = Number(incoming[':status']);
      responseHeaders = { ...incoming };
    });
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () =>
      finish(() =>
        resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8') }),
      ),
    );
    request.on('error', (error: Error) => finish(() => reject(error)));
    request.end(body);
  });

export interface SendViaApnsOptions {
  readonly secretId: string;
  readonly isTest: boolean;
  readonly secretsClient: SecretsManagerClient;
  readonly timeoutMs: number;
  readonly transport?: Http2Transport;
  /** Test seam: replaces the Apple host (a local HTTP/2 server). */
  readonly origin?: string;
}

function apnsReason(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Token-based (.p8) APNs send over HTTP/2. 200 → sent; 410 or BadDeviceToken → the token is
 * dead (invalid_token, not retried); anything else throws so SQS redelivers and the send
 * guard's FAILED re-claim path re-attempts. An expired/invalid provider token is discarded
 * first so the redelivery signs a fresh one.
 */
export async function sendViaApns(
  notification: PushNotification,
  options: SendViaApnsOptions,
): Promise<PushSendResult> {
  const credentials = await loadApnsCredentials(options.secretId, options.secretsClient, {
    isTest: options.isTest,
  });
  const origin =
    options.origin ??
    (credentials.environment === 'sandbox' ? APNS_SANDBOX_ORIGIN : APNS_PRODUCTION_ORIGIN);
  const jwt = apnsProviderToken(options.secretId, credentials);
  const headers: OutgoingHttpHeaders = {
    ':path': `/3/device/${encodeURIComponent(notification.token)}`,
    authorization: `bearer ${jwt}`,
    'apns-topic': credentials.bundleId,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-id': apnsIdFor(notification.idempotencyKey),
    'apns-collapse-id': apnsCollapseId(notification.collapseKey),
    'content-type': 'application/json',
  };
  const payload = JSON.stringify(buildApnsPayload(notification, credentials.interruptionLevel));
  const transport = options.transport ?? http2Transport;
  const response = await transport(origin, headers, payload, options.timeoutMs);
  if (response.status === 200) {
    const apnsId = response.headers['apns-id'];
    return {
      outcome: 'sent',
      ...(typeof apnsId === 'string' ? { providerMessageId: apnsId } : {}),
    };
  }
  const reason = apnsReason(response.body) ?? 'Unknown';
  if (response.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
    return { outcome: 'invalid_token', reason: `APNS_${reason}` };
  }
  if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') {
    discardApnsProviderToken(options.secretId, credentials);
  }
  throw new Error(`APNs responded ${response.status} ${reason}`);
}
