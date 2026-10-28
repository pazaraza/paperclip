/**
 * Which adapters the control plane can actually observe the liveness of,
 * and what may be concluded when it cannot.
 *
 * ABY-870 / ABY-896. The reaper in `heartbeat.ts` used to stamp
 * `failed` / `process_lost` on every run it found in the `running`
 * state, on the strength of this guard:
 *
 *     const tracksLocalChild = isTrackedLocalChildProcessAdapter(adapterType);
 *     const processPidAlive = tracksLocalChild && run.processPid && isProcessAlive(run.processPid);
 *
 * For `openclaw_gateway` the agent does not run as a Paperclip child
 * process. It runs inside the OpenClaw gateway's own process tree, so
 * `processPid` and `processGroupId` are null and the control plane
 * holds no handle it could observe. The guard therefore evaluated to
 * false *by short-circuit, not by observation* — the reaper reached a
 * verdict about a process it had never been able to see.
 *
 * The measured damage over the whole table: 8,288 `openclaw_gateway`
 * runs carry `errorCode=process_lost`, 8,286 of them with no pid and
 * no process group at all. 201 `openclaw_gateway` runs *do* carry a
 * process group id, and two of those group ids (10700, 98970) are
 * shared by two different agents' runs apiece — so treating the gateway
 * adapter as a tracked local child would arm a process-group kill
 * against another agent's live work.
 *
 * The rule this module encodes: **never infer death from the absence of
 * a handle the control plane never had.** When liveness is not
 * observable, the reaper may only conclude that the control plane lost
 * the execution handle — which is a statement about the control plane,
 * not about the agent.
 */

/**
 * Adapters whose runs execute as a local child process the control plane
 * spawned and can therefore observe with a pid / process-group probe.
 *
 * Kept in sync with `SESSIONED_LOCAL_ADAPTERS` in `heartbeat.ts`, which
 * is where the process-group kill path is armed. `openclaw_gateway` is
 * deliberately absent: the agent lives in the gateway's process tree, not
 * in Paperclip's.
 */
export const LOCALLY_OBSERVABLE_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

/**
 * True when the control plane holds an observable handle for this
 * adapter's execution.
 */
export function isLocallyObservableAdapter(adapterType: string | null | undefined): boolean {
  if (!adapterType) return false;
  return LOCALLY_OBSERVABLE_ADAPTERS.has(adapterType);
}

/**
 * The error code stamped when the reaper finalizes a run whose liveness
 * the control plane could not observe.
 *
 * It is deliberately NOT `process_lost`. That code is consumed
 * elsewhere as "the agent's process died" (`heartbeat-stop-metadata.ts`
 * maps it to the `process_lost` stop reason, and the run-finalization
 * path uses it to decide a run failed). Stamping it on a row the
 * control plane could not observe is what made the false verdict
 * indistinguishable from a true one. This code says only what is
 * actually known: the control plane lost the handle to the execution.
 *
 * The reconciler (`run-liveness-reconcile.ts`) admits both this code
 * and the historical `process_lost`, so rows stamped before this change
 * remain repairable.
 */
export const UNOBSERVED_LIVENESS_ERROR_CODE = "execution_handle_lost";

/**
 * Error codes whose stamp means "the control plane could not observe
 * this run's liveness" rather than "the agent process died".
 */
export const UNOBSERVED_LIVENESS_ERROR_CODES = new Set<string>([
  UNOBSERVED_LIVENESS_ERROR_CODE,
  // Historical rows: stamped by the old reaper on the same
  // non-observational basis. They are included so the repair path
  // reaches the damage that is already in the table.
  "process_lost",
]);
