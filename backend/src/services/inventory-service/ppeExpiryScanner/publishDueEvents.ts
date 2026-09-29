import { createHash } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { readInventoryConfig } from '../lifecycle/repository.js';

const METRIC_NAMESPACE = 'Boxalarm/PpeExpiryScanner';
const EVENT_SOURCE = 'inventory-service';

export interface EventBridgeBusConfig {
  readonly busName: string;
}

export function readPlatformEventBusConfig(env: NodeJS.ProcessEnv): EventBridgeBusConfig {
  const busName = env.PLATFORM_EVENT_BUS_NAME;
  if (!busName) {
    throw new Error('PLATFORM_EVENT_BUS_NAME is required and was not set');
  }
  return { busName };
}

let cachedEventBridgeClient: EventBridgeClient | undefined;

export function createEventBridgeClient(client?: EventBridgeClient): EventBridgeClient {
  if (client) {
    cachedEventBridgeClient = client;
    return client;
  }
  cachedEventBridgeClient ??= AWSXRay.captureAWSv3Client(new EventBridgeClient({}));
  return cachedEventBridgeClient;
}

export interface PublishDueEventParams {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly ppeItemId: string;
  readonly expiryDate: string;
  readonly correlationId: string;
  readonly now: Date;
}

export type PublishDueEventOutcome =
  'Published' | 'SkippedDuplicate' | 'PublishedMarkerNotConfirmed';

function deterministicEventId(
  deptId: string,
  memberId: string,
  ppeItemId: string,
  today: string,
): string {
  const hash = createHash('sha256')
    .update(`${deptId}#${memberId}#${ppeItemId}#${today}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function logPublishError(
  event: string,
  error: unknown,
  correlationId: string,
  ppeItemId: string,
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'inventory',
      reason: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
      correlationId,
      ppeItemId,
    }),
  );
}

export async function publishDueEvent(
  ddb: DynamoDBDocumentClient,
  eb: EventBridgeClient,
  env: NodeJS.ProcessEnv,
  params: PublishDueEventParams,
): Promise<PublishDueEventOutcome> {
  const { tableName } = readInventoryConfig(env);
  const { busName } = readPlatformEventBusConfig(env);
  const today = params.now.toISOString().slice(0, 10);
  const markerKey = {
    pk: buildDeptScopedPk(params.deptId, 'PPE_EXPIRY_FLAG', today),
    sk: `PPE#${params.memberId}#${params.ppeItemId}`,
  };
  const eventId = deterministicEventId(params.deptId, params.memberId, params.ppeItemId, today);

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...markerKey,
          entityType: 'PPE_EXPIRY_FLAG',
          flaggedAt: params.now.toISOString(),
          eventId,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR attribute_not_exists(publishedAt)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'SkippedDuplicate');
      return 'SkippedDuplicate';
    }
    logPublishError(
      'ppeExpiryScanner.markDuplicate.failed',
      error,
      params.correlationId,
      params.ppeItemId,
    );
    throw error;
  }

  // notification-service's ppeExpiryConsumer.ts turns this into a ppe-expiry digest reminder
  // for the holder and the APPARATUS role.
  let response;
  try {
    response = await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: EVENT_SOURCE,
            DetailType: 'ppe.expiry.due',
            EventBusName: busName,
            Detail: JSON.stringify({
              eventId,
              eventTime: params.now.toISOString(),
              eventType: 'ppe.expiry.due',
              source: EVENT_SOURCE,
              correlationId: params.correlationId,
              schemaVersion: '1.0',
              payload: {
                memberId: params.memberId,
                ppeItemId: params.ppeItemId,
                expiryDate: params.expiryDate,
                // notification-service keys every reminder row by department.
                deptId: params.deptId,
              },
            }),
          },
        ],
      }),
    );
  } catch (error) {
    logPublishError(
      'ppeExpiryScanner.publish.failed',
      error,
      params.correlationId,
      params.ppeItemId,
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed');
    throw error;
  }

  const entryResult = response.Entries?.[0];
  if (entryResult?.ErrorCode) {
    const error = new Error(entryResult.ErrorMessage ?? entryResult.ErrorCode);
    logPublishError(
      'ppeExpiryScanner.publish.entryFailed',
      error,
      params.correlationId,
      params.ppeItemId,
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed', entryResult.ErrorCode);
    throw error;
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: markerKey,
        UpdateExpression: 'SET publishedAt = :publishedAt',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':publishedAt': params.now.toISOString() },
      }),
    );
  } catch (error) {
    logPublishError(
      'ppeExpiryScanner.markPublished.failed',
      error,
      params.correlationId,
      params.ppeItemId,
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'PublishedMarkerNotConfirmed');
    return 'PublishedMarkerNotConfirmed';
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'Published');
  return 'Published';
}
