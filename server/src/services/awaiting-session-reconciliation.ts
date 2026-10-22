/**
 * RUAAAAA-5299 — decision rules for a run whose adapter abandoned its wait for a still-live
 * provider session.
 *
 * `openclaw_gateway` fail-fasts on gateway saturation: it stops *waiting*, not the session. The
 * gateway still owns the run and may execute it to completion minutes later. Writing a terminal
 * run status at that moment is the defect this module closes — the bounded-retry scheduler trusts
 * the terminal status and queues a retry against a snapshot the live session has already moved
 * past (RUAAAAA-5283, RUAAAAA-5297).
 *
 * So the run sits in the non-terminal `awaiting_session` status, keeps the issue execution lock, and
 * this module decides — from *live issue state*, never from the run row's own optimism — what the
 * run eventually becomes.
 *
 * These are pure functions on purpose: the acceptance criteria (replay of the two known instances,
 * and the mutation test that a genuine mid-run failure must still retry) are decisions, and
 * decisions that can be exercised without a database are decisions that actually get exercised.
 */

/** How long after entering `awaiting_session` reconcile looks at the run at all. */
export const AWAITING_SESSION_RECONCILE_GRACE_MS = 60_000;

/**
 * How long the live session may hold the issue execution lock before it is declared abandoned.
 *
 * Sized from the measured queue delays in the two reported instances: RUAAAAA-5283 landed 339s after
 * its run was dispatched and RUAAAAA-5297 landed 634s after. Anything materially below ~11min would
 * re-create the original bug by declaring a merely-queued session dead.
 */
export const AWAITING_SESSION_MAX_HOLD_MS = 45 * 60_000;

export type AwaitingSessionDecision =
  /** Too early to judge: leave the run and the issue lock exactly as they are. */
  | { action: "hold" }
  /** The live session landed the work: reconcile the run to `succeeded` and release the lock. */
  | { action: "superseded"; issueStatus: "done" | "cancelled" }
  /** The session never landed anything: fail for real so the normal bounded retry can take over. */
  | { action: "abandon" };

export function decideAwaitingSessionReconciliation(input: {
  /** Live issue status at reconcile time, or null when the issue no longer exists. */
  issueStatus: string | null;
  /** Issue status at the moment the adapter abandoned its wait, used only for the reason text. */
  issueStatusAtAbandon?: string | null;
  /** Ms elapsed since the run entered `awaiting_session` (`updatedAt`). */
  heldForMs: number;
  graceMs?: number;
  maxHoldMs?: number;
}): AwaitingSessionDecision {
  const graceMs = input.graceMs ?? AWAITING_SESSION_RECONCILE_GRACE_MS;
  const maxHoldMs = input.maxHoldMs ?? AWAITING_SESSION_MAX_HOLD_MS;

  // A live session cannot have completed the issue before the adapter even gave up on it, so the
  // grace window is checked first: it keeps a terminal issue read from racing the write that made
  // it terminal, which would otherwise reconcile a run to `succeeded` for someone else's work.
  if (input.heldForMs < graceMs) return { action: "hold" };

  if (input.issueStatus === "done" || input.issueStatus === "cancelled") {
    return { action: "superseded", issueStatus: input.issueStatus };
  }

  // Inside the hold window a queued session is normal under saturation. Abandoning it early is the
  // exact failure this fixes.
  if (input.heldForMs < maxHoldMs) return { action: "hold" };

  return { action: "abandon" };
}