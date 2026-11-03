import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * ABY-943 / ABY-837 regression.
 *
 * The recovery's issue -> live-run lookup only matched runs whose
 * `context_snapshot` carries an `issueId` key. A run woken outside the issue
 * (e.g. `heartbeat_timer`) that then worked the issue - checked it out, wrote
 * comments - was invisible to that predicate, so the recovery could declare
 * "no live execution path" and park an issue that a live run was still writing.
 *
 * Real occurrence: RUAAAAA-2324, where recovery action `0fa4b2cf` judged the
 * July run `2b5aca10-13c9-4aba-b7cb-0c1f9d7c3148` as the latest run while the
 * actually-live run `05a8f747-b77d-4412-8249-1fa808bfe3ef` had no `issueId`
 * key in its snapshot; that live run wrote a comment 6m38s AFTER the verdict.
 */
describeEmbeddedPostgres("recovery issue scope follows activity_log links", () => {
  async function withDb<T>(fn: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-activity-link-");
    const db = createDb(tempDb.connectionString);
    try {
      return await fn(db);
    } finally {
      await tempDb.cleanup();
    }
  }

  async function seed(db: ReturnType<typeof createDb>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Activity Link Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "coder",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-1`,
      title: "Issue worked by an unscoped run",
      status: "in_progress",
      createdByAgentId: agentId,
    });

    return { companyId, agentId, issueId };
  }

  it("finds a live run whose context_snapshot has no issueId but which wrote to the issue", async () => {
    await withDb(async (db) => {
      const { companyId, agentId, issueId } = await seed(db);

      // The stale run the recovery used to judge: it DOES name the issue.
      const staleRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: staleRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        errorCode: "adapter_failed",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-07-07T04:59:04.000Z"),
        finishedAt: new Date("2026-07-07T04:59:30.000Z"),
      });

      // The actually-live run: woken by the timer, so its snapshot has NO issueId.
      const liveRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: liveRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { wakeReason: "heartbeat_timer" },
        startedAt: new Date("2026-10-29T13:17:29.000Z"),
      });

      // ...but it is linked to the issue through activity_log.
      await db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "issue.checked_out",
        entityType: "issue",
        entityId: issueId,
        agentId,
        runId: liveRunId,
      });

      const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
      const scope = await recovery.getIssueRunScopeForTest(companyId, issueId);

      expect(scope.latestRunId).toBe(liveRunId);
      expect(scope.hasActiveExecutionPath).toBe(true);
    });
  });

  it("still finds a live run that names the issue directly, with no activity_log link", async () => {
    await withDb(async (db) => {
      const { companyId, agentId, issueId } = await seed(db);

      const liveRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: liveRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-10-29T13:17:29.000Z"),
      });

      const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
      const scope = await recovery.getIssueRunScopeForTest(companyId, issueId);

      expect(scope.latestRunId).toBe(liveRunId);
      expect(scope.hasActiveExecutionPath).toBe(true);
    });
  });

  it("reports no active execution path when no run is linked to the issue at all", async () => {
    await withDb(async (db) => {
      const { companyId, agentId, issueId } = await seed(db);

      const unrelatedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: unrelatedRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { wakeReason: "heartbeat_timer" },
        startedAt: new Date("2026-10-29T13:17:29.000Z"),
      });

      const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
      const scope = await recovery.getIssueRunScopeForTest(companyId, issueId);

      expect(scope.latestRunId).toBeNull();
      expect(scope.hasActiveExecutionPath).toBe(false);
    });
  });
});
