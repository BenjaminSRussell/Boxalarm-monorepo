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
import { emitMetric, logEvent } from '../../lib/logger.js';
import { NotFoundError, ValidationError, toProblemResponse } from '../../lib/problemDetails.js';
import { setLocation } from '../equipmentRepository.js';

export function createLocationHandler(docClient?: DynamoDBDocumentClient) {
  return async function innerHandler(
    event: GuardEvent,
    principal: CedarPrincipalContext,
  ): Promise<APIGatewayProxyResultV2> {
    const correlationId = extractTraceId(event);
    try {
      const assetId = event.pathParameters?.assetId;
      if (!assetId) {
        throw new ValidationError('assetId path parameter is required');
      }
      const deptId = toVerifiedDeptId(principal);
      const actorId = principal.sub;

      const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
      const location = typeof body.location === 'string' ? body.location.trim() : '';
      if (!location) {
        throw new ValidationError('location is required and must be a non-empty string');
      }

      const client = getDocClient(docClient);
      const { tableName } = readInventoryConfig(process.env);
      const asset = await setLocation(client, tableName, deptId, actorId, assetId, location);
      if (!asset) {
        throw new NotFoundError(`equipment asset ${assetId} was not found`);
      }

      emitMetric('EquipmentAssetLocationUpdated');
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(asset),
      };
    } catch (error) {
      logEvent('error', {
        event: 'inventory.equipment.location.failed',
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
  return withAuthorization(createLocationHandler(deps?.dynamoClient), {
    actionType: 'Boxalarm::Action',
    actionId: 'SetEquipmentLocation',
    resourceType: 'Boxalarm::Asset',
    resourceId: (event) => event.pathParameters?.assetId ?? '',
    ...(deps?.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
