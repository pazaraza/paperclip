import { describe, expect, it } from "vitest";
import {
  REAPER_ORPHANED_RUN_ERROR_CODE,
  isHeartbeatRunTerminalStatus,
  resolveHeartbeatRunOutcome,
  resolveTaskSessionLastError,
} from "./heartbeat-run-outcome.js";

describe("heartbeat run outcome", () => {
  it("keeps a terminal status written by another writer", () => {
    const resolution = resolveHeartbeatRunOutcome({
      priorStatus: "cancelled",
      priorErrorCode: "cancelled",
      adapterTimedOut: true,
      adapterExitCode: 130,
    });

    expect(resolution.outcome).toBe("cancelled");
    expect(resolution.preemptingFinalization).toBeNull();
  });

  it("labels a wall-clock death as timed_out when the reaper preempted the row", () => {
    const resolution = resolveHeartbeatRunOutcome({
      priorStatus: "failed",
      priorErrorCode: REAPER_ORPHANED_RUN_ERROR_CODE,
      priorError: "Process lost -- server may have restarted",
      priorFinishedAt: new Date("2026-10-23T15:12:05.949Z"),
      startedAt: new Date("2026-10-23T15:06:37.237Z"),
      adapterTimedOut: true,
      adapterExitCode: 130,
    });

    expect(resolution.outcome).toBe("timed_out");
    expect(resolution.preemptingFinalization).toEqual({
      errorCode: "process_lost",
      error: "Process lost -- server may have restarted",
      finishedAt: "2026-10-23T15:12:05.949Z",
      elapsedMs: 328712,
    });
  });

  it("does not let the reaper preempt a genuine adapter failure", () => {
    const resolution = resolveHeartbeatRunOutcome({
      priorStatus: "failed",
      priorErrorCode: REAPER_ORPHANED_RUN_ERROR_CODE,
      priorFinishedAt: new Date("2026-10-23T15:12:05.949Z"),
      startedAt: new Date("2026-10-23T15:06:37.237Z"),
      adapterTimedOut: false,
      adapterExitCode: 1,
      adapterErrorMessage: "boom",
    });

    expect(resolution.outcome).toBe("failed");
    expect(resolution.preemptingFinalization).toBeNull();
  });

  it("labels a wall-clock death as timed_out when no other writer got there first", () => {
    const resolution = resolveHeartbeatRunOutcome({
      priorStatus: "running",
      adapterTimedOut: true,
      adapterExitCode: 130,
    });

    expect(resolution.outcome).toBe("timed_out");
    expect(resolution.preemptingFinalization).toBeNull();
  });

  it("labels a clean adapter return as succeeded", () => {
    const resolution = resolveHeartbeatRunOutcome({
      priorStatus: "running",
      adapterTimedOut: false,
      adapterExitCode: 0,
    });

    expect(resolution.outcome).toBe("succeeded");
  });

  it("labels a failing adapter return as failed", () => {
    const resolution = resolveHeartbeatRunOutcome({
      priorStatus: "running",
      adapterTimedOut: false,
      adapterExitCode: 1,
      adapterErrorMessage: "boom",
    });

    expect(resolution.outcome).toBe("failed");
  });

  it("recognises the terminal statuses", () => {
    expect(isHeartbeatRunTerminalStatus("timed_out")).toBe(true);
    expect(isHeartbeatRunTerminalStatus("failed")).toBe(true);
    expect(isHeartbeatRunTerminalStatus("running")).toBe(false);
    expect(isHeartbeatRunTerminalStatus(null)).toBe(false);
  });
  it("files a wall-clock death on the task session as a timeout, not a run failure", () => {
    expect(
      resolveTaskSessionLastError({
        outcome: "timed_out",
        adapterErrorMessage: null,
      }),
    ).toBe("timeout");
  });

  it("keeps the adapter error message on the task session for a genuine failure", () => {
    expect(
      resolveTaskSessionLastError({
        outcome: "failed",
        adapterErrorMessage: "Adapter failed",
      }),
    ).toBe("Adapter failed");
  });

  it("falls back to run_failed for a failure with no adapter message", () => {
    expect(
      resolveTaskSessionLastError({
        outcome: "failed",
        adapterErrorMessage: null,
      }),
    ).toBe("run_failed");
  });

  it("clears the task session error on success", () => {
    expect(
      resolveTaskSessionLastError({
        outcome: "succeeded",
        adapterErrorMessage: null,
      }),
    ).toBeNull();
  });
});
