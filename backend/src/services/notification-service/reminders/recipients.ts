import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { parsePreferenceItem, type NotificationChannelMutes } from '../repository.js';

/**
 * personnel-service statuses (statusTransitions.ts) whose holders receive no role-routed
 * reminder: a member on leave or retired keeps their roles on the record but is not the
 * one who should act on a department's apparatus, supplies or certifications.
 */
const INACTIVE_STATUSES: ReadonlySet<string> = new Set(['LOA', 'RETIRED']);

export interface RosterMember {
  readonly memberId: string;
  readonly email?: string | undefined;
  readonly roles: readonly string[];
}

/** The department's active roster (personnel-service member rows on GSI3), every page. */
export async function loadRoster(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<RosterMember[]> {
  const members: RosterMember[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'MEMBER') },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      if (typeof item.memberId !== 'string' || INACTIVE_STATUSES.has(item.status as string)) {
        continue;
      }
      members.push({
        memberId: item.memberId,
        email: item.email as string | undefined,
        roles: Array.isArray(item.roles) ? (item.roles as string[]) : [],
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return members;
}

/** Everyone holding any of `roles`, each member once. */
export function membersWithRoles(
  roster: readonly RosterMember[],
  roles: readonly string[],
): RosterMember[] {
  return roster.filter((member) => member.roles.some((role) => roles.includes(role)));
}

/** A member's mutes for one preference key; no stored preference means nothing is muted. */
export async function readChannelMutes(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  muteKey: string | null,
): Promise<NotificationChannelMutes> {
  if (muteKey === null) {
    return { push: false, email: false };
  }
  const preference = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
        sk: `NOTIFPREF#${memberId}#${muteKey}`,
      },
    }),
  );
  const channels = parsePreferenceItem(preference.Item)?.channels;
  return { push: channels?.push === true, email: channels?.email === true };
}

/** The member's email on file (their METADATA row). */
export async function readMemberEmail(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
): Promise<string | undefined> {
  const member = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: 'METADATA' },
    }),
  );
  return member.Item?.email as string | undefined;
}
