/**
 * RUAAAAA-5323 — a `timed_out` run row must be re-classified once the
 * orphaned run's late evidence lands.
 *
 * The defect this pins: `classifyRunLiveness` is one-shot, evaluated at
 * run finalization. The openclaw_gateway wait budget expired before the
 * gateway streamed anything back, so the classifier saw zero evidence,
 * wrote `livenessState: failed` / `lastUsefulActionAt: null`, and nothing
 * ever asked again — even after the orphaned agent landed real durable
 * writes 348s later.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  type Db,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.ts";
import {
  buildRunLivenessInput,
  decideStrandedTimedOutRunReconcile,
  reconcileStrandedTimedOutRunLiveness,
  STRANDED_TIMED_OUT_RUN_LIVENESS_RECONCILED_ACTION,
  sweepStrandedRunLiveness,
} from "../services/run-liveness-reconcile.ts";

describe("stranded timed-out run liveness reconciliation guard", () => {
  it("reclassifies only when evidence landed strictly after finishedAt", () => {
    const finishedAt = new Date("2026-10-23T00:49:35.390Z");

    expect(
      decideStrandedTimedOutRunReconcile({
        runStatus: "timed_out",
        finishedAt,
        latestEvidenceAt: new Date("2026-10-23T00:53:31.526Z"),
      }),
    ).toEqual({ reconcile: true, lateEvidenceAt: new Date("2026-10-23T00:53:31.526Z") });

    // Evidence that already existed when the row was written: the first
    // classification already read it, so re-asking is pure churn.
    expect(
      decideStrandedTimedOutRunReconcile({
        runStatus: "timed_out",
        finishedAt,
        latestEvidenceAt: new Date("2026-10-23T00:49:35.385Z"),
      }),
    ).toEqual({ reconcile: false, reason: "no_late_evidence" });
    expect(
      decideStrandedTimedOutRunReconcile({
        runStatus: "timed_out",
        finishedAt,
        latestEvidenceAt: finishedAt,
      }),
    ).toEqual({ reconcile: false, reason: "no_late_evidence" });
    expect(
      decideStrandedTimedOutRunReconcile({
        runStatus: "timed_out",
        finishedAt,
        latestEvidenceAt: null,
      }),
    ).toEqual({ reconcile: false, reason: "no_late_evidence" });
  });

  it("excludes runs outside the false-terminal family", () => {
    const finishedAt = new Date("2026-10-23T00:49:35.390Z");
    const later = new Date("2026-10-23T00:53:31.526Z");

    // ABY-870 / ABY-896. `failed` qualifies only when the error code
    // says the control plane could not observe the run liveness. A
    // failed run that actually failed is not a false terminal.
    for (const runStatus of ["succeeded", "cancelled", "running", "queued"]) {
      expect(
        decideStrandedTimedOutRunReconcile({ runStatus, finishedAt, latestEvidenceAt: later }),
      ).toEqual({ reconcile: false, reason: "not_timed_out" });
    }
    expect(
      decideStrandedTimedOutRunReconcile({
        runStatus: "failed",
        errorCode: "adapter_crashed",
        finishedAt,
        latestEvidenceAt: later,
      }),
    ).toEqual({ reconcile: false, reason: "not_false_terminal" });
    expect(
      decideStrandedTimedOutRunReconcile({
        runStatus: "failed",
        errorCode: null,
        finishedAt,
        latestEvidenceAt: later,
      }),
    ).toEqual({ reconcile: false, reason: "not_false_terminal" });
    expect(
      decideStrandedTimedOutRunReconcile({
        runStatus: "timed_out",
        finishedAt: null,
        latestEvidenceAt: later,
      }),
    ).toEqual({ reconcile: false, reason: "no_finished_at" });
  });

  it("admits process_lost rows, whose stamp asserted an unobserved death (ABY-870)", () => {
    const finishedAt = new Date("2026-10-23T00:49:35.390Z");
    const later = new Date("2026-10-23T00:53:31.526Z");

    // The historical `process_lost` rows were stamped by a reaper
    // that held no handle to the agent process, so the stamp is not
    // evidence the run died. A late own-write is positive evidence
    // it did not.
    expect(
      decideStrandedTimedOutRunReconcile({
        runStatus: "failed",
        errorCode: "process_lost",
        finishedAt,
        latestEvidenceAt: later,
      }),
    ).toEqual({ reconcile: true, lateEvidenceAt: later });

    // The code the reaper now writes for adapters whose execution
    // the control plane cannot observe.
    expect(
      decideStrandedTimedOutRunReconcile({
        runStatus: "failed",
        errorCode: "execution_handle_lost",
        finishedAt,
        latestEvidenceAt: later,
      }),
    ).toEqual({ reconcile: true, lateEvidenceAt: later });
  });
});

describe("reconcileStrandedTimedOutRunLiveness", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-liveness-reconcile-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const FINISHED_AT = new Date("2026-10-23T00:49:35.390Z");

  async function seedTimedOutRun(input?: {
    runStatus?: "timed_out" | "succeeded" | "failed";
    errorCode?: string | null;
    livenessState?: "failed" | "advanced" | null;
    issueStatus?: "in_progress" | "done";
    /** A run with no source issue in its context (a heartbeat-timer run). */
    noSourceIssue?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = companyId.replace(/-/g, "").slice(0, 8).toUpperCase();

    await db.insert(companies).values({
      id: companyId,
      name: "Liveness Reconcile Co",
      issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "LongRunner",
      role: "engineer",
      status: "running",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Land work that outlives the wait budget",
      status: input?.issueStatus ?? "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "timed_out",
      contextSnapshot: input?.noSourceIssue ? {} : { issueId },
      error: "OpenClaw gateway run did not complete within waitTimeoutMs=600000ms",
      errorCode: input?.errorCode === undefined ? "timeout" : input.errorCode,
      livenessState: input?.livenessState === undefined ? "failed" : input.livenessState,
      lastUsefulActionAt: null,
      startedAt: new Date("2026-10-23T00:39:34.902Z"),
      finishedAt: FINISHED_AT,
      updatedAt: FINISHED_AT,
    });

    return { companyId, agentId, issueId, runId };
  }

  async function addComment(
    ctx: { companyId: string; agentId: string; issueId: string; runId: string },
    createdAt: Date,
  ) {
    await db.insert(issueComments).values({
      companyId: ctx.companyId,
      issueId: ctx.issueId,
      authorAgentId: ctx.agentId,
      createdByRunId: ctx.runId,
      body: "Durable write landed after the wait budget expired.",
      createdAt,
      updatedAt: createdAt,
    });
  }

  async function readRun(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
  }

  it("reclassifies a frozen timed_out row once the orphaned run lands a comment", async () => {
    const ctx = await seedTimedOutRun();
    await addComment(ctx, new Date("2026-10-23T00:53:31.526Z"));

    const before = await readRun(ctx.runId);
    expect(before?.livenessState).toBe("failed");
    expect(before?.lastUsefulActionAt).toBeNull();

    const result = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);

    expect(result.reconciled).toBe(true);
    expect(result.previousLivenessState).toBe("failed");
    expect(result.livenessState).toBe("advanced");

    const after = await readRun(ctx.runId);
    expect(after?.livenessState).toBe("advanced");
    expect(after?.livenessReason).toContain("concrete action evidence");
    expect(after?.lastUsefulActionAt?.toISOString()).toBe("2026-10-23T00:53:31.526Z");
  });

  it("is idempotent — a second pass does not rewrite a settled row", async () => {
    const ctx = await seedTimedOutRun();
    await addComment(ctx, new Date("2026-10-23T00:53:31.526Z"));

    await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    const settled = await readRun(ctx.runId);

    const second = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    expect(second.reconciled).toBe(false);
    expect(second.reason).toBe("already_reconciled");

    const after = await readRun(ctx.runId);
    expect(after?.livenessState).toBe(settled?.livenessState);
    expect(after?.lastUsefulActionAt?.toISOString()).toBe(settled?.lastUsefulActionAt?.toISOString());
    expect(after?.livenessReason).toBe(settled?.livenessReason);

    const reconcileRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, STRANDED_TIMED_OUT_RUN_LIVENESS_RECONCILED_ACTION));
    expect(reconcileRows.filter((row) => row.runId === ctx.runId)).toHaveLength(1);
  });

  it("does not churn a row whose evidence all predates finishedAt", async () => {
    const ctx = await seedTimedOutRun();
    await addComment(ctx, new Date("2026-10-23T00:49:35.385Z"));

    const result = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    expect(result.reconciled).toBe(false);
    expect(result.reason).toBe("no_late_evidence");

    const run = await readRun(ctx.runId);
    expect(run?.livenessState).toBe("failed");
    expect(run?.lastUsefulActionAt).toBeNull();
  });

  it("does not churn a timed_out run that never produced evidence at all", async () => {
    const ctx = await seedTimedOutRun();

    const result = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    expect(result.reconciled).toBe(false);
    expect(result.reason).toBe("no_late_evidence");

    expect((await readRun(ctx.runId))?.livenessState).toBe("failed");
  });

  it("leaves genuinely failed runs alone even when late evidence exists", async () => {
    for (const runStatus of ["succeeded", "failed"] as const) {
      // A run that actually failed is not a false terminal: its own
      // late writes do not prove the control plane mis-stamped it.
      const ctx = await seedTimedOutRun({
        runStatus,
        errorCode: runStatus === "failed" ? "adapter_crashed" : null,
        livenessState: "failed",
      });
      await addComment(ctx, new Date("2026-10-23T00:53:31.526Z"));

      const result = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
      expect(result.reconciled).toBe(false);
      expect(result.reason).toBe(runStatus === "failed" ? "not_false_terminal" : "not_timed_out");

      const run = await readRun(ctx.runId);
      expect(run?.livenessState).toBe("failed");
      expect(run?.lastUsefulActionAt).toBeNull();
    }
  });

  it("does not count its own reconciliation write as the run's evidence", async () => {
    const ctx = await seedTimedOutRun();
    await addComment(ctx, new Date("2026-10-23T00:53:31.526Z"));

    await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);

    // The reconciler logs an activity row scoped to this run. If that row
    // counted as evidence, a run would be able to credit itself for being
    // classified — and the next pass would find a false positive.
    const run = await readRun(ctx.runId);
    const evidence = (await buildRunLivenessInput(db, run!, undefined)).evidence;
    expect(evidence.activityEventsCreated).toBe(0);
    expect(evidence.issueCommentsCreated).toBe(1);
  });

  it("dates lastUsefulActionAt to the run's own write, not to later control-plane activity", async () => {
    const ctx = await seedTimedOutRun();
    const ownWriteAt = new Date("2026-10-23T00:53:31.526Z");
    await addComment(ctx, ownWriteAt);

    // Recovery touches the issue 4 minutes after the orphaned run's own
    // write. That timestamp must not become the run's useful-action time.
    await db.insert(activityLog).values({
      companyId: ctx.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: ctx.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: ctx.issueId,
      createdAt: new Date("2026-10-23T00:57:02.004Z"),
      details: { previousStatus: "in_progress", status: "blocked" },
    });

    const result = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    expect(result.reconciled).toBe(true);

    const run = await readRun(ctx.runId);
    expect(run?.livenessState).toBe("advanced");
    expect(run?.lastUsefulActionAt?.toISOString()).toBe(ownWriteAt.toISOString());
  });

  it("does not let a settled row walk backwards when the issue moves on", async () => {
    const ctx = await seedTimedOutRun();
    await addComment(ctx, new Date("2026-10-23T00:53:31.526Z"));

    await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    expect((await readRun(ctx.runId))?.livenessState).toBe("advanced");

    // `classifyRunLiveness` gates its timed_out override on
    // `issue.status === "in_progress"`. Recovery moving the issue to
    // blocked must not send the same evidence back to `failed`.
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, ctx.issueId));

    const second = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    expect(second.reconciled).toBe(false);
    expect(second.reason).toBe("already_reconciled");

    const run = await readRun(ctx.runId);
    expect(run?.livenessState).toBe("advanced");
    expect(run?.lastUsefulActionAt?.toISOString()).toBe("2026-10-23T00:53:31.526Z");
  });

  it("does not credit control-plane activity as the run working", async () => {
    const ctx = await seedTimedOutRun();

    // Recovery escalation writes `issue.updated` scoped to the run id even
    // though the agent produced nothing. Crediting that would turn a
    // do-nothing run into `advanced` on the strength of the machinery
    // examining it.
    await db.insert(activityLog).values({
      companyId: ctx.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: ctx.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: ctx.issueId,
      createdAt: new Date("2026-10-23T00:51:00.000Z"),
      details: { previousStatus: "in_progress", status: "blocked" },
    });

    const result = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    expect(result.reconciled).toBe(false);
    expect(result.reason).toBe("no_late_evidence");

    const run = await readRun(ctx.runId);
    expect(run?.livenessState).toBe("failed");
    expect(run?.lastUsefulActionAt).toBeNull();
  });

  it("repairs a process_lost row whose own writes landed after the false stamp (ABY-896)", async () => {
    // The ABY-870 class: the reaper stamped the run `process_lost` on the
    // strength of a handle the control plane never had, and the agent went
    // on to land real durable writes afterwards. The row must be repaired,
    // not left frozen at `failed` forever.
    const ctx = await seedTimedOutRun({ runStatus: "failed", errorCode: "process_lost" });
    const ownWriteAt = new Date("2026-10-23T00:53:31.526Z");
    await addComment(ctx, ownWriteAt);

    const result = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    expect(result.reconciled).toBe(true);

    const run = await readRun(ctx.runId);
    expect(run?.livenessState).toBe("advanced");
    expect(run?.lastUsefulActionAt?.toISOString()).toBe(ownWriteAt.toISOString());
  });

  it("repairs an execution_handle_lost row the same way (ABY-896)", async () => {
    // The code the reaper now writes for adapters whose execution the
    // control plane cannot observe. Same repair path, same predicate.
    const ctx = await seedTimedOutRun({ runStatus: "failed", errorCode: "execution_handle_lost" });
    const ownWriteAt = new Date("2026-10-23T00:53:31.526Z");
    await addComment(ctx, ownWriteAt);

    const result = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    expect(result.reconciled).toBe(true);

    const run = await readRun(ctx.runId);
    expect(run?.livenessState).toBe("advanced");
    expect(run?.lastUsefulActionAt?.toISOString()).toBe(ownWriteAt.toISOString());
  });

  it("repairs a sourceless run whose own writes landed on another issue (ABY-896)", async () => {
    // A run with no source issue in its context has no issue to scope its
    // evidence to. Scoping to the run's own issue is inapplicable
    // rather than restrictive for these, and the run's own writes count
    // wherever they landed. (Measured live: 15 of the 36 process_lost
    // rows with late own-writes are in this shape - several have no
    // source issue at all.)
    const ctx = await seedTimedOutRun({ runStatus: "failed", errorCode: "process_lost", noSourceIssue: true });
    const ownWriteAt = new Date("2026-10-23T00:53:31.526Z");
    await addComment(ctx, ownWriteAt);

    const result = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    expect(result.reconciled).toBe(true);

    const run = await readRun(ctx.runId);
    expect(run?.livenessState).toBe("advanced");
    expect(run?.lastUsefulActionAt?.toISOString()).toBe(ownWriteAt.toISOString());
  });

  it("does not repair a false-terminal row whose own writes all predate the stamp", async () => {
    const ctx = await seedTimedOutRun({ runStatus: "failed", errorCode: "process_lost" });
    await addComment(ctx, new Date("2026-10-23T00:49:35.385Z"));

    const result = await reconcileStrandedTimedOutRunLiveness(db, ctx.runId);
    expect(result.reconciled).toBe(false);
    expect(result.reason).toBe("no_late_evidence");

    const run = await readRun(ctx.runId);
    expect(run?.livenessState).toBe("failed");
    expect(run?.lastUsefulActionAt).toBeNull();
  });

  it("sweeps a false-terminal row whose issue was already blocked (ABY-896)", async () => {
    // The live ABY-843 shape: the false stamp moved the issue to
    // `blocked`, and the run's own write landed afterwards. The
    // recovery path only visits `todo` / `in_progress` issues, so
    // the repair is only reachable from the status-independent sweep.
    const ctx = await seedTimedOutRun({ runStatus: "failed", errorCode: "process_lost" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, ctx.issueId));
    const ownWriteAt = new Date("2026-10-23T00:53:31.526Z");
    await addComment(ctx, ownWriteAt);

    const swept = await sweepStrandedRunLiveness(db, { limit: 50 });
    expect(swept.runIds).toContain(ctx.runId);

    const run = await readRun(ctx.runId);
    expect(run?.livenessState).toBe("advanced");
    expect(run?.lastUsefulActionAt?.toISOString()).toBe(ownWriteAt.toISOString());
  });

  it("sweeps every qualifying row, not just the first window (ABY-896)", async () => {
    // The sweep selects candidates with a LIMIT. If the query is not
    // ordered, the window is arbitrary, and a pass can come back empty
    // while qualifying rows sit outside it - the sweep would report
    // convergence it had not reached, and those rows would stay frozen
    // at `failed` forever. This pins that every qualifying row is
    // reached.
    const contexts = [];
    for (let i = 0; i < 5; i++) {
      const ctx = await seedTimedOutRun({ runStatus: "failed", errorCode: "process_lost" });
      await addComment(ctx, new Date("2026-10-23T00:53:31.526Z"));
      contexts.push(ctx);
    }

    const swept = await sweepStrandedRunLiveness(db, { limit: 50 });
    for (const ctx of contexts) {
      expect(swept.runIds).toContain(ctx.runId);
      const run = await readRun(ctx.runId);
      expect(run?.livenessState).toBe("advanced");
    }
  });

  it("skips a missing run id without throwing", async () => {
    await expect(reconcileStrandedTimedOutRunLiveness(db, null)).resolves.toMatchObject({
      reconciled: false,
      reason: "run_missing",
    });
    await expect(reconcileStrandedTimedOutRunLiveness(db, randomUUID())).resolves.toMatchObject({
      reconciled: false,
      reason: "run_missing",
    });
  });

  /**
   * Wiring guard. Without this, deleting the reconciler call from
   * `recovery/service.ts` would leave every other test in this file green
   * while the frozen row stayed frozen forever — the exact shape of the
   * bug, reintroduced by a refactor.
   */
  it("is actually invoked by the recovery reconciliation path", async () => {
    const ctx = await seedTimedOutRun();
    // Reach the `didAutomaticRecoveryFail(latestRun, "issue_continuation_needed")`
    // branch: a timed_out continuation retry against an in_progress issue.
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: ctx.issueId, retryReason: "issue_continuation_needed" } })
      .where(eq(heartbeatRuns.id, ctx.runId));
    await addComment(ctx, new Date("2026-10-23T00:53:31.526Z"));

    const recovery = recoveryService(db, { enqueueWakeup: async () => null });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.runLivenessReconciled).toBeGreaterThan(0);

    const run = await readRun(ctx.runId);
    expect(run?.livenessState).toBe("advanced");
    expect(run?.lastUsefulActionAt?.toISOString()).toBe("2026-10-23T00:53:31.526Z");
  });

  it("leaves a frozen row alone when the recovery path runs before evidence lands", async () => {
    const ctx = await seedTimedOutRun();
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: ctx.issueId, retryReason: "issue_continuation_needed" } })
      .where(eq(heartbeatRuns.id, ctx.runId));

    const recovery = recoveryService(db, { enqueueWakeup: async () => null });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.runLivenessReconciled).toBe(0);
    expect((await readRun(ctx.runId))?.livenessState).toBe("failed");
  });
});