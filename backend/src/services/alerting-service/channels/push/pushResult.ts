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
