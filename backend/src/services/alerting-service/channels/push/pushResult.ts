/**
 * What a push provider said about one send. Retryable failures (429, 5xx, timeouts, auth
 * misconfiguration) are not a result — the adapter throws, so SQS redelivers and the send
 * guard's FAILED re-claim path re-attempts. `invalid_token` is the one terminal refusal:
 * the device token is dead and retrying it can never succeed.
 */
export type PushSendResult =
  | { readonly outcome: 'sent'; readonly providerMessageId?: string }
  | { readonly outcome: 'invalid_token'; readonly reason: string };
