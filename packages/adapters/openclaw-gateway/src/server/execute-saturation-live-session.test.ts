import { describe, expect, it } from "vitest";
import { buildSaturatedResult } from "./execute.js";

/**
 * RUAAAAA-5299: the saturation fail-fast must say whether the session it walked away from is still
 * alive. It is not a detail — the whole fix hinges on it. If the adapter reports a live session, the
 * server keeps the run non-terminal and schedules no retry; if it does not, the server writes a real
 * failure and the bounded retry fires. Getting this wrong in either direction is a regression, so
 * both directions are pinned here.
 */
describe("buildSaturatedResult live-session reporting (RUAAAAA-5299)", () => {
  const base = {
    stage: "wait" as const,
    reason: "queued_not_started",
    payload: { status: "pending", timeoutPhase: "queue", providerStarted: false },
    elapsedMs: 26_835,
    sliceCount: 3,
    waitTimeoutMs: 600_000,
    retryDelayMs: 120_000,
  };

  it("marks the run non-terminal and names the session when the gateway still owns it", () => {
    const result = buildSaturatedResult({ ...base, liveSessionRunId: "run_abc123" });

    expect(result.sessionLive).toBe(true);
    expect(result.liveSessionRunId).toBe("run_abc123");
    expect(result.errorCode).toBe("openclaw_gateway_saturated");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.timedOut).toBe(false);
    expect(result.errorMeta).toMatchObject({
      saturation: {
        sessionLive: true,
        liveSessionRunId: "run_abc123",
        stage: "wait",
        reason: "queued_not_started",
      },
    });
    // The message has to carry it too: this string is what an operator reads in the run log.
    expect(result.errorMessage).toContain("abandoned wait only");
    expect(result.errorMessage).toContain("run_abc123");
  });

  it("keeps the session terminal-failable when no session survived the adapter", () => {
    const result = buildSaturatedResult({ ...base, liveSessionRunId: null });

    expect(result.sessionLive).toBe(false);
    expect(result.liveSessionRunId).toBeNull();
    expect(result.errorCode).toBe("openclaw_gateway_saturated");
    expect(result.errorMessage).not.toContain("still live");
    expect(result.errorMeta).toMatchObject({ saturation: { sessionLive: false, liveSessionRunId: null } });
  });

  it("keeps the dispatch-stage verdict shaped like the wait-stage one", () => {
    const result = buildSaturatedResult({
      ...base,
      stage: "dispatch",
      elapsedMs: 0,
      sliceCount: 0,
      liveSessionRunId: "run_dispatch",
    });

    expect(result.sessionLive).toBe(true);
    expect(result.errorMeta).toMatchObject({ saturation: { stage: "dispatch", liveSessionRunId: "run_dispatch" } });
  });
});