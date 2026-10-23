import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import {
  markRunExecutionActive,
  markRunExecutionFinished,
} from "../services/heartbeat-run-execution-registry.ts";
import {
  buildProcessLossMessage,
  isRunInsideExecutionBudget,
  resolveRunExecutionHorizonMs,
} from "../services/heartbeat-run-liveness.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres orphan-run liveness tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

describe("heartbeat orphan-run liveness helpers", () => {
  it("resolves the adapter execution budget from adapter config", () => {
    expect(resolveRunExecutionHorizonMs({ timeoutSec: 1800 })).toBe(1_800_000);
    expect(resolveRunExecutionHorizonMs({ waitTimeoutMs: 600_000 })).toBe(600_000);
    expect(resolveRunExecutionHorizonMs({ timeoutSec: 0 })).toBeNull();
    expect(resolveRunExecutionHorizonMs({})).toBeNull();
    expect(resolveRunExecutionHorizonMs(null)).toBeNull();
  });

  it("treats a run as inside its execution budget until the budget plus grace elapses", () => {
    const nowMs = 10_000_000;
    expect(
      isRunInsideExecutionBudget({ startedAtMs: nowMs - 60_000, nowMs, horizonMs: 1_800_000 }),
    ).toBe(true);
    expect(
      isRunInsideExecutionBudget({ startedAtMs: nowMs - 1_800_000 - 59_000, nowMs, horizonMs: 1_800_000 }),
    ).toBe(true);
    expect(
      isRunInsideExecutionBudget({ startedAtMs: nowMs - 1_800_000 - 61_000, nowMs, horizonMs: 1_800_000 }),
    ).toBe(false);
    expect(isRunInsideExecutionBudget({ startedAtMs: 0, nowMs, horizonMs: 1_800_000 })).toBe(false);
  });

  it("states the real cause instead of guessing that the server restarted", () => {
    const serverStartedAtMs = 5_000_000;

    expect(
      buildProcessLossMessage({
        processPid: null,
        processGroupId: null,
        startedAtMs: serverStartedAtMs - 1_000,
        serverStartedAtMs,
      }),
    ).toContain("server restarted while this run was in flight");

    expect(
      buildProcessLossMessage({
        processPid: null,
        processGroupId: null,
        startedAtMs: serverStartedAtMs + 1_000,
        serverStartedAtMs,
      }),
    ).toContain("no child process was recorded for this adapter");

    expect(
      buildProcessLossMessage({
        processPid: 4242,
        processGroupId: null,
        startedAtMs: serverStartedAtMs + 1_000,
        serverStartedAtMs,
      }),
    ).toBe("Process lost -- child pid 4242 is no longer running");
  });
});

describeEmbeddedPostgres("heartbeat orphan-run liveness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupIds: { companyId: string; agentId: string; runId: string; wakeupRequestId: string }[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-orphan-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.stop?.();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    for (const ids of cleanupIds.splice(0)) {
      const agentRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, ids.agentId));
      for (const run of agentRuns) {
        await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
      }
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, ids.agentId));
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, ids.agentId));
      await db.delete(agents).where(eq(agents.id, ids.agentId));
      await db.delete(companies).where(eq(companies.id, ids.companyId));
    }
  });

  /**
   * Seeds a run that is already "running" in the database, with no recorded
   * child process (the shape the hermes_local adapter produces: it never
   * calls `onSpawn`, so the run row keeps processPid/processGroupId null).
   */
  async function seedRunningRunFixture(input: {
    adapterType?: string;
    adapterConfig?: Record<string, unknown>;
    startedAt: Date;
    updatedAt: Date;
    processPid?: number | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Compliance Specialist",
      role: "specialist",
      status: "running",
      adapterType: input.adapterType ?? "hermes_local",
      adapterConfig: input.adapterConfig ?? { timeoutSec: 1800 },
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_promoted",
      payload: null,
      status: "claimed",
      runId,
      requestedAt: input.startedAt,
      updatedAt: input.startedAt,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId: randomUUID() },
      processPid: input.processPid ?? null,
      processGroupId: null,
      startedAt: input.startedAt,
      createdAt: input.startedAt,
      updatedAt: input.updatedAt,
    });

    cleanupIds.push({ companyId, agentId, runId, wakeupRequestId });
    return { companyId, agentId, runId, wakeupRequestId };
  }

  it("does not reap a live run that another heartbeat service instance is executing", async () => {
    const now = new Date();
    const { runId } = await seedRunningRunFixture({
      startedAt: new Date(now.getTime() - 10 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 10 * 60 * 1000),
    });

    // Two independent service instances, exactly like the index scheduler and
    // an HTTP route each get their own `heartbeatService(db)` instance.
    const executingInstance = heartbeatService(db);
    const reapingInstance = heartbeatService(db);

    // The executing instance owns the run.
    markRunExecutionActive(runId);

    try {
      const result = await reapingInstance.reapOrphanedRuns({ staleThresholdMs: STALE_THRESHOLD_MS });
      expect(result.reaped).toBe(0);

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(run?.status).toBe("running");
      expect(run?.errorCode).not.toBe("process_lost");
    } finally {
      markRunExecutionFinished(runId);
      void executingInstance;
    }
  });

  it("does not freeze a process_lost verdict while a no-metadata run is inside its adapter execution budget", async () => {
    const now = new Date();
    const { runId } = await seedRunningRunFixture({
      adapterType: "hermes_local",
      adapterConfig: { timeoutSec: 1800 },
      startedAt: new Date(now.getTime() - 10 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 10 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: STALE_THRESHOLD_MS });

    expect(result.reaped).toBe(0);
    expect(result.skippedInsideExecutionBudget).toContain(runId);

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBeNull();
    expect(run?.finishedAt).toBeNull();
  });

  it("reaps a no-metadata run once it is past its adapter execution budget", async () => {
    const now = new Date();
    const { runId } = await seedRunningRunFixture({
      adapterType: "hermes_local",
      adapterConfig: { timeoutSec: 1800 },
      startedAt: new Date(now.getTime() - 40 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 40 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: STALE_THRESHOLD_MS });

    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
    // The old wording ("server may have restarted") was a guess emitted for
    // every run without process metadata, including runs whose server never
    // restarted. The replacement states the actual cause.
    expect(run?.error).not.toContain("server may have restarted");
    expect(run?.error).toContain("Process lost");
  });

  it("still reaps a run whose recorded child pid is dead, even inside the execution budget", async () => {
    const now = new Date();
    const { runId } = await seedRunningRunFixture({
      adapterType: "hermes_local",
      adapterConfig: { timeoutSec: 1800 },
      startedAt: new Date(now.getTime() - 10 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 10 * 60 * 1000),
      processPid: 999_999_999,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: STALE_THRESHOLD_MS });

    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });

  it("reaps a run that predates this server process at startup and says the server restarted", async () => {
    const { runId } = await seedRunningRunFixture({
      adapterType: "hermes_local",
      adapterConfig: { timeoutSec: 1800 },
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns();

    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
    expect(run?.error).toContain("server restarted");
  });
});
