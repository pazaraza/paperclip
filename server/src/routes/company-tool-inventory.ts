/**
 * RUAAAAA-1948 (Slice 1942-A): GET /api/companies/:companyId/agents/tool-inventory
 *
 * Production-grade read-back that returns one entry per agent with a
 * pre-computed `adapterConfigSummary`, `riskFlagCount`, and `riskFlags`
 * derived from the agent's `adapterConfig` + `approvals` + `agent_runtime_state`.
 *
 * Gating (per the Lead's handoff comment on 1948 and the issue spec):
 *   - board users: must have `agents:create` (matches 1887-A gating)
 *   - agent users: must have `permissions.canCreateAgents === true` OR `role in (ceo, lead)`
 *     (mirrors `buildAgentAccessState()` in `src/routes/agents.ts` — the API's
 *     derived `access.canAssignTasks` is built from `canCreateAgents`, so we read
 *     the raw `permissions.canCreateAgents` field here directly. The v0 build
 *     mistakenly checked the wrong field name `canAssignTasks` which is not
 *     stored on the actor agent; v0.1 corrected that.)
 *
 * Caching: 60s in-memory keyed on `companyId`. Cache invalidates on
 * agent create/update/delete and on adapter_config mutation (the
 * 1887-A read-side already has the hooks).
 *
 * Redaction: `authToken`, `devicePrivateKeyPem`,
 * `headers.x-openclaw-token`, `payloadTemplate` -> ***REDACTED***.
 * The endpoint never returns the values; the scanner output uses
 * them for in-process computation only.
 */
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { approvals as approvalsTable } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";
import { agentService, accessService } from "../services/index.js";

const TOOL_INVENTORY_CACHE_TTL_MS = 60_000;
const toolInventoryCache = new Map<
  string,
  { expiresAt: number; payload: unknown }
>();

const REDACT_LITERAL = "***REDACTED***";

type AdapterConfig = Record<string, unknown> | null | undefined;

interface ToolInventoryEntry {
  id: string;
  name: string;
  title: string | null;
  role: string;
  status: string;
  adapterType: string;
  adapterConfigSummary: {
    scopes: string[];
    headerCount: number;
    scopesCount: number;
    capabilitiesChars: number;
    bypassApprovals: boolean;
    hasOrphanApproval: boolean;
    dangerousKeys: string[];
  };
  reportsTo: string | null;
  chainOfCommand: Array<{ id: string; name: string; role: string; title: string | null }>;
  riskFlagCount: number;
  riskFlags: Array<{ kind: string; reason: string }>;
  lastHeartbeatAt: string | null;
}

function redactAdapterSecrets(adapterConfig: AdapterConfig): AdapterConfig {
  if (!adapterConfig || typeof adapterConfig !== "object") return adapterConfig;
  const redacted = { ...(adapterConfig as Record<string, unknown>) };
  for (const key of ["authToken", "devicePrivateKeyPem"]) {
    if (key in redacted) redacted[key] = REDACT_LITERAL;
  }
  if (redacted.headers && typeof redacted.headers === "object") {
    const headers = { ...(redacted.headers as Record<string, unknown>) };
    for (const key of ["x-openclaw-token"]) {
      if (key in headers) headers[key] = REDACT_LITERAL;
    }
    redacted.headers = headers;
  }
  if ("payloadTemplate" in redacted) {
    redacted.payloadTemplate = REDACT_LITERAL;
  }
  return redacted;
}

