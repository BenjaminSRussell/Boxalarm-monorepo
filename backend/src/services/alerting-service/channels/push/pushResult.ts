/**
 * What a push provider said about one send. Retryable failures (429, 5xx, timeouts, auth
 * misconfiguration) are not a result — the adapter throws, so SQS redelivers and the send
 * guard's FAILED re-claim path re-attempts. `invalid_token` is the one terminal refusal:
 * the device token is dead and retrying it can never succeed.
 */
export type PushSendResult =
  | { readonly outcome: 'sent'; readonly providerMessageId?: string }
  | {
      readonly outcome: 'invalid_token';
      readonly reason: string;
      /**
       * APNs 410 only: when (epoch ms) APNs last knew the token to be invalid. A device that
       * re-registered the same token after this has a live token again.
       */
      readonly invalidSinceMs?: number;
    }
  /**
   * Self-test/canary only: the gateway refused the message for a configuration reason (sender
   * or topic mismatch, credentials) rather than a dead token. Terminal and non-invalidating:
   * a redelivery cannot fix configuration, and a test must not dead-letter and page on-call.
   */
  | { readonly outcome: 'test_refused'; readonly reason: string };

/** A 4xx other than 429 — a refusal a retry cannot fix. */
export function isNonRetryableRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * One push send, including its in-process credential retry, must finish well inside the
 * worker's 15s Lambda timeout: a Lambda timeout fails the whole batch of up to 10 pages.
 * Each request still gets at most the per-request timeout, but all of them share one deadline
 * of this many per-request timeouts (2 x 4s = 8s), however the attempts split it.
 */
export const PUSH_SEND_BUDGET_REQUESTS = 2;

/** The timeout for the next request: the per-request cap, or whatever is left of the deadline. */
export function nextRequestTimeout(timeoutMs: number, deadlineMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    // Retryable: thrown, so SQS redelivers with a fresh budget.
    throw new Error('push send budget exhausted before the next request');
  }
  return Math.min(timeoutMs, remaining);
}

const FETCH_CONNECTION_ERROR_CODES = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
]);

/**
 * `fetch` (undici) reuses keep-alive sockets. One the far side or a NAT closed while the
 * Lambda was frozen fails the next POST with "other side closed", and undici does not retry a
 * POST itself. True only for that connection loss, never for a timeout or an HTTP error.
 */
export function isFetchConnectionLoss(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && FETCH_CONNECTION_ERROR_CODES.has(code);
}

/**
 * POST once, and once more on a fresh connection if the first attempt lost its connection
 * (isFetchConnectionLoss). Each attempt's timeout comes from `nextTimeoutMs`, so a retry never
 * outlives the send's deadline. For a page, a duplicate is the safe side of a miss.
 */
export async function fetchRetryingConnectionLoss(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  nextTimeoutMs: () => number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(nextTimeoutMs()) });
  } catch (error) {
    if (!isFetchConnectionLoss(error)) throw error;
    return fetch(url, { ...init, signal: AbortSignal.timeout(nextTimeoutMs()) });
  }
}
