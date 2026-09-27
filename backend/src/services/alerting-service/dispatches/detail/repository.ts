import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export interface DispatchAlertItem {
  readonly dispatchId: string;
  readonly incidentType: string;
  readonly address: string;
  readonly crossStreets: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly mapLink?: string;
  readonly narrative: string;
  readonly eligibleMemberCount?: number;
  readonly fanOutStartedAt?: number;
  readonly prePlanRefs?: readonly string[];
  readonly toneLadderStatus?: string;
  readonly currentToneSequence?: number;
  readonly nextToneAt?: number | null;
}

export interface PrePlanCopyItem {
  readonly summary: string;
  readonly hazards: readonly string[];
  readonly nearestHydrants: readonly unknown[];
}

export async function getDispatchDetail(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<DispatchAlertItem | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: 'METADATA' },
    }),
  );
  return result.Item as DispatchAlertItem | undefined;
}

/** The MUTUAL_AID_EVENT singleton (architecture §3.1), or undefined if none was requested. */
export async function getMutualAidEvent(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: 'MUTUALAID#SINGLETON' },
    }),
  );
  return result.Item?.entityType === 'MUTUAL_AID_EVENT' ? result.Item : undefined;
}

// Keyed by occupancyId per architecture.md:734 (`sk = OCCUPANCY#{occupancyId}`). The caller
// (handler.ts fetchPrePlan) currently has no occupancyId to give this — see the TODO there.
export async function getPrePlanCopy(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  occupancyId: string,
): Promise<PrePlanCopyItem | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'PREPLAN'), sk: `OCCUPANCY#${occupancyId}` },
    }),
  );
  return result.Item as PrePlanCopyItem | undefined;
}
