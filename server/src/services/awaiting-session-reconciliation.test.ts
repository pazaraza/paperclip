import { describe, expect, it } from "vitest";
import {
  AWAITING_SESSION_MAX_HOLD_MS,
  AWAITING_SESSION_RECONCILE_GRACE_MS,
  decideAwaitingSessionReconciliation,
} from "./awaiting-session-reconciliation.js";

const ms = (seconds: number) => seconds * 1_000;

/**
 * RUAAAAA-5299 acceptance: replay of the two reported instances must produce ZERO delivered retries.
 *
 * Both are the same shape, and the shape is the whole point — the run is abandoned while its
 * session is still live, so at every moment before the session finishes there is legitimately
 * nothing terminal to read. The old code read the saturation fail-fast as terminal and scheduled a
 * retry; the live session then landed the work minutes later and the retry woke an agent onto a
 * snapshot that no longer existed.
 *
 * `retryScheduled` is the observable under test: it is true exactly when the decision path that
 * schedules a bounded retry is reached.
 */
function replay(input: {
  /** Reconcile ticks after the adapter abandoned its wait, with live issue status at each tick. */
  ticks: Array<{ elapsedMs: number; issueStatus: string | null }>;
}) {
  const timeline = [];
  let retryScheduled = false;
  for (const tick of input.ticks) {
    const decision = decideAwaitingSessionReconciliation({
      issueStatus: tick.issueStatus,
      heldForMs: tick.elapsedMs,
    });
    timeline.push({ elapsedMs: tick.elapsedMs, issueStatus: tick.issueStatus, decision });
    if (decision.action === "abandon") retryScheduled = true;
  }
  return { timeline, retryScheduled };
}

describe("RUAAAAA-5299 awaiting-session reconciliation", () => {
  it("replays RUAAAAA-5283: run failed 21:42:30Z, session closed the issue 21:47:21Z — zero retries", () => {
    // Abandon at 21:42:30Z; the live session completes the issue at 21:47:21Z (291s later).
    // Under the old code the retry fired at +120s, while the issue was still legitimately
    // `in_progress` — which is exactly why a wake-time status re-read alone would not have helped.
    const result = replay({
      ticks: [
        { elapsedMs: ms(60), issueStatus: "in_progress" },   // +1m: retry would have fired here
        { elapsedMs: ms(120), issueStatus: "in_progress" },  // +2m: the old `retryNotBefore` floor
        { elapsedMs: ms(180), issueStatus: "in_progress" },
        { elapsedMs: ms(240), issueStatus: "in_progress" },
        { elapsedMs: ms(291), issueStatus: "done" },         // +4m51s: the live session lands it
      ],
    });

    expect(result.retryScheduled).toBe(false);
    const terminal = result.timeline.at(-1)!.decision;
    expect(terminal).toEqual({ action: "superseded", issueStatus: "done" });
  });

  it("replays RUAAAAA-5297: run failed 21:54:02Z, session closed the issue 22:04:08Z — zero retries", () => {
    // Abandon at 21:54:02Z; the live session completes the issue at 22:04:08Z (606s later, i.e.
    // beyond the adapter's own 600s waitTimeoutMs — the session outlived the run's whole budget).
    const result = replay({
      ticks: [
        { elapsedMs: ms(60), issueStatus: "in_progress" },
        { elapsedMs: ms(120), issueStatus: "in_progress" },  // the old retry fired at +120s
        { elapsedMs: ms(300), issueStatus: "in_progress" },
        { elapsedMs: ms(600), issueStatus: "in_progress" },
        { elapsedMs: ms(606), issueStatus: "done" },
      ],
    });

    expect(result.retryScheduled).toBe(false);
    expect(result.timeline.at(-1)!.decision).toEqual({ action: "superseded", issueStatus: "done" });
  });

  it("holds a live session that has not landed yet, instead of failing it early", () => {
    for (const elapsedMs of [
      AWAITING_SESSION_RECONCILE_GRACE_MS - 1,
      ms(120),
      ms(600),
      AWAITING_SESSION_MAX_HOLD_MS - 1,
    ]) {
      expect(
        decideAwaitingSessionReconciliation({ issueStatus: "in_progress", heldForMs: elapsedMs }),
      ).toEqual({ action: "hold" });
    }
  });

  it("does not read a terminal issue as this session's work during the grace window", () => {
    // Guards the race in the other direction: an issue that was already terminal when the adapter
    // gave up is not this run's success, and reconciling to `succeeded` would credit it wrongly.
    expect(
      decideAwaitingSessionReconciliation({
        issueStatus: "done",
        heldForMs: AWAITING_SESSION_RECONCILE_GRACE_MS - 1,
      }),
    ).toEqual({ action: "hold" });
  });

  it("MUTATION: a genuine dead session past the hold window still schedules the bounded retry", () => {
    // The guard must not silence real retries. A session that never lands anything has to fall
    // through to `abandon`, which is the branch that writes the real failure the retry is built on.
    expect(
      decideAwaitingSessionReconciliation({
        issueStatus: "in_progress",
        heldForMs: AWAITING_SESSION_MAX_HOLD_MS,
      }),
    ).toEqual({ action: "abandon" });

    // Same for an issue that vanished or was cancelled out from under the session: still a real
    // failure to retry against, not a superseded success.
    for (const issueStatus of [null, "cancelled"]) {
      expect(
        decideAwaitingSessionReconciliation({
          issueStatus,
          heldForMs: AWAITING_SESSION_MAX_HOLD_MS,
        }),
      ).toEqual(issueStatus === "cancelled" ? { action: "superseded", issueStatus } : { action: "abandon" });
    }
  });

  it("hold window comfortably exceeds the slowest measured queue delay", () => {
    // RUAAAAA-5297's session landed 606s after dispatch. If the window were tightened below that,
    // the fix would start declaring live sessions dead again.
    expect(AWAITING_SESSION_MAX_HOLD_MS).toBeGreaterThan(ms(606) * 2);
  });

  it("treats an in_review issue as still open work, not as a finished session", () => {
    expect(
      decideAwaitingSessionReconciliation({
        issueStatus: "in_review",
        heldForMs: ms(300),
      }),
    ).toEqual({ action: "hold" });
  });
});