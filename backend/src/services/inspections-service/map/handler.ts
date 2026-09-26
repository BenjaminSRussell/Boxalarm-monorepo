import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { coveringCells, type BoundingBox } from './geohash.js';
import { createDynamoClient, readMapTableConfig } from './dynamoClient.js';
import { queryMapCells } from './queryMapCells.js';

interface FieldError {
  readonly field: string;
  readonly detail: string;
}

type BboxField = 'minLat' | 'minLng' | 'maxLat' | 'maxLng';

const BBOX_FIELDS: readonly BboxField[] = ['minLat', 'minLng', 'maxLat', 'maxLng'];

function parseBoundingBox(
  query: Record<string, string | undefined> | undefined,
): { readonly bbox: BoundingBox } | { readonly errors: readonly FieldError[] } {
  const errors: FieldError[] = [];
  const values: Partial<Record<BboxField, number>> = {};

  for (const field of BBOX_FIELDS) {
    const raw = query?.[field];
    if (!raw) {
      errors.push({ field, detail: 'is required' });
      continue;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      errors.push({ field, detail: `must be numeric, received "${raw}"` });
      continue;
    }
    values[field] = num;
  }

  if (errors.length > 0) {
    return { errors };
  }

  const { minLat, minLng, maxLat, maxLng } = values as Record<BboxField, number>;

  if (minLat < -90 || minLat > 90) {
    errors.push({ field: 'minLat', detail: 'must be between -90 and 90' });
  }
  if (maxLat < -90 || maxLat > 90) {
    errors.push({ field: 'maxLat', detail: 'must be between -90 and 90' });
  }
  if (minLng < -180 || minLng > 180) {
    errors.push({ field: 'minLng', detail: 'must be between -180 and 180' });
  }
  if (maxLng < -180 || maxLng > 180) {
    errors.push({ field: 'maxLng', detail: 'must be between -180 and 180' });
  }
  if (minLat >= maxLat) {
    errors.push({ field: 'minLat', detail: 'must be less than maxLat' });
  }
  if (minLng >= maxLng) {
    errors.push({ field: 'minLng', detail: 'must be less than maxLng' });
  }

  if (errors.length > 0) {
    return { errors };
  }

  return { bbox: { minLat, minLng, maxLat, maxLng } };
}

function emitMapQueryMetric(cellCount: number, occupancyCount: number, hydrantCount: number): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/inspections-map',
            Dimensions: [[]],
            Metrics: [
              { Name: 'MapQueryIssued', Unit: 'Count' },
              { Name: 'CellCount', Unit: 'Count' },
              { Name: 'OccupancyCount', Unit: 'Count' },
              { Name: 'HydrantCount', Unit: 'Count' },
            ],
          },
        ],
      },
      CellCount: cellCount,
      OccupancyCount: occupancyCount,
      HydrantCount: hydrantCount,
      MapQueryIssued: 1,
    }),
  );
}

function emitMapQueryFailedMetric(reason: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/inspections-map',
            Dimensions: [['Reason']],
            Metrics: [{ Name: 'MapQueryFailed', Unit: 'Count' }],
          },
        ],
      },
      Reason: reason,
      MapQueryFailed: 1,
    }),
  );
}

async function handleMapQuery(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  docClient?: DynamoDBDocumentClient,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const parsed = parseBoundingBox(event.queryStringParameters);
  if ('errors' in parsed) {
    return badRequestProblem(
      traceId,
      parsed.errors.map((e) => `${e.field}: ${e.detail}`).join('; '),
    );
  }

  try {
    const deptId = toVerifiedDeptId(principal);
    const cells = coveringCells(parsed.bbox, 5);
    const config = readMapTableConfig(process.env);
    const doc = createDynamoClient(process.env, docClient);
    const result = await queryMapCells(doc, config.tableName, deptId, cells);
    emitMapQueryMetric(cells.length, result.occupancies.length, result.hydrants.length);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    console.error(
      JSON.stringify({
        event: 'inspections-map.query-failed',
        service: 'inspections-service',
        reason,
        message: error instanceof Error ? error.message : undefined,
        correlationId: traceId,
        deptId: principal.deptId,
      }),
    );
    emitMapQueryFailedMetric(reason);
    if (error instanceof RangeError) {
      return badRequestProblem(traceId, `bbox: ${error.message}`);
    }
    return serviceUnavailableProblem(traceId);
  }
}

export interface MapHandlerDeps {
  readonly authzClient?: VerifiedPermissionsClient;
  readonly docClient?: DynamoDBDocumentClient;
}

export function createHandler(
  deps: MapHandlerDeps = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization((event, principal) => handleMapQuery(event, principal, deps.docClient), {
    actionType: 'Boxalarm::Action',
    actionId: 'ViewInspectionsMap',
    resourceType: 'Boxalarm::InspectionsMap',
    resourceId: (event) =>
      toVerifiedDeptId({ deptId: event.requestContext.authorizer.lambda?.deptId ?? '' }),
    ...(deps.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
