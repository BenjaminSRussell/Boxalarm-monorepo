import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const DISPATCH_ID = 'NICHOLS-4471-1798000000';
const PK = `DEPT#NICHOLS#DISPATCH#${DISPATCH_ID}`;
const OFFICER = { sub: 'officer-7', deptId: 'NICHOLS', 'cognito:groups': 'OFFICER' };

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function conditionFailed(): Error {
  return Object.assign(new Error('conditional check failed'), {
    name: 'ConditionalCheckFailedException',
  });
}

/**
 * Single-table fake that evaluates the exact conditions these handlers write: halt's
 * ACTIVE-at-this-tone METADATA update, acknowledge's first-writer-wins update, and the
 * attribute_not_exists puts of the mutual-aid port.
 */
function createFakeDdb(seed: readonly FakeItem[], options: { failGets?: boolean } = {}) {
  const items = new Map<string, FakeItem>();
  const keyOf = (key: { pk: string; sk: string }): string => `${key.pk}#${key.sk}`;
  for (const item of seed) {
    items.set(keyOf(item), { ...item });
  }
  const haltConditionHolds = (
    item: FakeItem | undefined,
    values: Record<string, unknown>,
  ): boolean =>
    item !== undefined &&
    (item.toneLadderStatus === undefined || item.toneLadderStatus === values[':active']) &&
    (item.currentToneSequence === undefined || item.currentToneSequence === values[':tone']);
  const applySet = (item: FakeItem, expression: string, values: Record<string, unknown>) => {
    for (const assignment of expression.replace(/^SET /, '').split(',')) {
      const [attr, placeholder] = assignment.split('=').map((part) => part.trim());
      item[attr!] = values[placeholder!];
    }
  };
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    switch (name) {
      case 'GetCommand': {
        if (options.failGets) {
          return Promise.reject(new Error('ddb unavailable'));
        }
        const item = items.get(keyOf(input.Key as { pk: string; sk: string }));
        return Promise.resolve({ Item: item ? { ...item } : undefined });
      }
      case 'QueryCommand': {
        const values = input.ExpressionAttributeValues as Record<string, string>;
        return Promise.resolve({
          Items: [...items.values()].filter((item) => item.pk === values[':pk']),
        });
      }
      case 'PutCommand': {
        const put = input as { Item: FakeItem; ConditionExpression?: string };
        if (
          put.ConditionExpression?.startsWith('attribute_not_exists') &&
          items.has(keyOf(put.Item))
        ) {
          return Promise.reject(conditionFailed());
        }
        items.set(keyOf(put.Item), put.Item);
        return Promise.resolve({});
      }
      case 'UpdateCommand': {
        const update = input as {
          Key: { pk: string; sk: string };
          UpdateExpression: string;
          ExpressionAttributeValues: Record<string, unknown>;
        };
        const item = items.get(keyOf(update.Key));
        if (!item || item.acknowledgedAt !== undefined) {
          return Promise.reject(conditionFailed());
        }
        applySet(item, update.UpdateExpression, update.ExpressionAttributeValues);
        return Promise.resolve({ Attributes: { ...item } });
      }
      case 'TransactWriteCommand': {
        const txItems = input.TransactItems as ReadonlyArray<Record<string, unknown>>;
        const reasons = txItems.map((txItem) => {
          const put = txItem.Put as { Item: FakeItem; ConditionExpression?: string } | undefined;
          if (put?.ConditionExpression && items.has(keyOf(put.Item))) {
            return { Code: 'ConditionalCheckFailed' };
          }
          const update = txItem.Update as
            | {
                Key: { pk: string; sk: string };
                ExpressionAttributeValues: Record<string, unknown>;
              }
            | undefined;
          if (
            update &&
            !haltConditionHolds(items.get(keyOf(update.Key)), update.ExpressionAttributeValues)
          ) {
            return { Code: 'ConditionalCheckFailed' };
          }
          return { Code: 'None' };
        });
        if (reasons.some((reason) => reason.Code !== 'None')) {
          return Promise.reject(
            Object.assign(new Error('cancelled'), {
              name: 'TransactionCanceledException',
              CancellationReasons: reasons,
            }),
          );
        }
        for (const txItem of txItems) {
          const put = txItem.Put as { Item: FakeItem } | undefined;
          if (put) {
            items.set(keyOf(put.Item), put.Item);
          }
          const update = txItem.Update as
            | {
                Key: { pk: string; sk: string };
                UpdateExpression: string;
                ExpressionAttributeValues: Record<string, unknown>;
              }
            | undefined;
          if (update) {
            applySet(
              items.get(keyOf(update.Key))!,
              update.UpdateExpression,
              update.ExpressionAttributeValues,
            );
          }
        }
        return Promise.resolve({});
      }
      default:
        return Promise.reject(new Error(`fake ddb: unsupported ${name}`));
    }
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, send, items };
}

