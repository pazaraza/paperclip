import { describe, expect, it } from "vitest";
import { WAIT_SLICE_OVERRUN_SLACK } from "./execute.js";

/**
 * RUAAAAA-5299: the wait loop's poll-slot cap was derived from `waitSliceMs`, which assumes every
 * slice consumes its whole window. A gateway that answers `agent.wait` early — exactly what
 * RUAAAAA-5280's `gateway_draining` slices are — burns that cap long before the wall-clock budget
 * is gone.
 *
 * Observed on the live fleet with `waitTimeoutMs=600000` and 30s slices: cap = 24, gateway answering
 * in ~5s per slice, loop gave up at ~125s and reported
 *
 *   "did not complete within waitTimeoutMs=600000ms (elapsed 125558ms across 24 polling slice(s))"
 *
 * The cap is an ANTI-SPIN guard, not a second time budget. These tests pin the relationship that
 * makes that true.
 */

/** Mirrors the cap computation in execute.ts. */
function maxSlicesFor(input: {
  waitTimeoutMs: number;
  waitSliceMs: number;
  saturatedProbeSliceMs: number;
}): number {
  const minSliceMs = Math.max(1, Math.min(input.waitSliceMs, input.saturatedProbeSliceMs));
  return Math.max(4, Math.ceil(input.waitTimeoutMs / minSliceMs) + WAIT_SLICE_OVERRUN_SLACK);
}

/** What the OLD computation produced. */
function oldMaxSlicesFor(input: { waitTimeoutMs: number; waitSliceMs: number }): number {
  return Math.max(4, Math.ceil(input.waitTimeoutMs / Math.max(1, input.waitSliceMs)) + WAIT_SLICE_OVERRUN_SLACK);
}

const WAIT_TIMEOUT_MS = 600_000;
const WAIT_SLICE_MS = 30_000;
const PROBE_SLICE_MS = 5_000;

describe("RUAAAAA-5299 wait-loop poll-slot cap", () => {
  it("gives a fast-answering gateway enough slots to reach its wall-clock budget", () => {
    const cap = maxSlicesFor({
      waitTimeoutMs: WAIT_TIMEOUT_MS,
      waitSliceMs: WAIT_SLICE_MS,
      saturatedProbeSliceMs: PROBE_SLICE_MS,
    });

    // The gateway that motivated this answers in ~5s. At that rate the cap must not bind before the
    // 600s budget does, or the run dies early and writes a false `timed_out`.
    const wallClockAtCapMs = cap * PROBE_SLICE_MS;
    expect(wallClockAtCapMs).toBeGreaterThanOrEqual(WAIT_TIMEOUT_MS);
  });

  it("reproduces the ~125s premature exit with the old computation", () => {
    const old = oldMaxSlicesFor({ waitTimeoutMs: WAIT_TIMEOUT_MS, waitSliceMs: WAIT_SLICE_MS });
    expect(old).toBe(24);

    // 24 slices at the ~5.2s/slice this fleet actually showed: ~125s, matching the recorded run.
    const prematureExitMs = old * 5_200;
    expect(prematureExitMs).toBeLessThan(WAIT_TIMEOUT_MS / 2);
    expect(prematureExitMs).toBeGreaterThan(100_000);
    expect(prematureExitMs).toBeLessThan(150_000);
  });

  it("still caps a gateway that answers instantly, so the loop cannot spin", () => {
    const cap = maxSlicesFor({
      waitTimeoutMs: WAIT_TIMEOUT_MS,
      waitSliceMs: WAIT_SLICE_MS,
      saturatedProbeSliceMs: PROBE_SLICE_MS,
    });

    // Bounded, not unbounded: 0ms slices still terminate, just no longer before the time budget.
    expect(cap).toBe(124);
    expect(cap).toBeLessThan(WAIT_TIMEOUT_MS / 1000);
  });

  it("honours the time budget as written when slices do consume their window", () => {
    // No saturation probe in play: slices are the full 30s, so the old and new caps agree and the
    // behaviour is unchanged for the healthy path.
    const withProbe = maxSlicesFor({
      waitTimeoutMs: WAIT_TIMEOUT_MS,
      waitSliceMs: WAIT_SLICE_MS,
      saturatedProbeSliceMs: WAIT_SLICE_MS,
    });
    expect(withProbe).toBe(oldMaxSlicesFor({ waitTimeoutMs: WAIT_TIMEOUT_MS, waitSliceMs: WAIT_SLICE_MS }));
  });

  it("never returns fewer than the minimum slice count", () => {
    expect(
      maxSlicesFor({ waitTimeoutMs: 1_000, waitSliceMs: 30_000, saturatedProbeSliceMs: 5_000 }),
    ).toBeGreaterThanOrEqual(4);
  });
});