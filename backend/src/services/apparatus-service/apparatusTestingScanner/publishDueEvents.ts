import { createHash } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { readApparatusTableConfig } from '../dynamoClient.js';

const METRIC_NAMESPACE = 'Boxalarm/ApparatusTestingScanner';
const EVENT_SOURCE = 'apparatus-service';

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

export type ScbaTestType = 'SCBA_FLOW' | 'SCBA_HYDRO';

export interface PublishScbaTestDueParams {
  readonly deptId: VerifiedDeptId;
  readonly apparatusId: string;
  readonly scbaUnitId: string;
  readonly cylinderId: string;
  readonly testType: ScbaTestType;
  readonly dueDate: string;
  readonly correlationId: string;
  readonly now: Date;
}

export type PublishScbaTestDueOutcome = 'Published' | 'SkippedDuplicate';

function deterministicEventId(
  deptId: string,
  scbaUnitId: string,
  testType: ScbaTestType,
  today: string,
): string {
  const hash = createHash('sha256')
    .update(`${deptId}#${scbaUnitId}#${testType}#${today}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function logPublishError(
  event: string,
  error: unknown,
  correlationId: string,
  scbaUnitId: string,
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'apparatus-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      correlationId,
      scbaUnitId,
    }),
  );
}

export async function publishScbaTestDueEvent(
  ddb: DynamoDBDocumentClient,
  eb: EventBridgeClient,
  env: NodeJS.ProcessEnv,
  params: PublishScbaTestDueParams,
): Promise<PublishScbaTestDueOutcome> {
  const { tableName } = readApparatusTableConfig(env);
  const { busName } = readPlatformEventBusConfig(env);
  const today = params.now.toISOString().slice(0, 10);
  const markerKey = {
    pk: buildDeptScopedPk(params.deptId, 'SCBA_TEST_DUE_FLAG', today),
    sk: `SCBA#${params.scbaUnitId}#${params.testType}`,
  };
  const eventId = deterministicEventId(params.deptId, params.scbaUnitId, params.testType, today);

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...markerKey,
          entityType: 'SCBA_TEST_DUE_FLAG',
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
      'apparatusTestingScanner.markDuplicate.failed',
      error,
      params.correlationId,
      params.scbaUnitId,
    );
    throw error;
  }

  let response;
  try {
    response = await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: EVENT_SOURCE,
            DetailType: 'apparatus.test.due',
            EventBusName: busName,
            Detail: JSON.stringify({
              eventId,
              eventTime: params.now.toISOString(),
              eventType: 'apparatus.test.due',
              source: EVENT_SOURCE,
              correlationId: params.correlationId,
              schemaVersion: '1.0',
              payload: {
                apparatusId: params.apparatusId,
                testType: params.testType,
                dueDate: params.dueDate,
                scbaUnitId: params.scbaUnitId,
                cylinderId: params.cylinderId,
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
      'apparatusTestingScanner.publish.failed',
      error,
      params.correlationId,
      params.scbaUnitId,
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed');
    throw error;
  }

  const entryResult = response.Entries?.[0];
  if (entryResult?.ErrorCode) {
    const error = new Error(entryResult.ErrorMessage ?? entryResult.ErrorCode);
    logPublishError(
      'apparatusTestingScanner.publish.entryFailed',
      error,
      params.correlationId,
      params.scbaUnitId,
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
      'apparatusTestingScanner.markPublished.failed',
      error,
      params.correlationId,
      params.scbaUnitId,
    );
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'Published');
  return 'Published';
}
