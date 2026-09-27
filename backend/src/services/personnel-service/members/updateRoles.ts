import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import { UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';
import { readPersonnelConfig } from '../lib/config.js';
import { problemResponse, resolveTraceId } from '../lib/problemDetails.js';
import { ForbiddenError, requireRoleManager } from '../lib/authz.js';
import { MEMBER_ROLES, getMember, updateMemberRoles } from '../lib/memberRepository.js';
import type { MemberRole } from '../lib/memberRepository.js';
import { getCognitoClient, readMemberLoginConfig, syncRoleGroups } from '../lib/memberLogin.js';
import { logError, logInfo } from '../lib/logger.js';

/**
 * Roles reach the member through their tokens, which the apps renew silently; nothing here
 * signs anyone out, because a login prompt on the alert path is an alerting failure.
 */
const TAKES_EFFECT =
  "The change applies when the member's app next refreshes its session, within one hour.";

/** The full desired role set, deduped, in canonical order, with MEMBER always kept. */
function parseRolesBody(body: string | undefined): MemberRole[] {
  let raw: unknown;
  try {
    raw = body ? JSON.parse(body) : undefined;
  } catch {
    throw new Error('request body must be valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('request body must be a JSON object');
  }
  const roles = (raw as Record<string, unknown>).roles;
  if (!Array.isArray(roles)) {
    throw new Error('roles is required and must be an array');
  }
  for (const role of roles) {
    if (typeof role !== 'string' || !(MEMBER_ROLES as readonly string[]).includes(role)) {
      throw new Error(`roles must contain only: ${MEMBER_ROLES.join(', ')}`);
    }
  }
  return MEMBER_ROLES.filter((role) => role === 'MEMBER' || roles.includes(role));
}

interface TransactionCancellationReason {
  readonly Code?: string;
}

function isConditionalCheckFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') {
    return false;
  }
  const reasons = (error as { CancellationReasons?: readonly TransactionCancellationReason[] })
    .CancellationReasons;
  return (reasons ?? []).some((reason) => reason.Code === 'ConditionalCheckFailed');
}

function sameRoles(a: readonly MemberRole[], b: readonly MemberRole[]): boolean {
  return a.length === b.length && a.every((role) => b.includes(role));
}

function emitRolesMetric(outcome: 'MemberRolesUpdated' | 'MemberRolesUpdateFailed'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/personnel',
            Dimensions: [[]],
            Metrics: [{ Name: outcome, Unit: 'Count' }],
          },
        ],
      },
      [outcome]: 1,
    }),
  );
}

async function reconcileAfterConflict(
  traceId: string,
  tableName: string,
  loginConfig: ReturnType<typeof readMemberLoginConfig>,
  ctx: VerifiedAccessToken,
  memberId: string,
) {
  try {
    const current = await getMember(tableName, ctx, memberId);
    await syncRoleGroups(getCognitoClient(), loginConfig, memberId, current?.roles ?? []);
    logError('member.roles.update.conflict', traceId, new Error('roles changed concurrently'), {
      memberId,
      restoredTo: current?.roles ?? [],
    });
    return current
      ? problemResponse(
          409,
          'Conflict',
          'these roles were changed by someone else while you were editing; reload and try again',
          traceId,
        )
      : problemResponse(404, 'Not Found', `no member found with id ${memberId}`, traceId);
  } catch (error) {
    logError('member.roles.update.reconcile_failed', traceId, error, { memberId });
    emitRolesMetric('MemberRolesUpdateFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'member roles were only partly saved; reload and retry the request to finish',
      traceId,
    );
  }
}

/**
 * PUT /members/{memberId}/roles (F2.7): sets a member's full role set. Cognito groups are
 * synced first and the member row second; if the row write fails after the groups moved,
 * the caller gets 503 and repeating the same PUT converges both.
 */
export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<VerifiedAccessToken> = async (
  event,
) => {
  const ctx = event.requestContext.authorizer.lambda;
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return problemResponse(400, 'Bad Request', 'memberId path parameter is required', traceId);
  }

  try {
    requireRoleManager(ctx);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      logError('member.roles.update.forbidden', traceId, error, {
        actorId: ctx.sub,
        memberId,
        route: 'PUT /members/{memberId}/roles',
      });
      return problemResponse(403, 'Forbidden', error.message, traceId);
    }
    throw error;
  }
  if (memberId === ctx.sub) {
    // Blocks self-escalation and an admin removing their own ADMIN by mistake.
    return problemResponse(403, 'Forbidden', 'you cannot change your own roles', traceId);
  }

  let roles: MemberRole[];
  try {
    roles = parseRolesBody(event.body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid roles';
    return problemResponse(400, 'Bad Request', detail, traceId);
  }

  let config;
  let loginConfig;
  try {
    config = readPersonnelConfig(process.env);
    loginConfig = readMemberLoginConfig(process.env);
  } catch (error) {
    logError('member.roles.update.misconfigured', traceId, error);
    return problemResponse(503, 'Service Unavailable', 'unable to update member roles', traceId);
  }

  let member;
  try {
    member = await getMember(config.tableName, ctx, memberId);
  } catch (error) {
    logError('member.roles.update.read_failed', traceId, error, { memberId });
    emitRolesMetric('MemberRolesUpdateFailed');
    return problemResponse(503, 'Service Unavailable', 'unable to update member roles', traceId);
  }
  if (!member) {
    return problemResponse(404, 'Not Found', `no member found with id ${memberId}`, traceId);
  }

  let groups;
  try {
    groups = await syncRoleGroups(getCognitoClient(), loginConfig, memberId, roles);
  } catch (error) {
    if (error instanceof UserNotFoundException) {
      logError('member.roles.update.no_login', traceId, error, { memberId });
      return problemResponse(409, 'Conflict', `member ${memberId} has no login`, traceId);
    }
    logError('member.roles.update.groups_failed', traceId, error, { memberId });
    emitRolesMetric('MemberRolesUpdateFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'unable to update member roles; retry the same request',
      traceId,
    );
  }

  const previousRoles = member.roles;
  const changed =
    groups.added.length > 0 || groups.removed.length > 0 || !sameRoles(previousRoles, roles);
  if (changed) {
    try {
      await updateMemberRoles(config.tableName, ctx, memberId, previousRoles, roles, ctx.sub);
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        // Another admin changed the roles since this request read them, or the member is
        // gone. Cognito is what grants access, so it must never stay ahead of the row: put
        // the groups back to whatever the row now holds (none if the member is gone).
        return reconcileAfterConflict(traceId, config.tableName, loginConfig, ctx, memberId);
      }
      // The groups already hold the new roles; the row and the alerting snapshot do not.
      logError('member.roles.update.partial', traceId, error, {
        memberId,
        added: groups.added,
        removed: groups.removed,
      });
      emitRolesMetric('MemberRolesUpdateFailed');
      return problemResponse(
        503,
        'Service Unavailable',
        'member roles were only partly saved; retry the same request to finish',
        traceId,
      );
    }
    emitRolesMetric('MemberRolesUpdated');
  }

  logInfo('member.roles.updated', traceId, {
    memberId,
    actorId: ctx.sub,
    changed,
    added: groups.added,
    removed: groups.removed,
  });
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId, roles, changed, takesEffect: TAKES_EFFECT }),
  };
};