function authz(decision: 'ALLOW' | 'DENY') {
  const send = vi.fn().mockResolvedValue({ decision: Decision[decision] });
  return { client: { send } as unknown as VerifiedPermissionsClient, send };
}

function buildEvent(
  control: string,
  body?: unknown,
  dispatchId: string | undefined = DISPATCH_ID,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: `POST /api/v1/alerting/dispatches/{dispatchId}/${control}`,
    rawPath: `/api/v1/alerting/dispatches/${dispatchId ?? ''}/${control}`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token-1' },
    pathParameters: dispatchId ? { dispatchId } : undefined,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer: { lambda: OFFICER } },
  } as unknown as GuardEvent;
}

function parse(result: unknown): { statusCode: number; body: Record<string, unknown> } {
  const response = result as { statusCode: number; body: string };
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as Record<string, unknown>,
  };
}

function metadata(overrides: Partial<FakeItem> = {}): FakeItem {
  return {
    pk: PK,
    sk: 'METADATA',
    entityType: 'DISPATCH_ALERT',
    dispatchId: DISPATCH_ID,
    incidentType: 'STRUCTURE_FIRE',
    address: '123 Main St',
    isTest: false,
    toneLadderStatus: 'ACTIVE',
    currentToneSequence: 1,
    ...overrides,
  };
}

