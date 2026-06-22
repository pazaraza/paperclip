/**
 * RUAAAAA-1955 (Slice 1949-B): Runtime PDP initialization.
 *
 * Loads the JobBundle catalog + SafeWrapper approval matrix from disk,
 * builds the in-memory PdpContext the verdict function consumes, and
 * resolves the operator-controlled phase flag from the parent issue
 * (RUAAAAA-1949) description.
 *
 * Phase handling (per the v0 plan §3 and the issue spec):
 *   - phase=1 (default): the middleware logs every call but always
 *     returns `allow` (observation mode). No tool call is blocked.
 *   - phase=2: the middleware calls `decide()` and enforces the 5-row
 *     decision table. `hard_stop` is returned BEFORE the tool
 *     implementation runs; `soft_pause` returns 202 + an interaction
 *     payload; `allow` lets the call proceed.
 *   - Phase flips are reversible. Going from `phase=2` back to
 *     `phase=1` requires an operator signoff comment id; the runtime
 *     logs the flip + the comment id for audit.
 *
 * Lane: in-house, Engineering (Head of Engineering, `584ea4bb-…`).
 * See _default/RUAAAAA-1949-runtime-pdp-v0.md for the design.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  decide,
  type ActiveBundle,
  type PdpContext,
  type RunToken,
} from "./verdict.js";
import { createWebhookEmit } from "./webhook.js";
import {
  type PdpInitOptions,
  type PdpMiddleware,
  type PdpMiddlewareResult,
  type PdpPhase,
  type PdpRuntime,
} from "./types.js";

// ---------------------------------------------------------------------------
// Disk-load helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

interface RawCatalog {
  schemaVersion?: string;
  bundles?: Array<{
    bundleId: string;
    name: string;
    approverClass?: string;
    requiredTools?: Array<{ name: string }>;
    optionalTools?: Array<{ name: string }>;
  }>;
}

interface RawMatrix {
  byToolFamily?: Record<string, {
    defaultRisk?: string;
    defaultWrapper?: string | null;
    wrapperRequired?: boolean;
  }>;
}

const KNOWN_RISK_CLASSES = new Set(["R0", "R1", "R2", "R3", "R4"]);

/**
 * Convert the catalog's `requiredTools` entries (which carry `{name, why}`)
 * to the flat `string[]` the verdict function consumes.
 */
function toolNames(tools: Array<{ name: string }> | undefined): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => t.name).filter((n) => typeof n === "string");
}

/**
 * Build the `wrappersByTool` map for a single bundle by intersecting the
 * bundle's required + optional tools with the matrix's `byToolFamily`
 * table. A bundle that uses `write` gets `write-within-workspace` as
 * its wrapper; a bundle that uses `image_generate` gets
 * `media-with-license-tag`; etc. Tools without a wrapper-required
 * entry in the matrix contribute nothing (the verdict function treats
 * `wrappersByTool[tool] === undefined` as "no wrapper required").
 */
function buildWrappersByTool(
  bundleTools: string[],
  matrix: RawMatrix,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tool of bundleTools) {
    const familyEntry = matrix.byToolFamily?.[tool];
    if (!familyEntry) continue;
    if (familyEntry.wrapperRequired === true && familyEntry.defaultWrapper) {
      out[tool] = familyEntry.defaultWrapper;
    }
  }
  return out;
}

/**
 * Load and parse the catalog. Throws on parse error (fail-closed: a
 * malformed catalog means the PDP cannot safely enforce, so the init
 * refuses to start rather than booting with a half-empty in-memory
 * context that would silently allow every call).
 */
export async function loadCatalogFromDisk(catalogPath: string): Promise<RawCatalog> {
  const raw = await readFile(catalogPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `PDP init: failed to parse catalog at ${catalogPath}: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`PDP init: catalog at ${catalogPath} is not an object`);
  }
  return parsed as RawCatalog;
}

/**
 * Load and parse the matrix. Same fail-closed contract as the catalog.
 */
export async function loadMatrixFromDisk(matrixPath: string): Promise<RawMatrix> {
  const raw = await readFile(matrixPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `PDP init: failed to parse matrix at ${matrixPath}: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`PDP init: matrix at ${matrixPath} is not an object`);
  }
  return parsed as RawMatrix;
}

