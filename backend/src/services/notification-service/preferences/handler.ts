import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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
import {
  buildPreferenceItem,
  parsePreferenceItem,
  type NotificationChannelMutes,
  type NotificationPreference,
} from '../repository.js';

interface UpdatePreferenceBody {
  readonly category: string;
  readonly channels: NotificationChannelMutes;
}

function parseBody(raw: string | undefined | null): UpdatePreferenceBody {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('body must be valid JSON');
  }
  const body = (parsed ?? {}) as Partial<Record<string, unknown>>;
  if (typeof body.category !== 'string' || body.category.length === 0) {
    throw new Error('category is required and must be a non-empty string');
  }
  const channels = body.channels as Partial<NotificationChannelMutes> | undefined;
  if (
    typeof channels !== 'object' ||
    channels === null ||
    typeof channels.push !== 'boolean' ||
    typeof channels.email !== 'boolean'
  ) {
    throw new Error('channels is required and must be { push: boolean, email: boolean }');
  }
  return { category: body.category, channels: { push: channels.push, email: channels.email } };
}

function logError(event: string, error: unknown, correlationId: string): void {
  console.error(
    JSON.stringify({
      event,
      service: 'notification-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
    }),
  );
}

async function getPreferences(
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
          ':prefix': `NOTIFPREF#${memberId}#`,
        },
      }),
    );
    const preferences = (result.Items ?? [])
      .map(parsePreferenceItem)
      .filter((preference): preference is NotificationPreference => preference !== undefined);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preferences }),
    };
  } catch (error) {
    logError('notification.preferences.get_failed', error, traceId);
    return serviceUnavailableProblem(traceId);
  }
}

async function putPreferences(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  let body: UpdatePreferenceBody;
  try {
    body = parseBody(event.body);
  } catch (error) {
    return badRequestProblem(traceId, error instanceof Error ? error.message : 'invalid body');
  }

  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;
  const updatedAt = Date.now();
  const item = buildPreferenceItem(deptId, memberId, body.category, body.channels, updatedAt);

  try {
    const { tableName } = readNotificationConfig(process.env);
    const client = createDynamoClient(process.env);
    await client.send(new PutCommand({ TableName: tableName, Item: item }));
  } catch (error) {
    logError('notification.preferences.put_failed', error, traceId);
    return serviceUnavailableProblem(traceId);
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: body.category, channels: body.channels, updatedAt }),
  };
}

export const getHandler = withAuthorization(getPreferences, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewOwnNotificationPreferences',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.sub ?? '',
});

export const putHandler = withAuthorization(putPreferences, {
  actionType: 'Boxalarm::Action',
  actionId: 'UpdateOwnNotificationPreferences',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.sub ?? '',
});

export const GET_ROUTE_KEY = 'GET /api/v1/notifications/preferences';
export const PUT_ROUTE_KEY = 'PUT /api/v1/notifications/preferences';

/** Lambda entry point: one function serves both preference routes, dispatched on routeKey. */
export const handler = async (event: GuardEvent): Promise<APIGatewayProxyResultV2> => {
  if (event.routeKey === GET_ROUTE_KEY) {
    return getHandler(event);
  }
  if (event.routeKey === PUT_ROUTE_KEY) {
    return putHandler(event);
  }
  return notFoundProblem(extractTraceId(event), `No route for ${event.routeKey}.`);
};
