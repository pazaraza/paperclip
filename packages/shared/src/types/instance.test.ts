import { describe, expect, it } from "vitest";
import {
  DAILY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  MONTHLY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
} from "./instance.js";

/**
 * Regression guards for the default backup retention policy.
 *
 * Discovered during RUAAAAA-3132 (disk at 99% — 168 hourly backups kept
 * because `dailyDays: 7` is incompatible with the default hourly cadence).
 * Fix landed in RUAAAAA-3133.
 *
 * The intent of these tests is two-fold:
 *
 *  1. Catch any accidental revert of `dailyDays` from `3` back to `7` (the
 *     value that produced the disk-fill incident in the first place).
 *  2. Catch any policy expansion that would push steady-state file count
 *     past a safe budget. We use a conservative file budget rather than
 *     asserting on bytes because DB sizes vary and bytes asserted in a unit
 *     test would have to track a moving target.
 *
 * When changing any of these defaults, also update the JSDoc on
 * `DEFAULT_BACKUP_RETENTION` and link the new issue so the rationale chain
 * stays discoverable.
 */

describe("DEFAULT_BACKUP_RETENTION (RUAAAAA-3133 guard)", () => {
  it("pins dailyDays to the smallest preset", () => {
    expect(DEFAULT_BACKUP_RETENTION.dailyDays).toBe(
      Math.min(...DAILY_RETENTION_PRESETS),
    );
  });

  it("does not regress dailyDays to 7 (the value behind RUAAAAA-3132)", () => {
    expect(DEFAULT_BACKUP_RETENTION.dailyDays).toBeLessThan(7);
  });

  it("stays within the validator preset sets", () => {
    expect(DAILY_RETENTION_PRESETS).toContain(DEFAULT_BACKUP_RETENTION.dailyDays);
    expect(WEEKLY_RETENTION_PRESETS).toContain(DEFAULT_BACKUP_RETENTION.weeklyWeeks);
    expect(MONTHLY_RETENTION_PRESETS).toContain(DEFAULT_BACKUP_RETENTION.monthlyMonths);
  });

  it("keeps steady-state backup file count under 80 at hourly cadence", () => {
    // daily tier: dailyDays * 24 hourly backups per day
    // weekly tier: weeklyWeeks weekly buckets retained
    // monthly tier: monthlyMonths monthly buckets retained
    const dailyTierFiles = DEFAULT_BACKUP_RETENTION.dailyDays * 24;
    const weeklyTierFiles = DEFAULT_BACKUP_RETENTION.weeklyWeeks;
    const monthlyTierFiles = DEFAULT_BACKUP_RETENTION.monthlyMonths;
    const steadyStateFiles = dailyTierFiles + weeklyTierFiles + monthlyTierFiles;

    // Old default (dailyDays: 7) produced 168 + 4 + 1 = 173 files (~57 GB).
    // The fix caps the upper bound at 80 to leave headroom for DB growth.
    expect(steadyStateFiles).toBeLessThanOrEqual(80);
  });
});
