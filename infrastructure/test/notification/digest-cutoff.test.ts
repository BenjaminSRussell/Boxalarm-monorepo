import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { DIGEST_SCHEDULE_EXPRESSION } from "../../components/notification/digest";
import { PRE_DIGEST_SCANNER_SCHEDULE_EXPRESSION } from "../../components/inventory/daily-scanner";

/**
 * Guards the backend <-> infra timing seam (review minor 4). notification-service buckets a
 * reminder recorded at or after DIGEST_CUTOFF_MINUTES_UTC into the NEXT day's digest
 * (backend repository.ts DIGEST_BUCKET), because the digest job reads only its own day's
 * bucket. That is only correct while the digest runs after the cutoff: move the digest
 * earlier than the cutoff and every reminder recorded between the run and the cutoff lands
 * in a bucket whose run has already passed, and is never sent. The scanners must run
 * before the cutoff for today's reminders to make today's digest.
 */

const REPOSITORY = path.resolve(
  __dirname,
  "../../../backend/src/services/notification-service/repository.ts",
);

function backendCutoffMinutes(): number {
  const source = fs.readFileSync(REPOSITORY, "utf8");
  const match = /DIGEST_CUTOFF_MINUTES_UTC\s*=\s*(\d+)\s*\*\s*60\s*\+\s*(\d+)\s*;/.exec(source);
  if (!match) {
    throw new Error(`DIGEST_CUTOFF_MINUTES_UTC (hours * 60 + minutes) not found in ${REPOSITORY}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes past 00:00 UTC of a daily `cron(M H * * ? *)` Scheduler expression. */
function dailyCronMinutes(expression: string): number {
  const match = /^cron\((\d+) (\d+) \* \* \? \*\)$/.exec(expression);
  if (!match) {
    throw new Error(`not a fixed daily cron: ${expression}`);
  }
  return Number(match[2]) * 60 + Number(match[1]);
}

describe("digest cutoff vs schedules", () => {
  it("reads the backend cutoff (11:55 UTC today)", () => {
    expect(backendCutoffMinutes()).toBe(11 * 60 + 55);
  });

  it("the digest runs after the cutoff, so no recorded reminder lands in an already-run bucket", () => {
    expect(dailyCronMinutes(DIGEST_SCHEDULE_EXPRESSION)).toBeGreaterThan(backendCutoffMinutes());
  });

  it("the reminder scanners run before the cutoff, so today's reminders make today's digest", () => {
    expect(dailyCronMinutes(PRE_DIGEST_SCANNER_SCHEDULE_EXPRESSION)).toBeLessThan(
      backendCutoffMinutes(),
    );
  });
});
