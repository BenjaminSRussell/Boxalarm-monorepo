import { createHash } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * APNs answers `BadDeviceToken` both for a genuinely dead token and for a token sent to the
 * wrong APNs environment (sandbox vs production) — a per-stack secret setting. Misconfigure
 * it and every iOS member's token looks dead on their first page; invalidating them all would
 * silently strip push from the whole department until each member re-opens the app.
 *
 * So invalidations are rationed per department, shared by every worker container:
 * - Each token about to be invalidated is counted in a 5-minute window. The threshold applies to
 *   the current and previous window together, so a burst straddling a window boundary is still
 *   one burst.
 * - Past MASS_INVALIDATION_MAX_TOKENS distinct tokens the guard TRIPS: it writes a
 *   department-scoped latch and refuses every invalidation while the latch lives (1 hour via
 *   TTL, or until an operator deletes it). Tone 2/3 pages and SQS redeliveries that arrive
 *   later cannot strip more members. A refused invalidation throws, so the page redelivers,
 *   dead-letters and pages on-call.
 * - The first MASS_INVALIDATION_MAX_TOKENS tokens of a burst are invalidated before the trip.
 *   That is the price of letting real dead tokens (reinstalls, one or two at a time) clear
 *   without an operator.
 * Only tokens that would really be invalidated are counted: a rejection of a token the member
 * has since replaced or re-registered never reaches the guard.
 */
export const MASS_INVALIDATION_WINDOW_SECONDS = 300;
export const MASS_INVALIDATION_MAX_TOKENS = 3;
export const MASS_INVALIDATION_LATCH_SECONDS = 60 * 60;
const WINDOW_RETENTION_SECONDS = 24 * 60 * 60;
const LATCH_SK = 'TRIPPED';

export class MassTokenInvalidationError extends Error {}

/**
 * Admits one invalidation of `token`, or throws MassTokenInvalidationError when the guard is
 * (or now becomes) tripped. The same token rejected again (a redelivery) is counted once. Any
 * other error means the guard could not decide; the caller must then keep the token.
 */
export async function admitTokenInvalidation(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  token: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const nowSeconds = Math.floor(nowMs / 1000);
  const pk = buildDeptScopedPk(deptId, 'PUSH_TOKEN_INVALIDATION');

  // TTL deletion lags by up to days, so expiry is checked here, not left to DynamoDB.
  const latch = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: LATCH_SK }, ConsistentRead: true }),
  );
  const latchTtl: unknown = latch.Item?.ttl;
  if (latch.Item && (typeof latchTtl !== 'number' || latchTtl > nowSeconds)) {
    throw new MassTokenInvalidationError(
      'push token invalidation refused: the mass-invalidation guard is tripped for this ' +
        'department (a burst of rejected tokens reads as a push gateway misconfiguration). ' +
        `It clears ${MASS_INVALIDATION_LATCH_SECONDS / 60} minutes after tripping, or when an ` +
        `operator deletes the ${LATCH_SK} item.`,
    );
  }

  const windowStart =
    Math.floor(nowSeconds / MASS_INVALIDATION_WINDOW_SECONDS) * MASS_INVALIDATION_WINDOW_SECONDS;
  // Only a short hash is stored: the guard must never become a copy of device tokens.
  const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 16);
  const current = await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk: `WINDOW#${windowStart}` },
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
  const previous = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk, sk: `WINDOW#${windowStart - MASS_INVALIDATION_WINDOW_SECONDS}` },
      ConsistentRead: true,
    }),
  );
  const distinct = new Set([
    ...((current.Attributes?.tokenHashes as Set<string> | undefined) ?? []),
    ...((previous.Item?.tokenHashes as Set<string> | undefined) ?? []),
  ]).size;
  if (distinct <= MASS_INVALIDATION_MAX_TOKENS) {
    return;
  }

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk,
        sk: LATCH_SK,
        entityType: 'PUSH_TOKEN_INVALIDATION_TRIPPED',
        trippedAt: nowSeconds,
        distinctTokens: distinct,
        ttl: nowSeconds + MASS_INVALIDATION_LATCH_SECONDS,
      },
    }),
  );
  throw new MassTokenInvalidationError(
    `push token invalidation refused and guard tripped: ${distinct} distinct tokens rejected ` +
      `within ${(2 * MASS_INVALIDATION_WINDOW_SECONDS) / 60} minutes exceeds ` +
      `${MASS_INVALIDATION_MAX_TOKENS} - likely a push gateway misconfiguration (APNs ` +
      'environment or bundle id), not dead devices',
  );
}
