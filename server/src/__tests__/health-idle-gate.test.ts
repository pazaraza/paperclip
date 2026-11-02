import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { healthRoutes } from "../routes/health.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres health idle-gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ABY-919: the control plane's idle gate counted QUEUED runs as if they were
// in-flight work. A queued run is persisted work - the startup path calls
// `resumeQueuedRuns` - so a control-plane restart cannot lose it. Counting it
// toward "is the instance idle" measures queue depth, not restart risk.
//
// Measured on this control plane: over 10:22Z-16:23Z the instance had ZERO
// idle minutes by the queued+running definition (minimum 4 active at every one
// of 362 one-minute samples), while the running-only definition reached 0 on
// 20 of 723 20-second samples. An idle-guarded restart keyed on the old
// number could never fire.
//
// These tests pin the split at the route level, against a real database.
describeEmbeddedPostgres("health idle gate counts running runs only (ABY-919)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  let statusDir!: string;
  let previousStatusFile: string | undefined;
  let previousToken: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-health-idle-gate-");
    db = createDb(tempDb.connectionString);

    const company = await db
      .insert(companies)
      .values({ name: `idle-gate-${randomUUID()}` })
      .returning();
    companyId = company[0]!.id;

    // The dev-server block is only exposed when the supervisor status file
    // exists and the caller presents the supervisor token.
    statusDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-health-idle-gate-"));
    const statusFile = path.join(statusDir, "dev-server-status.json");
    writeFileSync(
      statusFile,
      `${JSON.stringify({
        dirty: true,
        lastChangedAt: "2026-10-28T12:00:00.000Z",
        changedPathCount: 1,
        changedPathsSample: ["server/src/routes/health.ts"],
        pendingMigrations: [],
        lastRestartAt: "2026-10-28T11:30:00.000Z",
      })}\n`,
      "utf8",
    );
    previousStatusFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    previousToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = statusFile;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN = "dev-runner-token";
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    rmSync(statusDir, { recursive: true, force: true });
    if (previousStatusFile === undefined) {
      delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    } else {
      process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousStatusFile;
    }
    if (previousToken === undefined) {
      delete process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN;
    } else {
      process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN = previousToken;
    }
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
      }),
    );
    return app;
  }

  async function seedRun(status: "queued" | "running") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `idle-gate-agent-${randomUUID()}`,
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status,
      invocationSource: "heartbeat_timer",
    });
  }

  async function readDevServer() {
    const res = await request(buildApp())
      .get("/api/health")
      .set("X-Paperclip-Dev-Server-Status-Token", "dev-runner-token");
    expect(res.status).toBe(200);
    return res.body.devServer as {
      activeRunCount: number;
      runningRunCount: number;
      waitingForIdle: boolean;
    };
  }

  it("reports queued runs in activeRunCount but not in runningRunCount", async () => {
    await seedRun("queued");
    await seedRun("queued");

    const devServer = await readDevServer();
    expect(devServer.activeRunCount).toBe(2);
    expect(devServer.runningRunCount).toBe(0);
  });

  it("reports running runs in both counts", async () => {
    await seedRun("queued");
    await seedRun("running");

    const devServer = await readDevServer();
    expect(devServer.activeRunCount).toBe(2);
    expect(devServer.runningRunCount).toBe(1);
  });

  it("excludes terminal runs from both counts", async () => {
    await seedRun("running");
    const terminalAgentId = randomUUID();
    await db.insert(agents).values({
      id: terminalAgentId,
      companyId,
      name: `idle-gate-terminal-${randomUUID()}`,
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: terminalAgentId,
      status: "succeeded",
      invocationSource: "heartbeat_timer",
    });

    const devServer = await readDevServer();
    expect(devServer.activeRunCount).toBe(1);
    expect(devServer.runningRunCount).toBe(1);
  });
});
