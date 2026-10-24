/**
 * RUAAAAA-5414 - a preempting writer must not erase a wall-clock death.
 *
 * The orphan reaper (`reapOrphanedRuns`) can finalize a run row as
 * `failed` / `process_lost` while the adapter is still running: the row goes
 * terminal before the child has actually died. When the adapter later reports
 * that the child hit its wall-clock ceiling (`timedOut`), the run ended by
 * timeout - the earlier `process_lost` write was a premature verdict about a
 * live child, not the outcome of the run.
 *
 * The decision lives here, free of the database, so the label that a run ends
 * up with can be unit tested directly.
 */

/** Error code the orphan reaper writes when it freezes a run as lost. */
export const REAPER_ORPHANED_RUN_ERROR_CODE = "process_lost";

export type HeartbeatRunOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

export const HEARTBEAT_RUN_OUTCOME_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export interface HeartbeatRunPreemptingFinalization {
  /** Error code the preempting writer left on the row. */
  errorCode: string | null;
  /** Error text the preempting writer left on the row. */
  error: string | null;
  /** When the preempting writer finalized the row. */
  finishedAt: string | null;
  /** Elapsed time at the preempting finalization, in milliseconds. */
  elapsedMs: number | null;
}

export interface ResolveHeartbeatRunOutcomeInput {
  /** Terminal status already on the row, if any. */
  priorStatus?: string | null;
  /** Error code already on the row, if any. */
  priorErrorCode?: string | null;
  /** Error text already on the row, if any. */
  priorError?: string | null;
  /** finished_at already on the row, if any. */
  priorFinishedAt?: Date | string | null;
  /** started_at of the run. */
  startedAt?: Date | string | null;
  /** Whether the adapter reported a wall-clock death. */
  adapterTimedOut?: boolean | null;
  adapterExitCode?: number | null;
  adapterErrorMessage?: string | null;
}

export interface HeartbeatRunOutcomeResolution {
  outcome: HeartbeatRunOutcome;
  /**
   * Details of the preempting finalization when the adapter's wall-clock death
   * superseded it. Null when no preempting finalization was superseded.
   */
  preemptingFinalization: HeartbeatRunPreemptingFinalization | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function elapsedMs(
  startedAt: Date | string | null | undefined,
  finishedAt: Date | string | null | undefined,
): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const end = finishedAt instanceof Date ? finishedAt : new Date(finishedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return end.getTime() - start.getTime();
}

export function isHeartbeatRunTerminalStatus(
  status: string | null | undefined,
): status is HeartbeatRunOutcome {
  return (HEARTBEAT_RUN_OUTCOME_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * Resolve the terminal outcome of a run once the adapter has returned.
 *
 * A pre-existing terminal status normally wins: the row was already finalized
 * (cancelled, or failed by another writer) and the adapter's late return does
 * not reopen it. The one exception is the orphan reaper's `process_lost`
 * verdict: it describes a live child, so when the adapter goes on to report a
 * wall-clock death, the run's outcome is a timeout, and the reaper's premature
 * finalization is preserved separately instead of being overwritten.
 */
export function resolveHeartbeatRunOutcome(
  input: ResolveHeartbeatRunOutcomeInput,
): HeartbeatRunOutcomeResolution {
  const priorStatus = input.priorStatus ?? null;

  if (isHeartbeatRunTerminalStatus(priorStatus)) {
    const preemptedByReaper =
      priorStatus === "failed" &&
      (input.priorErrorCode ?? null) === REAPER_ORPHANED_RUN_ERROR_CODE &&
      input.adapterTimedOut === true;

    if (!preemptedByReaper) {
      return { outcome: priorStatus, preemptingFinalization: null };
    }

    return {
      outcome: "timed_out",
      preemptingFinalization: {
        errorCode: input.priorErrorCode ?? null,
        error: input.priorError ?? null,
        finishedAt: toIso(input.priorFinishedAt),
        elapsedMs: elapsedMs(input.startedAt, input.priorFinishedAt),
      },
    };
  }

  if (input.adapterTimedOut === true) {
    return { outcome: "timed_out", preemptingFinalization: null };
  }

  if ((input.adapterExitCode ?? 0) === 0 && !input.adapterErrorMessage) {
    return { outcome: "succeeded", preemptingFinalization: null };
  }

  return { outcome: "failed", preemptingFinalization: null };
}