function fakeLambda(outcome: string | { functionError: string; errorType?: string } | Error) {
  const send = vi.fn<(command: unknown) => Promise<unknown>>(() => {
    if (outcome instanceof Error) {
      return Promise.reject(outcome);
    }
    if (typeof outcome === 'object') {
      return Promise.resolve({
        FunctionError: outcome.functionError,
        Payload: outcome.errorType
          ? new TextEncoder().encode(
              JSON.stringify({ errorType: outcome.errorType, errorMessage: 'failed' }),
            )
          : undefined,
      });
    }
    return Promise.resolve({
      Payload: new TextEncoder().encode(JSON.stringify({ outcome })),
    });
  });
  return { client: { send } as unknown as LambdaClient, send };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
  process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting-topic.fifo';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'store-1';
  process.env.TONE_EVALUATOR_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:tone-evaluator';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('POST /tone-ladder/advance', () => {
  async function run(
    seed: readonly FakeItem[],
    body: unknown,
    lambdaOutcome: Parameters<typeof fakeLambda>[0] = 'FIRED_MANUAL_OVERRIDE',
    decision: 'ALLOW' | 'DENY' = 'ALLOW',
  ) {
    const ddb = createFakeDdb(seed);
    const lambda = fakeLambda(lambdaOutcome);
    const vp = authz(decision);
    const { createHandler } = await import('./advanceHandler.js');
    const handler = createHandler({
      authzClient: vp.client,
      docClient: ddb.client,
      lambdaClient: lambda.client,
    });
    const result = parse(await handler(buildEvent('tone-ladder/advance', body)));
    return { result, ddb, lambda, vp };
  }

  it('invokes the Tone Evaluator for the next tone with the caller as triggeredBy', async () => {
    const { result, lambda, vp } = await run([metadata()], { expectedCurrentToneSequence: 1 });

    expect(result).toEqual({
      statusCode: 200,
      body: { dispatchId: DISPATCH_ID, toneSequence: 2, outcome: 'FIRED_MANUAL_OVERRIDE' },
    });
    const invoke = (lambda.send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(invoke).toMatchObject({
      FunctionName: 'arn:aws:lambda:us-east-1:1:function:tone-evaluator',
      InvocationType: 'RequestResponse',
    });
    expect(JSON.parse(Buffer.from(invoke.Payload as Uint8Array).toString('utf8'))).toEqual({
      deptId: 'NICHOLS',
      dispatchId: DISPATCH_ID,
      toneSequence: 2,
      manualOverride: { triggeredBy: 'officer-7' },
    });
    expect((vp.send.mock.calls[0]![0] as { input: Record<string, unknown> }).input).toMatchObject({
      action: { actionType: 'Boxalarm::Action', actionId: 'AdvanceToneLadder' },
      resource: { entityType: 'Boxalarm::Dispatch', entityId: DISPATCH_ID },
    });
  });

  it('reads the ladder strongly consistently before deciding', async () => {
    const { ddb } = await run([metadata()], { expectedCurrentToneSequence: 1 });

    expect((ddb.send.mock.calls[0]![0] as { input: Record<string, unknown> }).input).toMatchObject({
      Key: { pk: PK, sk: 'METADATA' },
      ConsistentRead: true,
    });
  });

  it('a stale or repeated request (ladder already moved) is a 409 and invokes nothing', async () => {
    const { result, lambda } = await run([metadata({ currentToneSequence: 2 })], {
      expectedCurrentToneSequence: 1,
    });

    expect(result.statusCode).toBe(409);
    expect(result.body.detail).toMatch(/now at tone 2, not tone 1/);
    expect(lambda.send).not.toHaveBeenCalled();
  });

  it.each([
    ['halted', { toneLadderStatus: 'HALTED_MANUAL' }, /halted/],
    ['completed', { toneLadderStatus: 'COMPLETED', currentToneSequence: 3 }, /already fired/],
  ])('refuses a %s ladder without invoking the evaluator', async (_label, overrides, detail) => {
    const { result, lambda } = await run([metadata(overrides)], {
      expectedCurrentToneSequence: 1,
    });

    expect(result.statusCode).toBe(409);
    expect(result.body.detail).toMatch(detail);
    expect(lambda.send).not.toHaveBeenCalled();
  });

  it('reports the evaluator losing a double-submit race as already fired (409)', async () => {
    const { result } = await run(
      [metadata()],
      { expectedCurrentToneSequence: 1 },
      'SKIPPED_ALREADY_FIRED',
    );

    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({ toneSequence: 2, outcome: 'SKIPPED_ALREADY_FIRED' });
  });

  it.each([
    ['a function error', { functionError: 'Unhandled' }],
    ['an invoke failure', new Error('socket hang up')],
  ])('answers 502 "outcome unknown" on %s, never a success', async (_label, outcome) => {
    const { result } = await run([metadata()], { expectedCurrentToneSequence: 1 }, outcome);

    expect(result.statusCode).toBe(502);
    expect(result.body.detail).toMatch(/Tone 2 may not have reached every member/);
  });

  // Review MINOR-R3: tone 3 reached everyone and committed; only an officer prompt failed.
  it('tells the officer the tone went out when only a mutual-aid prompt failed', async () => {
    const { result } = await run(
      [metadata({ currentToneSequence: 2 })],
      { expectedCurrentToneSequence: 2 },
      { functionError: 'Unhandled', errorType: 'MutualAidPromptIncompleteError' },
    );

    expect(result.statusCode).toBe(502);
    expect(result.body.detail).toMatch(/Tone 3 was sent to every eligible member/);
    expect(result.body.detail).toMatch(/Make the mutual-aid call now/);
  });

  it.each([
    ['no body', undefined],
    ['missing field', {}],
    ['tone 3 (nothing after it)', { expectedCurrentToneSequence: 3 }],
    ['non-integer', { expectedCurrentToneSequence: 1.5 }],
    ['string', { expectedCurrentToneSequence: '1' }],
    ['non-JSON', 'not json'],
  ])('400s a request with %s', async (_label, body) => {
    const { result, lambda } = await run([metadata()], body);

    expect(result.statusCode).toBe(400);
    expect(lambda.send).not.toHaveBeenCalled();
  });

  it('404s an unknown dispatch', async () => {
    const { result, lambda } = await run([], { expectedCurrentToneSequence: 1 });

    expect(result.statusCode).toBe(404);
    expect(lambda.send).not.toHaveBeenCalled();
  });

  it('403s when Cedar denies, before reading or invoking anything', async () => {
    const { result, lambda, ddb } = await run(
      [metadata()],
      { expectedCurrentToneSequence: 1 },
      'FIRED_MANUAL_OVERRIDE',
      'DENY',
    );

    expect(result.statusCode).toBe(403);
    expect(ddb.send).not.toHaveBeenCalled();
    expect(lambda.send).not.toHaveBeenCalled();
  });
});

