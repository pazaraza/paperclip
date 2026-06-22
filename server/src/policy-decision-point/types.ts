/**
 * RUAAAAA-1955 (Slice 1949-B): Public types for the runtime PDP middleware
 * + init flow. Kept in a single file so callers (the route handler, the
 * tests) can import the deps shape without pulling in the implementation.
 *
 * The actual decision logic lives in `./verdict.ts` (pure, side-effect-free);
 * the middleware adds the I/O concerns (loading the runToken, reading the
 * issue thread for signoffs, emitting telemetry) on top.
 *
 * Lane: in-house, Engineering (Head of Engineering, `584ea4bb-…`).
 * See _default/RUAAAAA-1949-runtime-pdp-v0.md for the design, and
 * _default/RUAAAAA-1954-runtime-pdp-verdict-lib-v0.1.md for the verdict
 * contract this middleware enforces.
 */
import type { Request, Response, NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import type {
  PdpContext,
  PdpInput,
  PdpOutput,
  RunToken,
} from "./verdict.js";

/**
 * The runtime PDP phase flag. `phase=1` is observation mode (the
 * middleware logs every call but always returns `allow`); `phase=2`
 * is enforcement mode (the middleware calls `decide()` and enforces
 * the 5-row decision table).
 *
 * The flag is per-PDP-runtime, not per-issue, because the spec wants
 * the operator to flip the whole runtime into enforcement. A future
 * per-issue override is out of scope for v0.
 */
export type PdpPhase = 1 | 2;

/**
 * The result of a middleware evaluation. The route handler in
 * `src/routes/plugins.ts` uses this to decide whether to call
 * `next()` (allow), return 202+payload (soft_pause), or 403+reason
 * (hard_stop).
 */
export interface PdpMiddlewareResult {
  /** The verdict from `decide()` plus the original tool call metadata. */
  verdict: PdpOutput;
  /** The original tool name the verdict was for (audit trail). */
  toolName: string;
  /** The company context the call originated from. */
  companyId: string;
  /** The issue the run is associated with. */
  issueId: string;
  /** The run id (from `runContext.runId`). */
  runId: string;
  /** The agent id (from `runContext.agentId`). */
  agentId: string;
  /** The phase the PDP was in when it evaluated this call. */
  phase: PdpPhase;
}

/**
 * The deps the middleware needs to evaluate a tool call. Every loader
 * is injectable so the test file can drive the middleware with a
 * deterministic in-memory data shape.
 *
 * Production wiring (in `src/routes/plugins.ts`) supplies a DB-backed
 * `loadRunToken` + `loadAcceptedSignoff` and a `publishLiveEvent`-backed
 * `emitVerdict`; tests supply no-op / in-memory variants.
 */
export interface PdpMiddlewareDeps {
  /** The pure decision function. Always `decide` from `./verdict.ts`. */
  decide: (input: PdpInput) => PdpOutput;
  /**
   * Snapshot the current phase. The middleware calls this on every tool
   * call so a phase flip takes effect immediately (no server restart).
   */
  getPhase: () => PdpPhase;
  /** Snapshot the current in-memory PdpContext (catalog + matrix derived). */
  getContext: () => PdpContext;
  /**
   * Load the runToken for a run, or return null if no runToken is
   * available for that run. The middleware fails closed (returns
   * `run_token_missing` hard_stop) when this returns null.
   *
   * Production loader queries `heartbeat_runs.contextSnapshot.runToken`
   * (where 1888 Slice B writes it) AND accepts an explicit
   * `runContext.runToken` field on the request body.
   */
  loadRunToken: (input: { runId: string; agentId: string; companyId: string }) => Promise<RunToken | null>;
  /**
   * Load the accepted `request_confirmation` actor ids for an issue,
   * partitioned into the reviewer chain and the CEO approver chain.
   *
   * Production loader queries `issue_thread_interactions` for
   * `kind='request_confirmation'` AND `status='accepted'` AND
   * `issue_id=issueId`, then maps `resolvedByAgentId` / `resolvedByUserId`
   * into the two buckets based on each agent's role.
   *
   * Fail-closed default: returning empty arrays for both buckets makes
   * every R3+ call soft_pause / hard_stop, which is the safe default
   * until the signoff subsystem ships a real query.
   */
  loadAcceptedSignoff: (input: { issueId: string; companyId: string }) => Promise<{ reviewer: string[]; ceo: string[] }>;
  /**
   * Side-effect: publish the verdict. Production wiring posts to the
   * 1944 telemetry surface (additive, `kind: pdp_verdict`) and emits on
   * the OpenClaw webhook stream. 1957 (Slice 1949-D) takes over the
   * real emit; v0 logs to `server.log` so the audit trail is durable.
   */
  emitVerdict: (result: PdpMiddlewareResult) => void;
}

/**
 * The Express middleware signature. Returns a `(req, res, next)` triple
 * suitable for `app.use(...)` or `router.post(path, mw, handler)`.
 */
export type PdpMiddleware = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;

/**
 * The shape of the `POST /api/plugins/tools/execute` request body the
 * PDP middleware needs. The route handler validates the full shape
 * before invoking the middleware, but the middleware reads the same
 * fields so it can build the PdpInput for `decide()`.
 */
export interface PdpToolExecuteBody {
  tool: string;
  parameters?: unknown;
  runContext: {
    agentId: string;
    runId: string;
    companyId: string;
    projectId: string;
    /**
     * Optional explicit runToken. If absent, the middleware falls
     * back to the DB loader. 1888 Slice B writes this field.
     */
    runToken?: RunToken | null;
  };
}

/**
 * Options for `initPdp()`. The init flow is the boot-time wiring that
 * loads the catalog + matrix and seeds the in-memory PdpContext.
 */
export interface PdpInitOptions {
  /** The DB handle. Used for the parent-issue phase flag lookup and
   *  for the default runToken / signoff loaders. */
  db: Db;
  /** Absolute path to `job-bundle-catalog.example.json`. */
  catalogPath: string;
  /** Absolute path to `safe-wrapper-approval-matrix.json`. */
  matrixPath: string;
  /**
   * The id of the parent PDP issue (RUAAAAA-1949). The init reads its
   * description to detect the `phase=2` flag.
   */
  parentIssueId: string;
  /**
   * Initial phase override. If omitted, the phase is read from the
   * parent issue description (`phase=2` → 2, anything else → 1).
   */
  initialPhase?: PdpPhase;
  /**
   * The 1948 `tool_inventory_change` subscriber. The init registers
   * a listener that invalidates the in-memory PdpContext when the
   * inventory changes. For v0 the inventory endpoint is not yet live
   * (it is blocked on the operator dev-server restart), so the init
   * defaults to a no-op subscriber that logs the change but does not
   * yet rebuild the context. 1948 → 1957 will wire the real subscriber.
   */
  onInventoryChange?: (event: { companyId: string; at: string }) => void;
  /**
   * Optional override for the reviewer + CEO chain resolution. Defaults
   * to a DB query for agents in the company with role IN ('lead',
   * 'head-of-engineering', 'ceo').
   */
  resolveApproverChains?: (db: Db, companyId: string) => Promise<{ reviewer: string[]; ceo: string[] }>;
}

/**
 * The runtime handle returned by `initPdp()`. The route handler holds
 * a reference to this and passes its `middleware` to the tool-execute
 * route, and its `loadRunToken` / `loadAcceptedSignoff` / `emitVerdict`
 * to the middleware deps. The `phase` getter + `setPhase` setter
 * implement the operator-controlled phase flip.
 */
export interface PdpRuntime {
  /** Express middleware that evaluates the tool call. */
  middleware: PdpMiddleware;
  /** Snapshot the current phase. */
  getPhase: () => PdpPhase;
  /**
   * Flip the phase. To go from `phase=2` back to `phase=1` the caller
   * MUST pass `operatorSignoffCommentId`; the runtime logs the flip
   * and stamps the comment id so a later audit can prove the operator
   * explicitly signed off. Forward flips (1 → 2) do not require a
   * signoff comment.
   */
  setPhase: (next: PdpPhase, operatorSignoffCommentId?: string) => void;
  /** Snapshot the current in-memory PdpContext. */
  getContext: () => PdpContext;
  /** Reload the in-memory PdpContext from disk (called by the
   *  `tool_inventory_change` subscriber). */
  reloadContext: () => Promise<void>;
  /** Production loader: pulls the runToken from the request body or
   *  the heartbeat_runs.contextSnapshot column. */
  loadRunToken: PdpMiddlewareDeps["loadRunToken"];
  /** Production loader: pulls the accepted signoff actor ids from the
   *  issue_thread_interactions table. */
  loadAcceptedSignoff: PdpMiddlewareDeps["loadAcceptedSignoff"];
  /** Production side-effect: publishes the verdict (1957 takes over). */
  emitVerdict: PdpMiddlewareDeps["emitVerdict"];
  /** Tear down (idempotent). Drops the inventory-change subscription
   *  and clears the in-memory context. */
  shutdown: () => Promise<void>;
}
