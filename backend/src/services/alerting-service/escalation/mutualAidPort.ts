import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import {
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
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

const ADAPTER_NAME = 'OFFICER_MANUAL_PROMPT';
const OFFICER_ROLE = 'OFFICER';

async function promptOfficer(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchAlertText,
  officer: EligibilitySnapshotItem,
): Promise<boolean> {
  const pushTarget = resolvePushTarget(officer.contactChannels);
  const idempotencyKey = `${dispatchId}#MUTUALAID#${officer.memberId}#push`;
  const item = {
    pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
    sk: `MAPROMPT#${officer.memberId}#PUSH`,
    entityType: 'MUTUAL_AID_PROMPT',
    dispatchId,
    memberId: officer.memberId,
    deptId,
    idempotencyKey,
    sentAt: Math.floor(Date.now() / 1000),
    delivered: !pushTarget.skipped,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return false;
    }
    logError('alerting.mutualAid.promptWriteFailed', error, {
      deptId,
      dispatchId,
      memberId: officer.memberId,
    });
    return false;
  }
  if (pushTarget.skipped) {
    return false;
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
        MessageDeduplicationId: idempotencyKey,
        MessageAttributes: { channel: { DataType: 'String', StringValue: 'push' } },
      }),
    );
    return true;
  } catch (error) {
    logError('alerting.mutualAid.promptPublishFailed', error, {
      deptId,
      dispatchId,
      memberId: officer.memberId,
    });
    return false;
  }
}

export async function requestMutualAid(input: MutualAidRequestInput): Promise<MutualAidResult> {
  const { ddb, sns, tableName, topicArn, deptId, dispatchId, dispatch, reason, triggeredBy } =
    input;
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
  const triggeredAt = Math.floor(Date.now() / 1000);

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
        logInfo('alerting.mutualAid.alreadyRequested', { deptId, dispatchId });
        return { requested: false, officersNotified: 0, adapterUsed: ADAPTER_NAME };
      }
      // Any other cancellation (TransactionConflict, throttling) recorded nothing: rethrow so
      // the caller retries instead of reporting "already requested" when nobody was.
      logError('alerting.mutualAid.eventWriteFailed', error, { deptId, dispatchId });
      throw error;
    }
    logError('alerting.mutualAid.eventWriteFailed', error, { deptId, dispatchId });
    throw error;
  }

  const eligibleMembers = await queryEligibleMembers(ddb, tableName, deptId);
  const officers = eligibleMembers.filter((member) => member.roles.includes(OFFICER_ROLE));

  // promptOfficer already catches its own DynamoDB/SNS failures and resolves to false rather
  // than throwing, so Promise.allSettled here is belt-and-suspenders: one officer's failure
  // (caught or not) must never block or delay the rest of the officer roster being prompted.
  const promptResults = await Promise.allSettled(
    officers.map((officer) =>
      promptOfficer(ddb, sns, tableName, topicArn, deptId, dispatchId, dispatch, officer),
    ),
  );
  let officersNotified = 0;
  promptResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (result.value) {
        officersNotified += 1;
      }
      return;
    }
    logError('alerting.mutualAid.promptFailed', result.reason, {
      deptId,
      dispatchId,
      memberId: officers[index]?.memberId,
    });
  });

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: buildBridgeOutboxRecord(deptId, 'alerting.mutual_aid.triggered', dispatchId, {
          dispatchId,
          triggeredAt,
          reason,
          predicateSnapshot: { officerCount: officers.length },
          adapterUsed: ADAPTER_NAME,
          officersNotified,
        }),
      }),
    );
  } catch (error) {
    logError('alerting.mutualAid.bridgeOutboxWriteFailed', error, { deptId, dispatchId });
  }

  logInfo('alerting.mutualAid.requested', { deptId, dispatchId, reason, officersNotified });
  return { requested: true, officersNotified, adapterUsed: ADAPTER_NAME };
}
