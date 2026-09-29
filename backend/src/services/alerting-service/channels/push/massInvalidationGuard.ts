import { createHash } from 'node:crypto';
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * APNs answers `BadDeviceToken` both for a genuinely dead token and for a token sent to the
 * wrong APNs environment (sandbox vs production) — a per-stack secret setting. Misconfigure
 * it and every iOS member's token looks dead on their first page; invalidating them all would
 * silently strip push from the whole department until each member re-opens the app.
 *
 * So invalidations are counted per department in a fixed window shared by every worker
 * container. Past the threshold the worker stops invalidating and throws instead: the page is
 * redelivered, dead-letters, and the push DLQ alarm pages on-call — a misconfiguration stays
 * loud and recoverable. Real dead tokens arrive one or two at a time (reinstalls), far below it.
 */
export const MASS_INVALIDATION_WINDOW_SECONDS = 300;
export const MASS_INVALIDATION_MAX_TOKENS = 3;
const WINDOW_RETENTION_SECONDS = 24 * 60 * 60;

export class MassTokenInvalidationError extends Error {}

/**
 * Records `token` against the current window and throws MassTokenInvalidationError when the
 * window now holds more than MASS_INVALIDATION_MAX_TOKENS distinct tokens. The same token
 * rejected again (a redelivery) is counted once.
 */
export async function admitTokenInvalidation(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  token: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const windowStart =
    Math.floor(nowMs / 1000 / MASS_INVALIDATION_WINDOW_SECONDS) * MASS_INVALIDATION_WINDOW_SECONDS;
  // Only a short hash is stored: the window item must never become a copy of device tokens.
  const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 16);
  const result = await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(deptId, 'PUSH_TOKEN_INVALIDATION'),
        sk: `WINDOW#${windowStart}`,
      },
      UpdateExpression: 'ADD tokenHashes :hash SET entityType = :entityType, #ttl = :ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':hash': new Set([tokenHash]),
        ':entityType': 'PUSH_TOKEN_INVALIDATION_WINDOW',
        ':ttl': windowStart + WINDOW_RETENTION_SECONDS,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  const hashes = result.Attributes?.tokenHashes as Set<string> | undefined;
  const distinct = hashes?.size ?? 0;
  if (distinct > MASS_INVALIDATION_MAX_TOKENS) {
    throw new MassTokenInvalidationError(
      `push token invalidation refused: ${distinct} distinct tokens rejected in ` +
        `${MASS_INVALIDATION_WINDOW_SECONDS}s exceeds ${MASS_INVALIDATION_MAX_TOKENS} - ` +
        'likely a push gateway misconfiguration (APNs environment or bundle id), not dead devices',
    );
  }
}
