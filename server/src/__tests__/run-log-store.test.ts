import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRunLogStoreForTests, type RunLogStore } from "../services/run-log-store.ts";

/**
 * Regression tests for `RunLogStore.pruneOlderThan` (RUAAAAA-3219).
 *
 * The on-disk shape is `<basePath>/<companyId>/<agentId>/<runId>.ndjson` for
 * the active store and `<basePath>/<orphanRunId>/<agentId>/<file>.ndjson`
 * for pre-migration orphan dirs that pre-date the layout change. Both are
 * structurally identical at the directory level, so the sweep discriminates
 * by:
 *
 *  - The `allowedCompanyIds` allowlist (when provided): top-level dirs not
 *    in the set are skipped entirely (the orphan case).
 *  - Per-`<agentId>/<runId>.ndjson>` mtime check with a strict `< cutoff`
 *    boundary so a file at exactly `now - retentionMs` is preserved.
 *
 * Acceptance criteria from RUAAAAA-3219:
 *  - `getRunLogStore().pruneOlderThan(30*24*3600*1000)` removes files outside
 *    the window ✓ (this test exercises the same `pruneOlderThan` API via
 *    `createRunLogStoreForTests`).
 *  - Live generalSettings.runLogsRetention reads from instance_settings
 *    jsonb without restart ✓ (covered by the index.ts wiring; this file
 *    only tests the store-level behavior).
 *  - Regression: prune does NOT touch orphan dirs ✓.
 *  - Per-company audit: each top-level only sees its own files pruned ✓.
 */

interface FixtureHandles {
  base: string;
  cleanup: () => void;
}

