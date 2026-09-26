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
import { setAssignment, type AssignedToType } from '../equipmentRepository.js';

function isAssignedToType(value: unknown): value is AssignedToType {
  return value === 'MEMBER' || value === 'APPARATUS';
}

export function createAssignmentHandler(docClient?: DynamoDBDocumentClient) {
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
      const assignedToType = body.assignedToType;
      const assignedToId = typeof body.assignedToId === 'string' ? body.assignedToId.trim() : '';
      if (!isAssignedToType(assignedToType)) {
        throw new ValidationError('assignedToType must be MEMBER or APPARATUS');
      }
      if (!assignedToId) {
        throw new ValidationError('assignedToId is required and must be a non-empty string');
      }

      const client = getDocClient(docClient);
      const { tableName } = readInventoryConfig(process.env);
      const asset = await setAssignment(
        client,
        tableName,
        deptId,
        actorId,
        assetId,
        assignedToType,
        assignedToId,
      );
      if (!asset) {
        throw new NotFoundError(`equipment asset ${assetId} was not found`);
      }

      emitMetric('EquipmentAssetAssigned');
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(asset),
      };
    } catch (error) {
      logEvent('error', {
        event: 'inventory.equipment.assignment.failed',
        correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
      emitMetric('EquipmentAssetAssignFailed');
      return toProblemResponse(error, event.rawPath, correlationId);
    }
  };
}

export function createHandler(deps?: {
  readonly authzClient?: WithAuthorizationOptions['client'];
  readonly dynamoClient?: DynamoDBDocumentClient;
}): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(createAssignmentHandler(deps?.dynamoClient), {
    actionType: 'Boxalarm::Action',
    actionId: 'AssignEquipmentAsset',
    resourceType: 'Boxalarm::Asset',
    resourceId: (event) => event.pathParameters?.assetId ?? '',
    ...(deps?.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
