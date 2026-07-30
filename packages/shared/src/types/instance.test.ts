import { describe, expect, it } from "vitest";
import {
  DAILY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_RUN_LOG_RETENTION,
  MONTHLY_RETENTION_PRESETS,
  RUN_LOG_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
} from "./instance.js";

/**
 * Regression guards for the default backup retention policy.
 *
 * Discovered during RUAAAAA-3132 (disk at 99% — 168 hourly backups kept
 * because `dailyDays: 7` is incompatible with the default hourly cadence).
 * Fix landed in RUAAAAA-3133 (lowered default to `3`).
 *
 * RUAAAAA-3176 extended the schema floor to allow `dailyDays: 1` for
 * operators on tight disks. The default stays at `3` — `1` is intentionally
 * NOT the new default, because a fresh new instance with no operator
 * awareness of its DB growth trajectory still benefits from a 3-day daily
 * tier as a safer baseline.
 *
 * The intent of these tests is three-fold:
 *
 *  1. Catch any accidental revert of `dailyDays` from `3` back to `7` (the
 *     value that produced the disk-fill incident in the first place).
 *  2. Catch any policy expansion that would push steady-state file count
 *     past a safe budget. We use a conservative file budget rather than
 *     asserting on bytes because DB sizes vary and bytes asserted in a unit
 *     test would have to track a moving target.
 *  3. Pin the floor-preset inclusion (`DAILY_RETENTION_PRESETS` must contain
 *     `1`) so future PRs cannot silently remove the option for tight-disk
 *     operators.
 *
 * When changing any of these defaults, also update the JSDoc on
 * `DEFAULT_BACKUP_RETENTION` and link the new issue so the rationale chain
 * stays discoverable.
 */

describe("DEFAULT_BACKUP_RETENTION (RUAAAAA-3133 guard)", () => {
  it("pins dailyDays to 3 (the post-3133 default; not 7, not 1)", () => {
    // Default stays at 3 — see file JSDoc. `1` was added to the preset in
    // RUAAAAA-3176 for operators on tight disks, but is NOT the new default.
    expect(DEFAULT_BACKUP_RETENTION.dailyDays).toBe(3);
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

  it("keeps the dailyDays:1 floor in the preset set (RUAAAAA-3176 guard)", () => {
    // Prevents a future PR from silently removing the tight-disk option
    // added in RUAAAAA-3176. Without this guard, the default-pin and the
    // steady-state-file-count tests would still pass even if the preset
    // silently regressed to [3, 7, 14] and broke the live instance's ability
    // to opt into the smallest tier.
    expect(DAILY_RETENTION_PRESETS).toContain(1);
  });
});

/**
 * Regression guards for the default run-log retention policy.
 *
 * Discovered during the RUAAAAA-3219 work: before this feature the per-run
 * ndjson tree under `instances/default/data/run-logs/<company>/<agent>/<run>.ndjson`
 * had no retention guard at all. The RUAAAAA-3200 audit measured 4.27 GiB /
 * 64,961 files across the 14 active companies, growing at ~25 MiB/day; left
 * alone, the same trajectory would push the live instance into disk-pressure
 * within ~3 months (RUAAAAA-3186 was the emergency).
 *
 * The intent of these tests is two-fold:
 *
 *  1. Pin `retentionDays` to `30` (the preset middle that yields ~1.4 GiB
 *     steady-state at our current rate). Bumping it back up to `60`/`90`
 *     without an explicit override and an update to this guard is a build
 *     failure waiting to happen.
 *  2. Pin the preset set membership so a future PR cannot silently remove
 *     `7` (the tight-disk option) or grow the set past `90` (which would
 *     erase the disk-pressure protection entirely for operators).
 *
 * If the right answer is `retentionDays > 30` for your deployment, update
 * the comment above and link the new issue — same procedure as
 * `DEFAULT_BACKUP_RETENTION`.
 */
describe("DEFAULT_RUN_LOG_RETENTION (RUAAAAA-3219 guard)", () => {
  it("pins retentionDays to 30 (the post-3219 default; not 60, not 90)", () => {
    expect(DEFAULT_RUN_LOG_RETENTION.retentionDays).toBe(30);
  });

  it("stays within the validator preset set", () => {
    expect(RUN_LOG_RETENTION_PRESETS).toContain(DEFAULT_RUN_LOG_RETENTION.retentionDays);
  });

  it("caps the maximum retention at 90 days (no-shrink past 90 days guard)", () => {
    expect(Math.max(...RUN_LOG_RETENTION_PRESETS)).toBeLessThanOrEqual(90);
  });

  it("keeps the 7-day floor in the preset set (tight-disk option)", () => {
    // Without `7`, operators on tight disks lose the ability to opt into the
    // smallest retention tier without a code change.
    expect(RUN_LOG_RETENTION_PRESETS).toContain(7);
  });
});
