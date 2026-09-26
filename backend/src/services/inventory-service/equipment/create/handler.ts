import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
  type WithAuthorizationOptions,
} from '@boxalarm/authz';
import { extractTraceparent } from '@boxalarm/logging';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getDocClient, readInventoryConfig } from '../../lib/dynamoDb.js';
import { emitMetric, logEvent } from '../../lib/logger.js';
import { ValidationError, toProblemResponse } from '../../lib/problemDetails.js';
import { createEquipmentAsset } from '../equipmentRepository.js';

export function createCreateEquipmentHandler(docClient?: DynamoDBDocumentClient) {
  return async function innerHandler(
    event: GuardEvent,
    principal: CedarPrincipalContext,
  ): Promise<APIGatewayProxyResultV2> {
    const correlationId = extractTraceId(event);
    // W3C traceparent: propagate the caller's incoming header, or mint a fresh
    // root-span one when this is the first hop — echoed back so the caller/tracing
    // backend can join this response to the same trace. Working example of
    // @boxalarm/logging's extractTraceparent; not yet adopted by other handlers.
    const traceparent = extractTraceparent(event.headers);
    try {
      const deptId = toVerifiedDeptId(principal);
      const actorId = principal.sub;

      const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
      const serialNumber = typeof body.serialNumber === 'string' ? body.serialNumber.trim() : '';
      if (!serialNumber) {
        throw new ValidationError('serialNumber is required and must be a non-empty string');
      }
      const location = typeof body.location === 'string' ? body.location.trim() : '';

      const client = getDocClient(docClient);
      const { tableName } = readInventoryConfig(process.env);
      const asset = await createEquipmentAsset(client, tableName, deptId, actorId, {
        serialNumber,
        location,
      });

      emitMetric('EquipmentAssetCreated');
      return {
        statusCode: 201,
        headers: { 'content-type': 'application/json', traceparent },
        body: JSON.stringify(asset),
      };
    } catch (error) {
      logEvent('error', {
        event: 'inventory.equipment.create.failed',
        correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
      emitMetric('EquipmentAssetCreateFailed');
      const problem = toProblemResponse(error, event.rawPath, correlationId);
      return { ...problem, headers: { ...problem.headers, traceparent } };
    }
  };
}

// Architecture §2 inventory table: POST /equipment is Cognito(admin) — a Verified
// Permissions check requiring chief/admin/officer (cedar-policies.ts INVENTORY_ADMIN_*).
export function createHandler(deps?: {
  readonly authzClient?: WithAuthorizationOptions['client'];
  readonly dynamoClient?: DynamoDBDocumentClient;
}): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(createCreateEquipmentHandler(deps?.dynamoClient), {
    actionType: 'Boxalarm::Action',
    actionId: 'RegisterEquipmentAsset',
    resourceType: 'Boxalarm::Department',
    resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
    ...(deps?.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