describe('POST /tone-ladder/halt', () => {
  async function run(seed: readonly FakeItem[], decision: 'ALLOW' | 'DENY' = 'ALLOW') {
    const ddb = createFakeDdb(seed);
    const vp = authz(decision);
    const { createHandler } = await import('./haltHandler.js');
    const handler = createHandler({ authzClient: vp.client, docClient: ddb.client });
    const result = parse(await handler(buildEvent('tone-ladder/halt')));
    return { result, ddb, vp };
  }

  it('halts an active ladder and writes the SKIPPED_MANUALLY_HALTED audit row', async () => {
    const { result, ddb, vp } = await run([metadata()]);

    expect(result).toEqual({
      statusCode: 200,
      body: {
        dispatchId: DISPATCH_ID,
        toneLadder: { status: 'HALTED_MANUAL', currentToneSequence: 1 },
        changed: true,
      },
    });
    expect(ddb.items.get(`${PK}#METADATA`)).toMatchObject({
      toneLadderStatus: 'HALTED_MANUAL',
      nextToneAt: null,
      haltedBy: 'officer-7',
    });
    const audit = [...ddb.items.values()].find((item) => item.sk.startsWith('TONE#2#'));
    expect(audit?.sk).toMatch(/^TONE#2#\d+#SKIPPED_MANUALLY_HALTED$/);
    expect(audit).toMatchObject({
      entityType: 'TONE_EVENT',
      toneSequence: 2,
      outcome: 'SKIPPED_MANUALLY_HALTED',
      triggeredBy: 'officer-7',
    });
    // The fire-guard singleton is never written by a halt.
    expect(ddb.items.has(`${PK}#TONE#2`)).toBe(false);
    expect((vp.send.mock.calls[0]![0] as { input: Record<string, unknown> }).input).toMatchObject({
      action: { actionType: 'Boxalarm::Action', actionId: 'HaltToneLadder' },
      resource: { entityType: 'Boxalarm::Dispatch', entityId: DISPATCH_ID },
    });
  });

  it('is idempotent: a second halt is 200 changed=false and writes no second audit row', async () => {
    const ddb = createFakeDdb([metadata()]);
    const { createHandler } = await import('./haltHandler.js');
    const handler = createHandler({ authzClient: authz('ALLOW').client, docClient: ddb.client });

    await handler(buildEvent('tone-ladder/halt'));
    const second = parse(await handler(buildEvent('tone-ladder/halt')));

    expect(second).toMatchObject({ statusCode: 200, body: { changed: false } });
    expect([...ddb.items.values()].filter((item) => item.entityType === 'TONE_EVENT')).toHaveLength(
      1,
    );
  });

  it('re-reads and halts at the new tone when a scheduled tone lands between read and write', async () => {
    const ddb = createFakeDdb([metadata()]);
    const realSend = ddb.send.getMockImplementation()!;
    let raced = false;
    ddb.send.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'TransactWriteCommand' && !raced) {
        raced = true;
        ddb.items.get(`${PK}#METADATA`)!.currentToneSequence = 2;
      }
      return realSend(command);
    });
    const { createHandler } = await import('./haltHandler.js');
    const handler = createHandler({ authzClient: authz('ALLOW').client, docClient: ddb.client });

    const result = parse(await handler(buildEvent('tone-ladder/halt')));

    expect(result).toMatchObject({
      statusCode: 200,
      body: { toneLadder: { status: 'HALTED_MANUAL', currentToneSequence: 2 }, changed: true },
    });
    const audits = [...ddb.items.values()].filter((item) => item.entityType === 'TONE_EVENT');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ toneSequence: 3 });
  });

  it('409s a completed ladder and leaves it COMPLETED', async () => {
    const { result, ddb } = await run([
      metadata({ toneLadderStatus: 'COMPLETED', currentToneSequence: 3 }),
    ]);

    expect(result.statusCode).toBe(409);
    expect(ddb.items.get(`${PK}#METADATA`)?.toneLadderStatus).toBe('COMPLETED');
  });

  it('halts a legacy record with no ladder fields (defaults ACTIVE / tone 1)', async () => {
    const legacy = metadata();
    delete legacy.toneLadderStatus;
    delete legacy.currentToneSequence;

    const { result } = await run([legacy]);

    expect(result).toMatchObject({ statusCode: 200, body: { changed: true } });
  });

  it('404s an unknown dispatch', async () => {
    expect((await run([])).result.statusCode).toBe(404);
  });

  // The authz client is cached per module instance, so allow and deny need separate tests.
  it('403s a Cedar deny before touching the table', async () => {
    const denied = await run([metadata()], 'DENY');
    expect(denied.result.statusCode).toBe(403);
    expect(denied.ddb.send).not.toHaveBeenCalled();
  });

  it('503s when the table is unavailable', async () => {
    const ddb = createFakeDdb([metadata()], { failGets: true });
    const { createHandler } = await import('./haltHandler.js');
    const handler = createHandler({ authzClient: authz('ALLOW').client, docClient: ddb.client });

    expect(parse(await handler(buildEvent('tone-ladder/halt'))).statusCode).toBe(503);
  });
});

