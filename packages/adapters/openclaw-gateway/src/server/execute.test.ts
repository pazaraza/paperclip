import { describe, expect, it } from "vitest";
import {
  classifyWaitSliceStatus,
  detectCooldownSignal,
  detectWaitSliceSaturation,
  parseCooldownBackoffSequence,
  parseSaturatedDuration,
  parseSaturatedMinQueuedSlices,
  resolveSessionKey,
} from "./execute.js";

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});


describe("classifyWaitSliceStatus (RUAAAAA-5199)", () => {
  it("treats a completed slice as done", () => {
    expect(classifyWaitSliceStatus("ok")).toBe("done");
    expect(classifyWaitSliceStatus("OK")).toBe("done");
  });

  it("REGRESSION: a slice `timeout` is NOT terminal — it must keep polling", () => {
    // Before RUAAAAA-5199 this status hit `waitStatus = "timeout"; break;`, which capped every run
    // at the 30s slice default no matter what waitTimeoutMs was configured.
    expect(classifyWaitSliceStatus("timeout")).toBe("cooldown_check");
    expect(classifyWaitSliceStatus("TIMEOUT")).toBe("cooldown_check");
  });

  it("treats a missing/empty status as non-terminal", () => {
    expect(classifyWaitSliceStatus("")).toBe("cooldown_check");
    expect(classifyWaitSliceStatus("   ")).toBe("cooldown_check");
    expect(classifyWaitSliceStatus(undefined)).toBe("cooldown_check");
    expect(classifyWaitSliceStatus(null)).toBe("cooldown_check");
  });

  it("still treats a real error as terminal", () => {
    expect(classifyWaitSliceStatus("error")).toBe("error");
  });

  it("surfaces genuinely unknown statuses as unexpected", () => {
    expect(classifyWaitSliceStatus("saturated")).toBe("unexpected");
  });
});

describe("detectWaitSliceSaturation (RUAAAAA-5256)", () => {
  it("flags a queued-but-never-started run as saturated", () => {
    // This is the gateway's answer to an over-committed dispatch: accepted, then parked in the
    // queue. RUAAAAA-5199 kept polling these until the 600s budget died, which is what produced
    // the fleet-wide `timed_out` storm RUAAAAA-5256 was opened for.
    const verdict = detectWaitSliceSaturation({
      runId: "run-1",
      status: "timeout",
      timeoutPhase: "queue",
      providerStarted: false,
    });
    expect(verdict.saturated).toBe(true);
    expect(verdict.reason).toBe("queued_not_started");
    expect(verdict.providerStarted).toBe(false);
  });

  it("does NOT flag a `gateway_draining` slice that omits providerStarted (RUAAAAA-5280)", () => {
    // Regression: the gateway omits `providerStarted` on the `gateway_draining` branch of
    // `waitForTurn` precisely BECAUSE an active chat entry is registered and the snapshot is
    // merely not published yet. Reading the absent flag as "never started" failed 25/25 fleet
    // dispatches from 20:22:44Z and held the fleet at zero success. Absence is unknown, not false.
    const verdict = detectWaitSliceSaturation({
      status: "timeout",
      timeoutPhase: "gateway_draining",
    });
    expect(verdict.saturated).toBe(false);
    expect(verdict.reason).toBeNull();
    expect(verdict.providerStarted).toBe(false);
    expect(verdict.providerStartedKnown).toBe(false);
  });

  it("still flags a drain that explicitly reports providerStarted:false", () => {
    // The narrow, genuinely-diagnostic case the correction preserves.
    const verdict = detectWaitSliceSaturation({
      status: "timeout",
      timeoutPhase: "gateway_draining",
      providerStarted: false,
    });
    expect(verdict.saturated).toBe(true);
    expect(verdict.reason).toBe("gateway_draining");
  });

  it("flags a `pending` dispatch as saturated", () => {
    const verdict = detectWaitSliceSaturation({ status: "pending", timeoutPhase: "queue" });
    expect(verdict.saturated).toBe(true);
    expect(verdict.reason).toBe("queued_not_started");
  });

  it("honours an explicit `code: saturated` verdict", () => {
    const verdict = detectWaitSliceSaturation({ status: "error", code: "saturated" });
    expect(verdict.saturated).toBe(true);
    expect(verdict.reason).toBe("explicit_saturated");
  });

  it("REGRESSION: a slow-but-started run is NOT saturation (RUAAAAA-5199 stays intact)", () => {
    const verdict = detectWaitSliceSaturation({ status: "timeout", providerStarted: true });
    expect(verdict.saturated).toBe(false);
    expect(verdict.reason).toBeNull();
  });

  it("does not fire on a bare slice timeout with no queue evidence", () => {
    // The classic in-flight slice: no timeoutPhase, no providerStarted flag. Treating this as
    // saturation would re-break RUAAAAA-5199 by capping every healthy run at one probe slice.
    expect(detectWaitSliceSaturation({ status: "timeout" }).saturated).toBe(false);
    expect(detectWaitSliceSaturation({}).saturated).toBe(false);
    expect(detectWaitSliceSaturation(null).saturated).toBe(false);
  });

  it("does not fire on a finished run whose snapshot carries a terminal marker", () => {
    const verdict = detectWaitSliceSaturation({
      status: "timeout",
      timeoutPhase: "queue",
      endedAt: "2026-10-22T14:00:00.000Z",
    });
    expect(verdict.saturated).toBe(false);
  });

  it("does not fire on ok/error terminal slices", () => {
    expect(detectWaitSliceSaturation({ status: "ok" }).saturated).toBe(false);
    expect(detectWaitSliceSaturation({ status: "error", error: "boom" }).saturated).toBe(false);
  });
});

