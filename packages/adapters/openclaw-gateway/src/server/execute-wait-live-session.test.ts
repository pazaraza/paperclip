import { describe, expect, it } from "vitest";
import { buildCooldownExhaustedResult, buildWaitTimeoutResult } from "./execute.js";

/**
 * RUAAAAA-5302: the wait-stage `timeout` and exhausted-cooldown paths must say whether the session
 * they walked away from is still alive.
 *
 * They are the two siblings of RUAAAAA-5299's saturation fail-fast. 5299 added `sessionLive` to the
 * adapter contract but only wired it to saturation, and its server-side gate was guarded with
 * `&& !timedOut` — so on these two paths, where `timedOut: true` and a live session are both true,
 * the flag was computed and discarded. Run `0707c344` went terminal `timed_out` at 22:13:54.718Z and
 * its session landed the full disposition 9m56s later.
 *
 * Both directions are pinned everywhere: reporting `live` when nothing is live strands the run, and
 * reporting `dead` when something is live is the original bug.
 */
describe("buildWaitTimeoutResult live-session reporting (RUAAAAA-5302)", () => {
  const base = {
    payload: { status: "timeout" },
    elapsedMs: 136_182,
    sliceCount: 24,
    maxSlices: 124,
    waitTimeoutMs: 600_000,
    waitSliceMs: 30_000,
    probeSliceMs: 5_000,
    providerEverStarted: false,
    endReason: "slice_cap" as const,
    cooldownSignal: null,
    cooldownAttempts: 0,
    cooldownBackoffSequenceMs: [],
  };

  it("marks the run non-terminal and names the session when the gateway still owns it", () => {
    const result = buildWaitTimeoutResult({ ...base, liveSessionRunId: "run_0707c344" });

    expect(result.sessionLive).toBe(true);
    expect(result.liveSessionRunId).toBe("run_0707c344");
    expect(result.errorCode).toBe("openclaw_gateway_wait_timeout");
    expect(result.errorMeta).toMatchObject({
      waitTimeout: {
        sessionLive: true,
        liveSessionRunId: "run_0707c344",
        endReason: "slice_cap",
        budgetExhausted: false,
      },
    });
    // The message has to carry it too: this string is what an operator reads in the run log.
    expect(result.errorMessage).toContain("run_0707c344");
  });

  it("keeps timedOut true — the adapter really did spend its wait budget", () => {
    // `timedOut: true` is the honest history of the adapter, and the run record should keep it.
    // What was false is "the session died", which is what `sessionLive` now carries. RUAAAAA-5302
    // fixes the server's precedence so `sessionLive` wins over this, rather than mutating this.
    const result = buildWaitTimeoutResult({ ...base, liveSessionRunId: "run_0707c344" });

    expect(result.timedOut).toBe(true);
  });

  it("keeps the session terminal-failable when only our own Paperclip run id is available", () => {
    // The gate is a gateway-issued run id, never the `ctx.runId` fallback: our own bookkeeping id
    // says nothing about whether a provider session exists.
    const result = buildWaitTimeoutResult({ ...base, liveSessionRunId: null });

    expect(result.sessionLive).toBe(false);
    expect(result.liveSessionRunId).toBeNull();
    expect(result.errorCode).toBe("openclaw_gateway_wait_timeout");
    expect(result.errorMeta).toMatchObject({ waitTimeout: { sessionLive: false, liveSessionRunId: null } });
  });

  it("reports the timeout-in-cooldown variant as live too, with its own error code", () => {
    const result = buildWaitTimeoutResult({
      ...base,
      endReason: "budget",
      cooldownSignal: { detected: true, provider: "anthropic", reason: "rate_limit", untilIso: "2026-10-22T22:30:00Z" },
      cooldownAttempts: 3,
      cooldownBackoffSequenceMs: [1_000, 5_000, 30_000],
      liveSessionRunId: "run_cd",
    });

    expect(result.sessionLive).toBe(true);
    expect(result.liveSessionRunId).toBe("run_cd");
    expect(result.errorCode).toBe("openclaw_gateway_wait_timeout_in_cooldown");
    expect(result.errorMessage).toContain("rate_limit");
    expect(result.errorMeta).toMatchObject({
      waitTimeout: { sessionLive: true, budgetExhausted: true, cooldownAttempts: 3 },
    });
  });
});

/**
 * RUAAAAA-5302: the second, smaller item on the issue — the timeout string could not be reconciled
 * with itself.
 *
 * The live string was `elapsed 136182ms across 24 polling slice(s) of 30000ms` against a
 * `waitTimeoutMs=600000ms` budget. 24 × 30s is 720s, which is neither the elapsed 136s nor the
 * 600s budget, and the run never got anywhere near its budget. The cause was not the message: the
 * loop was running 5s probe slices (it had not yet seen `providerStarted`) while `maxSlices` was
 * still sized from the nominal 30s slice, so the cap fired early and truncated the wait.
 *
 * These tests pin the property that matters to an operator reading the string — that the reported
 * cadence, the slice count, and the stated ending are mutually consistent.
 */