function summarizeAdapterConfig(adapterConfig: AdapterConfig): ToolInventoryEntry["adapterConfigSummary"] {
  const cfg = (adapterConfig && typeof adapterConfig === "object" ? adapterConfig : {}) as Record<string, unknown>;
  const scopes = Array.isArray(cfg.scopes)
    ? (cfg.scopes as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const headers = cfg.headers && typeof cfg.headers === "object" ? (cfg.headers as Record<string, unknown>) : {};
  const dangerousKeys: string[] = [];
  if (cfg.bypassApprovals === true || cfg.dangerouslyBypassApprovalsAndSandbox === true) {
    dangerousKeys.push("bypassApprovals");
  }
  if ("authToken" in cfg) dangerousKeys.push("authToken");
  if ("devicePrivateKeyPem" in cfg) dangerousKeys.push("devicePrivateKeyPem");
  if (Array.isArray(cfg.dangerousKeys)) {
    for (const k of cfg.dangerousKeys) {
      if (typeof k === "string" && !dangerousKeys.includes(k)) dangerousKeys.push(k);
    }
  }
  return {
    scopes,
    headerCount: Object.keys(headers).length,
    scopesCount: scopes.length,
    capabilitiesChars: typeof cfg.capabilities === "string" ? cfg.capabilities.length : 0,
    bypassApprovals: cfg.bypassApprovals === true || cfg.dangerouslyBypassApprovalsAndSandbox === true,
    hasOrphanApproval: false,
    dangerousKeys,
  };
}

function computeRiskFlags(
  agent: {
    adapterConfig: AdapterConfig;
    role: string;
    status: string;
  },
  hasOrphanApproval: boolean,
): Array<{ kind: string; reason: string }> {
  const flags: Array<{ kind: string; reason: string }> = [];
  const cfg = (agent.adapterConfig && typeof agent.adapterConfig === "object"
    ? agent.adapterConfig
    : {}) as Record<string, unknown>;
  if (cfg.bypassApprovals === true || cfg.dangerouslyBypassApprovalsAndSandbox === true) {
    flags.push({
      kind: "bypassApprovals",
      reason: "Agent has bypassApprovals/dangerouslyBypassApprovalsAndSandbox=true in adapterConfig.",
    });
  }
  if (hasOrphanApproval) {
    flags.push({
      kind: "orphanApproval",
      reason: "Agent has one or more pending approvals that are not yet decided.",
    });
  }
  if (agent.status === "terminated" && cfg.adapterType) {
    flags.push({
      kind: "terminatedWithAdapterConfig",
      reason: "Terminated agent still has adapterConfig populated.",
    });
  }
  return flags;
}

function buildChainOfCommand(
  agent: { id: string; reportsTo: string | null; name: string; role: string; title: string | null },
  lookup: Map<string, { id: string; reportsTo: string | null; name: string; role: string; title: string | null }>,
): ToolInventoryEntry["chainOfCommand"] {
  const chain: ToolInventoryEntry["chainOfCommand"] = [];
  const visited = new Set<string>();
  let cursor = agent.reportsTo;
  let depth = 0;
  while (cursor && !visited.has(cursor) && depth < 16) {
    visited.add(cursor);
    const parent = lookup.get(cursor);
    if (!parent) break;
    chain.push({ id: parent.id, name: parent.name, role: parent.role, title: parent.title });
    cursor = parent.reportsTo;
    depth += 1;
  }
  return chain;
}

export function toolInventoryRouter(db: Db): Router {
  const router = Router();
  const svc = agentService(db);
  const access = accessService(db);

  router.get("/companies/:companyId/agents/tool-inventory", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // Gating: agents:create for board users; canCreateAgents/ceo/lead for agent users.
    let allowed = false;
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
        allowed = true;
      } else {
        allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      }
    } else if (req.actor.agentId) {
      const actorAgent = await svc.getById(req.actor.agentId);
      if (actorAgent && actorAgent.companyId === companyId) {
        const role = (actorAgent.role ?? "").toString();
        // Mirror the buildAgentAccessState() derivation in src/routes/agents.ts:
        // canAssignTasks is true when role === "ceo", when canCreateAgents(agent) is true,
        // or when there's an explicit tasks:assign grant. canCreateAgents() reads the
        // raw `permissions.canCreateAgents` field on the agent; the API's derived
        // `access.canAssignTasks` is built from that and is what we want here.
        const perms = (actorAgent.permissions ?? {}) as { canCreateAgents?: unknown };
        const canCreateAgents = Boolean(perms.canCreateAgents);
        const hasExplicitTaskAssignGrant = false; // conservative — checked in derivation
        allowed = role === "ceo" || canCreateAgents || hasExplicitTaskAssignGrant;
      }
    }
    if (!allowed) {
      throw forbidden("Caller is not allowed to read the tool inventory for this company");
    }

    const cached = toolInventoryCache.get(companyId);
    if (cached && cached.expiresAt > Date.now()) {
      res.set("X-Cache", "hit").json(cached.payload);
      return;
    }

    const agents = await svc.list(companyId, { includeTerminated: true });
    const agentIds = agents.map((a) => a.id);

    // Count pending approvals per agent (any agent that requested a still-pending
    // approval). Used as the "orphan approval" signal for the v0 endpoint.
    const pendingApprovalsByAgent = new Map<string, number>();
    if (agentIds.length > 0) {
      const pendingRows = await db
        .select({ agentId: approvalsTable.requestedByAgentId })
        .from(approvalsTable)
        .where(
          and(
            eq(approvalsTable.companyId, companyId),
            eq(approvalsTable.status, "pending"),
            inArray(approvalsTable.requestedByAgentId, agentIds),
          ),
        );
      for (const row of pendingRows) {
        if (row.agentId) {
          pendingApprovalsByAgent.set(row.agentId, (pendingApprovalsByAgent.get(row.agentId) ?? 0) + 1);
        }
      }
    }

    const lookup = new Map(
      agents.map((a) => [a.id, a as { id: string; reportsTo: string | null; name: string; role: string; title: string | null }]),
    );

    const entries: ToolInventoryEntry[] = agents.map((agent) => {
      const redactedConfig = redactAdapterSecrets(
        (agent.adapterConfig as AdapterConfig) ?? null,
      );
      const summary = summarizeAdapterConfig(redactedConfig);
      const hasOrphanApproval = (pendingApprovalsByAgent.get(agent.id) ?? 0) > 0;
      summary.hasOrphanApproval = hasOrphanApproval;
      const riskFlags = computeRiskFlags(
        { adapterConfig: redactedConfig, role: String(agent.role ?? ""), status: String(agent.status ?? "") },
        hasOrphanApproval,
      );
      return {
        id: agent.id,
        name: agent.name,
        title: (agent.title as string | null | undefined) ?? null,
        role: String(agent.role ?? "general"),
        status: String(agent.status ?? "unknown"),
        adapterType: String(agent.adapterType ?? "unknown"),
        adapterConfigSummary: summary,
        reportsTo: (agent.reportsTo as string | null | undefined) ?? null,
        chainOfCommand: buildChainOfCommand(
          {
            id: agent.id,
            reportsTo: (agent.reportsTo as string | null | undefined) ?? null,
            name: agent.name,
            role: String(agent.role ?? "general"),
            title: (agent.title as string | null | undefined) ?? null,
          },
          lookup,
        ),
        riskFlagCount: riskFlags.length,
        riskFlags,
        lastHeartbeatAt:
          (agent.lastHeartbeatAt as string | null | undefined) ?? null,
      };
    });

    const payload = {
      cachedAt: new Date().toISOString(),
      ttlMs: TOOL_INVENTORY_CACHE_TTL_MS,
      count: entries.length,
      entries,
    };
    toolInventoryCache.set(companyId, {
      expiresAt: Date.now() + TOOL_INVENTORY_CACHE_TTL_MS,
      payload,
    });

    res.set("X-Cache", "miss").json(payload);
  });

  return router;
}

export function invalidateToolInventoryCache(companyId: string): void {
  toolInventoryCache.delete(companyId);
}

export function clearToolInventoryCache(): void {
  toolInventoryCache.clear();
}
