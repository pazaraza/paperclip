/**
 * Process-wide registry of heartbeat runs that are currently executing.
 *
 * `heartbeatService()` is instantiated in many places: the index scheduler, the
 * issue/agent/approval routers, the routine scheduler, and the plugin host.
 * Each instance used to keep its own `activeRunExecutions` set, so the orphan
 * reaper in one instance could not see a run that another instance was
 * executing. The reaper then froze a `failed` / `process_lost` verdict on a run
 * whose adapter child was still alive and working (RUAAAAA-5353).
 *
 * The registry is process-wide for the same reason `runningProcesses` is: the
 * liveness question ("is this run executing right now?") is a property of the
 * process, not of the service instance that happens to ask.
 */
const activeRunExecutions = new Set<string>();

export function markRunExecutionActive(runId: string): void {
  if (!runId) return;
  activeRunExecutions.add(runId);
}

export function markRunExecutionFinished(runId: string): void {
  if (!runId) return;
  activeRunExecutions.delete(runId);
}

export function isRunExecutionActive(runId: string): boolean {
  if (!runId) return false;
  return activeRunExecutions.has(runId);
}
