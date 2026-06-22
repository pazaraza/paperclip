import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

import { toolInventoryRouter } from "../routes/company-tool-inventory.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const otherAgentId = "44444444-4444-4444-8444-444444444444";
const bossAgentId = "55555555-5555-4555-8555-555555555555";

const sampleAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "running",
  reportsTo: bossAgentId,
  capabilities: null,
  adapterType: "openclaw_gateway",
  adapterConfig: {
    url: "ws://127.0.0.1:18789/",
    authToken: "SECRET_TOKEN_VALUE_SHOULD_BE_REDACTED",
    devicePrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----",
    headers: { "x-openclaw-token": "ANOTHER_SECRET" },
    payloadTemplate: { model: "gpt-4" },
    scopes: ["read:agents", "write:agents"],
    capabilities: "long capabilities text...",
    bypassApprovals: false,
  },
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: "2026-06-19T13:50:51.111Z",
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-06-19T13:50:51.149Z"),
};

const bossAgent = {
  id: bossAgentId,
  companyId,
  name: "Head of Engineering",
  urlKey: "head-of-engineering",
  role: "general",
  title: "Head of Engineering",
  status: "running",
  reportsTo: null,
  capabilities: null,
  adapterType: "openclaw_gateway",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: true },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-06-19T13:50:51.149Z"),
};

const orphanAgent = {
  id: otherAgentId,
  companyId,
  name: "Orphan Agent",
  urlKey: "orphan-agent",
  role: "engineer",
  title: "Orphan Agent",
  status: "running",
  reportsTo: null,
  capabilities: null,
  adapterType: "openclaw_gateway",
  adapterConfig: { bypassApprovals: true },
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-06-19T13:50:51.149Z"),
};

function buildApp(actor: any, dbMock: any) {
  const app = express();
  app.use((req: any, _res: any, next: any) => {
    req.actor = actor;
    next();
  });
  app.use(toolInventoryRouter(dbMock as any));
  return app;
}

