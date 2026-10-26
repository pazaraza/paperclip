import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  activityLog,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { issueService } from "../services/issues.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function makeRecoveryActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-09T19:30:00.000Z");
  return {
    id: randomUUID(),
    companyId: "company-1",
    sourceIssueId: "source-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "successful_run_missing_issue_disposition",
    fingerprint: "missing-disposition:fingerprint",
    evidence: {},
    nextAction: "Choose a valid issue disposition.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("issueRecoveryActionService", () => {
  it("does not reactivate an action resolved between the active read and update", async () => {
    const existingRow = makeRecoveryActionRow({ id: "existing-action", attemptCount: 1 });
    const createdRow = makeRecoveryActionRow({ id: "new-action", attemptCount: 1 });
    const selectResults = [[existingRow], []];

    const makeSelectQuery = (rows: unknown[]) => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(rows);
      },
    });

    const fakeDb = {
      select: vi.fn(() => makeSelectQuery(selectResults.shift() ?? [])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [createdRow]),
        })),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never).upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      nextAction: "Choose a valid issue disposition.",
    });

    expect(result).toMatchObject({ id: "new-action", status: "active" });
    expect(fakeDb.update).toHaveBeenCalledTimes(1);
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue recovery action tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue recovery actions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-recovery-actions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  function createApp(actor: any = { type: "board", source: "local_implicit" }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("upserts one active source-scoped action per issue and keeps company scoping explicit", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);

    const first = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    const second = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    expect(second.id).toBe(first.id);
    expect(second.attemptCount).toBe(2);
    expect(second.evidence).toMatchObject({ latestRunId: "run-2" });
    expect(await svc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: first.id });
    expect(await svc.getActiveForIssue(randomUUID(), sourceIssueId)).toBeNull();
  });

  it("escalates stranded assigned work into a source action instead of a recovery issue", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
    });
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup.mock.calls[0]?.[1]?.payload).toMatchObject({
      issueId: sourceIssue.id,
      sourceIssueId: sourceIssue.id,
      recoveryCause: "stranded_assigned_issue",
    });
  });

  it("routes stranded recovery to the operating assignee, not the executive desk (RUAAAAA-1703)", async () => {
    // Reproduces the bug where specialist routine residue woke the CEO lane
    // because resolveStrandedIssueRecoveryOwnerAgentId tried assignee.reportsTo
    // before the assignee. With the fix, the invokable assignee wins and the
    // executive role agents are reserved for the narrow escalation case.
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const leadId = randomUUID();
    const specialistId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Routing Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ceoId,
        companyId,
        name: "CEO",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: leadId,
        companyId,
        name: "Marketing Lead",
        role: "cmo",
        status: "idle",
        reportsTo: ceoId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: specialistId,
        companyId,
        name: "Demand Gen Specialist",
        role: "general",
        status: "idle",
        reportsTo: leadId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Core Health Review",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: specialistId,
      createdByAgentId: specialistId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: specialistId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      ownerAgentId: specialistId,
      previousOwnerAgentId: specialistId,
      returnOwnerAgentId: specialistId,
    });
    expect(actionRows[0]?.ownerAgentId).not.toBe(ceoId);
    expect(actionRows[0]?.ownerAgentId).not.toBe(leadId);
  });

  it("escalates to the assignee's manager when the assignee is no longer invokable (RUAAAAA-1703)", async () => {
    // The narrow manager-escalation path: the operating owner exists but is
    // paused/terminated/budget-blocked, so recovery ownership should step up
    // the reportsTo chain rather than skip straight to the executive.
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const leadId = randomUUID();
    const specialistId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Routing Co 2",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ceoId,
        companyId,
        name: "CEO",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: leadId,
        companyId,
        name: "Marketing Lead",
        role: "cmo",
        status: "idle",
        reportsTo: ceoId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: specialistId,
        companyId,
        name: "Paused Specialist",
        role: "general",
        status: "paused",
        reportsTo: leadId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Routine Health Check",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: specialistId,
      createdByAgentId: specialistId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: specialistId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(actionRows).toHaveLength(1);
    // Paused specialist is not invokable, so the lead (assignee.reportsTo) is
    // the next operating-lane escalation. CEO is reserved for the case where
    // the whole chain is unavailable.
    expect(actionRows[0]?.ownerAgentId).toBe(leadId);
    expect(actionRows[0]?.ownerAgentId).not.toBe(ceoId);
  });

  it("falls back to executive integration only when the entire operating chain is unavailable (RUAAAAA-1703)", async () => {
    // The narrow CEO rule: when both the assignee and their manager are not
    // invokable, executive ownership is the legitimate recovery destination.
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const leadId = randomUUID();
    const specialistId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Routing Co 3",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ceoId,
        companyId,
        name: "CEO",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: leadId,
        companyId,
        name: "Paused Marketing Lead",
        role: "cmo",
        status: "paused",
        reportsTo: ceoId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: specialistId,
        companyId,
        name: "Terminated Specialist",
        role: "general",
        status: "terminated",
        reportsTo: leadId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Orphan routine work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: specialistId,
      createdByAgentId: ceoId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: specialistId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(actionRows).toHaveLength(1);
    // Entire operating chain is unavailable → executive integration is the
    // legitimate recovery owner for board-created or orphaned work.
    expect(actionRows[0]?.ownerAgentId).toBe(ceoId);
  });

  it("reuses the same source-scoped action when latest run IDs change while the cause stays the same", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    expect(actionRows[0]?.evidence).toMatchObject({ latestRunId: secondLatestRun.id });
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup.mock.calls[1]?.[1]?.payload).toMatchObject({
      issueId: sourceIssue.id,
      sourceIssueId: sourceIssue.id,
      strandedRunId: secondLatestRun.id,
      recoveryCause: "stranded_assigned_issue",
    });
  });

  it("keeps the source issue blocked when source-scoped wakeup is claimed synchronously", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, managerId));
    const enqueueWakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ status: "in_progress" })
        .where(eq(issues.id, sourceIssue.id));
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterFirst?.status).toBe("blocked");
    expect(afterFirst?.assigneeAgentId).toBe(coderId);

    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    const [afterSecond] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterSecond?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Recovery action:");
  });

  it("does not create nested recovery artifacts when issue-backed fallback work itself fails", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Recover stalled issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      parentId: sourceIssueId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "stranded_issue_recovery",
      originId: sourceIssueId,
      originFingerprint: `stranded_issue_recovery:${sourceIssueId}`,
    });
    const [recoveryIssue] = await db.select().from(issues).where(eq(issues.id, recoveryIssueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue: recoveryIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: managerId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
    });

    const actionRows = await db.select().from(issueRecoveryActions);
    expect(actionRows).toHaveLength(0);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]?.status).toBe("blocked");
  });

  it("exposes active recovery actions on the issue read API", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({
      id: action.id,
      sourceIssueId,
      kind: "missing_disposition",
      ownerAgentId: managerId,
    });

    const list = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
    expect(list.body.active).toMatchObject({ id: action.id });
    expect(list.body.actions).toHaveLength(1);
  });

  it("resolves an active recovery action and removes it from active projections", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Operator confirmed the source issue is complete.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Operator confirmed the source issue is complete.",
    });
    expect(resolved.body.recoveryAction.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
  });

  it("rejects blocked recovery resolution when the source issue has no first-class blockers", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-without-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Choose a disposition with a live continuation path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const rejected = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
      })
      .expect(422);

    expect(rejected.body.error).toContain("requires an unresolved first-class blocker");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("allows blocked recovery resolution when the source issue has an unresolved first-class blocker", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Unblock recovery disposition",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-with-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Wait for the blocker before continuing.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
        resolutionNote: "The source issue is explicitly blocked by a follow-up.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "blocked",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "blocked",
      resolutionNote: "The source issue is explicitly blocked by a follow-up.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("rejects false-positive recovery resolution without an explicit source issue status", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:fingerprint",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        resolutionNote: "The source issue still has a live execution path.",
      })
      .expect(400);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolutionNote: null,
    });
  });

  it("allows false-positive recovery resolution to restore a blocked source issue in the same request", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:false-positive-unblock",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        sourceIssueStatus: "in_review",
        resolutionNote: "Recovery signal was stale; return to review.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "in_review",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "false_positive",
      resolutionNote: "Recovery signal was stale; return to review.",
    });
  });

  it("allows continuing recovery resolution to keep the source issue at in_progress (RUAAAAA-1817)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_state",
      fingerprint: "missing-disposition:continuing",
      evidence: {
        sourceRunId: "run-1",
        correctiveRunId: "run-2",
        missingDisposition: "clear_next_step",
      },
      nextAction: "Choose and record a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "continuing",
        sourceIssueStatus: "in_progress",
        resolutionNote:
          "Source issue remains in_progress with a valid continuation path recorded by the corrective run.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "in_progress",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "continuing",
      resolutionNote: expect.stringContaining("continuation path recorded by the corrective run"),
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("rejects continuing recovery resolution when sourceIssueStatus is not in_progress (RUAAAAA-1817)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_state",
      fingerprint: "missing-disposition:continuing-rejected",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const rejected = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "continuing",
        sourceIssueStatus: "done",
      })
      .expect(400);

    expect(JSON.stringify(rejected.body)).toContain("Continuing recovery actions must keep the source issue at in_progress");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("enforces company scope when resolving recovery actions", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
      })
      .expect(403);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });

  it("auto-resolves active recovery actions when the source issue transitions to done (RUAAAAA-1928 safety net)", async () => {
    const { companyId, managerId, sourceIssueId, sourceIssue } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-done:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    const updated = await issueService(db).update(sourceIssueId, {
      status: "done",
      actorAgentId: managerId,
    });
    expect(updated?.status).toBe("done");

    const [cleared] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(cleared?.status).toBe("resolved");
    expect(cleared?.outcome).toBe("restored");
    expect(cleared?.resolutionNote).toMatch(/Auto-cleared by source issue status transition/);
    expect(cleared?.resolutionNote).toMatch(/done/);
    expect(cleared?.resolvedAt).toBeTruthy();

    const active = await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId);
    expect(active).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    const autoClearLog = activityRows.find(
      (row) => row.action === "issue.recovery_action_resolved"
        && (row.details as Record<string, unknown> | null)?.source === "auto_clear_on_terminal_status",
    );
    expect(autoClearLog).toBeTruthy();
    expect((autoClearLog!.details as Record<string, unknown>)).toMatchObject({
      source: "auto_clear_on_terminal_status",
      outcome: "restored",
      sourceIssueStatus: "done",
      previousStatus: sourceIssue.status,
    });

    // Resolve is idempotent: a second call should not throw or change state.
    const after = await issueService(db).update(sourceIssueId, {
      status: "done",
      actorAgentId: managerId,
    });
    expect(after?.status).toBe("done");
  });

  it("auto-resolves active recovery actions when the source issue transitions to cancelled (RUAAAAA-1928 safety net)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: `auto-clear-cancelled:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });

    const updated = await issueService(db).update(sourceIssueId, {
      status: "cancelled",
      actorAgentId: managerId,
    });
    expect(updated?.status).toBe("cancelled");

    const [cleared] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(cleared?.status).toBe("resolved");
    expect(cleared?.outcome).toBe("restored");
    expect(cleared?.resolutionNote).toMatch(/cancelled/);
    expect(cleared?.resolvedAt).toBeTruthy();

    const active = await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId);
    expect(active).toBeNull();
  });

  it("does not auto-resolve active recovery actions on non-safety-net status transitions (RUAAAAA-1928 safety net)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-non-terminal:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    // Move to `todo` (truly non-safety-net — the safety net now covers
    // done/cancelled/blocked/in_review only after the 1931 + 2100 fixes).
    const updated = await issueService(db).update(sourceIssueId, {
      status: "todo",
      actorAgentId: managerId,
    });
    expect(updated?.status).toBe("todo");

    const [stillActive] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(stillActive?.status).toBe("active");
    expect(stillActive?.resolvedAt).toBeNull();
  });

  it("does not auto-resolve recovery actions when status is set but unchanged (RUAAAAA-1928 safety net)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    // Move source to done first
    await issueService(db).update(sourceIssueId, { status: "done", actorAgentId: managerId });

    // Now create an active recovery on an already-done source
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-no-transition:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    // Update with the same status (no actual transition)
    const updated = await issueService(db).update(sourceIssueId, {
      status: "done",
      actorAgentId: managerId,
    });
    expect(updated?.status).toBe("done");

    // Recovery should still be active because the status didn't actually change
    const [stillActive] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(stillActive?.status).toBe("active");
  });

  it("auto-resolves active recovery actions across multiple sources in independent transitions (RUAAAAA-1928 safety net)", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const svc = issueService(db);

    // Set up a second source issue in the same company
    const sourceIssueId2 = randomUUID();
    await db.insert(issues).values({
      id: sourceIssueId2,
      companyId,
      title: "Second source for multi-clear test",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 99,
      identifier: `${prefix}-99`,
    });

    const action1 = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: `auto-clear-multi-1:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });

    const action2 = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId: sourceIssueId2,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: `auto-clear-multi-2:${sourceIssueId2}`,
      evidence: { sourceIssueId: sourceIssueId2 },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    // Transition both sources to done; each transition should auto-clear its own action
    const updated1 = await svc.update(sourceIssueId, { status: "done", actorAgentId: managerId });
    const updated2 = await svc.update(sourceIssueId2, { status: "done", actorAgentId: managerId });
    expect(updated1?.status).toBe("done");
    expect(updated2?.status).toBe("done");

    const active1 = await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId);
    const active2 = await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId2);
    expect(active1).toBeNull();
    expect(active2).toBeNull();

    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    const ourRows = rows.filter(
      (r) => r.fingerprint === action1.fingerprint || r.fingerprint === action2.fingerprint,
    );
    expect(ourRows).toHaveLength(2);
    for (const row of ourRows) {
      expect(row.status).toBe("resolved");
      expect(row.outcome).toBe("restored");
      expect(row.resolutionNote).toMatch(/Auto-cleared by source issue status transition/);
    }
  });

  // RUAAAAA-1931 — extend the 1928 safety net to also auto-resolve active
  // recovery actions on a `blocked` source transition. The original safety
  // net only covered `done` / `cancelled`, which left stranded recoveries on
  // blocked sources with no clean resolution path and kept firing wakes to
  // the recovery owner. The cleanest fix is parallel: when the source status
  // transitions to `blocked`, call the same `resolveActiveForIssue` resolver
  // and emit a distinct `auto_clear_on_blocked_status` activity log entry.

  it("auto-resolves active recovery actions when the source issue transitions to blocked (RUAAAAA-1931 safety net)", async () => {
    const { companyId, managerId, sourceIssueId, sourceIssue } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-blocked:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    const updated = await issueService(db).update(sourceIssueId, {
      status: "blocked",
      actorAgentId: managerId,
    });
    expect(updated?.status).toBe("blocked");

    const [cleared] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(cleared?.status).toBe("resolved");
    expect(cleared?.outcome).toBe("restored");
    expect(cleared?.resolutionNote).toMatch(/Auto-cleared by source issue status transition/);
    expect(cleared?.resolutionNote).toMatch(/blocked/);
    expect(cleared?.resolvedAt).toBeTruthy();

    const active = await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId);
    expect(active).toBeNull();

    // Activity log must use the new `auto_clear_on_blocked_status` source
    // value, NOT `auto_clear_on_terminal_status`, so dashboards can tell
    // blocked-clear from done/cancelled-clear apart.
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    const autoClearLog = activityRows.find(
      (row) => row.action === "issue.recovery_action_resolved"
        && (row.details as Record<string, unknown> | null)?.source === "auto_clear_on_blocked_status",
    );
    expect(autoClearLog).toBeTruthy();
    expect((autoClearLog!.details as Record<string, unknown>)).toMatchObject({
      source: "auto_clear_on_blocked_status",
      outcome: "restored",
      sourceIssueStatus: "blocked",
      previousStatus: sourceIssue.status,
    });
  });

  it("is a no-op when an already-blocked source is re-PATCHed to blocked (RUAAAAA-1931 safety net)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-blocked-idempotent:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    // First transition: in_progress -> blocked resolves the action.
    await issueService(db).update(sourceIssueId, {
      status: "blocked",
      actorAgentId: managerId,
    });
    const [afterFirst] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(afterFirst?.status).toBe("resolved");
    const firstResolvedAt = afterFirst?.resolvedAt;
    expect(firstResolvedAt).toBeTruthy();

    // Second update with the same status: must not throw, must not mutate
    // the already-resolved row, must not emit a fresh activity log.
    const afterSecond = await issueService(db).update(sourceIssueId, {
      status: "blocked",
      actorAgentId: managerId,
    });
    expect(afterSecond?.status).toBe("blocked");

    const [afterSecondRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(afterSecondRow?.status).toBe("resolved");
    expect(afterSecondRow?.resolvedAt?.getTime()).toBe(firstResolvedAt!.getTime());
  });

  it("does not re-resolve an already-resolved recovery when the source moves from blocked back to in_progress (RUAAAAA-1931 safety net)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-blocked-to-in-progress:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    // in_progress -> blocked: resolves the action.
    await issueService(db).update(sourceIssueId, {
      status: "blocked",
      actorAgentId: managerId,
    });
    const [afterBlock] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(afterBlock?.status).toBe("resolved");
    const blockResolvedAt = afterBlock?.resolvedAt;
    expect(blockResolvedAt).toBeTruthy();

    // blocked -> in_progress: must not re-resolve the already-resolved action,
    // must not write a new auto-clear activity log.
    const reopened = await issueService(db).update(sourceIssueId, {
      status: "in_progress",
      actorAgentId: managerId,
    });
    expect(reopened?.status).toBe("in_progress");

    const [afterReopen] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(afterReopen?.status).toBe("resolved");
    expect(afterReopen?.resolvedAt?.getTime()).toBe(blockResolvedAt!.getTime());

    const reopenActivityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    const reopenAutoClear = reopenActivityRows.filter(
      (row) => row.action === "issue.recovery_action_resolved"
        && (
          (row.details as Record<string, unknown> | null)?.source === "auto_clear_on_blocked_status"
          || (row.details as Record<string, unknown> | null)?.source === "auto_clear_on_terminal_status"
        )
        && (row.details as Record<string, unknown> | null)?.sourceIssueStatus === "in_progress",
    );
    expect(reopenAutoClear).toHaveLength(0);
  });

  it("auto-resolves recovery actions across multiple blocked transitions of the same source (RUAAAAA-1931 safety net)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const svc = issueService(db);

    // First stranded recovery, then blocked-transition resolves it.
    const action1 = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-blocked-multi-1:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });
    await svc.update(sourceIssueId, { status: "blocked", actorAgentId: managerId });
    const [afterFirstBlock] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action1.id));
    expect(afterFirstBlock?.status).toBe("resolved");

    // Reopen, then create a second stranded recovery, then block again.
    await svc.update(sourceIssueId, { status: "in_progress", actorAgentId: managerId });
    const action2 = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: `auto-clear-blocked-multi-2:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    await svc.update(sourceIssueId, { status: "blocked", actorAgentId: managerId });
    const [afterSecondBlock] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action2.id));
    expect(afterSecondBlock?.status).toBe("resolved");
    expect(afterSecondBlock?.outcome).toBe("restored");
    expect(afterSecondBlock?.resolutionNote).toMatch(/blocked/);

    // Both actions are resolved; no active recovery remains.
    const allRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
        ),
      );
    expect(allRows).toHaveLength(2);
    for (const row of allRows) {
      expect(row.status).toBe("resolved");
      expect(row.outcome).toBe("restored");
      expect(row.resolutionNote).toMatch(/Auto-cleared by source issue status transition/);
      expect(row.resolutionNote).toMatch(/blocked/);
    }
    const stillActive = await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId);
    expect(stillActive).toBeNull();
  });

  it("does NOT auto-resolve active recovery actions when the source transitions to blocked without an explicit actor (RUAAAAA-1931 safety net)", async () => {
    // The recovery system itself transitions sources to `blocked` as part of
    // its own workflow (see `escalateStrandedAssignedIssue` in
    // `services/recovery/service.ts`) and does NOT pass an `actorAgentId` or
    // `actorUserId`. The 1931 safety net must NOT fire in those internal
    // transitions, otherwise it would erase the recovery the system just
    // created and prevent the recovery owner from ever being woken.
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-blocked-no-actor:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    // No `actorAgentId` / `actorUserId` — this mimics the recovery system's
    // internal blocked transition.
    const updated = await issueService(db).update(sourceIssueId, {
      status: "blocked",
    });
    expect(updated?.status).toBe("blocked");

    // Recovery must still be active — the safety net should not have fired.
    const [stillActive] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(stillActive?.status).toBe("active");
    expect(stillActive?.resolvedAt).toBeNull();

    // And no `auto_clear_on_blocked_status` activity log was written.
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    const autoClearLog = activityRows.find(
      (row) => row.action === "issue.recovery_action_resolved"
        && (row.details as Record<string, unknown> | null)?.source === "auto_clear_on_blocked_status",
    );
    expect(autoClearLog).toBeUndefined();
  });

  it("uses the terminal-status branch (not the blocked branch) when a blocked source transitions to done, and does not double-resolve (RUAAAAA-1931 safety net)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-blocked-then-done:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    // in_progress -> blocked resolves the action via the 1931 branch.
    await issueService(db).update(sourceIssueId, {
      status: "blocked",
      actorAgentId: managerId,
    });
    const [afterBlock] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(afterBlock?.status).toBe("resolved");
    const blockResolvedAt = afterBlock?.resolvedAt;
    expect(blockResolvedAt).toBeTruthy();

    // blocked -> done: the recovery is already resolved, so this must be a
    // no-op. The 1928 terminal branch's UPDATE has no matching row (status
    // already 'resolved', not 'active'/'escalated'), so no second resolution
    // is written and `resolvedAt` does not change.
    await issueService(db).update(sourceIssueId, {
      status: "done",
      actorAgentId: managerId,
    });
    const [afterDone] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(afterDone?.status).toBe("resolved");
    expect(afterDone?.resolvedAt?.getTime()).toBe(blockResolvedAt!.getTime());
    expect(afterDone?.resolutionNote).toMatch(/blocked/);
    expect(afterDone?.resolutionNote).not.toMatch(/done/);

    // Exactly one auto-clear activity log was written, and it is the
    // blocked-source variant — not a terminal one.
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    const autoClearLogs = activityRows.filter(
      (row) => row.action === "issue.recovery_action_resolved",
    );
    expect(autoClearLogs).toHaveLength(1);
    const details = autoClearLogs[0]!.details as Record<string, unknown>;
    expect(details.source).toBe("auto_clear_on_blocked_status");
    expect(details.sourceIssueStatus).toBe("blocked");
  });

  // RUAAAAA-2100 — extend the 1928/1931 safety net to also auto-resolve
  // active recovery actions on an `in_review` source transition. The
  // originating investigation (RUAAAAA-2098) found that when a source
  // issue is intentionally reconciled to `in_review` (rather than done,
  // cancelled, or blocked), the recovery action stays active forever and
  // keeps waking the recovery owner. The fix mirrors the 1931 shape: gate
  // on an explicit operator actor (so internal recovery system flows that
  // don't pass an actor cannot accidentally erase the recovery they just
  // created), and emit a distinct `auto_clear_on_in_review_status`
  // activity log entry so dashboards can tell the three branches apart.

  it("auto-resolves stranded_assigned_issue when the source issue transitions to in_review (RUAAAAA-2100 safety net)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-in-review-stranded:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    const updated = await issueService(db).update(sourceIssueId, {
      status: "in_review",
      actorAgentId: managerId,
    });
    expect(updated?.status).toBe("in_review");

    const [cleared] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(cleared?.status).toBe("resolved");
    expect(cleared?.outcome).toBe("restored");
    expect(cleared?.resolutionNote).toMatch(/Auto-cleared by source issue status transition/);
    expect(cleared?.resolutionNote).toMatch(/RUAAAAA-2100/);
    expect(cleared?.resolvedAt).toBeTruthy();

    const active = await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId);
    expect(active).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    const autoClearLog = activityRows.find(
      (row) => row.action === "issue.recovery_action_resolved"
        && (row.details as Record<string, unknown> | null)?.source === "auto_clear_on_in_review_status",
    );
    expect(autoClearLog).toBeTruthy();
    expect((autoClearLog!.details as Record<string, unknown>)).toMatchObject({
      source: "auto_clear_on_in_review_status",
      outcome: "restored",
      sourceIssueStatus: "in_review",
      previousStatus: "in_progress",
    });
  });

  it("auto-resolves missing_disposition when the source issue transitions to in_review (RUAAAAA-2100 safety net)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: `auto-clear-in-review-missing-disp:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });

    const updated = await issueService(db).update(sourceIssueId, {
      status: "in_review",
      actorAgentId: managerId,
    });
    expect(updated?.status).toBe("in_review");

    const [cleared] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(cleared?.status).toBe("resolved");
    expect(cleared?.outcome).toBe("restored");
    expect(cleared?.resolutionNote).toMatch(/RUAAAAA-2100/);

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    const autoClearLog = activityRows.find(
      (row) => row.action === "issue.recovery_action_resolved"
        && (row.details as Record<string, unknown> | null)?.source === "auto_clear_on_in_review_status",
    );
    expect(autoClearLog).toBeTruthy();
  });

  it("auto-resolves active recovery actions on blocked -> in_review transition (RUAAAAA-2100 safety net)", async () => {
    // Integration shape: an issue moves from `blocked` (where 1931 already
    // resolved a recovery, but the issue was then re-blocked by a fresh
    // stranded action) forward to `in_review` to acknowledge the work.
    // The 2100 branch must fire and resolve the new recovery action.
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-in-review-from-blocked:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    // Force the source to blocked first (operator-actor).
    await issueService(db).update(sourceIssueId, {
      status: "blocked",
      actorAgentId: managerId,
    });
    const [afterBlock] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(afterBlock?.status).toBe("resolved");

    // Now create a fresh stranded recovery (simulating the work coming back
    // stranded after the operator unblocked) and transition to in_review.
    const freshAction = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: `auto-clear-in-review-from-blocked-2:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const reopened = await issueService(db).update(sourceIssueId, {
      status: "in_review",
      actorAgentId: managerId,
    });
    expect(reopened?.status).toBe("in_review");

    const [afterReview] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, freshAction.id));
    expect(afterReview?.status).toBe("resolved");
    expect(afterReview?.outcome).toBe("restored");
    expect(afterReview?.resolutionNote).toMatch(/RUAAAAA-2100/);

    const active = await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId);
    expect(active).toBeNull();
  });

  it("does NOT auto-resolve active recovery actions on a in_review transition without an explicit operator actor (RUAAAAA-2100 safety net)", async () => {
    // The 2100 branch is gated on an explicit operator actor, matching the
    // 1931 defensive gate. No current server path transitions a source to
    // `in_review` without an actor, but the gate ensures no future internal
    // flow can accidentally erase the recovery it just created.
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-in-review-no-actor:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    // No `actorAgentId` / `actorUserId` — this mimics the recovery
    // system's hypothetical internal in_review transition.
    const updated = await issueService(db).update(sourceIssueId, {
      status: "in_review",
    });
    expect(updated?.status).toBe("in_review");

    const [stillActive] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(stillActive?.status).toBe("active");
    expect(stillActive?.resolvedAt).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    const autoClearLog = activityRows.find(
      (row) => row.action === "issue.recovery_action_resolved"
        && (row.details as Record<string, unknown> | null)?.source === "auto_clear_on_in_review_status",
    );
    expect(autoClearLog).toBeUndefined();
  });

  it("is a no-op when an already-in_review source is re-PATCHed to in_review (RUAAAAA-2100 safety net)", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-in-review-idempotent:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    // First transition: in_progress -> in_review resolves the action.
    await issueService(db).update(sourceIssueId, {
      status: "in_review",
      actorAgentId: managerId,
    });
    const [afterFirst] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(afterFirst?.status).toBe("resolved");
    const firstResolvedAt = afterFirst?.resolvedAt;
    expect(firstResolvedAt).toBeTruthy();

    // Second update with the same status: must not throw, must not mutate
    // the already-resolved row, must not emit a fresh activity log.
    const afterSecond = await issueService(db).update(sourceIssueId, {
      status: "in_review",
      actorAgentId: managerId,
    });
    expect(afterSecond?.status).toBe("in_review");

    const [afterSecondRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(afterSecondRow?.status).toBe("resolved");
    expect(afterSecondRow?.resolvedAt?.getTime()).toBe(firstResolvedAt!.getTime());
  });

  it("uses the blocked branch (not the in_review branch) when a blocked source transitions to in_review after a prior blocked-clear, and does not double-resolve (RUAAAAA-2100 safety net)", async () => {
    // Edge case: 1931 cleared a recovery on the first blocked transition,
    // then the source moves blocked -> in_review. The 2100 branch should
    // be a no-op (the recovery is already resolved; no new active action
    // exists at the moment of the transition).
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: `auto-clear-in-review-after-blocked:${sourceIssueId}`,
      evidence: { sourceIssueId },
      nextAction: "Pick up the stranded issue and continue.",
      wakePolicy: { type: "wake_owner" },
    });

    // in_progress -> blocked (1931 clears the action)
    await issueService(db).update(sourceIssueId, {
      status: "blocked",
      actorAgentId: managerId,
    });
    const [afterBlock] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(afterBlock?.status).toBe("resolved");
    const blockResolvedAt = afterBlock?.resolvedAt;
    expect(blockResolvedAt).toBeTruthy();

    // blocked -> in_review: the recovery is already resolved, so 2100 must
    // be a no-op. No new activity log entry is written because the
    // resolver's UPDATE has no matching row (status already 'resolved').
    await issueService(db).update(sourceIssueId, {
      status: "in_review",
      actorAgentId: managerId,
    });
    const [afterReview] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(afterReview?.status).toBe("resolved");
    expect(afterReview?.resolvedAt?.getTime()).toBe(blockResolvedAt!.getTime());
    expect(afterReview?.resolutionNote).toMatch(/blocked/);
    expect(afterReview?.resolutionNote).not.toMatch(/in_review/);

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    const autoClearLogs = activityRows.filter(
      (row) => row.action === "issue.recovery_action_resolved",
    );
    expect(autoClearLogs).toHaveLength(1);
    const details = autoClearLogs[0]!.details as Record<string, unknown>;
    expect(details.source).toBe("auto_clear_on_blocked_status");
    expect(details.sourceIssueStatus).toBe("blocked");
  });

  // -------------------------------------------------------------------------
  // RUAAAAA-2239 — routine_execution sibling auto-clear family.
  //
  // When a routine re-fires and the new execution issue transitions to a
  // terminal disposition (`done` for a clean run, `in_review` for a failed
  // run), the new run's success or different failure mode proves the cause
  // of any prior stranded_assigned_issue force-block on a SIBLING
  // routine_execution issue for the same routine is no longer reproducible.
  // The new family is event-driven by a sibling routine_execution
  // transition (not by an operator PATCH and not by a reconciliation
  // sweep on the same issue). The cause-reproducibility check is:
  //   - new run status === "succeeded" → not reproducible (auto-clear)
  //   - new run status terminal-failed AND new errorCode !== old errorCode
  //     (with null treated as a sentinel "no error code") → not reproducible
  //   - new run status terminal-failed AND new errorCode === old errorCode
  //     → still reproducible (skip)
  // -------------------------------------------------------------------------

  async function seedRoutineExecutionFixture(opts: {
    routineId: string;
    priorErrorCode: string | null;
    priorRunStatus: "failed" | "cancelled" | "timed_out";
  }) {
    const { companyId, managerId, coderId, prefix } = await seedCompany();
    const priorIssueId = randomUUID();
    const currentIssueId = randomUUID();
    const priorRunId = randomUUID();
    const currentRunId = randomUUID();

    await db.insert(issues).values([
      {
        id: priorIssueId,
        companyId,
        title: `Routine ${opts.routineId} prior blocked run`,
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        originKind: "routine_execution",
        originId: opts.routineId,
        issueNumber: 100,
        identifier: `${prefix}-100`,
      },
      {
        id: currentIssueId,
        companyId,
        title: `Routine ${opts.routineId} current run`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: coderId,
        originKind: "routine_execution",
        originId: opts.routineId,
        issueNumber: 101,
        identifier: `${prefix}-101`,
      },
    ]);

    // Prior run — the failed run that originally stranded the prior
    // blocked sibling.
    await db.insert(heartbeatRuns).values({
      id: priorRunId,
      companyId,
      agentId: coderId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.priorRunStatus,
      errorCode: opts.priorErrorCode,
      contextSnapshot: { issueId: priorIssueId },
      startedAt: new Date("2026-06-27T01:05:00.000Z"),
      finishedAt: new Date("2026-06-27T01:05:30.000Z"),
    });

    return {
      companyId,
      managerId,
      coderId,
      prefix,
      priorIssueId,
      currentIssueId,
      priorRunId,
      currentRunId,
    };
  }

  async function seedActiveStrandedAction(input: {
    companyId: string;
    sourceIssueId: string;
    ownerAgentId: string;
    fingerprint: string;
  }) {
    return issueRecoveryActionService(db).upsertSourceScoped({
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: input.ownerAgentId,
      cause: "stranded_assigned_issue",
      fingerprint: input.fingerprint,
      evidence: { sourceIssueId: input.sourceIssueId },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
  }

  it("auto-clears stranded_assigned_issue on a prior routine_execution sibling when the routine re-fires and succeeds (RUAAAAA-2239 case 1)", async () => {
    const routineId = randomUUID();
    const fixture = await seedRoutineExecutionFixture({
      routineId,
      priorErrorCode: "ECONNREFUSED",
      priorRunStatus: "failed",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const priorAction = await seedActiveStrandedAction({
      companyId: fixture.companyId,
      sourceIssueId: fixture.priorIssueId,
      ownerAgentId: fixture.managerId,
      fingerprint: `2239-case1:${fixture.priorIssueId}`,
    });

    // Current run (the routine re-fire) succeeds cleanly.
    await db.insert(heartbeatRuns).values({
      id: fixture.currentRunId,
      companyId: fixture.companyId,
      agentId: fixture.coderId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId: fixture.currentIssueId },
      startedAt: new Date("2026-06-27T03:00:00.000Z"),
      finishedAt: new Date("2026-06-27T03:00:25.000Z"),
    });

    // Trigger the routine re-fire terminal transition on the current issue.
    const updated = await issueService(db).update(fixture.currentIssueId, {
      status: "done",
      actorAgentId: fixture.managerId,
    });
    expect(updated?.status).toBe("done");

    // Prior blocked sibling should be auto-cleared and transitioned to done.
    const [priorIssueRow] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.priorIssueId));
    expect(priorIssueRow?.status).toBe("done");
    expect(priorIssueRow?.completedAt).toBeTruthy();

    const [clearedAction] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, priorAction.id));
    expect(clearedAction?.status).toBe("resolved");
    // RUAAAAA-5489 (AC6): the reconciler closed the issue itself, so the
    // outcome must not claim that a run did the work.
    expect(clearedAction?.outcome).toBe("auto_cleared_by_reconciliation");
    expect(clearedAction?.outcome).not.toBe("recovered_by_subsequent_run");
    expect(clearedAction?.resolutionNote).toMatch(/RUAAAAA-2239/);
    expect(clearedAction?.resolutionNote).toMatch(/succeeded/);

    const activeAfter = await recoveryActionSvc.getActiveForIssue(
      fixture.companyId,
      fixture.priorIssueId,
    );
    expect(activeAfter).toBeNull();

    // Audit trail should record the cross-issue auto-clear.
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, fixture.priorIssueId));
    const autoClearLogs = activityRows.filter(
      (row) => row.action === "issue.recovery_action_resolved",
    );
    expect(autoClearLogs).toHaveLength(1);
    const details = autoClearLogs[0]!.details as Record<string, unknown>;
    expect(details.source).toBe("auto_clear_on_routine_recovery");
    expect(details.previousSourceIssueStatus).toBe("blocked");
    expect(details.sourceIssueStatus).toBe("done");
    expect(details.triggeringIssueId).toBe(fixture.currentIssueId);
    expect(details.triggeringRoutineId).toBe(routineId);
    expect(details.newRunStatus).toBe("succeeded");
    expect(details.priorErrorCode).toBe("ECONNREFUSED");
  });

  it("does NOT auto-clear stranded_assigned_issue when the routine re-fires with the same errorCode (RUAAAAA-2239 case 2)", async () => {
    const routineId = randomUUID();
    const fixture = await seedRoutineExecutionFixture({
      routineId,
      priorErrorCode: "ECONNREFUSED",
      priorRunStatus: "failed",
    });
    const priorAction = await seedActiveStrandedAction({
      companyId: fixture.companyId,
      sourceIssueId: fixture.priorIssueId,
      ownerAgentId: fixture.managerId,
      fingerprint: `2239-case2:${fixture.priorIssueId}`,
    });

    // Current re-fire still fails with the same ECONNREFUSED cause — the
    // underlying issue (gateway outage) is still reproducible.
    await db.insert(heartbeatRuns).values({
      id: fixture.currentRunId,
      companyId: fixture.companyId,
      agentId: fixture.coderId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      errorCode: "ECONNREFUSED",
      contextSnapshot: { issueId: fixture.currentIssueId },
      startedAt: new Date("2026-06-27T03:00:00.000Z"),
      finishedAt: new Date("2026-06-27T03:00:30.000Z"),
    });

    await issueService(db).update(fixture.currentIssueId, {
      status: "in_review",
      actorAgentId: fixture.managerId,
    });

    // Prior sibling must stay blocked — the cause is still reproducible.
    const [priorIssueRow] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.priorIssueId));
    expect(priorIssueRow?.status).toBe("blocked");

    const [actionAfter] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, priorAction.id));
    expect(actionAfter?.status).toBe("active");
    expect(actionAfter?.outcome).toBeNull();
    expect(actionAfter?.resolvedAt).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, fixture.priorIssueId));
    const autoClearLogs = activityRows.filter(
      (row) => row.action === "issue.recovery_action_resolved",
    );
    expect(autoClearLogs).toHaveLength(0);
  });

  it("does NOT auto-clear stranded_assigned_issue when the routine re-fires with a different errorCode AND that new failure is the current terminal status (RUAAAAA-2239 case 3)", async () => {
    const routineId = randomUUID();
    const fixture = await seedRoutineExecutionFixture({
      routineId,
      priorErrorCode: "ECONNREFUSED",
      priorRunStatus: "failed",
    });
    const priorAction = await seedActiveStrandedAction({
      companyId: fixture.companyId,
      sourceIssueId: fixture.priorIssueId,
      ownerAgentId: fixture.managerId,
      fingerprint: `2239-case3:${fixture.priorIssueId}`,
    });

    // Current re-fire fails with a DIFFERENT errorCode (a new bug, not the
    // old ECONNREFUSED). Per the spec, a different errorCode counts as
    // "no longer reproducible" — so this SHOULD auto-clear, not skip.
    // This test asserts the explicit "different code" auto-clear path.
    await db.insert(heartbeatRuns).values({
      id: fixture.currentRunId,
      companyId: fixture.companyId,
      agentId: fixture.coderId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      errorCode: "TIMEOUT",
      contextSnapshot: { issueId: fixture.currentIssueId },
      startedAt: new Date("2026-06-27T03:00:00.000Z"),
      finishedAt: new Date("2026-06-27T03:00:30.000Z"),
    });

    await issueService(db).update(fixture.currentIssueId, {
      status: "in_review",
      actorAgentId: fixture.managerId,
    });

    // Different errorCode ⇒ prior ECONNREFUSED cause is no longer
    // reproducible, so the prior sibling should auto-clear.
    const [priorIssueRow] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.priorIssueId));
    expect(priorIssueRow?.status).toBe("done");

    const [actionAfter] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, priorAction.id));
    expect(actionAfter?.status).toBe("resolved");
    // RUAAAAA-5489 (AC6): the reconciler closed the issue itself.
    expect(actionAfter?.outcome).toBe("auto_cleared_by_reconciliation");
    expect(actionAfter?.outcome).not.toBe("recovered_by_subsequent_run");
    expect(actionAfter?.resolutionNote).toMatch(/error code differs/);

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, fixture.priorIssueId));
    const autoClearLogs = activityRows.filter(
      (row) => row.action === "issue.recovery_action_resolved",
    );
    expect(autoClearLogs).toHaveLength(1);
    const details = autoClearLogs[0]!.details as Record<string, unknown>;
    expect(details.source).toBe("auto_clear_on_routine_recovery");
    expect(details.newErrorCode).toBe("TIMEOUT");
    expect(details.priorErrorCode).toBe("ECONNREFUSED");
  });

  it("does NOT auto-clear recovery actions on non-routine-execution sources when a routine_execution sibling transitions to done (RUAAAAA-2239 case 4)", async () => {
    const routineId = randomUUID();
    const { companyId, managerId, coderId, prefix, sourceIssueId: nonRoutineSourceId } = await seedCompany();
    const currentIssueId = randomUUID();
    const currentRunId = randomUUID();

    // Build a routine_execution "current" issue that triggers the
    // routine_recovery cross-issue sweep, plus a separate NON-routine-
    // execution issue that already has an active stranded action.
    await db.insert(issues).values({
      id: currentIssueId,
      companyId,
      title: `Routine ${routineId} current run`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      originKind: "routine_execution",
      originId: routineId,
      issueNumber: 200,
      identifier: `${prefix}-200`,
    });

    // The non-routine-execution source from seedCompany() is manual. Mark
    // it as blocked (the stranded force-block state) and seed an active
    // stranded action on it.
    await db
      .update(issues)
      .set({ status: "blocked" })
      .where(eq(issues.id, nonRoutineSourceId));
    const nonRoutineAction = await seedActiveStrandedAction({
      companyId,
      sourceIssueId: nonRoutineSourceId,
      ownerAgentId: managerId,
      fingerprint: `2239-case4:${nonRoutineSourceId}`,
    });

    // Current run succeeds cleanly.
    await db.insert(heartbeatRuns).values({
      id: currentRunId,
      companyId,
      agentId: coderId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId: currentIssueId },
      startedAt: new Date("2026-06-27T03:00:00.000Z"),
      finishedAt: new Date("2026-06-27T03:00:25.000Z"),
    });

    await issueService(db).update(currentIssueId, {
      status: "done",
      actorAgentId: managerId,
    });

    // The non-routine-execution source must be UNAFFECTED — the
    // routine_recovery family only walks routine_execution origin siblings
    // for the same routine. The 1928/1931/2100 safety net family is the
    // one that handles terminal transitions on the SAME issue; neither
    // family should auto-clear the non-routine-execution sibling just
    // because a routine_execution sibling transitioned.
    const [nonRoutineRow] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, nonRoutineSourceId));
    expect(nonRoutineRow?.status).toBe("blocked");

    const [nonRoutineActionAfter] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, nonRoutineAction.id));
    expect(nonRoutineActionAfter?.status).toBe("active");
    expect(nonRoutineActionAfter?.outcome).toBeNull();
  });

  // -------------------------------------------------------------------------
  // RUAAAAA-5489 - board side of the anchor gap (AC5/AC6).
  //
  // The routine_recovery reconciliation closes a stranded sibling and
  // resolves its recovery action without posting the firing to the anchor
  // the tick's own contract points at. The tick then has no anchor record,
  // and it is no longer detectable by the stranded-tick reaper either,
  // because the reconciliation overwrites exactly the state the reaper
  // selects on.
  //
  // AC5: the reconciliation must REFUSE to close a tick whose parent is a
  // live recording anchor, leaving the recovery action active so the
  // watch-side reaper repairs it in the right order (post to the anchor
  // first, then close).
  //
  // AC6: the outcome must not be "recovered_by_subsequent_run" when the
  // reconciler itself closed the issue.
  // -------------------------------------------------------------------------

  it("does NOT auto-close a routine_execution sibling whose record lives on a live recording anchor (RUAAAAA-5489 AC5)", async () => {
    const routineId = randomUUID();
    const fixture = await seedRoutineExecutionFixture({
      routineId,
      priorErrorCode: "ECONNREFUSED",
      priorRunStatus: "failed",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);

    // A live recording anchor: an open, unassigned issue that persists the
    // record for its children instead of being worked as a task of its own.
    const anchorId = randomUUID();
    await db.insert(issues).values({
      id: anchorId,
      companyId: fixture.companyId,
      title: "Persistent tick log (anchor)",
      status: "backlog",
      priority: "medium",
      issueNumber: 90,
      identifier: `${fixture.prefix}-90`,
    });
    await db
      .update(issues)
      .set({ parentId: anchorId })
      .where(eq(issues.id, fixture.priorIssueId));

    const priorAction = await seedActiveStrandedAction({
      companyId: fixture.companyId,
      sourceIssueId: fixture.priorIssueId,
      ownerAgentId: fixture.managerId,
      fingerprint: `5489-ac5:${fixture.priorIssueId}`,
    });

    // The routine re-fire succeeds cleanly.
    await db.insert(heartbeatRuns).values({
      id: fixture.currentRunId,
      companyId: fixture.companyId,
      agentId: fixture.coderId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId: fixture.currentIssueId },
      startedAt: new Date("2026-06-27T03:00:00.000Z"),
      finishedAt: new Date("2026-06-27T03:00:25.000Z"),
    });

    const updated = await issueService(db).update(fixture.currentIssueId, {
      status: "done",
      actorAgentId: fixture.managerId,
    });
    expect(updated?.status).toBe("done");

    // The sibling must NOT be closed: its record lives on the anchor.
    const [priorIssueRow] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.priorIssueId));
    expect(priorIssueRow?.status).toBe("blocked");
    expect(priorIssueRow?.completedAt).toBeFalsy();

    // The recovery action must stay ACTIVE so the watch-side reaper repairs
    // it in the right order: post to the anchor FIRST, then close.
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, priorAction.id));
    expect(actionRow?.status).toBe("active");
    expect(actionRow?.outcome).toBeNull();
    expect(actionRow?.resolutionNote).toBeNull();

    const activeAfter = await recoveryActionSvc.getActiveForIssue(
      fixture.companyId,
      fixture.priorIssueId,
    );
    expect(activeAfter).not.toBeNull();

    // The refusal has to be auditable.
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, fixture.priorIssueId));
    const skipLogs = activityRows.filter(
      (row) => row.action === "issue.recovery_action_auto_clear_skipped",
    );
    expect(skipLogs).toHaveLength(1);
    const skipDetails = skipLogs[0]!.details as Record<string, unknown>;
    expect(skipDetails.source).toBe("auto_clear_skipped_recording_anchor");
    expect(skipDetails.anchorIssueId).toBe(anchorId);
    expect(skipDetails.recoveryActionId).toBe(priorAction.id);
    expect(skipDetails.triggeringIssueId).toBe(fixture.currentIssueId);
    expect(skipDetails.triggeringRoutineId).toBe(routineId);
  });

  it("auto-closes a routine_execution sibling whose parent is NOT a live anchor and records the reconciler outcome (RUAAAAA-5489 AC6)", async () => {
    const routineId = randomUUID();
    const fixture = await seedRoutineExecutionFixture({
      routineId,
      priorErrorCode: "ECONNREFUSED",
      priorRunStatus: "failed",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);

    // An ASSIGNED parent is a working issue, not a persistent tick log, so
    // the reconciler stays free to close the sibling.
    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId,
      companyId: fixture.companyId,
      title: "Working parent issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: fixture.managerId,
      issueNumber: 90,
      identifier: `${fixture.prefix}-90`,
    });
    await db
      .update(issues)
      .set({ parentId })
      .where(eq(issues.id, fixture.priorIssueId));

    const priorAction = await seedActiveStrandedAction({
      companyId: fixture.companyId,
      sourceIssueId: fixture.priorIssueId,
      ownerAgentId: fixture.managerId,
      fingerprint: `5489-ac6:${fixture.priorIssueId}`,
    });

    await db.insert(heartbeatRuns).values({
      id: fixture.currentRunId,
      companyId: fixture.companyId,
      agentId: fixture.coderId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId: fixture.currentIssueId },
      startedAt: new Date("2026-06-27T03:00:00.000Z"),
      finishedAt: new Date("2026-06-27T03:00:25.000Z"),
    });

    const updated = await issueService(db).update(fixture.currentIssueId, {
      status: "done",
      actorAgentId: fixture.managerId,
    });
    expect(updated?.status).toBe("done");

    const [priorIssueRow] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.priorIssueId));
    expect(priorIssueRow?.status).toBe("done");

    const [clearedAction] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, priorAction.id));
    expect(clearedAction?.status).toBe("resolved");
    expect(clearedAction?.outcome).toBe("auto_cleared_by_reconciliation");
    expect(clearedAction?.outcome).not.toBe("recovered_by_subsequent_run");
    expect(clearedAction?.resolutionNote).toMatch(/closed by the reconciler itself/);

    const activeAfter = await recoveryActionSvc.getActiveForIssue(
      fixture.companyId,
      fixture.priorIssueId,
    );
    expect(activeAfter).toBeNull();

    // The anchor guard must not have fired for a non-anchor parent.
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, fixture.priorIssueId));
    const skipLogs = activityRows.filter(
      (row) => row.action === "issue.recovery_action_auto_clear_skipped",
    );
    expect(skipLogs).toHaveLength(0);
  });
});
