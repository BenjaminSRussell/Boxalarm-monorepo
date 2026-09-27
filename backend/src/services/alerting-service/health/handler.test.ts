import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { canaryCheck } from './handler.js';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const docMock = mockClient(doc);
const signal = new AbortController().signal;

// 2026-09-27T12:00:00Z
const NOON = Date.UTC(2026, 8, 27, 12) / 1000;
// 2026-09-27T00:02:00Z
const JUST_AFTER_MIDNIGHT = Date.UTC(2026, 8, 27, 0, 2) / 1000;

const ENABLED = {
  CANARY_ENABLED: 'true',
  CANARY_DEPT_ID: 'nichols-fd',
  CANARY_MAX_AGE_SECONDS: '600',
  HEALTH_TABLE_NAME: 'alerting-table',
};

function run(env: NodeJS.ProcessEnv, now: number): Promise<boolean> {
  return canaryCheck(env, doc, () => now).run(signal);
}

beforeEach(() => {
  docMock.reset();
});

describe('alerting readiness canary check', () => {
  it('passes without reading anything when the canary is switched off', async () => {
    await expect(run({ HEALTH_TABLE_NAME: 'alerting-table' }, NOON)).resolves.toBe(true);
    expect(docMock.calls()).toHaveLength(0);
  });

  it("passes on a recent PASS, reading only today's canary partition", async () => {
    docMock.on(QueryCommand).resolves({ Items: [{ result: 'PASS', ranAt: NOON - 120 }] });

    await expect(run(ENABLED, NOON)).resolves.toBe(true);

    const input = docMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.TableName).toBe('alerting-table');
    expect(input?.ExpressionAttributeValues).toEqual({
      ':pk': 'DEPT#nichols-fd#CANARY#2026-09-27',
    });
    expect(input?.Limit).toBe(1);
    expect(input?.ScanIndexForward).toBe(false);
  });

  it('fails when the latest run is a FAIL', async () => {
    docMock.on(QueryCommand).resolves({ Items: [{ result: 'FAIL', ranAt: NOON - 60 }] });
    await expect(run(ENABLED, NOON)).resolves.toBe(false);
  });

  it('fails when the latest PASS is older than CANARY_MAX_AGE_SECONDS', async () => {
    docMock.on(QueryCommand).resolves({ Items: [{ result: 'PASS', ranAt: NOON - 601 }] });
    await expect(run(ENABLED, NOON)).resolves.toBe(false);
  });

  it('fails when an enabled canary has no runs today', async () => {
    docMock.on(QueryCommand).resolves({ Items: [] });
    await expect(run(ENABLED, NOON)).resolves.toBe(false);
    expect(docMock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it("falls back to yesterday's partition just after UTC midnight", async () => {
    docMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': 'DEPT#nichols-fd#CANARY#2026-09-27' },
      })
      .resolves({ Items: [] })
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': 'DEPT#nichols-fd#CANARY#2026-09-26' },
      })
      .resolves({ Items: [{ result: 'PASS', ranAt: JUST_AFTER_MIDNIGHT - 100 }] });

    await expect(run(ENABLED, JUST_AFTER_MIDNIGHT)).resolves.toBe(true);
  });

  it('rejects (not ready) when the enabled canary is missing its max age', async () => {
    await expect(run({ ...ENABLED, CANARY_MAX_AGE_SECONDS: '' }, NOON)).rejects.toThrow(
      /CANARY_MAX_AGE_SECONDS/,
    );
  });
});
