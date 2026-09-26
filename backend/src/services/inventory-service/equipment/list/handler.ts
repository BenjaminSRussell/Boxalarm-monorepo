import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
  type WithAuthorizationOptions,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getDocClient, readInventoryConfig } from '../../lib/dynamoDb.js';
import { logEvent } from '../../lib/logger.js';
import { toProblemResponse } from '../../lib/problemDetails.js';
import { listEquipmentAssets, type ListEquipmentAssetsFilter } from '../equipmentRepository.js';

export function createListEquipmentHandler(docClient?: DynamoDBDocumentClient) {
  return async function innerHandler(
    event: GuardEvent,
    principal: CedarPrincipalContext,
  ): Promise<APIGatewayProxyResultV2> {
    const correlationId = extractTraceId(event);
    try {
      const deptId = toVerifiedDeptId(principal);
      const assignedToTypeParam = event.queryStringParameters?.assignedToType;
      const assignedToId = event.queryStringParameters?.assignedToId;
      const filter: ListEquipmentAssetsFilter = {
        ...(assignedToTypeParam === 'MEMBER' || assignedToTypeParam === 'APPARATUS'
          ? { assignedToType: assignedToTypeParam }
          : {}),
        ...(assignedToId ? { assignedToId } : {}),
      };

      const client = getDocClient(docClient);
      const { tableName } = readInventoryConfig(process.env);
      const items = await listEquipmentAssets(client, tableName, deptId, filter);

      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      };
    } catch (error) {
      logEvent('error', {
        event: 'inventory.equipment.list.failed',
        correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
      return toProblemResponse(error, event.rawPath, correlationId);
    }
  };
}

export function createHandler(deps?: {
  readonly authzClient?: WithAuthorizationOptions['client'];
  readonly dynamoClient?: DynamoDBDocumentClient;
}): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(createListEquipmentHandler(deps?.dynamoClient), {
    actionType: 'Boxalarm::Action',
    actionId: 'ListEquipment',
    resourceType: 'Boxalarm::Department',
    resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
    ...(deps?.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
