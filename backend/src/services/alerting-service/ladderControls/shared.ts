import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { badRequestProblem, type GuardEvent, type ProblemResponse } from '@boxalarm/authz';
import { assertNoDelimiter, buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * Shared plumbing for the four officer ladder-control routes (architecture §2, F1.13/F1.14):
 * POST /dispatches/{dispatchId}/tone-ladder/{advance,halt} and
 * POST /dispatches/{dispatchId}/mutual-aid/{trigger,acknowledge}.
 */

export const LADDER_CONTROL_METRIC_NAMESPACE = 'Boxalarm/Alerting';
/** Emitted (with the control name as Reason) whenever a control fails server-side; alarmed. */
export const LADDER_CONTROL_FAILED_METRIC = 'LadderControlFailed';

export const TONE_LADDER_ACTIVE = 'ACTIVE';
export const TONE_LADDER_HALTED = 'HALTED_MANUAL';
export const TONE_LADDER_COMPLETED = 'COMPLETED';
export const FINAL_TONE_SEQUENCE = 3;

function problem(
  status: number,
  slug: string,
  title: string,
  detail: string,
  traceId: string,
  extensions: Record<string, unknown> = {},
): ProblemResponse {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: `https://boxalarm.dev/problems/${slug}`,
      title,
      status,
      detail,
      traceId,
      ...extensions,
    }),
  };
}

export function conflictProblem(
  traceId: string,
  detail: string,
  extensions: Record<string, unknown> = {},
): ProblemResponse {
  return problem(409, 'conflict', 'Conflict', detail, traceId, extensions);
}

/** The control's outcome is unknown or partial — the caller must re-read state, not assume. */
export function outcomeUnknownProblem(traceId: string, detail: string): ProblemResponse {
  return problem(502, 'outcome-unknown', 'Outcome Unknown', detail, traceId);
}

export function dataUnavailableProblem(traceId: string): ProblemResponse {
  return problem(
    503,
    'service-unavailable',
    'Service Unavailable',
    'The alert data store is temporarily unavailable and did not confirm this request. Refresh the dispatch before trying again.',
    traceId,
  );
}

export function jsonResponse(
  statusCode: number,
  body: unknown,
): {
  statusCode: number;
  headers: { 'content-type': 'application/json' };
  body: string;
} {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export type ParsedDispatchId =
  | { readonly ok: true; readonly dispatchId: string }
  | { readonly ok: false; readonly problem: ProblemResponse };

export function parseDispatchId(event: GuardEvent, traceId: string): ParsedDispatchId {
  const dispatchId = event.pathParameters?.dispatchId;
  if (!dispatchId || dispatchId.trim().length === 0) {
    return {
      ok: false,
      problem: badRequestProblem(traceId, 'dispatchId path parameter is required'),
    };
  }
  try {
    assertNoDelimiter(dispatchId, 'dispatchId');
  } catch {
    return {
      ok: false,
      problem: badRequestProblem(traceId, 'dispatchId path parameter must not contain "#"'),
    };
  }
  return { ok: true, dispatchId };
}

export type ParsedBody =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly problem: ProblemResponse };

/** An absent body is `{}`; anything present must be a JSON object. */
export function parseJsonObjectBody(event: GuardEvent, traceId: string): ParsedBody {
  if (!event.body) {
    return { ok: true, body: {} };
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, body: parsed as Record<string, unknown> };
    }
  } catch {
    // fall through to the 400 below
  }
  return { ok: false, problem: badRequestProblem(traceId, 'request body must be a JSON object') };
}

/**
 * The ladder fields of DISPATCH_ALERT METADATA, with the same defaults the detail route and
 * the Tone Evaluator apply to a record written before these fields existed.
 */
export interface LadderState {
  readonly status: string;
  readonly currentToneSequence: number;
}

export function readLadderState(item: Record<string, unknown>): LadderState {
  return {
    status: typeof item.toneLadderStatus === 'string' ? item.toneLadderStatus : TONE_LADDER_ACTIVE,
    currentToneSequence:
      typeof item.currentToneSequence === 'number' ? item.currentToneSequence : 1,
  };
}

/** Strongly consistent: every control decides on the ladder's committed state. */
export async function getDispatchMetadata(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: 'METADATA' },
      ConsistentRead: true,
    }),
  );
  return result.Item;
}

export async function getMutualAidEvent(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: 'MUTUALAID#SINGLETON' },
      ConsistentRead: true,
    }),
  );
  return result.Item;
}

export interface MutualAidView {
  readonly triggeredAt: number | null;
  readonly reason: string | null;
  readonly triggeredBy: string | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: number | null;
  readonly notes: string | null;
}

/** The officer-facing projection of the MUTUAL_AID_EVENT singleton (never the raw item). */
export function toMutualAidView(item: Record<string, unknown>): MutualAidView {
  const str = (key: string): string | null => (typeof item[key] === 'string' ? item[key] : null);
  const num = (key: string): number | null => (typeof item[key] === 'number' ? item[key] : null);
  return {
    triggeredAt: num('triggeredAt'),
    reason: str('reason'),
    triggeredBy: str('triggeredBy'),
    acknowledgedBy: str('acknowledgedBy'),
    acknowledgedAt: num('acknowledgedAt'),
    notes: str('notes'),
  };
}

export function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}
