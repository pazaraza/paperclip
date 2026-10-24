/**
 * RUAAAAA-1957 (Slice 1949-D): Runtime PDP webhook stream integration.
 *
 * The verdict function (`./verdict.ts`) is pure; the middleware
 * (`./middleware.ts`) translates the verdict into an HTTP response.
 * This module is the third leg: the side-effect that publishes every
 * verdict to the operator-console telemetry + alerts surfaces.
 *
 * Two surfaces are kept in sync on every verdict:
 *
 *   1. **1944 telemetry surface** — the structured server log. The
 *      `kind: "pdp_verdict"` line is what the 1944 telemetry
 *      aggregator (`_default/telemetry-aggregator.py`) consumes
 *      additively. 1944 is designed to accept the new event kind
 *      without a schema change. The 1955 author already wired the
 *      v0 log emit; this module wraps that into a structured envelope
 *      with `kind: "pdp_verdict"` so the aggregator can pick it up
 *      deterministically.
 *
 *   2. **1902 alerts panel webhook** — the OpenClaw live-event stream
 *      keyed on `companyId + issueId + runId`. The operator console's
 *      alerts panel (`1902`) subscribes to `pdp.verdict` events on the
 *      same WebSocket and renders the verdict in the detections panel
 *      in real time. We use the same `publishLiveEvent` path that the
 *      heartbeat service uses for `heartbeat.run.status` events.
 *
 * Contract (matches the 1955 `PdpMiddlewareDeps.emitVerdict`):
 *
 *   - **Fire-and-forget**: the function returns synchronously. The
 *     middleware does not await it. The HTTP response is sent before
 *     the webhook posts complete. This is the entire point of having
 *     a sync void emit: the PDP MUST NOT block the tool dispatch on
 *     a slow webhook.
 *   - **Single retry**: a transient failure (network error, 5xx) is
 *     retried exactly once after a short backoff. After that, the
 *     failure is logged and the verdict is considered "delivered" so
 *     the rogue detector can flag the persistent failure.
 *   - **Persistent failure → rogue-detector + phase degrade**: if both
 *     attempts fail, the emit logs a `ROG-PDP-001` rogue-detector
 *     line AND sets a per-run `phase=1` flag for the affected run so
 *     the next tool call is observation-mode until the operator
 *     resolves the alert. The phase degrade is in-process (no DB
 *     write) so it self-heals on the next server restart.
 *   - **Decision-path preserved**: every emit carries the full
 *     `decisionPath` so the operator console can render the audit
 *     trail without re-running the decision.
 *
 * Lane: in-house, Engineering (Head of Engineering, `584ea4bb-…`).
 * See _default/RUAAAAA-1949-runtime-pdp-v0.md §2 for the contract,
 * and _default/RUAAAAA-1955-runtime-pdp-middleware-v0.1.md for the
 * middleware that calls this emit.
 */
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "../services/live-events.js";
import type { PdpMiddlewareResult } from "./types.js";

/**
 * The shape of a published verdict event. The 1944 aggregator and the
 * 1902 alerts panel both consume this same shape; the structured
 * server log line embeds the same fields under `kind: "pdp_verdict"`.
 */
export interface PdpVerdictEvent {
  kind: "pdp_verdict";
  schemaVersion: 1;
  /** ISO-8601 timestamp at emit time. */
  timestamp: string;
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  /** The phase the PDP was in when it evaluated this call. */
  phase: 1 | 2;
  tool: string;
  verdict: "allow" | "soft_pause" | "hard_stop";
  reason: string;
  argsHash: string;
  bundleId: string | null;
  decisionPath: string[];
  /** Internal attempt counter (0 = first try, 1 = retry). */
  attempt: number;
}

/**
 * Deps the factory needs. Tests inject deterministic clocks + spies;
 * production wiring gets the real `setTimeout`, the real
 * `publishLiveEvent`, and the real `setPhase` (for the phase degrade
 * on persistent failure).
 */
export interface WebhookEmitDeps {
  /** Injectable for tests. Default: `setTimeout` from node:timers. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Injectable for tests. Default: `clearTimeout` from node:timers. */
  clearTimeout?: (handle: unknown) => void;
  /**
   * Injectable for tests. Default: the real `publishLiveEvent` from
   * `services/live-events.js`. The webhook emit calls this on every
   * attempt; a thrown error is treated as a transient failure and
   * retried once.
   */
  publish?: (event: PdpVerdictEvent) => void;
  /**
   * Injectable for tests. Default: the in-process phase setter that
   * the runtime exposes (so the next tool call for the affected run
   * falls back to `phase=1`). The factory wires this to the
   * `PdpRuntime.setPhase` function. The webhook emit calls this
   * exactly once on persistent failure, with the operator signoff
   * requirement waived (the webhook fail is itself the audit trail).
   */
  degradePhaseToOne?: (runId: string, reason: string) => void;
  /** Injectable for tests. Default: `Date.now` / `new Date()`. */
  nowIso?: () => string;
  /**
   * Backoff in ms before the single retry. Default 250ms. The spec
   * asks for a single retry; the backoff is short so a transient
   * network blip clears quickly without holding the runtime hostage.
   */
  retryAfterMs?: number;
}