describe("parseSaturatedDuration (RUAAAAA-5256)", () => {
  it("falls back when unset and clamps into range", () => {
    expect(parseSaturatedDuration(undefined, 5_000, 1_000, 60_000)).toBe(5_000);
    expect(parseSaturatedDuration("2500", 5_000, 1_000, 60_000)).toBe(2_500);
    expect(parseSaturatedDuration(10, 5_000, 1_000, 60_000)).toBe(1_000);
    expect(parseSaturatedDuration(999_999, 5_000, 1_000, 60_000)).toBe(60_000);
  });
});

describe("parseSaturatedMinQueuedSlices (RUAAAAA-5256)", () => {
  it("defaults to 3 consecutive queued slices", () => {
    expect(parseSaturatedMinQueuedSlices(undefined)).toBe(3);
  });

  it("clamps operator input to a sane window", () => {
    expect(parseSaturatedMinQueuedSlices("1")).toBe(1);
    expect(parseSaturatedMinQueuedSlices(0)).toBe(1);
    expect(parseSaturatedMinQueuedSlices(500)).toBe(20);
  });
});

describe("detectCooldownSignal (RUAAAAA-5062)", () => {
  it("detects 'Provider X is in cooldown' and returns provider", () => {
    const signal = detectCooldownSignal([
      "Provider minimax-portal is in cooldown",
    ]);
    expect(signal.detected).toBe(true);
    expect(signal.provider).toBe("minimax-portal");
    expect(signal.reason).toBe("provider_cooldown");
  });

  it("detects 'Provider X is in cooldown (billing)' variant", () => {
    const signal = detectCooldownSignal([
      "Provider openai is in cooldown (billing)",
    ]);
    expect(signal.detected).toBe(true);
    expect(signal.provider).toBe("openai");
    expect(signal.reason).toBe("billing_cooldown");
  });

  it("detects 'Auth profile' unavailable text", () => {
    const signal = detectCooldownSignal([
      "Auth profile 'gpt-5-pro' is temporarily unavailable",
    ]);
    expect(signal.detected).toBe(true);
    expect(signal.provider).toBe("gpt-5-pro");
    expect(signal.reason).toBe("auth_profile_unavailable");
  });

  it("does not fire on unrelated error text", () => {
    const signal = detectCooldownSignal([
      "OpenClaw gateway run timed out after 600000ms",
      "Internal server error",
    ]);
    expect(signal.detected).toBe(false);
  });

  it("ignores empty and null input", () => {
    const signal = detectCooldownSignal([null, undefined, "", "   "]);
    expect(signal.detected).toBe(false);
  });

  it("parses cooldownUntil from ISO timestamp in message", () => {
    const iso = "2026-10-16T15:00:00.000Z";
    const signal = detectCooldownSignal([`Provider a is in cooldown until ${iso}`]);
    expect(signal.detected).toBe(true);
    expect(signal.untilIso).toBe(iso);
    expect(typeof signal.untilMs).toBe("number");
  });
});

describe("parseCooldownBackoffSequence (RUAAAAA-5062)", () => {
  it("returns the default 30/60/120 sequence when config is missing", () => {
    expect(parseCooldownBackoffSequence(undefined)).toEqual([30_000, 60_000, 120_000]);
  });

  it("parses comma-separated ms values", () => {
    expect(parseCooldownBackoffSequence("30000,60000,120000,300000")).toEqual([
      30_000, 60_000, 120_000, 300_000,
    ]);
  });

  it("accepts an array of numbers", () => {
    expect(parseCooldownBackoffSequence([15_000, 45_000])).toEqual([15_000, 45_000]);
  });

  it("falls back to defaults when entries are below the 100ms minimum", () => {
    expect(parseCooldownBackoffSequence([10, 20, 30])).toEqual([
      30_000, 60_000, 120_000,
    ]);
  });

  it("caps entries at the 10-minute maximum", () => {
    const out = parseCooldownBackoffSequence([20 * 60_000, 5_000]);
    expect(out[0]).toBe(10 * 60_000);
    expect(out[1]).toBe(5_000);
  });
});
