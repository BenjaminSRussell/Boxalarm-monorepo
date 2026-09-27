import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';
import { readPersonnelConfig } from '../lib/config.js';
import { problemResponse, resolveTraceId } from '../lib/problemDetails.js';
import { ForbiddenError, requireAdminRole } from '../lib/authz.js';
import { createMember } from '../lib/memberRepository.js';
import type { NewMemberInput } from '../lib/memberRepository.js';
import { logError, logInfo } from '../lib/logger.js';
import {
  MemberLoginExistsError,
  createMemberLogin,
  deleteMemberLogin,
  getCognitoClient,
  readMemberLoginConfig,
} from '../lib/memberLogin.js';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

const REQUIRED_FIELDS = [
  'firstName',
  'lastName',
  'phone',
  'email',
  'joinDate',
  'rank',
  'agencyId',
] as const;

function parseCreateInput(body: string | undefined): NewMemberInput {
  let raw: unknown;
  try {
    raw = body ? JSON.parse(body) : undefined;
  } catch {
    throw new Error('request body must be valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('request body must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  const input: Partial<Record<(typeof REQUIRED_FIELDS)[number], string>> = {};
  for (const field of REQUIRED_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${field} is required and must be a non-empty string`);
    }
    input[field] = value;
  }
  return input as NewMemberInput;
}

function emitMemberCreatedMetric(): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/personnel',
            Dimensions: [[]],
            Metrics: [{ Name: 'MemberCreated', Unit: 'Count' }],
          },
        ],
      },
      MemberCreated: 1,
    }),
  );
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<VerifiedAccessToken> = async (
  event,
) => {
  const ctx = event.requestContext.authorizer.lambda;
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);

  try {
    requireAdminRole(ctx);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      logError('member.create.forbidden', traceId, error, {
        actorId: ctx.sub,
        route: 'POST /members',
      });
      return problemResponse(403, 'Forbidden', error.message, traceId);
    }
    throw error;
  }

  let input: NewMemberInput;
  try {
    input = parseCreateInput(event.body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid request body';
    return problemResponse(400, 'Bad Request', detail, traceId);
  }

  let config;
  let loginConfig;
  try {
    config = readPersonnelConfig(process.env);
    loginConfig = readMemberLoginConfig(process.env);
  } catch (error) {
    logError('member.create.misconfigured', traceId, error);
    return problemResponse(503, 'Service Unavailable', 'unable to create member', traceId);
  }

  // The login comes first: its sub is the memberId (lib/memberLogin.ts).
  const cognito = getCognitoClient();
  let memberId: string;
  try {
    memberId = await createMemberLogin(cognito, loginConfig, {
      email: input.email,
      deptId: toVerifiedDeptId(ctx),
    });
  } catch (error) {
    if (error instanceof MemberLoginExistsError) {
      return problemResponse(409, 'Conflict', error.message, traceId);
    }
    logError('member.create.login_failed', traceId, error);
    return problemResponse(503, 'Service Unavailable', 'unable to create member', traceId);
  }

  try {
    const member = await createMember(config.tableName, ctx, input, ctx.sub, memberId);
    emitMemberCreatedMetric();
    logInfo('member.created', traceId, { memberId: member.memberId });
    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(member),
    };
  } catch (error) {
    logError('member.create.failed', traceId, error);
    try {
      await deleteMemberLogin(cognito, loginConfig, input.email);
    } catch (cleanupError) {
      // The login now exists with no member row; re-adding the member will answer 409.
      logError('member.create.login_orphaned', traceId, cleanupError, { memberId });
    }
    return problemResponse(503, 'Service Unavailable', 'unable to create member', traceId);
  }
};
