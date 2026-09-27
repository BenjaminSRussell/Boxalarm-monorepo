import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * "Active" is a recency window, not a lifecycle state. The alerting plane has no
 * cleared/closed state for a DISPATCH_ALERT (toneLadderStatus only tracks the re-tone
 * ladder: COMPLETED means tone 3 evaluated, HALTED_MANUAL means an officer stopped
 * re-toning — the call itself is still working in both cases), and the incident lifecycle
 * that does know when a call clears lives in the incident table, which the alerting
 * plane holds no IAM permission on (N1.5/N1.7 isolation). So an active dispatch is a
 * non-test dispatch dispatched within this window, and the response says so.
 */
export const ACTIVE_WINDOW_SECONDS = 2 * 60 * 60;

/** Pages of the window partition read before giving up; the window holds a handful of items. */
const MAX_PAGES = 5;

export interface ActiveDispatchItem {
  readonly dispatchId: string;
  readonly incidentType?: string;
  readonly address?: string;
  readonly crossStreets?: string;
  readonly dispatchedAt: number;
  readonly toneLadderStatus?: string;
  readonly currentToneSequence?: number;
}

export interface ActiveDispatchPage {
  readonly items: readonly ActiveDispatchItem[];
  readonly truncated: boolean;
}

/**
 * Access pattern 7 (architecture.md §4): GSI2 `gsi2pk = DEPT#{deptId}` ranged on
 * `gsi2sk = DISPATCH#{dispatchedAt}`. Only non-test DISPATCH_ALERT items carry GSI2 keys
 * (dispatches/repository.ts), so self-test pages never appear. Epoch seconds stay ten
 * digits until 2286, so the string range orders the same as the numbers.
 */
export async function queryActiveDispatches(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  nowSeconds: number,
): Promise<ActiveDispatchPage> {
  const items: ActiveDispatchItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'gsi2pk = :gsi2pk AND gsi2sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':gsi2pk': buildDeptScopedPk(deptId),
          ':from': `DISPATCH#${nowSeconds - ACTIVE_WINDOW_SECONDS}`,
          ':to': 'DISPATCH#9999999999',
        },
        ScanIndexForward: false,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((result.Items ?? []) as ActiveDispatchItem[]));
    exclusiveStartKey = result.LastEvaluatedKey;
    pages += 1;
  } while (exclusiveStartKey && pages < MAX_PAGES);
  return { items, truncated: exclusiveStartKey !== undefined };
}
