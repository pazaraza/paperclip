/**
 * RUAAAAA-1955 (Slice 1949-B): Runtime PDP middleware.
 *
 * Express middleware that sits between the tool dispatcher route
 * handler (`POST /api/plugins/tools/execute` in
 * `src/routes/plugins.ts`) and the tool implementation. Every tool
 * call goes through this middleware; the middleware:
 *
 *   1. Loads the runToken (from the request body if 1888 set it, or
 *      from the heartbeat_runs.contextSnapshot if not). If absent →
 *      `hard_stop` with reason `run_token_missing` (fail-closed).
 *   2. Loads the accepted signoff actor ids from the issue thread.
 *      Empty lists are safe (R3+ will soft_pause / hard_stop).
 *   3. Reads the current phase from the runtime. If `phase=1` →
 *      logs the call + returns `allow` (observation mode).
 *   4. If `phase=2` → calls the pure `decide()` function from
 *      `./verdict.ts`.
 *   5. On `allow` → calls `next()` (the tool implementation runs).
 *      On `soft_pause` → responds 202 + interaction payload (the route
 *      handler short-circuits, the tool implementation is NOT invoked).
 *      On `hard_stop` → responds 403 + reason (the tool implementation
 *      is NOT invoked; this is the entire point of the PDP).
 *   6. Emits the verdict on the configured `emitVerdict` channel
 *      (default: structured server log; 1957 takes over the real
 *      telemetry + webhook emit).
 *
 * The middleware is fully async and tolerant of loader failures: any
 * loader that throws is treated as if it returned the safe default
 * (null runToken → `run_token_missing` hard_stop; signoff loader
 * throw → empty arrays → R3+ fail closed). This keeps the route
 * handler from leaking 500s when the PDP's dependencies are flaky.
 *
 * Lane: in-house, Engineering (Head of Engineering, `584ea4bb-…`).
 * See _default/RUAAAAA-1949-runtime-pdp-v0.md for the design.
 */
import {
  type PdpMiddleware,
  type PdpMiddlewareDeps,
  type PdpMiddlewareResult,
  type PdpToolExecuteBody,
} from "./types.js";

/**
 * Build the PDP Express middleware from a deps bag. The deps bag
 * pattern keeps the middleware testable: the test file supplies
 * in-memory loaders and a no-op emit, so every verdict path can be
 * exercised without touching the database or the live catalog.
 */
export function createPdpMiddleware(deps: PdpMiddlewareDeps): PdpMiddleware {
  const { decide, getPhase, getContext, loadRunToken, loadAcceptedSignoff, emitVerdict } = deps;

  return async function pdpMiddleware(req, res, next) {
    // The route handler validates `req.body` before invoking us, but we
    // defend in depth: if the body is missing or wrong-shaped, we let
    // the route handler's 400 take over (we just call `next()` and the
    // downstream validation will reject the call).
    const body = (req.body ?? null) as PdpToolExecuteBody | null;
    if (!body || typeof body !== "object" || !body.tool || !body.runContext) {
      next();
      return;
    }
    const { tool, parameters, runContext } = body;
    const { agentId, runId, companyId } = runContext;

    // Phase snapshot. Read once per call so a phase flip takes effect
    // immediately.
    const phase = getPhase();

    // ---- 1) runToken -------------------------------------------------
    // Prefer an explicit `runContext.runToken` (set by 1888 Slice B on
    // the request body); fall back to the DB loader. The DB loader is
    // a Promise; we await it but never let it throw.
    let runToken = runContext.runToken ?? null;
    if (!runToken) {
      try {
        runToken = await loadRunToken({ runId, agentId, companyId });
      } catch (err) {
        runToken = null;
        // Swallow — fall through to the run_token_missing hard_stop.
      }
    }

    // ---- 2) signoff --------------------------------------------------
    let reviewer: string[] = [];
    let ceo: string[] = [];
    try {
      const signoff = await loadAcceptedSignoff({
        // 1888 Slice B sets `runToken.issueId`; if the runToken is
        // missing we don't know which issue to check, so we use the
        // raw run context. The route handler validates
        // `runContext.runId` belongs to `runContext.companyId` so
        // we can safely look up the issue id from the heartbeat_runs
        // row instead. For v0 we pass `runId` as the issueId proxy;
        // a future iteration can resolve it to a real issue id.
        issueId: runToken?.issueId ?? runId,
        companyId,
      });
      reviewer = signoff.reviewer;
      ceo = signoff.ceo;
    } catch {
      reviewer = [];
      ceo = [];
    }

    // ---- 3) verdict --------------------------------------------------
    // Phase=1 short-circuit: log + return allow. We still emit a
    // `pdp_verdict` event with verdict=allow + reason=ok so the
    // observation-mode telemetry still produces a clean audit trail.
    const pdpInput = {
      toolName: tool,
      args: parameters ?? null,
      runToken,
      context: getContext(),
      acceptedReviewerActorIds: reviewer,
      acceptedCeoActorIds: ceo,
    };
    const rawVerdict = decide(pdpInput);

    // In phase=1 we override the verdict to `allow` with reason `ok`.
    // The decisionPath is preserved so the audit trail still shows
    // what the runtime WOULD have decided in phase=2.
    const verdict = phase === 1
      ? { ...rawVerdict, verdict: "allow" as const, reason: "ok" as const }
      : rawVerdict;

    const result: PdpMiddlewareResult = {
      verdict,
      toolName: tool,
      companyId,
      issueId: runToken?.issueId ?? runId,
      runId,
      agentId,
      phase,
    };

    // ---- 4) emit -----------------------------------------------------
    try {
      emitVerdict(result);
    } catch {
      // Emit failures must never block the call. The audit trail is
      // best-effort; the call's disposition is decided by the verdict
      // below.
    }

    // ---- 5) dispatch on verdict -------------------------------------
    if (verdict.verdict === "allow") {
      next();
      return;
    }
    if (verdict.verdict === "soft_pause") {
      // 202 Accepted with the interaction payload the caller needs to
      // resolve. The route handler / agent adapter is expected to
      // create a `request_confirmation` interaction from this payload
      // and wake the reviewer chain; for v0 we just return the payload
      // and let the caller drive the rest of the flow.
      res.status(202).json({
        verdict: "soft_pause",
        reason: verdict.reason,
        bundleId: verdict.bundleId,
        argsHash: verdict.argsHash,
        decisionPath: verdict.decisionPath,
        phase,
        interaction: {
          kind: "request_confirmation",
          version: 1,
          prompt: `Tool call "${tool}" requires a reviewer signoff before it can proceed (PDP reason: ${verdict.reason}).`,
          acceptLabel: "Approve and run",
          rejectLabel: "Cancel",
          rejectRequiresReason: true,
          target: { kind: "issue", issueId: result.issueId },
        },
      });
      return;
    }
    // hard_stop
    res.status(403).json({
      verdict: "hard_stop",
      reason: verdict.reason,
      bundleId: verdict.bundleId,
      argsHash: verdict.argsHash,
      decisionPath: verdict.decisionPath,
      phase,
      tool: tool,
    });
  };
}