describe("wait-timeout message honesty (RUAAAAA-5302)", () => {
  const live = {
    payload: { status: "timeout" },
    elapsedMs: 136_182,
    sliceCount: 24,
    maxSlices: 124,
    waitTimeoutMs: 600_000,
    waitSliceMs: 30_000,
    probeSliceMs: 5_000,
    providerEverStarted: false,
    cooldownSignal: null,
    cooldownAttempts: 0,
    cooldownBackoffSequenceMs: [],
    liveSessionRunId: "run_0707c344",
  };

  it("no longer claims a nominal slice the loop never used", () => {
    const result = buildWaitTimeoutResult({ ...live, endReason: "slice_cap" });

    // The old string asserted "24 polling slice(s) of 30000ms", which is 720s — impossible against
    // a 136s elapsed time. It must now describe the cadence actually used.
    expect(result.errorMessage).not.toContain("24 polling slice(s) of 30000ms");
    expect(result.errorMessage).toContain("5000-30000ms probe cadence");
    expect(result.errorMessage).toContain("run never reported provider-started");
  });

  it("names the cap as the limit that ended the loop, not the budget", () => {
    // This is the distinction an operator cannot currently make: a run that was cut short by the
    // cap and a run that genuinely used its whole budget need different responses.
    const result = buildWaitTimeoutResult({ ...live, endReason: "slice_cap" });

    expect(result.errorMessage).toContain("slice cap (124 slices)");
    expect(result.errorMessage).toContain("BEFORE the 600000ms budget was spent");
    expect(result.errorMeta).toMatchObject({ waitTimeout: { budgetExhausted: false, endReason: "slice_cap" } });
  });

  it("says the budget was spent when the budget is what ended it", () => {
    const result = buildWaitTimeoutResult({ ...live, endReason: "budget" });

    expect(result.errorMessage).toContain("ended when the 600000ms wait budget was spent");
    expect(result.errorMessage).not.toContain("BEFORE the 600000ms budget was spent");
    expect(result.errorMeta).toMatchObject({ waitTimeout: { budgetExhausted: true, endReason: "budget" } });
  });

  it("reports the full cadence once the run has actually provider-started", () => {
    const result = buildWaitTimeoutResult({
      ...live,
      providerEverStarted: true,
      endReason: "budget",
      sliceCount: 20,
    });

    expect(result.errorMessage).toContain("20 polling slice(s), 30000ms");
    expect(result.errorMessage).not.toContain("probe cadence");
  });
});

/**
 * RUAAAAA-5302: exhausted cooldown backoff gives up on a run that is in provider cooldown, not one
 * that is dead. Same defect as the saturation fail-fast, one branch over.
 */
describe("buildCooldownExhaustedResult live-session reporting (RUAAAAA-5302)", () => {
  const base = {
    payload: { status: "error", error: "provider rate limit" },
    waitTimeoutMs: 600_000,
    cooldownSignal: {
      detected: true,
      provider: "anthropic",
      reason: "rate_limit",
      untilIso: "2026-10-22T22:30:00Z",
      untilMs: 1_789_999_800_000,
    },
    cooldownAttempts: 3,
    cooldownBackoffSequenceMs: [1_000, 5_000, 30_000],
  };

  it("holds the run non-terminal when the gateway still owns the session", () => {
    const result = buildCooldownExhaustedResult({ ...base, liveSessionRunId: "run_cd_42" });

    expect(result.sessionLive).toBe(true);
    expect(result.liveSessionRunId).toBe("run_cd_42");
    expect(result.errorCode).toBe("openclaw_gateway_wait_cooldown");
    // Not a timeout: the adapter never ran out of budget here, it ran out of backoff steps.
    expect(result.timedOut).toBe(false);
    // No `errorFamily`: rerouting the non-live case into bounded backoff retry is a policy call
    // (see the builder), not part of this fix.
    expect(result.errorFamily).toBeUndefined();
    expect(result.errorMeta).toMatchObject({
      cooldownExhausted: {
        sessionLive: true,
        liveSessionRunId: "run_cd_42",
        provider: "anthropic",
        attempts: 3,
      },
    });
    // The message has to carry it too: this string is what an operator reads in the run log.
    expect(result.errorMessage).toContain("gave up waiting only");
    expect(result.errorMessage).toContain("run_cd_42");
    expect(result.errorMessage).toContain("still live in provider cooldown");
  });

  it("keeps the session terminal-failable when no gateway-issued run id survived", () => {
    const result = buildCooldownExhaustedResult({ ...base, liveSessionRunId: null });

    expect(result.sessionLive).toBe(false);
    expect(result.liveSessionRunId).toBeNull();
    expect(result.errorCode).toBe("openclaw_gateway_wait_cooldown");
    expect(result.errorMessage).not.toContain("still live");
    expect(result.errorMeta).toMatchObject({
      cooldownExhausted: { sessionLive: false, liveSessionRunId: null },
    });
  });
});