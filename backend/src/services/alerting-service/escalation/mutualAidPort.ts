import { createHash } from 'node:crypto';
import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildBridgeOutboxRecord } from '../platformBusBridge.js';
import { queryEligibleMembers, type EligibilitySnapshotItem } from '../eligibility/selector.js';
import { resolvePushTarget } from '../eligibility/resolvePushTarget.js';
import { logError, logInfo } from '../dispatches/logger.js';
import { buildAlertingEnvelope } from './alertingEnvelope.js';
import {
  buildMutualAidPromptPayload,
  type DispatchAlertText,
} from '../channels/channelEnvelope.js';

export type MutualAidReason = 'TONE_3_PREDICATE_UNMET' | 'MANUAL';

export interface MutualAidRequestInput {
  readonly ddb: DynamoDBDocumentClient;
  readonly sns: SNSClient;
  readonly tableName: string;
  readonly topicArn: string;
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  /** The dispatch's METADATA text, so the officer's prompt names the incident it is for. */
  readonly dispatch: DispatchAlertText;
  readonly reason: MutualAidReason;
  /** memberId of the officer who pressed "Trigger mutual aid" — set only for reason MANUAL. */
  readonly triggeredBy?: string;
}

export interface MutualAidResult {
  readonly requested: boolean;
  readonly officersNotified: number;
  readonly adapterUsed: string;
  /**
   * Set when an automatic trigger was not recorded because an officer halted the tone
   * ladder (F1.14: "halting also suppresses automatic mutual-aid triggering").
   */
  readonly suppressedBy?: 'HALTED_MANUAL';
}

const SINGLETON_ITEM_INDEX = 0;
const HALT_CHECK_ITEM_INDEX = 1;

function cancellationCode(error: unknown, index: number): string | undefined {
  const reasons = (error as { CancellationReasons?: ReadonlyArray<{ Code?: string }> })
    .CancellationReasons;
  return reasons?.[index]?.Code;
}

const METRIC_NAMESPACE = 'Boxalarm/Alerting';

/**
 * Thrown after every reachable officer has been prompted when at least one prompt could not
 * be sent, so the caller retries: the Tone Evaluator via its Scheduler retry, a manual
 * trigger via the officer's retry. A repeat is safe - sent prompts are skipped and only the
 * unsent ones go out again.
 */
export class MutualAidPromptIncompleteError extends Error {
  constructor(
    readonly failed: number,
    readonly officers: number,
  ) {
    super(`mutual-aid prompt failed for ${failed} of ${officers} officers`);
    this.name = 'MutualAidPromptIncompleteError';
  }
}

type PromptOutcome = 'SENT' | 'ALREADY_SENT' | 'NO_PUSH_TARGET' | 'FAILED';

const ADAPTER_NAME = 'OFFICER_MANUAL_PROMPT';
/** architecture.md MUTUAL_AID_EVENT.officersNotified: roles containing OFFICER or CHIEF. */
const PROMPTED_ROLES: readonly string[] = ['OFFICER', 'CHIEF'];

/**
 * Claims, publishes, then marks one officer's prompt sent. The claim alone proves nothing:
 * a publish that failed after it left the claim behind, and skipping on the claim meant a
 * retry never prompted that officer. An existing claim is skipped only once sentAt shows it
 * went out; otherwise it is re-published - safe, because the deterministic
 * MessageDeduplicationId collapses repeats inside SNS FIFO's window and the push worker's
 * MAPROMPT send guard collapses them after it.
 */
