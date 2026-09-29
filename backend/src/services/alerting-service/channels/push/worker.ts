// TODO: E1-S2 — assumes alerting-push-queue.fifo + paired DLQ (maxReceiveCount: 3), RawMessageDelivery=true, ALERTING_TABLE_NAME + APNS_SECRET_ID/APNS_SANDBOX_SECRET_ID/FCM_SECRET_ID/FCM_SANDBOX_SECRET_ID env vars (direct APNs/FCM, push/pushProviderAdapter.ts), and an execution role scoped to the alerting-service table only.
// TODO: E8-S11 — assumes a CloudWatch alarm on this queue's DLQ that pages on-call immediately.
import { createChannelWorkerHandler } from '../deliverChannelMessage.js';

export const handler = createChannelWorkerHandler('push');
