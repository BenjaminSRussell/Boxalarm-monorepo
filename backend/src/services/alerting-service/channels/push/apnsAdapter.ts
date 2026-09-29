import { connect, constants, type ClientHttp2Session, type OutgoingHttpHeaders } from 'node:http2';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  apnsProviderToken,
  evictPushCredentials,
  loadApnsCredentials,
  PushProviderAuthError,
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

/**
 * A cached connection idle longer than this is replaced before use rather than trusted. A
 * Lambda frozen between pages cannot process the FIN/RST of a connection the far side (or a
 * NAT) dropped while it slept, and a silently dropped connection just hangs until the
 * request deadline — so a quiet station's first page would otherwise fail. A fresh TLS
 * handshake costs a few hundred ms, well inside the 4s budget.
 */
export const APNS_SESSION_MAX_IDLE_MS = 60_000;

/** How long a suspect session gets to answer a PING before it is torn down. */
const SESSION_PING_TIMEOUT_MS = 1_000;

interface CachedSession {
  readonly session: ClientHttp2Session;
  lastUsedAt: number;
}

// One HTTP/2 connection per origin, reused across warm invocations as Apple recommends —
// a TLS handshake per page would spend a chunk of the 4s budget.
const sessions = new Map<string, CachedSession>();

function isUsable(session: ClientHttp2Session): boolean {
  return !session.closed && !session.destroyed;
}

function dropSession(origin: string, session: ClientHttp2Session): void {
  if (sessions.get(origin)?.session === session) sessions.delete(origin);
  if (!session.destroyed) session.destroy();
}

function sessionFor(origin: string): ClientHttp2Session {
  const existing = sessions.get(origin);
  if (existing && isUsable(existing.session)) {
    if (Date.now() - existing.lastUsedAt <= APNS_SESSION_MAX_IDLE_MS) {
      existing.lastUsedAt = Date.now();
      return existing.session;
    }
    dropSession(origin, existing.session);
  }
  const session = connect(origin);
  const forget = () => {
    if (sessions.get(origin)?.session === session) sessions.delete(origin);
  };
  session.on('error', forget);
  session.on('goaway', forget);
  session.on('close', forget);
  // A cached idle connection must never hold a Lambda (or a test process) open.
  session.unref();
  sessions.set(origin, { session, lastUsedAt: Date.now() });
  return session;
}

/**
 * After a stream times out, the connection itself may be dead (silently dropped) or merely
 * slow for that one stream. PING it: a live connection keeps serving sibling pages; one that
 * does not answer is torn down so the next page reconnects.
 */
function probeSession(origin: string, session: ClientHttp2Session): void {
  if (!isUsable(session)) return;
  const timer = setTimeout(() => dropSession(origin, session), SESSION_PING_TIMEOUT_MS);
  timer.unref();
  try {
    session.ping((error) => {
      clearTimeout(timer);
      if (error) dropSession(origin, session);
    });
  } catch {
    clearTimeout(timer);
    dropSession(origin, session);
  }
}

export function resetApnsSessions(): void {
  for (const { session } of sessions.values()) session.destroy();
  sessions.clear();
}

const CONNECTION_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT']);

/**
 * Errors that say the connection, not the request, failed: a reset or closed socket, a
 * GOAWAY, a destroyed session, or any other node:http2 session/stream error. Retrying such a
 * page on a fresh connection is safe — APNs dedupes nothing, but the page carries the same
 * apns-id, and for a page a duplicate is the safe side of a miss.
 */
export function isConnectionLevelError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return (
    typeof code === 'string' && (CONNECTION_ERROR_CODES.has(code) || code.startsWith('ERR_HTTP2_'))
  );
}

class ApnsTimeoutError extends Error {}

function requestOnce(
  origin: string,
  session: ClientHttp2Session,
  headers: OutgoingHttpHeaders,
  body: string,
  timeoutMs: number,
): Promise<Http2Response> {
  return new Promise<Http2Response>((resolve, reject) => {
    let request: ReturnType<ClientHttp2Session['request']>;
    try {
      request = session.request({ ':method': 'POST', ...headers });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        // Cancel only this stream: sibling pages in the same batch share the connection.
        request.close(constants.NGHTTP2_CANCEL);
        probeSession(origin, session);
        reject(new ApnsTimeoutError(`APNs request timed out after ${timeoutMs}ms`));
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
      finish(() => {
        const cached = sessions.get(origin);
        if (cached?.session === session) cached.lastUsedAt = Date.now();
        resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8') });
      }),
    );
    request.on('error', (error: Error) => finish(() => reject(error)));
    request.end(body);
  });
}

/**
 * node:http2 POST with a hard deadline covering connect, send and response. A connection-level
 * failure (see isConnectionLevelError) is retried once on a fresh connection within the same
 * deadline, so a connection that died while the Lambda was frozen costs a reconnect, not a
 * 30s SQS redelivery.
 */
export const http2Transport: Http2Transport = async (origin, headers, body, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  const session = sessionFor(origin);
  try {
    return await requestOnce(origin, session, headers, body, timeoutMs);
  } catch (error) {
    if (error instanceof ApnsTimeoutError || !isConnectionLevelError(error)) throw error;
    dropSession(origin, session);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw error;
    return requestOnce(origin, sessionFor(origin), headers, body, remaining);
  }
};

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

const APNS_AUTH_FAILURES = new Set([
  'ExpiredProviderToken',
  'InvalidProviderToken',
  'MissingProviderToken',
]);

/**
 * Token-based (.p8) APNs send over HTTP/2. 200 → sent; 410 or BadDeviceToken → the token is
 * dead (invalid_token, not retried); anything else throws so SQS redelivers and the send
 * guard's FAILED re-claim path re-attempts. A provider-credential refusal evicts the cached
 * secret and token and is retried once in-process with freshly read credentials, so a key
 * rotation costs one extra round trip rather than a dead-lettered page.
 */
export async function sendViaApns(
  notification: PushNotification,
  options: SendViaApnsOptions,
): Promise<PushSendResult> {
  try {
    return await sendViaApnsOnce(notification, options);
  } catch (error) {
    if (!(error instanceof PushProviderAuthError)) throw error;
    evictPushCredentials(options.secretId);
    try {
      return await sendViaApnsOnce(notification, options);
    } catch (retryError) {
      if (retryError instanceof PushProviderAuthError) evictPushCredentials(options.secretId);
      throw retryError;
    }
  }
}

async function sendViaApnsOnce(
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
  const message = `APNs responded ${response.status} ${reason}`;
  if (APNS_AUTH_FAILURES.has(reason)) {
    throw new PushProviderAuthError(message);
  }
  throw new Error(message);
}
