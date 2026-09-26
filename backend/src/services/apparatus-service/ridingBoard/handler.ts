import type {
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  notFoundProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
  type ProblemResponse,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { AuthorizerContext } from '../../platform-service/authorizer/handler.js';
import {
  emitApparatusMetric,
  getTraceId,
  problemResponse as apparatusProblemResponse,
  readAuthorizerContext,
} from '../authContext.js';
import { createDynamoClient, readApparatusConfig } from '../client.js';
import { findApparatusItem, logError } from '../repository.js';
import { resolveRidingPosition } from './entity.js';
import {
  assignSeat,
  getRidingBoard,
  getRidingPositionsConfig,
  type AssignSeatOutcome,
} from './repository.js';

const METRICS_NAMESPACE = 'Boxalarm/RidingBoard';

export const getRidingBoardHandler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<
  AuthorizerContext
> = async (event) => {
  const traceId = getTraceId(process.env);

  let deptId;
  try {
    ({ deptId } = readAuthorizerContext(event));
  } catch (error) {
    logError('apparatus.ridingBoard.get.denied', error, { traceId });
    return apparatusProblemResponse(
      401,
      'Unauthorized',
      'A valid department-scoped authorization context is required.',
      traceId,
    );
  }

  const dispatchId = event.pathParameters?.dispatchId;
  if (!dispatchId) {
    return apparatusProblemResponse(
      400,
      'Bad Request',
      'dispatchId path parameter is required.',
      traceId,
    );
  }

  try {
    const client = createDynamoClient(process.env);
    const { tableName } = readApparatusConfig(process.env);
    const board = await getRidingBoard(client, tableName, deptId, dispatchId);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(board),
    };
  } catch (error) {
    logError('apparatus.ridingBoard.get.failed', error, { traceId, deptId, dispatchId });
    emitApparatusMetric('RidingBoardReadFailed');
    return apparatusProblemResponse(
      503,
      'Service Unavailable',
      'Unable to read the riding board.',
      traceId,
    );
  }
};

interface AssignRequestBody {
  readonly unitId?: unknown;
  readonly positionCode?: unknown;
  readonly memberId?: unknown;
  readonly expectedVersion?: unknown;
  readonly clientAssignmentId?: unknown;
}

function problemDetailsResponse(
  status: number,
  type: string,
  title: string,
  detail: string,
  traceId: string,
  extra: Record<string, unknown> = {},
): ProblemResponse {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type, title, status, detail, traceId, ...extra }),
  };
}

function conflictProblem(
  traceId: string,
  current: Extract<AssignSeatOutcome, { kind: 'CONFLICT' }>,
): ProblemResponse {
  return problemDetailsResponse(
    409,
    'https://boxalarm.dev/problems/riding-assignment-conflict',
    'Conflict',
    'This seat was reassigned by another officer before this write landed.',
    traceId,
    { currentAssignment: current.current ?? null },
  );
}

function outOfServiceProblem(traceId: string, reason: string | undefined): ProblemResponse {
  return problemDetailsResponse(
    409,
    'https://boxalarm.dev/problems/apparatus-out-of-service',
    'Conflict',
    'This apparatus is out of service and cannot accept a riding assignment.',
    traceId,
    { reason: reason ?? null },
  );
}

function jsonResponse(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function parseBody(rawBody: string | undefined, traceId: string): AssignRequestBody | undefined {
  if (!rawBody) {
    return undefined;
  }
  try {
    return JSON.parse(rawBody) as AssignRequestBody;
  } catch (error) {
    logError('apparatus.ridingBoard.assign.parseBody.failed', error, { traceId });
    return undefined;
  }
}

async function postAssignment(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const dispatchId = event.pathParameters?.dispatchId;
  if (!dispatchId) {
    return badRequestProblem(traceId, 'dispatchId path parameter is required.');
  }

  const body = parseBody(event.body, traceId);
  if (!body) {
    return badRequestProblem(traceId, 'The request body must be valid JSON.');
  }
  const { unitId, positionCode, memberId, expectedVersion, clientAssignmentId } = body;
  if (typeof unitId !== 'string' || unitId.length === 0) {
    return badRequestProblem(traceId, 'unitId is required and must be a non-empty string.');
  }
  if (typeof positionCode !== 'string' || positionCode.length === 0) {
    return badRequestProblem(traceId, 'positionCode is required and must be a non-empty string.');
  }
  if (memberId !== null && typeof memberId !== 'string') {
    return badRequestProblem(
      traceId,
      'memberId must be a string (the assigned member) or null (vacate).',
    );
  }
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    return badRequestProblem(
      traceId,
      'expectedVersion is required and must be a non-negative integer.',
    );
  }
  if (typeof clientAssignmentId !== 'string' || clientAssignmentId.length === 0) {
    return badRequestProblem(
      traceId,
      'clientAssignmentId is required and must be a non-empty string (offline-replay idempotency key).',
    );
  }

  const deptId = toVerifiedDeptId(principal);
  const client = createDynamoClient(process.env);
  const { tableName } = readApparatusConfig(process.env);

  let apparatus;
  let positionsByType;
  try {
    [apparatus, positionsByType] = await Promise.all([
      findApparatusItem(client, tableName, deptId, unitId),
      getRidingPositionsConfig(client, tableName, deptId),
    ]);
  } catch (error) {
    logError('apparatus.ridingBoard.assign.lookupFailed', error, { traceId, deptId, dispatchId });
    return serviceUnavailableProblem(traceId);
  }

  if (!apparatus) {
    return notFoundProblem(traceId, `No apparatus found with unitId "${unitId}".`);
  }

  const resolution = resolveRidingPosition(apparatus.type, positionsByType, positionCode);
  if (resolution.kind === 'UNKNOWN_POSITION') {
    return badRequestProblem(
      traceId,
      `positionCode "${positionCode}" is not a configured riding position for apparatus type "${apparatus.type}".`,
    );
  }

  try {
    const outcome = await assignSeat(client, tableName, deptId, dispatchId, {
      unitId,
      positionCode,
      memberId,
      expectedVersion,
      clientAssignmentId,
      assignedBy: principal.sub,
    });

    switch (outcome.kind) {
      case 'APPARATUS_NOT_FOUND':
        return notFoundProblem(traceId, `No apparatus found with unitId "${unitId}".`);
      case 'OUT_OF_SERVICE':
        return outOfServiceProblem(traceId, outcome.reason);
      case 'CONFLICT':
        return conflictProblem(traceId, outcome);
      case 'ALREADY_APPLIED':
        return jsonResponse(200, { dispatchId, replayed: true, current: outcome.current ?? null });
      case 'ASSIGNED':
        return jsonResponse(200, {
          dispatchId,
          apparatusId: outcome.apparatusId,
          positionCode: outcome.positionCode,
          memberId: outcome.memberId,
          previousMemberId: outcome.previousMemberId,
          version: outcome.version,
        });
    }
  } catch (error) {
    logError('apparatus.ridingBoard.assign.writeFailed', error, { traceId, deptId, dispatchId });
    emitOutcomeMetric(METRICS_NAMESPACE, 'RidingAssignmentFailed', 'WriteError');
    return serviceUnavailableProblem(traceId);
  }
}

export const assignRidingPositionHandler = withAuthorization(postAssignment, {
  actionType: 'Boxalarm::Action',
  actionId: 'AssignRidingPosition',
  resourceType: 'Boxalarm::RidingBoard',
  resourceId: (event) => event.pathParameters?.dispatchId ?? '',
});
