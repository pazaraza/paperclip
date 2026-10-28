import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";

const tempDirs = [];

function createTempStatusFile(payload: unknown) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-status-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "dev-server-status.json");
  writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dev server status helpers", () => {
  it("reads and normalizes persisted supervisor state", () => {
    const filePath = createTempStatusFile({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 4,
      changedPathsSample: ["server/src/app.ts", "packages/shared/src/index.ts"],
      pendingMigrations: ["0040_restart_banner.sql"],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });

    expect(readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath })).toEqual({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 4,
      changedPathsSample: ["server/src/app.ts", "packages/shared/src/index.ts"],
      pendingMigrations: ["0040_restart_banner.sql"],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });
  });

  it("derives waiting-for-idle health state", () => {
    const health = toDevServerHealthStatus(
      {
        dirty: true,
        lastChangedAt: "2026-03-20T12:00:00.000Z",
        changedPathCount: 2,
        changedPathsSample: ["server/src/app.ts"],
        pendingMigrations: [],
        lastRestartAt: "2026-03-20T11:30:00.000Z",
      },
      { autoRestartEnabled: true, activeRunCount: 3 },
    );

    expect(health).toMatchObject({
      enabled: true,
      restartRequired: true,
      reason: "backend_changes",
      autoRestartEnabled: true,
      activeRunCount: 3,
      waitingForIdle: true,
    });
  });

  it("ABY-919: keys the idle gate on RUNNING runs, not on queued runs", () => {
    // A queued run is persisted work: the startup path calls
    // `resumeQueuedRuns`, so a control-plane restart cannot lose it. It is
    // therefore NOT a reason to defer a restart.
    //
    // The defect this pins: `activeRunCount` counted queued runs too, so on a
    // busy fleet the count never reached zero and an idle-guarded restart
    // could never fire. Measured on this control plane over 10:22Z-16:23Z:
    // zero idle minutes by the queued+running definition (minimum 4 active at
    // every one of 362 one-minute samples), while the running-only definition
    // reached zero on 20 of 723 20-second samples.
    const health = toDevServerHealthStatus(
      {
        dirty: true,
        lastChangedAt: "2026-10-28T12:00:00.000Z",
        changedPathCount: 2,
        changedPathsSample: ["server/src/app.ts"],
        pendingMigrations: [],
        lastRestartAt: "2026-10-28T11:30:00.000Z",
      },
      { autoRestartEnabled: true, activeRunCount: 9, runningRunCount: 0 },
    );

    expect(health).toMatchObject({
      activeRunCount: 9,
      runningRunCount: 0,
      // The queue is deep, but nothing is executing: the instance IS idle for
      // restart purposes, so the gate must be open.
      waitingForIdle: false,
    });
  });

  it("ABY-919: keeps the idle gate closed while a run is actually executing", () => {
    const health = toDevServerHealthStatus(
      {
        dirty: true,
        lastChangedAt: "2026-10-28T12:00:00.000Z",
        changedPathCount: 2,
        changedPathsSample: ["server/src/app.ts"],
        pendingMigrations: [],
        lastRestartAt: "2026-10-28T11:30:00.000Z",
      },
      { autoRestartEnabled: true, activeRunCount: 3, runningRunCount: 1 },
    );

    expect(health).toMatchObject({
      runningRunCount: 1,
      waitingForIdle: true,
    });
  });

  it("ABY-919: falls back to activeRunCount when runningRunCount is absent", () => {
    // Backwards compatibility with an older server that does not report the
    // new field: the gate must still close on a non-zero count rather than
    // treating an unknown count as idle.
    const health = toDevServerHealthStatus(
      {
        dirty: true,
        lastChangedAt: "2026-03-20T12:00:00.000Z",
        changedPathCount: 2,
        changedPathsSample: ["server/src/app.ts"],
        pendingMigrations: [],
        lastRestartAt: "2026-03-20T11:30:00.000Z",
      },
      { autoRestartEnabled: true, activeRunCount: 4 },
    );

    expect(health).toMatchObject({
      runningRunCount: 4,
      waitingForIdle: true,
    });
  });

  it("ignores oversized persisted status files", () => {
    const filePath = createTempStatusFile({
      dirty: true,
      changedPathsSample: ["x".repeat(70 * 1024)],
      pendingMigrations: [],
    });

    expect(readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath })).toBeNull();
  });
});
