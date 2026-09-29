import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { assertNoDelimiter, buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

interface ContactChannelSnapshot {
  readonly channel: string;
  readonly platform?: string;
  readonly token?: string;
  readonly valid?: boolean;
}

/**
 * APNs/FCM error codes that say the token itself is dead — retrying the same token can never
 * succeed. Shared by the provider-webhook path (pushReceiptHandler) and the push worker, which
 * learns the same fact synchronously from the provider's send response.
 */
export const PERMANENT_INVALID_TOKEN_CODES: ReadonlySet<string> = new Set([
  'BadDeviceToken',
  'Unregistered',
  'UNREGISTERED',
  'INVALID_ARGUMENT',
]);

export type InvalidatePushTokenResult = 'invalidated' | 'no_match';

const MAX_ATTEMPTS = 3;

/**
 * Marks the member's PUSH contact entry `valid: false` in the alerting eligibility snapshot,
 * but only while that entry still carries `token` — a device that re-registered a fresh token
 * in the meantime must not be disabled by a rejection of its old one. Every other channel is
 * preserved. Guarded on snapshotUpdatedAt so a concurrent snapshot write is never overwritten;
 * a lost race re-reads and retries.
 */
export async function invalidatePushToken(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  token: string,
): Promise<InvalidatePushTokenResult> {
  assertNoDelimiter(memberId, 'memberId');
  const pk = buildDeptScopedPk(deptId, 'ELIGIBILITY');
  const sk = `MEMBER#${memberId}`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const existing = await client.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
    const currentChannels =
      (existing.Item?.contactChannels as ContactChannelSnapshot[] | undefined) ?? [];
    const pushEntry = currentChannels.find((entry) => entry.channel === 'PUSH');
    if (!existing.Item || !pushEntry || pushEntry.token !== token) {
      return 'no_match';
    }

    const snapshotUpdatedAt = existing.Item.snapshotUpdatedAt as number | undefined;
    const contactChannels = currentChannels.map((entry) =>
      entry.channel === 'PUSH' ? { ...entry, valid: false } : entry,
    );

    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk, sk },
          UpdateExpression: 'SET contactChannels = :contactChannels',
          ConditionExpression:
            snapshotUpdatedAt === undefined
              ? 'attribute_exists(pk) AND attribute_not_exists(snapshotUpdatedAt)'
              : 'attribute_exists(pk) AND snapshotUpdatedAt = :snapshotUpdatedAt',
          ExpressionAttributeValues:
            snapshotUpdatedAt === undefined
              ? { ':contactChannels': contactChannels }
              : { ':contactChannels': contactChannels, ':snapshotUpdatedAt': snapshotUpdatedAt },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        continue;
      }
      throw error;
    }
    return 'invalidated';
  }

  throw new Error(`push token invalidation for member ${memberId} lost a repeated write race`);
}