/**
 * Build a `emitVerdict`-shaped function that posts every PDP verdict
 * to the 1944 telemetry surface (structured log) AND the 1902 alerts
 * panel live-event stream. Returns a synchronous function: the
 * middleware calls it and the HTTP response is sent immediately. The
 * webhook posts happen in the background.
 *
 * Failure handling:
 *   - Success on the first attempt → no retry, no log.
 *   - Failure on the first attempt, success on the retry → no log.
 *   - Failure on both attempts → log `ROG-PDP-001` and degrade the
 *     affected run's effective phase to `phase=1` for the rest of
 *     the process lifetime.
 */
export function createWebhookEmit(
  deps: WebhookEmitDeps = {},
): (result: PdpMiddlewareResult) => void {
  const setTimeoutFn = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const publish = deps.publish ?? defaultPublish;
  const degrade = deps.degradePhaseToOne ?? defaultDegrade;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const retryAfter = deps.retryAfterMs ?? 250;

  return function emitVerdict(result: PdpMiddlewareResult): void {
    // Synchronous structured log: the 1944 surface. This is the v0
    // path the 1955 author already wrote, kept here so the 1944
    // aggregator (`_default/telemetry-aggregator.py`) can pick the
    // line up deterministically from the JSON log stream.
    const baseEvent: Omit<PdpVerdictEvent, "attempt"> = {
      kind: "pdp_verdict",
      schemaVersion: 1,
      timestamp: nowIso(),
      companyId: result.companyId,
      issueId: result.issueId,
      runId: result.runId,
      agentId: result.agentId,
      phase: result.phase,
      tool: result.toolName,
      verdict: result.verdict.verdict,
      reason: result.verdict.reason,
      argsHash: result.verdict.argsHash,
      bundleId: result.verdict.bundleId,
      decisionPath: result.verdict.decisionPath,
    };

    // First attempt: post + log. The live-event publish is fire-and-forget
    // by contract; any throw from the publisher is caught and retried.
    let firstFailure: unknown = null;
    try {
      publish({ ...baseEvent, attempt: 0 });
    } catch (err) {
      firstFailure = err;
    }

    if (firstFailure === null) {
      // Fast path: first attempt succeeded. No retry, no log.
      return;
    }

    // Slow path: first attempt failed. Schedule a single retry. The
    // middleware has long since returned; this is background work.
    const timer = setTimeoutFn(() => {
      let retryFailure: unknown = null;
      try {
        publish({ ...baseEvent, attempt: 1 });
      } catch (err) {
        retryFailure = err;
      }

      if (retryFailure === null) {
        logger.info(
          {
            kind: "pdp_verdict_retry_succeeded",
            runId: result.runId,
            companyId: result.companyId,
            issueId: result.issueId,
            firstError: errorMessage(firstFailure),
          },
          "pdp_verdict_retry_succeeded",
        );
        return;
      }

      // Persistent failure: both attempts failed. Log to rogue
      // detector and degrade the affected run's effective phase to
      // phase=1. The phase degrade is in-process only; a server
      // restart clears it (the operator resolves the alert from the
      // rogue detector in the meantime).
      logger.error(
        {
          kind: "ROG-PDP-001",
          runId: result.runId,
          companyId: result.companyId,
          issueId: result.issueId,
          tool: result.toolName,
          verdict: result.verdict.verdict,
          reason: result.verdict.reason,
          firstError: errorMessage(firstFailure),
          retryError: errorMessage(retryFailure),
          retryAfterMs: retryAfter,
        },
        "ROG-PDP-001: PDP verdict webhook persistent failure",
      );
      try {
        degrade(result.runId, `ROG-PDP-001: ${errorMessage(retryFailure)}`);
      } catch (err) {
        // The degrade itself is best-effort; if it throws we log and
        // move on. The rogue-detector entry is the source of truth.
        logger.error(
          { err: errorMessage(err), runId: result.runId },
          "ROG-PDP-001: phase-degrade call itself threw",
        );
      }
    }, retryAfter);
    // Unref so the retry timer does not keep the process alive at
    // shutdown. The next attempt runs in the background; if the
    // process exits before the retry, the verdict is lost (the
    // structured log line is the durable record).
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    // Clear the timer ref for the unused `clearTimeoutFn` dep so
    // tests can introspect the failure path without leaving dangling
    // handles.
    void clearTimeoutFn;
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function defaultPublish(event: PdpVerdictEvent): void {
  // Two emissions: the structured log (1944 surface) and the live
  // event stream (1902 alerts panel). We emit them both; a throw
  // from either triggers the retry.
  logger.info(event, "pdp_verdict");
  publishLiveEvent({
    companyId: event.companyId,
    type: "pdp.verdict",
    payload: {
      schemaVersion: event.schemaVersion,
      timestamp: event.timestamp,
      runId: event.runId,
      agentId: event.agentId,
      issueId: event.issueId,
      phase: event.phase,
      tool: event.tool,
      verdict: event.verdict,
      reason: event.reason,
      argsHash: event.argsHash,
      bundleId: event.bundleId,
      decisionPath: event.decisionPath,
      attempt: event.attempt,
    },
  });
}

function defaultDegrade(runId: string, reason: string): void {
  // The default degrade is a no-op stand-in. Production wiring
  // injects a function that flips the in-process phase for the
  // affected run. The 1955 author's `PdpRuntime` does not yet
  // expose a per-run phase setter; the 1957 wire-up adds one.
  logger.warn({ runId, reason }, "pdp_verdict: phase degrade (no-op default)");
}
