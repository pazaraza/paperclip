/**
 * Liveness helpers for heartbeat runs the orphan reaper may declare dead.
 *
 * RUAAAAA-5353: a `hermes_local` run was finalized `failed` / `process_lost`
 * while its agent process was still alive and working. The reaper had no way
 * to tell "this run is gone" from "this run is executing inside another
 * heartbeat service instance", and the adapter never reported a child pid, so
 * the process-level check had nothing to inspect either.
 *
 * These helpers are deliberately pure so they can be unit tested without a
 * database.
 */

/** Slack added on top of an adapter's own execution budget before the reaper may declare the run dead. */
export const ORPHAN_REAP_EXECUTION_HORIZON_GRACE_MS = 60_000;

/** Wall-clock start of this server process, used to tell "the server restarted under this run" from "the run outlived its budget". */
export const SERVER_PROCESS_STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);

/**
 * The execution budget the adapter for this run was configured with, in ms.
 * Returns null when the adapter declares no timeout, because then there is no
 * basis for extending the reap deadline.
 */
export function resolveRunExecutionHorizonMs(
  adapterConfig: Record<string, unknown> | null | undefined,
): number | null {
  const config = adapterConfig ?? {};
  const timeoutSec = Number(config.timeoutSec);
  if (Number.isFinite(timeoutSec) && timeoutSec > 0) return timeoutSec * 1000;
  const waitTimeoutMs = Number(config.waitTimeoutMs);
  if (Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0) return waitTimeoutMs;
  return null;
}

/** True while the run is still inside the execution budget its adapter was given. */
export function isRunInsideExecutionBudget(input: {
  startedAtMs: number;
  nowMs: number;
  horizonMs: number;
  graceMs?: number;
}): boolean {
  if (!Number.isFinite(input.startedAtMs) || input.startedAtMs <= 0) return false;
  if (!Number.isFinite(input.horizonMs) || input.horizonMs <= 0) return false;
  const graceMs = input.graceMs ?? ORPHAN_REAP_EXECUTION_HORIZON_GRACE_MS;
  return input.nowMs - input.startedAtMs < input.horizonMs + graceMs;
}

/**
 * The message attached to a `process_lost` verdict.
 *
 * "server may have restarted" was a guess: it was emitted for every run with
 * no recorded child process, including runs whose server never restarted. That
 * mis-attributed live-run failures to a crash that never happened, which is
 * how this class stayed undiagnosed (RUAAAAA-5353).
 */
export function buildProcessLossMessage(input: {
  processPid: number | null;
  processGroupId: number | null;
  startedAtMs?: number | null;
  serverStartedAtMs?: number;
  descendantOnly?: boolean;
}): string {
  if (input.descendantOnly && input.processGroupId) {
    return `Process lost -- parent pid ${input.processPid ?? "unknown"} exited, but descendant process group ${input.processGroupId} was still alive and was terminated`;
  }
  if (input.processPid) {
    return `Process lost -- child pid ${input.processPid} is no longer running`;
  }
  if (input.processGroupId) {
    return `Process lost -- process group ${input.processGroupId} is no longer running`;
  }
  const serverStartedAtMs = input.serverStartedAtMs ?? SERVER_PROCESS_STARTED_AT_MS;
  const startedAtMs = input.startedAtMs ?? 0;
  if (startedAtMs > 0 && startedAtMs < serverStartedAtMs) {
    return "Process lost -- server restarted while this run was in flight";
  }
  return "Process lost -- no child process was recorded for this adapter and the run exceeded its execution budget";
}
