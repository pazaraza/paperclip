import { describe, expect, it } from "vitest";
import { resolveHeartbeatRunOutcome } from "./heartbeat.js";

/**
 * RUAAAAA-5302: the run-status precedence ladder.
 *
 * This ladder is where RUAAAAA-5299's fix was silently switched off. Its comment said `sessionLive`
 * "outranks every terminal verdict below it"; the code said
 * `sessionStillLive && !adapterResult.timedOut`. The two disagreed, the code won, and because
 * RUAAAAA-5299 only wired `sessionLive` to the saturation path — which reports `timedOut: false` —
 * the guard looked harmless. It was not: on the wait-stage `timeout` path both flags are true, so
 * the flag was computed and dropped, and run `0707c344` went terminal `timed_out` over a session
 * that landed its full disposition 9m56s later.
 *
 * The precedence is pinned here because it has now been wrong twice in a row.
 */
describe("resolveHeartbeatRunOutcome (RUAAAAA-5302)", () => {
  const clean = { exitCode: 0, errorMessage: null, timedOut: false };

  it("holds a live-session timeout non-terminal — the RUAAAAA-5302 regression", () => {
    // openclaw_gateway reports `timedOut: true` to mean "I spent my wait budget", not "the
    // provider session died". Both facts are true here and the live one must win, or the run is
    // failed and the bounded retry fires against a snapshot the session has already moved past.
    const outcome = resolveHeartbeatRunOutcome({
      adapterResult: {
        exitCode: 1,
        errorMessage: "OpenClaw gateway run did not complete within waitTimeoutMs=600000ms",
        timedOut: true,
        sessionLive: true,
      },
    });

    expect(outcome).toBe("awaiting_session");
  });

  it("holds a live-session exhausted-cooldown failure non-terminal", () => {
    const outcome = resolveHeartbeatRunOutcome({
      adapterResult: {
        exitCode: 1,
        errorMessage: "OpenClaw gateway run in cooldown",
        timedOut: false,
        sessionLive: true,
      },
    });

    expect(outcome).toBe("awaiting_session");
  });

  it("still times out when no session is live — the other six adapters' local timeout", () => {
    // claude-local, codex-local, cursor-local, gemini-local, opencode-local and pi-local all set
    // `timedOut: true` and never populate `sessionLive`. Their behaviour must be untouched.
    const outcome = resolveHeartbeatRunOutcome({
      adapterResult: { exitCode: 1, errorMessage: "agent timed out", timedOut: true, sessionLive: false },
    });

    expect(outcome).toBe("timed_out");
  });

  it("still times out when sessionLive is null rather than false", () => {
    const outcome = resolveHeartbeatRunOutcome({
      adapterResult: { exitCode: 1, errorMessage: "agent timed out", timedOut: true, sessionLive: null },
    });

    expect(outcome).toBe("timed_out");
  });

  it("lets a terminal status already on the run row win over everything", () => {
    // A cancel or stop that landed mid-run is a fact about the run, not about the adapter's view.
    const outcome = resolveHeartbeatRunOutcome({
      adapterResult: { exitCode: 1, errorMessage: "x", timedOut: true, sessionLive: true },
      latestRunStatus: "cancelled",
    });

    expect(outcome).toBe("cancelled");
  });

  it("preserves the pre-existing verdicts for adapters that do not report sessionLive", () => {
    expect(resolveHeartbeatRunOutcome({ adapterResult: clean })).toBe("succeeded");
    expect(
      resolveHeartbeatRunOutcome({
        adapterResult: { exitCode: 1, errorMessage: "boom", timedOut: false },
      }),
    ).toBe("failed");
    expect(
      resolveHeartbeatRunOutcome({
        adapterResult: { exitCode: 0, errorMessage: null, timedOut: false },
        latestRunStatus: "running",
      }),
    ).toBe("succeeded");
  });

  it("treats an already-terminal run row as terminal even with no adapter result fields", () => {
    const outcome = resolveHeartbeatRunOutcome({
      adapterResult: {},
      latestRunStatus: "failed",
    });

    expect(outcome).toBe("failed");
  });
});