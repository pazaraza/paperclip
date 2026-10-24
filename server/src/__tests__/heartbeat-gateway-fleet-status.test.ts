import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: null,
    signal: null,
    timedOut: true,
    errorMessage: "OpenClaw gateway run timed out after 300000ms",
    errorCode: "timeout",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres gateway fleet-status tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForAgentStatus(
  db: ReturnType<typeof createDb>,
  agentId: string,
  expected: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest: typeof agents.$inferSelect | null = null;
  while (Date.now() < deadline) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    latest = agent ?? null;
    if (agent?.status === expected) return agent;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest;
}

describeEmbeddedPostgres("OpenClaw gateway fleet status finalization", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-gateway-fleet-status-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: null,
      signal: null,
      timedOut: true,
      errorMessage: "OpenClaw gateway run timed out after 300000ms",
      errorCode: "timeout",
      provider: "test",
      model: "test-model",
    }));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterType: "openclaw_gateway" | "codex_local", status = "idle") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: adapterType === "openclaw_gateway" ? "Gateway Agent" : "Codex Agent",
      role: "engineer",
      status,
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("keeps OpenClaw gateway timeout evidence on the run without holding agent status in error", async () => {
    const { agentId } = await seedAgent("openclaw_gateway");

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
    });
    expect(run).toBeTruthy();

    const settledRun = await waitForRunToSettle(heartbeat, run!.id);
    const agent = await waitForAgentStatus(db, agentId, "idle");
    const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));

    expect(settledRun?.status).toBe("timed_out");
    expect(agent?.status).toBe("idle");
    expect(runtime.lastRunStatus).toBe("timed_out");
    expect(runtime.lastError).toBe("OpenClaw gateway run timed out after 300000ms");
  });

  it("still marks non-gateway terminal failures as agent errors", async () => {
    const { agentId } = await seedAgent("codex_local");

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
    });
    expect(run).toBeTruthy();

    const settledRun = await waitForRunToSettle(heartbeat, run!.id);
    const agent = await waitForAgentStatus(db, agentId, "error");

    expect(settledRun?.status).toBe("timed_out");
    expect(agent?.status).toBe("error");
  });

  it("reconciles stale agent errors when runtime shows a clean successful run", async () => {
    const { agentId, companyId } = await seedAgent("openclaw_gateway", "error");

    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "openclaw_gateway",
      lastRunStatus: "succeeded",
      lastError: null,
      stateJson: {},
    });

    const reconciled = await heartbeat.reconcileStaleSuccessfulAgentErrors();
    const agent = await waitForAgentStatus(db, agentId, "idle");

    expect(reconciled).toBe(1);
    expect(agent?.status).toBe("idle");
  });

  it("does not reconcile stale successful errors while a run is active", async () => {
    const { agentId, companyId } = await seedAgent("openclaw_gateway", "error");

    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "openclaw_gateway",
      lastRunStatus: "succeeded",
      lastError: null,
      stateJson: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "queued",
      invocationSource: "timer",
      triggerDetail: "system",
      contextSnapshot: {},
    });

    const reconciled = await heartbeat.reconcileStaleSuccessfulAgentErrors();
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));

    expect(reconciled).toBe(0);
    expect(agent?.status).toBe("error");
  });
});