describe('POST /mutual-aid/trigger', () => {
  const officerSnapshot: FakeItem = {
    pk: 'DEPT#NICHOLS#ELIGIBILITY',
    sk: 'MEMBER#officer-1',
    entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
    memberId: 'officer-1',
    active: true,
    quals: [],
    roles: ['OFFICER'],
    contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
    availabilityState: 'AVAILABLE',
    snapshotUpdatedAt: 0,
  };

  async function build(seed: readonly FakeItem[], decision: 'ALLOW' | 'DENY' = 'ALLOW') {
    const ddb = createFakeDdb(seed);
    const snsSend = vi.fn().mockResolvedValue({});
    const vp = authz(decision);
    const { createHandler } = await import('./mutualAidTriggerHandler.js');
    const handler = createHandler({
      authzClient: vp.client,
      docClient: ddb.client,
      snsClient: { send: snsSend } as unknown as SNSClient,
    });
    return { handler, ddb, snsSend, vp };
  }

  // Review MINOR-R9: the partial-prompt branch had no test.
  it('answers 502 with the counts when an officer prompt fails, and a retry prompts only the missed officer', async () => {
    const { handler, snsSend } = await build([metadata(), officerSnapshot]);
    snsSend.mockRejectedValueOnce(new Error('sns unavailable'));

    const first = parse(await handler(buildEvent('mutual-aid/trigger')));

    expect(first.statusCode).toBe(502);
    expect(first.body.detail).toMatch(/Mutual aid is recorded, but 1 of 1 officers could not be/);

    const retry = parse(await handler(buildEvent('mutual-aid/trigger')));

    expect(retry).toMatchObject({ statusCode: 200, body: { created: false, officersNotified: 1 } });
    expect(snsSend).toHaveBeenCalledTimes(2);
  });

  it('records a MANUAL trigger through the mutual-aid port and prompts officers', async () => {
    const { handler, ddb, snsSend, vp } = await build([metadata(), officerSnapshot]);

    const result = parse(await handler(buildEvent('mutual-aid/trigger')));

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        dispatchId: DISPATCH_ID,
        created: true,
        officersNotified: 1,
        adapterUsed: 'OFFICER_MANUAL_PROMPT',
        mutualAid: { reason: 'MANUAL', triggeredBy: 'officer-7', acknowledgedAt: null },
      },
    });
    expect(ddb.items.get(`${PK}#MUTUALAID#SINGLETON`)).toMatchObject({
      entityType: 'MUTUAL_AID_EVENT',
      reason: 'MANUAL',
      triggeredBy: 'officer-7',
    });
    expect(snsSend).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse(
      (snsSend.mock.calls[0]![0] as { input: { Message: string } }).input.Message,
    ) as { eventType: string; payload: Record<string, unknown> };
    expect(prompt).toMatchObject({
      eventType: 'alerting.mutual_aid.triggered',
      payload: { alertKind: 'mutual_aid_prompt', memberId: 'officer-1', address: '123 Main St' },
    });
    expect((vp.send.mock.calls[0]![0] as { input: Record<string, unknown> }).input).toMatchObject({
      action: { actionType: 'Boxalarm::Action', actionId: 'TriggerMutualAid' },
      resource: { entityType: 'Boxalarm::Dispatch', entityId: DISPATCH_ID },
    });
  });

  it('works on a halted ladder (a halt suppresses only the automatic trigger)', async () => {
    const { handler } = await build([
      metadata({ toneLadderStatus: 'HALTED_MANUAL' }),
      officerSnapshot,
    ]);

    const result = parse(await handler(buildEvent('mutual-aid/trigger')));

    expect(result).toMatchObject({ statusCode: 200, body: { created: true } });
  });

  it('a second trigger is 200 created=false with the existing record and prompts nobody again', async () => {
    const { handler, snsSend } = await build([
      metadata(),
      officerSnapshot,
      {
        pk: PK,
        sk: 'MUTUALAID#SINGLETON',
        entityType: 'MUTUAL_AID_EVENT',
        reason: 'TONE_3_PREDICATE_UNMET',
        triggeredAt: 1798000360,
      },
      // officer-1 was already prompted by the first trigger.
      {
        pk: PK,
        sk: 'MAPROMPT#officer-1#PUSH',
        entityType: 'MUTUAL_AID_PROMPT',
        memberId: 'officer-1',
        idempotencyKey: 'dispatch-1#MUTUALAID#officer-1#push',
        sentAt: 1798000361,
      },
    ]);

    const result = parse(await handler(buildEvent('mutual-aid/trigger')));

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        created: false,
        officersNotified: 0,
        mutualAid: { reason: 'TONE_3_PREDICATE_UNMET', triggeredAt: 1798000360 },
      },
    });
    expect(snsSend).not.toHaveBeenCalled();
  });

  it('404s an unknown dispatch without recording anything', async () => {
    const { handler, ddb } = await build([officerSnapshot]);

    expect(parse(await handler(buildEvent('mutual-aid/trigger'))).statusCode).toBe(404);
    expect(ddb.items.has(`${PK}#MUTUALAID#SINGLETON`)).toBe(false);
  });

  it('403s a Cedar deny', async () => {
    const { handler, ddb } = await build([metadata(), officerSnapshot], 'DENY');

    expect(parse(await handler(buildEvent('mutual-aid/trigger'))).statusCode).toBe(403);
    expect(ddb.send).not.toHaveBeenCalled();
  });
});

