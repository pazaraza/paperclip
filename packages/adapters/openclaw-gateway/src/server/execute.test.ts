import { describe, expect, it } from "vitest";
import {
  buildWaitTimeoutMessage,
  classifyWaitSliceStatus,
  deriveMaxSlices,
  detectCooldownSignal,
  detectWaitSliceSaturation,
  parseCooldownBackoffSequence,
  parseSaturatedDuration,
  parseSaturatedMinQueuedSlices,
  resolveGatewayOperatorScopes,
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

describe("buildWaitTimeoutMessage (RUAAAAA-5310)", () => {
  // The whole point of this issue: an operator reads this string to learn how long the adapter
  // waited, so the numbers in it have to reconcile. Parse them back out and prove they do.
  const parseReported = (msg: string) => {
    const elapsed = Number(/elapsed (\d+)ms/.exec(msg)?.[1]);
    const slices = Number(/across (\d+) polling slice\(s\)/.exec(msg)?.[1]);
    const measured = Number(/= (\d+)ms\/slice measured/.exec(msg)?.[1]);
    return { elapsed, slices, measured };
  };

  it("REGRESSION: the real 24-slice / 121s signature stays self-consistent (was '24 slices of 30000ms')", () => {
    const msg = buildWaitTimeoutMessage({
      waitTimeoutMs: 600_000,
      elapsedMs: 121_053,
      sliceCount: 24,
      maxSlices: 24,
      nominalSliceMs: 30_000,
      probeSliceMs: 5_000,
      connectTimeoutMs: 60_000,
      exitReason: "slice_cap_exhausted",
    });
    const { elapsed, slices, measured } = parseReported(msg);
    expect(slices).toBe(24);
    expect(elapsed).toBe(121_053);
    // measured x count == elapsed, to within the per-slice rounding of the quotient.
    expect(Math.abs(measured * slices - elapsed)).toBeLessThanOrEqual(slices);
    expect(msg).toContain("exit=slice_cap_exhausted");
    expect(msg).toContain("24-slice cap");
    // The nominal interval is reported as configuration, never as a per-slice claim.
    expect(msg).not.toMatch(/polling slice\(s\) of /);
  });

  it("REGRESSION: the 18-slice / 601s overrun signature stays self-consistent", () => {
    const msg = buildWaitTimeoutMessage({
      waitTimeoutMs: 600_000,
      elapsedMs: 601_203,
      sliceCount: 18,
      maxSlices: 24,
      nominalSliceMs: 30_000,
      probeSliceMs: 5_000,
      connectTimeoutMs: 60_000,
      exitReason: "budget_exhausted",
    });
    const { elapsed, slices, measured } = parseReported(msg);
    expect(slices).toBe(18);
    expect(elapsed).toBe(601_203);
    expect(Math.abs(measured * slices - elapsed)).toBeLessThanOrEqual(slices);
    expect(msg).toContain("exit=budget_exhausted");
    expect(msg).not.toContain("slice cap");
  });

  it("distinguishes a real budget exhaustion from a cap exhaustion", () => {
    const base = {
      waitTimeoutMs: 600_000, elapsedMs: 600_500, sliceCount: 20, maxSlices: 124,
      nominalSliceMs: 30_000, probeSliceMs: 5_000, connectTimeoutMs: 60_000,
    };
    expect(buildWaitTimeoutMessage({ ...base, exitReason: "budget_exhausted" }))
      .toContain("reached the waitTimeoutMs budget");
    expect(buildWaitTimeoutMessage({ ...base, exitReason: "slice_cap_exhausted" }))
      .toContain("hit the 124-slice cap before the wall-clock budget");
  });

  it("reports the probe cadence when probe slices are shorter than nominal", () => {
    const msg = buildWaitTimeoutMessage({
      waitTimeoutMs: 600_000, elapsedMs: 121_053, sliceCount: 24, maxSlices: 24,
      nominalSliceMs: 30_000, probeSliceMs: 5_000, connectTimeoutMs: 60_000,
      exitReason: "slice_cap_exhausted",
    });
    expect(msg).toContain("5000ms probe");
    expect(msg).toContain("30000ms nominal");
    expect(msg).toContain("per-call ceiling 90000ms");
  });

  it("reports nominal-only cadence when probe slicing is not shorter", () => {
    const msg = buildWaitTimeoutMessage({
      waitTimeoutMs: 600_000, elapsedMs: 600_500, sliceCount: 20, maxSlices: 24,
      nominalSliceMs: 30_000, probeSliceMs: 30_000, connectTimeoutMs: 60_000,
      exitReason: "budget_exhausted",
    });
    expect(msg).toContain("30000ms nominal");
    expect(msg).not.toContain("probe");
  });

  it("does not divide by zero when no slice completed", () => {
    const msg = buildWaitTimeoutMessage({
      waitTimeoutMs: 600_000, elapsedMs: 4_200, sliceCount: 0, maxSlices: 124,
      nominalSliceMs: 30_000, probeSliceMs: 5_000, connectTimeoutMs: 60_000,
      exitReason: "budget_exhausted",
    });
    expect(msg).toContain("across 0 polling slice(s)");
    expect(msg).toContain(`= ${4_200}ms/slice measured`);
    expect(msg).not.toContain("NaN");
  });
});

/**
 * RUAAAAA-5317. The non-vacuous regression guard for "the waiter abandons live runs at ~130s
 * against a 600s budget".
 *
 * RUAAAAA-5280 fixed the arithmetic inline in the wait loop but left it untested. Every `maxSlices`
 * in this suite was an *input* to the message formatter; none asserted how the cap is derived, so
 * a future edit could reintroduce the nominal-cadence derivation and every test would stay green.
 *
 * The invariant under test is not "the timeout got longer" — a longer cap proves nothing. It is:
 *
 *     the cap must be unreachable before the wall-clock budget has actually run out
 *
 * checked at the production config (600s budget, 30s nominal slice, 5s RUAAAAA-5256 probe slice).
 */
describe("deriveMaxSlices (RUAAAAA-5317)", () => {
  // The exact production config from the live adapterConfig of the Head of Engineering agent.
  const PROD = { waitTimeoutMs: 600_000, nominalSliceMs: 30_000, probeSliceMs: 5_000 };

  it("keeps the slice cap beyond the wall-clock budget on probe cadence", () => {
    const { maxSlices, shortestSliceMs, capEarliestFireMs } = deriveMaxSlices(PROD);
    // The load-bearing invariant: the loop cannot hit the cap before the budget is spent.
    expect(capEarliestFireMs).toBeGreaterThanOrEqual(PROD.waitTimeoutMs);
    // Probe cadence is the shortest the loop can use, so that is what the cap must be sized from.
    expect(shortestSliceMs).toBe(5_000);
    // The pre-fix derivation: ceil(600000/30000)+4 = 24, which fired at 24*5s = 120s.
    expect(maxSlices).not.toBe(24);
    expect(maxSlices).toBe(124);
  });

  it("REGRESSION: a run outliving the old ~130s abandonment point still fits under the cap", () => {
    // RUAAAAA-5317 asks for proof that the fix is not "raise the timeout". Reproduce the real
    // failure at loop level: a still-running turn that is NOT provider-started stays on 5s probe
    // slices for its whole life, so a 200s run makes 40 slices.
    const RUN_MS = 200_000; // comfortably past the 130s abandonment point, inside the 600s budget
    const { maxSlices, shortestSliceMs } = deriveMaxSlices(PROD);
    const slicesTaken = Math.ceil(RUN_MS / shortestSliceMs);

    expect(slicesTaken).toBe(40);
    // Pre-fix: 40 > 24, so the loop abandoned a live run at 120s and wrote finished_at.
    const preFixMaxSlices = Math.ceil(PROD.waitTimeoutMs / PROD.nominalSliceMs) + 4;
    expect(preFixMaxSlices).toBe(24);
    expect(slicesTaken).toBeGreaterThan(preFixMaxSlices); // this is the bug being pinned
    // Post-fix the same run stays under the cap, so the waiter keeps polling to completion
    // instead of declaring the run dead and dispatching a replacement wake.
    expect(slicesTaken).toBeLessThan(maxSlices);
  });

  it("sizes the cap from the shortest cadence regardless of which one the loop is on", () => {
    // Once `providerStarted` is seen the loop switches to the nominal 30s slice, which makes the
    // budget even easier to survive. The cap must not shrink just because the cadence got longer.
    const probe = deriveMaxSlices(PROD);
    const nominal = deriveMaxSlices({ ...PROD, probeSliceMs: 30_000 });
    expect(nominal.maxSlices).toBe(24); // ceil(600000/30000)+4 — correct HERE, because 30s is the real cadence
    expect(nominal.capEarliestFireMs).toBeGreaterThanOrEqual(PROD.waitTimeoutMs);
    // The probe path needs more slices to cover the same wall clock, and must get them.
    expect(probe.maxSlices).toBeGreaterThan(nominal.maxSlices);
  });

  it("never returns a cap below the floor, whatever the input", () => {
    expect(deriveMaxSlices({ waitTimeoutMs: 0, nominalSliceMs: 30_000, probeSliceMs: 5_000 }).maxSlices).toBe(4);
    // Degenerate cadence must not divide by zero into Infinity.
    const zero = deriveMaxSlices({ waitTimeoutMs: 600_000, nominalSliceMs: 0, probeSliceMs: 0 });
    expect(Number.isFinite(zero.maxSlices)).toBe(true);
    expect(zero.shortestSliceMs).toBe(1);
  });
});

describe("resolveGatewayOperatorScopes", () => {
  it("drops scopes outside the gateway's closed operator scope set (RUAAAAA-5381)", () => {
    const result = resolveGatewayOperatorScopes([
      "operator.admin",
      "operator.write",
      "operator.read",
      "agent.run",
      "agent.wake",
    ]);
    expect(result.scopes).toEqual(["operator.admin", "operator.write", "operator.read"]);
    expect(result.dropped).toEqual(["agent.run", "agent.wake"]);
  });

  it("falls back to the default operator scope set when nothing valid survives", () => {
    const result = resolveGatewayOperatorScopes(["agent.run", "agent.wake"]);
    expect(result.scopes).toEqual(["operator.admin"]);
    expect(result.dropped).toEqual(["agent.run", "agent.wake"]);
  });

  it("keeps a valid operator scope list untouched", () => {
    const result = resolveGatewayOperatorScopes(["operator.admin"]);
    expect(result.scopes).toEqual(["operator.admin"]);
    expect(result.dropped).toEqual([]);
  });

  it("defaults to operator.admin when no scopes are configured", () => {
    expect(resolveGatewayOperatorScopes(undefined).scopes).toEqual(["operator.admin"]);
  });
});
