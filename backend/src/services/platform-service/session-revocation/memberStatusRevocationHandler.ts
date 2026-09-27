import { UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { Handler, SQSEvent, SQSRecord } from 'aws-lambda';
import {
  createRevocationClient,
  readRevocationConfig,
  revokeMemberSession,
} from './cognitoRevocationClient.js';
import type { RevocationConfig } from './cognitoRevocationClient.js';

const REVOKING_STATUSES = new Set(['LOA', 'RETIRED']);

let cachedClient: CognitoIdentityProviderClient | undefined;

function getClient(): CognitoIdentityProviderClient {
  cachedClient ??= createRevocationClient();
  return cachedClient;
}

interface MemberStatusChangedPayload {
  readonly memberId: string;
  readonly status: string;
  readonly correlationId?: string | undefined;
}

interface MemberStatusEnvelope {
  readonly eventType?: unknown;
  readonly correlationId?: unknown;
  readonly payload?: { memberId?: unknown; status?: unknown };
}

// EventBridge -> SQS delivers its own envelope with the producer payload nested under
// `detail` unless the rule carries an input transformer; accept both shapes so a plain
// domain-envelope body (e.g. from a direct SQS test fixture) and a real EventBridge-wrapped
// body both parse.
function unwrapEnvelope(rawBody: string): MemberStatusEnvelope {
  const parsed: unknown = JSON.parse(rawBody);
  if (parsed && typeof parsed === 'object' && 'detail' in parsed) {
    return parsed.detail ?? parsed;
  }
  return parsed as MemberStatusEnvelope;
}

function safeExtractCorrelationId(record: SQSRecord): string | undefined {
  try {
    const envelope = unwrapEnvelope(record.body);
    return typeof envelope.correlationId === 'string' ? envelope.correlationId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns undefined for a member.updated that is not a status change: profile, push-token
 * and role changes share the event type but carry no `status`, and must not be retried
 * into the DLQ. A `status` that is present but unusable is still malformed.
 */
function parseMemberStatusEvent(record: SQSRecord): MemberStatusChangedPayload | undefined {
  const envelope = unwrapEnvelope(record.body);
  if (envelope.eventType !== 'personnel.member.updated') {
    throw new Error(`unexpected eventType: ${JSON.stringify(envelope.eventType)}`);
  }
  const memberId = envelope.payload?.memberId;
  const status = envelope.payload?.status;
  if (status === undefined) {
    return undefined;
  }
  if (typeof memberId !== 'string' || memberId.trim().length === 0) {
    throw new Error('payload.memberId is required and was not a non-empty string');
  }
  if (typeof status !== 'string' || status.trim().length === 0) {
    throw new Error('payload.status is required and was not a non-empty string');
  }
  const correlationId =
    typeof envelope.correlationId === 'string' ? envelope.correlationId : undefined;
  return { memberId, status, correlationId };
}

export const handler: Handler<SQSEvent, void> = async (event) => {
  let config: RevocationConfig;
  try {
    config = readRevocationConfig(process.env);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'memberStatusRevocation.configError',
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    throw error;
  }
  const { userPoolId } = config;
  const client = getClient();

  // Records are processed concurrently: revokeMemberSession calls are independent, and
  // running them serially made invocation duration grow linearly with batch size while
  // also letting one malformed record block every later record in the same batch.
  const results = await Promise.allSettled(
    event.Records.map(async (record) => {
      let payload: MemberStatusChangedPayload | undefined;
      try {
        payload = parseMemberStatusEvent(record);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'memberStatusRevocation.malformedPayload',
            message: error instanceof Error ? error.message : undefined,
            messageId: record.messageId,
            correlationId: safeExtractCorrelationId(record),
            service: 'platform-service',
          }),
        );
        throw error;
      }

      if (!payload || !REVOKING_STATUSES.has(payload.status)) {
        return;
      }

      try {
        await revokeMemberSession(client, {
          userPoolId,
          username: payload.memberId,
          correlationId: payload.correlationId,
        });
      } catch (error) {
        // UserNotFoundException is not retryable -- no-op instead of DLQ-storming.
        if (error instanceof UserNotFoundException) {
          return;
        }
        throw error;
      }
    }),
  );

  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    throw failure.reason;
  }
};
