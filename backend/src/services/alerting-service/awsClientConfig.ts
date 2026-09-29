/**
 * SDK client settings for the alerting plane's hot path (channel workers). The push send has
 * an 8s budget, but it is measured with the clock and cannot abort an SDK call already in
 * flight. Without these bounds a stalled DynamoDB or Secrets Manager socket (for example a
 * stale keep-alive after a Lambda freeze) could hold one page until the worker's 15s Lambda
 * timeout, and that timeout fails every page in the batch. Each attempt now gets 1s to connect
 * and 2s to answer. The SDK's default retries (3 attempts) remain, so a transient stall costs
 * a retry, not the batch.
 */
export const ALERTING_SDK_REQUEST_HANDLER = {
  connectionTimeout: 1_000,
  requestTimeout: 2_000,
} as const;

export const ALERTING_SDK_CLIENT_CONFIG = {
  requestHandler: ALERTING_SDK_REQUEST_HANDLER,
} as const;