async function promptOfficer(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchAlertText,
  officer: EligibilitySnapshotItem,
): Promise<PromptOutcome> {
  const pushTarget = resolvePushTarget(officer.contactChannels);
  const idempotencyKey = `${dispatchId}#MUTUALAID#${officer.memberId}#push`;
  const key = {
    pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
    sk: `MAPROMPT#${officer.memberId}#PUSH`,
  };
  const context = { deptId, dispatchId, memberId: officer.memberId };
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...key,
          entityType: 'MUTUAL_AID_PROMPT',
          dispatchId,
          memberId: officer.memberId,
          deptId,
          idempotencyKey,
          claimedAt: Math.floor(Date.now() / 1000),
          delivered: !pushTarget.skipped,
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') {
      logError('alerting.mutualAid.promptWriteFailed', error, context);
      return 'FAILED';
    }
    try {
      const existing = await ddb.send(
        new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
      );
      if (existing.Item?.sentAt) {
        return 'ALREADY_SENT';
      }
    } catch (readError) {
      logError('alerting.mutualAid.promptReadFailed', readError, context);
      return 'FAILED';
    }
  }
  if (pushTarget.skipped) {
    return 'NO_PUSH_TARGET';
  }
  try {
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(
          buildAlertingEnvelope(
            'alerting.mutual_aid.triggered',
            dispatchId,
            buildMutualAidPromptPayload({
              deptId,
              dispatchId,
              memberId: officer.memberId,
              dispatch,
            }),
          ),
        ),
        MessageGroupId: dispatchId,
        // Hashed like every other alerting publish: SNS FIFO allows at most 128 characters
        // from a restricted set, which a raw key with an unusual dispatchId can break.
        MessageDeduplicationId: createHash('sha256').update(idempotencyKey).digest('hex'),
        MessageAttributes: { channel: { DataType: 'String', StringValue: 'push' } },
      }),
    );
  } catch (error) {
    logError('alerting.mutualAid.promptPublishFailed', error, context);
    return 'FAILED';
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: 'SET sentAt = :sentAt',
        ExpressionAttributeValues: { ':sentAt': Math.floor(Date.now() / 1000) },
      }),
    );
  } catch (error) {
    // The prompt went out; a retry may re-publish it, which the dedup id and send guard absorb.
    logError('alerting.mutualAid.promptMarkSentFailed', error, context);
  }
  return 'SENT';
}

/**
 * Emits alerting.mutual_aid.triggered to the LOB bridge exactly once per dispatch, on
 * whichever pass gets there first. Only the attempt that created the singleton used to write
 * it, after prompting - so an attempt that died first, or whose outbox write failed, lost the
 * event for good, since every retry saw "already requested" (review MINOR-7). The singleton's
 * eventRecorded flag and the outbox row are now written together, and every pass tries.
 * Audit, not delivery (architecture: it never blocks a send), so a failure is only logged.
 */
async function recordMutualAidEvent(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk: 'MUTUALAID#SINGLETON' },
              UpdateExpression: 'SET eventRecorded = :recorded',
              ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(eventRecorded)',
              ExpressionAttributeValues: { ':recorded': true },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: buildBridgeOutboxRecord(
                deptId,
                'alerting.mutual_aid.triggered',
                dispatchId,
                payload,
              ),
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (cancellationCode(error, SINGLETON_ITEM_INDEX) === 'ConditionalCheckFailed') {
      return;
    }
    logError('alerting.mutualAid.bridgeOutboxWriteFailed', error, { deptId, dispatchId });
  }
}