/**
 * Build the in-memory PdpContext from the parsed catalog + matrix.
 * The wrapper registry is the union of all `defaultWrapper` entries
 * in the matrix's `byToolFamily` table; the reviewer + CEO chains
 * are passed in by the caller (loaded from the DB by the default
 * approver-chain resolver).
 */
export function buildPdpContext(args: {
  catalog: RawCatalog;
  matrix: RawMatrix;
  reviewerChain: string[];
  ceoApproverChain: string[];
}): PdpContext {
  const { catalog, matrix, reviewerChain, ceoApproverChain } = args;

  const activeBundles: ActiveBundle[] = (catalog.bundles ?? []).flatMap(
    (b): ActiveBundle[] => {
      if (!b.bundleId || !b.name) return [];
      const approverClass = b.approverClass;
      if (!approverClass || !KNOWN_RISK_CLASSES.has(approverClass)) {
        // Unknown / missing risk class — fail-closed by skipping the
        // bundle. The verdict function returns `tool_not_in_bundle` for
        // any tool call that doesn't match a known bundle, so a
        // malformed bundle is the same as no bundle.
        return [];
      }
      const required = toolNames(b.requiredTools);
      const optional = toolNames(b.optionalTools);
      const allTools = [...required, ...optional];
      return [{
        bundleId: b.bundleId,
        name: b.name,
        approverClass: approverClass as ActiveBundle["approverClass"],
        requiredTools: required,
        optionalTools: optional,
        wrappersByTool: buildWrappersByTool(allTools, matrix),
      }];
    },
  );

  const wrapperRegistry: Record<string, string> = {};
  for (const [tool, entry] of Object.entries(matrix.byToolFamily ?? {})) {
    if (entry?.defaultWrapper) {
      wrapperRegistry[tool] = entry.defaultWrapper;
    }
  }

  return {
    activeBundles,
    wrapperRegistry,
    reviewerChain,
    ceoApproverChain,
  };
}

// ---------------------------------------------------------------------------
// DB-backed default loaders
// ---------------------------------------------------------------------------

/**
 * Default approver-chain resolver: query the agents table for the
 * reviewer chain (role IN lead/head-of-engineering) and the CEO
 * approver chain (role = ceo). Internal-only, single-company scope.
 */
export async function defaultResolveApproverChains(
  db: Db,
  companyId: string,
): Promise<{ reviewer: string[]; ceo: string[] }> {
  const query = db.select({ id: agents.id, role: agents.role }).from(agents);
  const rows = companyId ? await query.where(eq(agents.companyId, companyId)) : await query;

  const reviewer: string[] = [];
  const ceo: string[] = [];
  for (const row of rows) {
    const role = (row.role ?? "").toString().toLowerCase();
    if (role === "ceo") {
      ceo.push(row.id);
    } else if (role === "lead" || role === "head-of-engineering" || role === "head of engineering") {
      reviewer.push(row.id);
    }
  }
  return { reviewer, ceo };
}

/**
 * Default phase-flag reader: load the parent issue (RUAAAAA-1949)
 * description and look for the literal token `phase=2`. Returns 2
 * if found, 1 otherwise. The init runs once at boot; live phase
 * flips happen through `setPhase()`.
 */
async function readParentIssuePhase(db: Db, parentIssueId: string): Promise<PdpPhase> {
  const rows = await db
    .select({ description: issues.description })
    .from(issues)
    .where(eq(issues.id, parentIssueId))
    .limit(1);
  const desc = rows[0]?.description ?? "";
  // The phase flag is agent-controlled: the description author writes
  // "phase=2" to opt the runtime into enforcement mode. We match the
  // literal token with a word boundary so "phase=2x" or "phase=20"
  // don't accidentally trip the flag.
  return /\bphase=2\b/i.test(desc) ? 2 : 1;
}

// ---------------------------------------------------------------------------
// initPdp
// ---------------------------------------------------------------------------

/**
 * Initialize the runtime PDP. Returns a `PdpRuntime` handle the route
 * handler in `src/routes/plugins.ts` consumes. The init is synchronous
 * with respect to the in-memory context (the context is built before
 * the function returns); the DB-backed loaders are async and resolved
 * lazily on the first tool call.
 */
