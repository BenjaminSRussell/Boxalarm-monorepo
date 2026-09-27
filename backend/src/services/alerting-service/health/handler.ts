import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createHealthHandler, dynamoTableCheck, type ReadinessCheck } from '@boxalarm/health';
import { canaryDateKey, queryLatestCanaryRuns } from '../canary/canaryRunRepository.js';

const SECONDS_PER_DAY = 86_400;

/**
 * The N1.6 canary signal (architecture.md §4.3): ready only if the latest CANARY_RUN passed
 * and is recent. It reads the alerting table alone. A stack with the canary switched off
 * (CANARY_ENABLED unset) has no runs to read, so readiness falls back to the DynamoDB probe.
 */
export function canaryCheck(
  env: NodeJS.ProcessEnv,
  client: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({})),
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): ReadinessCheck {
  return {
    name: 'canary',
    run: async () => {
      if (env.CANARY_ENABLED !== 'true') {
        return true;
      }
      const tableName = env.HEALTH_TABLE_NAME;
      const maxAgeSeconds = Number(env.CANARY_MAX_AGE_SECONDS);
      if (!tableName || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
        throw new Error('HEALTH_TABLE_NAME and a positive CANARY_MAX_AGE_SECONDS are required');
      }
      const deptId = toVerifiedDeptId({ deptId: env.CANARY_DEPT_ID ?? '' });
      const now = nowSeconds();
      // Runs are partitioned by UTC day; just after midnight the latest is in yesterday's.
      let [latest] = await queryLatestCanaryRuns(client, tableName, deptId, canaryDateKey(now), 1);
      if (!latest && now % SECONDS_PER_DAY < maxAgeSeconds) {
        [latest] = await queryLatestCanaryRuns(
          client,
          tableName,
          deptId,
          canaryDateKey(now - SECONDS_PER_DAY),
          1,
        );
      }
      const ranAt = typeof latest?.ranAt === 'number' ? latest.ranAt : undefined;
      return latest?.result === 'PASS' && ranAt !== undefined && now - ranAt <= maxAgeSeconds;
    },
  };
}

// GET /api/v1/alerting/health/{liveness,readiness}: the alerting table and the canary.
export const handler = createHealthHandler({
  service: 'alerting-service',
  readinessChecks: [dynamoTableCheck(process.env), canaryCheck(process.env)],
});