export async function requestMutualAid(input: MutualAidRequestInput): Promise<MutualAidResult> {
  const { ddb, sns, tableName, topicArn, deptId, dispatchId, dispatch, reason, triggeredBy } =
    input;
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
  const triggeredAt = Math.floor(Date.now() / 1000);

  let created = true;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk,
                sk: 'MUTUALAID#SINGLETON',
                entityType: 'MUTUAL_AID_EVENT',
                dispatchId,
                deptId,
                reason,
                adapterUsed: ADAPTER_NAME,
                triggeredAt,
                ...(triggeredBy ? { triggeredBy } : {}),
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          // Only the automatic trigger honours a halt; an officer's manual trigger is allowed
          // "at any time" (architecture §1.3a). Checked in the same transaction as the
          // singleton write, so a halt that commits while tone 3 is still fanning out still
          // wins the race.
          ...(reason === 'MANUAL'
            ? []
            : [
                {
                  ConditionCheck: {
                    TableName: tableName,
                    Key: { pk, sk: 'METADATA' },
                    ConditionExpression:
                      'attribute_not_exists(toneLadderStatus) OR toneLadderStatus <> :halted',
                    ExpressionAttributeValues: { ':halted': 'HALTED_MANUAL' },
                  },
                },
              ]),
        ],
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      if (
        cancellationCode(error, SINGLETON_ITEM_INDEX) !== 'ConditionalCheckFailed' &&
        cancellationCode(error, HALT_CHECK_ITEM_INDEX) === 'ConditionalCheckFailed'
      ) {
        logInfo('alerting.mutualAid.suppressedByHalt', { deptId, dispatchId, reason });
        return {
          requested: false,
          officersNotified: 0,
          adapterUsed: ADAPTER_NAME,
          suppressedBy: 'HALTED_MANUAL',
        };
      }
      if (
        cancellationCode(error, SINGLETON_ITEM_INDEX) === undefined ||
        cancellationCode(error, SINGLETON_ITEM_INDEX) === 'ConditionalCheckFailed'
      ) {
        // Already requested - but an earlier attempt may have died before prompting every
        // officer, so fall through to the prompt pass, which skips prompts already sent.
        logInfo('alerting.mutualAid.alreadyRequested', { deptId, dispatchId });
        created = false;
      } else {
        // Any other cancellation (TransactionConflict, throttling) recorded nothing: rethrow so
        // the caller retries instead of reporting "already requested" when nobody was.
        logError('alerting.mutualAid.eventWriteFailed', error, { deptId, dispatchId });
        throw error;
      }
    } else {
      logError('alerting.mutualAid.eventWriteFailed', error, { deptId, dispatchId });
      throw error;
    }
  }

  const eligibleMembers = await queryEligibleMembers(ddb, tableName, deptId);
  const officers = eligibleMembers.filter((member) =>
    member.roles.some((role) => PROMPTED_ROLES.includes(role)),
  );

  // promptOfficer already catches its own DynamoDB/SNS failures and resolves to false rather
  // than throwing, so Promise.allSettled here is belt-and-suspenders: one officer's failure
  // (caught or not) must never block or delay the rest of the officer roster being prompted.
  const promptResults = await Promise.allSettled(
    officers.map((officer) =>
      promptOfficer(ddb, sns, tableName, topicArn, deptId, dispatchId, dispatch, officer),
    ),
  );
  let officersNotified = 0;
  let failed = 0;
  promptResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (result.value === 'SENT') {
        officersNotified += 1;
      } else if (result.value === 'FAILED') {
        failed += 1;
      }
      return;
    }
    failed += 1;
    logError('alerting.mutualAid.promptFailed', result.reason, {
      deptId,
      dispatchId,
      memberId: officers[index]?.memberId,
    });
  });

  await recordMutualAidEvent(ddb, tableName, pk, deptId, dispatchId, {
    dispatchId,
    triggeredAt,
    reason,
    predicateSnapshot: { officerCount: officers.length },
    adapterUsed: ADAPTER_NAME,
    officersNotified,
  });

  if (created && officers.every((o) => resolvePushTarget(o.contactChannels).skipped)) {
    // Recorded, but no officer can be prompted: the mutual-aid call depends on someone
    // noticing. Alarmed (MutualAidNoOfficerReachable) so it is never silent.
    emitOutcomeMetric(METRIC_NAMESPACE, 'MutualAidNoOfficerReachable');
    logError('alerting.mutualAid.noOfficerReachable', new Error('no officer push target'), {
      deptId,
      dispatchId,
      officerCount: officers.length,
    });
  }

  if (failed > 0) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'MutualAidPromptFailed');
    throw new MutualAidPromptIncompleteError(failed, officers.length);
  }

  logInfo('alerting.mutualAid.requested', {
    deptId,
    dispatchId,
    reason,
    created,
    officersNotified,
  });
  return { requested: created, officersNotified, adapterUsed: ADAPTER_NAME };
}
