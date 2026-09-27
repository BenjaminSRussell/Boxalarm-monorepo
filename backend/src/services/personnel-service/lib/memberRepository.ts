import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { VerifiedPrincipal } from '@boxalarm/dept-scope';
import type { MemberStatus, SettableStatus } from './statusTransitions.js';

export type MemberRole = 'MEMBER' | 'OFFICER' | 'TRAINING' | 'APPARATUS' | 'ADMIN' | 'CHIEF';

export interface Member {
  readonly memberId: string;
  readonly deptId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly email: string;
  readonly status: MemberStatus;
  readonly joinDate: string;
  readonly rank: string;
  readonly agencyId: string;
  readonly roles: readonly MemberRole[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewMemberInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly email: string;
  readonly joinDate: string;
  readonly rank: string;
  readonly agencyId: string;
}

export interface StatusChangeResult {
  readonly updatedAt: number;
  readonly eventId: string;
}

let cachedDocClient: DynamoDBDocumentClient | undefined;

function getDocClient(): DynamoDBDocumentClient {
  cachedDocClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedDocClient;
}

function toMember(item: Record<string, unknown>): Member {
  return {
    memberId: item.memberId as string,
    deptId: item.deptId as string,
    firstName: item.firstName as string,
    lastName: item.lastName as string,
    phone: item.phone as string,
    email: item.email as string,
    status: item.status as MemberStatus,
    joinDate: item.joinDate as string,
    rank: item.rank as string,
    agencyId: item.agencyId as string,
    roles: item.roles as MemberRole[],
    createdAt: item.createdAt as number,
    updatedAt: item.updatedAt as number,
  };
}

/** memberId is the member's Cognito `sub` (see memberLogin.ts), never a generated id. */
export async function createMember(
  tableName: string,
  principal: VerifiedPrincipal,
  input: NewMemberInput,
  actorId: string,
  memberId: string,
): Promise<Member> {
  const deptId = toVerifiedDeptId(principal);
  const now = Date.now();
  const changedAt = new Date(now).toISOString();
  const auditDate = changedAt.slice(0, 10);
  const member: Member = {
    memberId,
    deptId,
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    email: input.email,
    status: 'PROBATIONARY',
    joinDate: input.joinDate,
    rank: input.rank,
    agencyId: input.agencyId,
    roles: ['MEMBER'],
    createdAt: now,
    updatedAt: now,
  };

  await getDocClient().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
              sk: 'METADATA',
              entityType: 'MEMBER',
              gsi3pk: buildDeptScopedPk(deptId, 'MEMBER'),
              gsi3sk: `${member.lastName}#${memberId}`,
              ...member,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: buildDeptScopedPk(deptId, 'AUDIT', auditDate),
              sk: `${now}#MEMBER#${memberId}#${actorId}`,
              entityType: 'AUDIT_LOG_ENTRY',
              mutatedEntityType: 'MEMBER',
              mutatedEntityId: memberId,
              action: 'CREATE',
              actorId,
              changedFields: {
                status: { old: null, new: 'PROBATIONARY' },
                rank: { old: null, new: input.rank },
                agencyId: { old: null, new: input.agencyId },
              },
              ts: now,
              gsi3pk: buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', 'MEMBER', memberId),
              gsi3sk: changedAt,
            },
            ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          },
        },
      ],
    }),
  );

  return member;
}

export async function getMember(
  tableName: string,
  principal: VerifiedPrincipal,
  memberId: string,
): Promise<Member | undefined> {
  const deptId = toVerifiedDeptId(principal);
  const result = await getDocClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: 'METADATA' },
    }),
  );
  return result.Item ? toMember(result.Item) : undefined;
}

export async function listMembers(
  tableName: string,
  principal: VerifiedPrincipal,
): Promise<Member[]> {
  const deptId = toVerifiedDeptId(principal);
  const members: Member[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await getDocClient().send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'MEMBER') },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    members.push(...(result.Items ?? []).map(toMember));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return members;
}

export async function updateMemberStatus(
  tableName: string,
  principal: VerifiedPrincipal,
  memberId: string,
  previousStatus: MemberStatus,
  newStatus: SettableStatus,
  actorId: string,
): Promise<StatusChangeResult> {
  const deptId = toVerifiedDeptId(principal);
  const now = Date.now();
  const eventId = randomUUID();
  const changedAt = new Date(now).toISOString();
  const auditDate = changedAt.slice(0, 10);

  await getDocClient().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName,
            Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: 'METADATA' },
            ConditionExpression: '#status = :previousStatus',
            UpdateExpression: 'SET #status = :newStatus, updatedAt = :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':previousStatus': previousStatus,
              ':newStatus': newStatus,
              ':now': now,
            },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: buildDeptScopedPk(deptId, 'AUDIT', auditDate),
              sk: `${now}#MEMBER#${memberId}#${actorId}`,
              entityType: 'AUDIT_LOG_ENTRY',
              mutatedEntityType: 'MEMBER',
              mutatedEntityId: memberId,
              action: 'UPDATE',
              actorId,
              changedFields: { status: { old: previousStatus, new: newStatus } },
              ts: now,
              gsi3pk: buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', 'MEMBER', memberId),
              gsi3sk: changedAt,
            },
            ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: buildDeptScopedPk(deptId, 'OUTBOX', memberId),
              sk: `EVT#${eventId}`,
              entityType: 'OUTBOX_ENTRY',
              eventId,
              eventTime: changedAt,
              eventType: 'personnel.member.updated',
              source: 'personnel-service',
              correlationId: memberId,
              schemaVersion: '1.0',
              payload: { memberId, deptId, previousStatus, newStatus, actorId, changedAt },
              status: 'PENDING',
              // ponytail: outbox relay left unbuilt (durable OUTBOX_ENTRY write only); upgrade
              // path is a DynamoDB Streams -> EventBridge Lambda once a ticket owns it (see
              // plan.md §3, §16) — no ttl here so an unpublished entry is never silently dropped.
            },
          },
        },
      ],
    }),
  );

  return { updatedAt: now, eventId };
}