describe("company-tool-inventory (RUAAAAA-1948)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearToolInventoryCache } = await import("../routes/company-tool-inventory.js");
    clearToolInventoryCache();
  });

  it("returns 403 when actor has no permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    const selectChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
    const app = buildApp({ type: "board", source: "remote", companyIds: [companyId], userId: "u-board-1", isInstanceAdmin: false }, { select: () => selectChain });
    const res = await request(app).get(`/companies/${companyId}/agents/tool-inventory`);
    expect(res.status).toBe(403);
  });

  it("returns 200 with payload for a canAssignTasks agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...sampleAgent,
      role: "lead",
      permissions: { canCreateAgents: true },
    });
    mockAgentService.list.mockResolvedValue([sampleAgent, bossAgent, orphanAgent]);
    const selectChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([{ agentId: orphanAgent.id }]) };
    const app = buildApp({ type: "agent", agentId: sampleAgent.id, companyId }, { select: () => selectChain });
    const res = await request(app).get(`/companies/${companyId}/agents/tool-inventory`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.ttlMs).toBe(60_000);
    const me = res.body.entries.find((e: any) => e.id === sampleAgent.id);
    expect(me).toBeDefined();
    expect(me.role).toBe("engineer");
    expect(me.adapterType).toBe("openclaw_gateway");
    expect(me.adapterConfigSummary.scopes).toEqual(["read:agents", "write:agents"]);
    expect(me.adapterConfigSummary.scopesCount).toBe(2);
    expect(me.adapterConfigSummary.headerCount).toBe(1);
    expect(me.adapterConfigSummary.bypassApprovals).toBe(false);
    expect(me.adapterConfigSummary.dangerousKeys).toEqual(
      expect.arrayContaining(["authToken", "devicePrivateKeyPem"]),
    );
    expect(me.chainOfCommand).toEqual([
      { id: bossAgentId, name: "Head of Engineering", role: "general", title: "Head of Engineering" },
    ]);
    expect(me.reportsTo).toBe(bossAgentId);
  });

  it("redacts sensitive fields in the response", async () => {
    mockAgentService.getById.mockResolvedValue({ ...sampleAgent, role: "ceo" });
    mockAgentService.list.mockResolvedValue([sampleAgent]);
    const selectChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
    const app = buildApp({ type: "agent", agentId: sampleAgent.id, companyId }, { select: () => selectChain });
    const res = await request(app).get(`/companies/${companyId}/agents/tool-inventory`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("SECRET_TOKEN_VALUE_SHOULD_BE_REDACTED");
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(text).not.toContain("ANOTHER_SECRET");
    // Replaced: redaction is internal; we don't return ***REDACTED*** literal in summary.
  });

  it("flags bypassApprovals and orphanApproval", async () => {
    mockAgentService.getById.mockResolvedValue({ ...sampleAgent, role: "ceo" });
    mockAgentService.list.mockResolvedValue([sampleAgent, orphanAgent]);
    const selectChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([{ agentId: orphanAgent.id }]) };
    const app = buildApp({ type: "agent", agentId: sampleAgent.id, companyId }, { select: () => selectChain });
    const res = await request(app).get(`/companies/${companyId}/agents/tool-inventory`);
    expect(res.status).toBe(200);
    const orphan = res.body.entries.find((e: any) => e.id === orphanAgent.id);
    expect(orphan.riskFlagCount).toBe(2);
    const kinds = orphan.riskFlags.map((f: any) => f.kind).sort();
    expect(kinds).toEqual(["bypassApprovals", "orphanApproval"]);
  });

  it("returns cache hit on second call within 60s", async () => {
    mockAgentService.getById.mockResolvedValue({ ...sampleAgent, role: "ceo" });
    mockAgentService.list.mockResolvedValue([sampleAgent]);
    const selectChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
    const app = buildApp({ type: "agent", agentId: sampleAgent.id, companyId }, { select: () => selectChain });
    const r1 = await request(app).get(`/companies/${companyId}/agents/tool-inventory`);
    const r2 = await request(app).get(`/companies/${companyId}/agents/tool-inventory`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(mockAgentService.list).toHaveBeenCalledTimes(1);
  });

  it("returns 200 for a general-role agent with permissions.canCreateAgents === true (regression: v0 used wrong field name canAssignTasks)", async () => {
    // Regression: v0 read `(actorAgent.permissions as { canAssignTasks?: boolean } | null)?.canAssignTasks`
    // which is a field that does not exist on the actor agent; only role in (ceo, lead) could pass.
    // Marketing Lead (role: "cmo", permissions.canCreateAgents: true) was wrongly rejected with 403.
    // v0.1 mirrors buildAgentAccessState() and reads the raw `permissions.canCreateAgents` field.
    // This test pins the fix: a general-role agent with canCreateAgents: true must reach 200.
    mockAgentService.getById.mockResolvedValue({
      ...sampleAgent,
      role: "general", // not ceo/lead — gating must come from permissions
      permissions: { canCreateAgents: true },
    });
    mockAgentService.list.mockResolvedValue([sampleAgent]);
    const selectChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
    const app = buildApp({ type: "agent", agentId: sampleAgent.id, companyId }, { select: () => selectChain });
    const res = await request(app).get(`/companies/${companyId}/agents/tool-inventory`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it("returns 403 for a general-role agent whose permissions do NOT include canCreateAgents", async () => {
    // Negative side of the regression: general role alone is not enough.
    // Only role in (ceo, lead) or permissions.canCreateAgents === true grants access.
    mockAgentService.getById.mockResolvedValue({
      ...sampleAgent,
      role: "general",
      permissions: {}, // no canCreateAgents
    });
    mockAgentService.list.mockResolvedValue([sampleAgent]);
    const selectChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
    const app = buildApp({ type: "agent", agentId: sampleAgent.id, companyId }, { select: () => selectChain });
    const res = await request(app).get(`/companies/${companyId}/agents/tool-inventory`);
    expect(res.status).toBe(403);
  });

  it("board user with agents:create permission gets 200", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    mockAgentService.list.mockResolvedValue([sampleAgent]);
    const selectChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
    const app = buildApp({ type: "board", source: "remote", companyIds: [companyId], userId: "u-board-2", isInstanceAdmin: false }, { select: () => selectChain });
    const res = await request(app).get(`/companies/${companyId}/agents/tool-inventory`);
    expect(res.status).toBe(200);
  });
});