export async function initPdp(opts: PdpInitOptions): Promise<PdpRuntime> {
  const { db, catalogPath, matrixPath, parentIssueId, initialPhase, onInventoryChange } = opts;

  logger.info(
    { catalogPath, matrixPath, parentIssueId, initialPhase: initialPhase ?? "(auto)" },
    "PDP init: loading catalog + matrix",
  );

  const [catalog, matrix] = await Promise.all([
    loadCatalogFromDisk(catalogPath),
    loadMatrixFromDisk(matrixPath),
  ]);

  // Initial approver chains — re-resolved on every reload. For the very
  // first build we look up the chains for the first company we see; the
  // runtime treats the chains as company-scoped at evaluation time, so
  // the chains get re-resolved per call when the companyId is known.
  // For v0 the chains are loaded once for "all companies" (a flat
  // reviewer/CEO list, since the same operator team approves for every
  // company in this Paperclip instance). The route handler threads the
  // companyId through the middleware, which calls `resolveApproverChains`
  // on the first call to that company.
  const initialChains = opts.resolveApproverChains
    ? await opts.resolveApproverChains(db, /* companyId */ "")
    : await defaultResolveApproverChains(db, /* companyId */ "");

  let context: PdpContext = buildPdpContext({
    catalog,
    matrix,
    reviewerChain: initialChains.reviewer,
    ceoApproverChain: initialChains.ceo,
  });

  // Resolve the phase. Priority: explicit `initialPhase` > parent issue
  // description. The init logs both so the operator can verify which
  // path won.
  const parentPhase = await readParentIssuePhase(db, parentIssueId);
  let phase: PdpPhase = initialPhase ?? parentPhase;
  let lastSignoffCommentId: string | null = null;
  logger.info(
    { phase, parentPhase, explicit: initialPhase ?? null },
    "PDP init: phase resolved",
  );

  // Re-resolve the approver chains for a specific company. Used by the
  // signoff + runToken loaders when the companyId is known.
  async function chainsForCompany(companyId: string): Promise<{ reviewer: string[]; ceo: string[] }> {
    if (companyId) {
      return opts.resolveApproverChains
        ? await opts.resolveApproverChains(db, companyId)
        : await defaultResolveApproverChains(db, companyId);
    }
    return { reviewer: context.reviewerChain, ceo: context.ceoApproverChain };
  }

  // ---- default runToken loader -----------------------------------------
  // Pulls the runToken from `heartbeat_runs.contextSnapshot.runToken` if
  // 1888 Slice B wrote one there. The runtime falls back to an explicit
  // `runContext.runToken` on the request body (handled in middleware.ts).
  async function loadRunToken(input: { runId: string; agentId: string; companyId: string }): Promise<RunToken | null> {
    const { heartbeatRuns } = await import("@paperclipai/db");
    const rows = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .limit(1);
    const snap = rows[0]?.contextSnapshot as Record<string, unknown> | null | undefined;
    if (!snap) return null;
    const candidate = (snap as { runToken?: unknown }).runToken;
    if (!candidate || typeof candidate !== "object") return null;
    const c = candidate as Partial<RunToken>;
    if (!c.runId || !c.agentId || !c.issueId || !c.maxRiskClass) return null;
    if (!KNOWN_RISK_CLASSES.has(c.maxRiskClass)) return null;
    return {
      runId: c.runId,
      agentId: c.agentId,
      issueId: c.issueId,
      activeBundleId: typeof c.activeBundleId === "string" ? c.activeBundleId : null,
      maxRiskClass: c.maxRiskClass as RunToken["maxRiskClass"],
    };
  }

  // ---- default signoff loader ------------------------------------------
  // Reads the issue thread for accepted `request_confirmation` interactions
  // and partitions the actor ids into the reviewer + CEO buckets based on
  // each agent's role at resolution time.
  async function loadAcceptedSignoff(input: { issueId: string; companyId: string }): Promise<{ reviewer: string[]; ceo: string[] }> {
    const { issueThreadInteractions } = await import("@paperclipai/db");
    const { and } = await import("drizzle-orm");
    const rows = await db
      .select({
        resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
        resolvedByUserId: issueThreadInteractions.resolvedByUserId,
        createdByAgentId: issueThreadInteractions.createdByAgentId,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.issueId, input.issueId),
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "accepted"),
        ),
      );
    const reviewer: string[] = [];
    const ceo: string[] = [];
    // For each accepted interaction, attribute the approval to either
    // the reviewer chain (default) or the CEO chain if the resolving
    // actor is in the company's CEO list. We resolve the chain once
    // per call.
    const chains = await chainsForCompany(input.companyId);
    const ceoSet = new Set(chains.ceo);
    for (const row of rows) {
      const agentId = row.resolvedByAgentId;
      if (!agentId) continue; // user-resolved approvals are not yet
                                // attributed to the chain (out of scope)
      if (ceoSet.has(agentId)) {
        ceo.push(agentId);
      } else {
        reviewer.push(agentId);
      }
    }
    return { reviewer, ceo };
  }

  // ---- default verdict emit --------------------------------------------
  // The 1957 webhook module is the real emit: structured log + live
  // event stream (1902 alerts panel webhook). It also handles the
  // single-retry policy and the rogue-detector + phase-degrade on
  // persistent failure. The 1955 v0 emit is replaced; the audit
  // trail is durable in the JSON log + the 1902 detections panel.
  const webhookEmit = createWebhookEmit({
    retryAfterMs: 250,
  });
  function emitVerdict(result: PdpMiddlewareResult): void {
    webhookEmit(result);
  }

  // ---- inventory change subscriber -------------------------------------
  // 1948 inventory endpoint emits `tool_inventory_change` events; the
  // 1957 wiring will own the real subscriber. For v0 we register a
  // callback slot that, on change, reloads the in-memory context from
  // disk (cheap and deterministic) and re-resolves the approver chains.
  let inventoryChangeListener: ((event: { companyId: string; at: string }) => void) | null = null;
  if (onInventoryChange) {
    inventoryChangeListener = onInventoryChange;
  } else {
    inventoryChangeListener = (event) => {
      logger.info({ event }, "PDP init: tool_inventory_change received (no-op in v0)");
    };
  }

  // ---- reload context --------------------------------------------------
  async function reloadContext(): Promise<void> {
    const [catalog2, matrix2] = await Promise.all([
      loadCatalogFromDisk(catalogPath),
      loadMatrixFromDisk(matrixPath),
    ]);
    context = buildPdpContext({
      catalog: catalog2,
      matrix: matrix2,
      reviewerChain: context.reviewerChain,
      ceoApproverChain: context.ceoApproverChain,
    });
    logger.info(
      { activeBundles: context.activeBundles.length, wrappers: Object.keys(context.wrapperRegistry).length },
      "PDP init: context reloaded",
    );
  }

  // ---- phase control ---------------------------------------------------
  function getPhase(): PdpPhase {
    return phase;
  }
  function setPhase(next: PdpPhase, operatorSignoffCommentId?: string): void {
    if (next === phase) return;
    // Going from phase=2 → phase=1 requires an operator signoff comment.
    // This is the only irreversible-ish constraint in the spec; the
    // operator signoff is the audit trail that says "I am aware the
    // runtime is no longer gating and I'm OK with that".
    if (phase === 2 && next === 1 && !operatorSignoffCommentId) {
      throw new Error(
        "PDP setPhase: flipping from phase=2 back to phase=1 requires operatorSignoffCommentId",
      );
    }
    const previous = phase;
    phase = next;
    lastSignoffCommentId = operatorSignoffCommentId ?? lastSignoffCommentId;
    logger.warn(
      {
        previous,
        next,
        operatorSignoffCommentId: operatorSignoffCommentId ?? null,
        lastSignoffCommentId,
      },
      "PDP init: phase flipped",
    );
  }

  // ---- shutdown --------------------------------------------------------
  let shutdown = false;
  async function pdpShutdown(): Promise<void> {
    if (shutdown) return;
    shutdown = true;
    inventoryChangeListener = null;
    context = {
      activeBundles: [],
      wrapperRegistry: {},
      reviewerChain: [],
      ceoApproverChain: [],
    };
    logger.info("PDP init: shutdown complete");
  }

  // ---- middleware factory ----------------------------------------------
  // The middleware itself is built in `./middleware.ts`; we just import
  // it lazily so the two files can be tested in isolation.
  const { createPdpMiddleware } = await import("./middleware.js");
  const middleware: PdpMiddleware = createPdpMiddleware({
    decide,
    getPhase,
    getContext: () => context,
    loadRunToken,
    loadAcceptedSignoff,
    emitVerdict,
  });

  return {
    middleware,
    getPhase,
    setPhase,
    getContext: () => context,
    reloadContext,
    loadRunToken,
    loadAcceptedSignoff,
    emitVerdict,
    shutdown: pdpShutdown,
  };
}