function freshFixture(): FixtureHandles {
  const base = mkdtempSync(join(tmpdir(), "paperclip-run-log-store-test-"));
  return {
    base,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function touchFile(
  filePath: string,
  mtimeMs: number,
  body: string = '{"ts":"2026-07-29T00:00:00.000Z","stream":"stdout","chunk":"x"}\n',
): void {
  // `writeFileSync` does NOT create parent directories on its own, so ensure
  // the path exists up to the leaf before touching the file's mtime.
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, body, "utf8");
  // macOS / Node `utimesSync(path, seconds, nanos)` only reliably maps past
  // dates within a small window; using `Date` objects round-trips cleanly
  // across the full history and lets us pin an exact mtimeMs without drift.
  const d = new Date(mtimeMs);
  utimesSync(filePath, d, d);
}

function seedFile(
  base: string,
  companyId: string,
  agentId: string,
  runId: string,
  mtimeMs: number,
): string {
  const relPath = join(base, companyId, agentId, `${runId}.ndjson`);
  touchFile(relPath, mtimeMs);
  return relPath;
}

function seedOrphanFile(base: string, runId: string, agentId: string, mtimeMs: number): string {
  // Orphans look like <run-id>/<agent-id>/<file>.ndjson — top-level is a
  // run-id, not a real company. The sweep must skip this entire tree.
  const relPath = join(base, runId, agentId, `${runId}.ndjson`);
  touchFile(relPath, mtimeMs);
  return relPath;
}

describe("RunLogStore.pruneOlderThan (RUAAAAA-3219)", () => {
  let fx: FixtureHandles;
  let store: RunLogStore;

  beforeEach(() => {
    fx = freshFixture();
    store = createRunLogStoreForTests(fx.base);
  });

  afterEach(() => {
    fx.cleanup();
  });

  it("deletes only ndjson files older than retentionMs in active store dirs", async () => {
    const now = Date.parse("2026-07-29T12:00:00.000Z");
    const oneDay = 24 * 60 * 60 * 1000;
    const retentionMs = 30 * oneDay;

    // 45-day-old file: should be deleted
    const stale = seedFile(fx.base, "company-aaaa", "agent-1111", "run-stale-001", now - 45 * oneDay);
    // 7-day-old file: should be preserved
    const fresh = seedFile(fx.base, "company-aaaa", "agent-1111", "run-fresh-001", now - 7 * oneDay);
    // Exactly at the boundary (now - retentionMs): preserved (strict `< cutoff`)
    const boundary = seedFile(fx.base, "company-aaaa", "agent-1111", "run-boundary-001", now - retentionMs);
    // Non-ndjson file with stale mtime: must not be touched
    const staleNonNdjson = join(fx.base, "company-aaaa", "agent-1111", "stale.txt");
    touchFile(staleNonNdjson, now - 45 * oneDay, "old");

    const result = await store.pruneOlderThan({
      retentionMs,
      now: () => now,
      allowedCompanyIds: new Set(["company-aaaa"]),
    });

    expect(result.prunedCount).toBe(1);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
    expect(result.hitLimit).toBe(false);
    expect(result.skippedCompanyDirs).toEqual([]);

    // Stale is gone; fresh and boundary survive.
    const { existsSync } = await import("node:fs");
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(boundary)).toBe(true);
    expect(existsSync(staleNonNdjson)).toBe(true);
  });

  it("does not touch orphan top-level dirs (RUAAAAA-3219 acceptance criterion)", async () => {
    const now = Date.parse("2026-07-29T12:00:00.000Z");
    const oneDay = 24 * 60 * 60 * 1000;
    const retentionMs = 7 * oneDay;

    // Active top-level under a real company id.
    const activeStale = seedFile(
      fx.base,
      "company-real-active",
      "agent-real",
      "run-real-active-001",
      now - 30 * oneDay,
    );

    // Orphan: structurally identical `<run-id>/<agent-id>/<file>.ndjson`
    // tree, but top-level is a run-id, NOT in the companies table.
    const orphanStale = seedOrphanFile(
      fx.base,
      "orphan-run-id-orphan",
      "orphan-agent-id-orphan",
      now - 30 * oneDay,
    );

    const result = await store.pruneOlderThan({
      retentionMs,
      now: () => now,
      allowedCompanyIds: new Set(["company-real-active"]),
    });

    // Active file is deleted; orphan entire subtree is preserved untouched.
    expect(result.prunedCount).toBe(1);
    expect(result.skippedCompanyDirs).toContain("orphan-run-id-orphan");

    const { existsSync } = await import("node:fs");
    expect(existsSync(activeStale)).toBe(false);
    expect(existsSync(orphanStale)).toBe(true);
  });

  it("per-company audit: each top-level only sees its own files pruned", async () => {
    const now = Date.parse("2026-07-29T12:00:00.000Z");
    const oneDay = 24 * 60 * 60 * 1000;

    const companyAStale = seedFile(fx.base, "company-a", "agent-a1", "run-a-stale", now - 45 * oneDay);
    const companyAFresh = seedFile(fx.base, "company-a", "agent-a1", "run-a-fresh", now - 5 * oneDay);
    const companyBStale = seedFile(fx.base, "company-b", "agent-b1", "run-b-stale", now - 45 * oneDay);
    const companyBFresh = seedFile(fx.base, "company-b", "agent-b1", "run-b-fresh", now - 5 * oneDay);
    const companyUnknownStale = seedFile(
      fx.base,
      "company-unknown",
      "agent-u1",
      "run-u-stale",
      now - 45 * oneDay,
    );

    const result = await store.pruneOlderThan({
      retentionMs: 30 * oneDay,
      now: () => now,
      allowedCompanyIds: new Set(["company-a", "company-b"]),
    });

    // Two stale files pruned (one per known company); one stale file
    // preserved (unknown company — listed in skipped).
    expect(result.prunedCount).toBe(2);
    expect(result.skippedCompanyDirs).toEqual(["company-unknown"]);

    const { existsSync } = await import("node:fs");
    expect(existsSync(companyAStale)).toBe(false);
    expect(existsSync(companyAFresh)).toBe(true);
    expect(existsSync(companyBStale)).toBe(false);
    expect(existsSync(companyBFresh)).toBe(true);
    expect(existsSync(companyUnknownStale)).toBe(true);
  });

  it("respects maxDeleteCount and returns hitLimit when the cap is reached", async () => {
    const now = Date.parse("2026-07-29T12:00:00.000Z");
    const oneDay = 24 * 60 * 60 * 1000;

    const files: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      files.push(
        seedFile(fx.base, "company-x", "agent-x1", `run-x-stale-${String(i).padStart(3, "0")}`, now - 60 * oneDay),
      );
    }

    const result = await store.pruneOlderThan({
      retentionMs: 30 * oneDay,
      now: () => now,
      allowedCompanyIds: new Set(["company-x"]),
      maxDeleteCount: 4,
    });

    expect(result.hitLimit).toBe(true);
    expect(result.prunedCount).toBe(4);

    const { existsSync } = await import("node:fs");
    const remaining = files.filter((f) => existsSync(f));
    expect(remaining.length).toBe(6);
  });

  it("is a no-op when the base path does not exist yet (fresh instance)", async () => {
    rmSync(fx.base, { recursive: true, force: true });

    const result = await store.pruneOlderThan({
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      allowedCompanyIds: new Set(["company-foo"]),
    });

    expect(result.prunedCount).toBe(0);
    expect(result.bytesReclaimed).toBe(0);
    expect(result.hitLimit).toBe(false);
    expect(result.skippedCompanyDirs).toEqual([]);
  });

  it("rejects non-positive retentionMs rather than deleting the active store", async () => {
    const fresh = seedFile(
      fx.base,
      "company-z",
      "agent-z1",
      "run-z-fresh",
      Date.parse("2026-07-29T00:00:00.000Z"),
    );

    await expect(
      store.pruneOlderThan({
        retentionMs: 0,
        allowedCompanyIds: new Set(["company-z"]),
      }),
    ).rejects.toThrow(/retentionMs/);
    await expect(
      store.pruneOlderThan({
        retentionMs: -1,
        allowedCompanyIds: new Set(["company-z"]),
      }),
    ).rejects.toThrow(/retentionMs/);

    const { existsSync } = await import("node:fs");
    expect(existsSync(fresh)).toBe(true);
  });
});