describe('POST /mutual-aid/acknowledge', () => {
  const requested: FakeItem = {
    pk: PK,
    sk: 'MUTUALAID#SINGLETON',
    entityType: 'MUTUAL_AID_EVENT',
    reason: 'MANUAL',
    triggeredAt: 1798000100,
  };

  async function build(seed: readonly FakeItem[], decision: 'ALLOW' | 'DENY' = 'ALLOW') {
    const ddb = createFakeDdb(seed);
    const vp = authz(decision);
    const { createHandler } = await import('./mutualAidAcknowledgeHandler.js');
    const handler = createHandler({ authzClient: vp.client, docClient: ddb.client });
    return { handler, ddb, vp };
  }

  it('records who confirmed the call, when, and trimmed notes', async () => {
    const { handler, ddb, vp } = await build([requested]);

    const result = parse(
      await handler(buildEvent('mutual-aid/acknowledge', { notes: '  Called Trumbull Center  ' })),
    );

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        changed: true,
        mutualAid: {
          reason: 'MANUAL',
          acknowledgedBy: 'officer-7',
          notes: 'Called Trumbull Center',
        },
      },
    });
    expect(typeof (result.body.mutualAid as { acknowledgedAt: unknown }).acknowledgedAt).toBe(
      'number',
    );
    expect(ddb.items.get(`${PK}#MUTUALAID#SINGLETON`)).toMatchObject({
      acknowledgedBy: 'officer-7',
      notes: 'Called Trumbull Center',
    });
    expect((vp.send.mock.calls[0]![0] as { input: Record<string, unknown> }).input).toMatchObject({
      action: { actionType: 'Boxalarm::Action', actionId: 'AcknowledgeMutualAid' },
      resource: { entityType: 'Boxalarm::Dispatch', entityId: DISPATCH_ID },
    });
  });

  it('accepts no notes', async () => {
    const { handler } = await build([requested]);

    const result = parse(await handler(buildEvent('mutual-aid/acknowledge')));

    expect(result).toMatchObject({ statusCode: 200, body: { mutualAid: { notes: null } } });
  });

  it('a repeat by the same officer returns the stored acknowledgement unchanged', async () => {
    const { handler } = await build([
      { ...requested, acknowledgedBy: 'officer-7', acknowledgedAt: 1798000200, notes: 'first' },
    ]);

    const result = parse(await handler(buildEvent('mutual-aid/acknowledge', { notes: 'second' })));

    expect(result).toMatchObject({
      statusCode: 200,
      body: { changed: false, mutualAid: { notes: 'first', acknowledgedAt: 1798000200 } },
    });
  });

  it('never overwrites another officer’s acknowledgement (409)', async () => {
    const { handler, ddb } = await build([
      { ...requested, acknowledgedBy: 'officer-2', acknowledgedAt: 1798000200, notes: 'first' },
    ]);

    const result = parse(await handler(buildEvent('mutual-aid/acknowledge', { notes: 'second' })));

    expect(result.statusCode).toBe(409);
    expect(ddb.items.get(`${PK}#MUTUALAID#SINGLETON`)).toMatchObject({
      acknowledgedBy: 'officer-2',
      notes: 'first',
    });
  });

  it('409s when mutual aid was never requested', async () => {
    const { handler } = await build([metadata()]);

    const result = parse(await handler(buildEvent('mutual-aid/acknowledge')));

    expect(result.statusCode).toBe(409);
    expect(result.body.detail).toMatch(/has not been requested/);
  });

  it.each([
    ['non-string notes', { notes: 42 }],
    ['over-long notes', { notes: 'x'.repeat(1001) }],
    ['a JSON array', [1]],
  ])('400s %s', async (_label, body) => {
    const { handler, ddb } = await build([requested]);

    expect(parse(await handler(buildEvent('mutual-aid/acknowledge', body))).statusCode).toBe(400);
    expect(ddb.items.get(`${PK}#MUTUALAID#SINGLETON`)?.acknowledgedAt).toBeUndefined();
  });

  it('403s a Cedar deny', async () => {
    const { handler, ddb } = await build([requested], 'DENY');

    expect(parse(await handler(buildEvent('mutual-aid/acknowledge'))).statusCode).toBe(403);
    expect(ddb.send).not.toHaveBeenCalled();
  });
});

describe('dispatchId validation (every control)', () => {
  it.each([
    ['./advanceHandler.js', 'tone-ladder/advance'],
    ['./haltHandler.js', 'tone-ladder/halt'],
    ['./mutualAidTriggerHandler.js', 'mutual-aid/trigger'],
    ['./mutualAidAcknowledgeHandler.js', 'mutual-aid/acknowledge'],
  ])('%s rejects a dispatchId carrying the key delimiter', async (modulePath, control) => {
    const ddb = createFakeDdb([metadata()]);
    const module = (await import(modulePath)) as {
      createHandler: (deps: Record<string, unknown>) => (event: GuardEvent) => Promise<unknown>;
    };
    const handler = module.createHandler({
      authzClient: authz('ALLOW').client,
      docClient: ddb.client,
    });

    const result = parse(
      await handler(buildEvent(control, { expectedCurrentToneSequence: 1 }, 'X#METADATA')),
    );

    expect(result.statusCode).toBe(400);
    expect(ddb.send).not.toHaveBeenCalled();
  });
});
