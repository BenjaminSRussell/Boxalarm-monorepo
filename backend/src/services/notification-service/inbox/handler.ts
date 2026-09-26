import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  badRequestProblem,
  extractTraceId,
  notFoundProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readNotificationConfig } from '../dynamoClient.js';

function logError(
  event: string,
  error: unknown,
  correlationId: string,
  extra: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'notification-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
      ...extra,
    }),
  );
}

function encodeCursor(key: Record<string, unknown> | undefined): string | null {
  return key ? Buffer.from(JSON.stringify(key)).toString('base64url') : null;
}

function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// The member-facing shape: never the raw item, whose pk/sk/gsi1 keys and ttl are storage
// details (and the pk embeds the dept scope).
function toInboxEntry(item: Record<string, unknown>): Record<string, unknown> {
  return {
    notificationId: item.notificationId,
    category: item.category,
    summary: item.summary,
    items: item.items ?? [],
    createdAt: item.createdAt,
    readAt: item.readAt ?? null,
  };
}

async function listNotifications(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;

  try {
    const { tableName } = readNotificationConfig(process.env);
    const client = createDynamoClient(process.env);
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'MEMBER', memberId),
          ':prefix': 'NOTIF#',
        },
        ExclusiveStartKey: decodeCursor(event.queryStringParameters?.cursor),
        ScanIndexForward: false,
      }),
    );
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: (result.Items ?? []).map(toInboxEntry),
        nextCursor: encodeCursor(result.LastEvaluatedKey as Record<string, unknown> | undefined),
      }),
    };
  } catch (error) {
    logError('notification.inbox.list_failed', error, traceId);
    return serviceUnavailableProblem(traceId);
  }
}

async function markNotificationRead(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const notificationId = event.pathParameters?.id;
  if (!notificationId) {
    return badRequestProblem(traceId, [{ field: 'id', detail: 'is required' }]);
  }

  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;
  const { tableName } = readNotificationConfig(process.env);
  const client = createDynamoClient(process.env);

  let existingSk: string | undefined;
  try {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk = :gsi1sk',
        ExpressionAttributeValues: {
          ':gsi1pk': buildDeptScopedPk(deptId, 'MEMBER', memberId),
          ':gsi1sk': `NOTIFICATION#${notificationId}`,
        },
      }),
    );
    existingSk = (result.Items ?? [])[0]?.sk as string | undefined;
  } catch (error) {
    logError('notification.inbox.markRead.query_failed', error, traceId, { notificationId });
    return serviceUnavailableProblem(traceId);
  }

  if (!existingSk) {
    return notFoundProblem(traceId, `notification ${notificationId} was not found`);
  }

  const readAt = Date.now();
  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: existingSk },
        ConditionExpression: 'attribute_exists(pk)',
        UpdateExpression: 'SET readAt = :readAt',
        ExpressionAttributeValues: { ':readAt': readAt },
      }),
    );
  } catch (error) {
    logError('notification.inbox.markRead.update_failed', error, traceId, { notificationId });
    return serviceUnavailableProblem(traceId);
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notificationId, readAt }),
  };
}

export const listHandler = withAuthorization(listNotifications, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewOwnNotifications',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.sub ?? '',
});

export const markReadHandler = withAuthorization(markNotificationRead, {
  actionType: 'Boxalarm::Action',
  actionId: 'MarkNotificationRead',
  resourceType: 'Boxalarm::Notification',
  resourceId: (event) => event.pathParameters?.id ?? '',
});

export const LIST_ROUTE_KEY = 'GET /api/v1/notifications';
export const MARK_READ_ROUTE_KEY = 'POST /api/v1/notifications/{id}/read';

/** Lambda entry point: one function serves both inbox routes, dispatched on routeKey. */
export const handler = async (event: GuardEvent): Promise<APIGatewayProxyResultV2> => {
  if (event.routeKey === LIST_ROUTE_KEY) {
    return listHandler(event);
  }
  if (event.routeKey === MARK_READ_ROUTE_KEY) {
    return markReadHandler(event);
  }
  return notFoundProblem(extractTraceId(event), `No route for ${event.routeKey}.`);
};
