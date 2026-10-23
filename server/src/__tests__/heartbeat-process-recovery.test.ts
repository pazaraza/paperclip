import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { and, eq, or, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companySkills,
  companies,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Recovered stranded heartbeat work.",
    provider: "test",
    model: "test-model",
  })),
);

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

import {
  heartbeatService,
  redactDetectedSuccessfulRunProgressSummaryForBoard,
} from "../services/heartbeat.ts";
import {
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
} from "../services/recovery/index.ts";
import {
  DEFAULT_MAX_SWEEP_CONTINUATION_ATTEMPTS,
  SWEEP_CONTINUATION_EXHAUSTED_COMMENT_PREFIX,
} from "../services/run-continuations.ts";
import { readSweepContinuationAttempt } from "../services/recovery/run-liveness-continuations.ts";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
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

async function waitForValue<T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest: T | null | undefined = null;
  while (Date.now() < deadline) {
    latest = await read();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest ?? null;
}

async function waitForHeartbeatIdle(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db
      .select({
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cancelActiveRunsForCleanup(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeRuns = await db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        or(
          eq(heartbeatRuns.status, "queued"),
          eq(heartbeatRuns.status, "running"),
        ),
      );

    if (activeRuns.length === 0) return;

    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    const wakeupRequestIds = activeRuns
      .map((run) => run.wakeupRequestId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
        errorCode: "test_cleanup",
        error: "Cancelled by heartbeat-process-recovery test cleanup",
        processPid: null,
        processGroupId: null,
      })
      .where(inArray(heartbeatRuns.id, runIds));

    if (wakeupRequestIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "Cancelled by heartbeat-process-recovery test cleanup",
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function spawnOrphanedProcessGroup() {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => process.exit(0), 25);",
      ].join(" "),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => resolve());
  });

  const descendantPid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
    throw new Error(`Failed to capture orphaned descendant pid from detached process group: ${stdout}`);
  }

  return {
    processPid: leader.pid ?? null,
    processGroupId: leader.pid ?? null,
    descendantPid,
  };
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Recovered stranded heartbeat work.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    await cancelActiveRunsForCleanup(db, 5_000);
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({
          status: heartbeatRuns.status,
          processPid: heartbeatRuns.processPid,
          processGroupId: heartbeatRuns.processGroupId,
        })
        .from(heartbeatRuns);
      const managedExecutionStillActive = runs.some(
        (run) =>
          (run.status === "queued" || run.status === "running") &&
          !run.processPid &&
          !run.processGroupId,
      );
      if (!managedExecutionStillActive) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitForHeartbeatIdle(db, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(costEvents);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issueComments);
      await db.delete(issueDocuments);
      try {
        await db.delete(issues);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(budgetPolicies);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(companySkills);
      try {
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processGroupId?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
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
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false ? {} : { issueId },
      processPid: input?.processPid ?? null,
      processGroupId: input?.processGroupId ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  async function seedEnvironmentLeaseFixture(input: {
    companyId: string;
    runId: string;
    issueId: string;
    provider?: string;
  }) {
    const environmentId = randomUUID();
    const leaseId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");

    await db.insert(environments).values({
      id: environmentId,
      companyId: input.companyId,
      name: "Local test environment",
      driver: "local",
      status: "active",
      config: {},
      metadata: null,
    });

    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId: input.companyId,
      environmentId,
      issueId: input.issueId,
      heartbeatRunId: input.runId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: input.provider ?? "local",
      providerLeaseId: null,
      acquiredAt: now,
      lastUsedAt: now,
      metadata: {
        driver: "local",
      },
      createdAt: now,
      updatedAt: now,
    });

    return { environmentId, leaseId };
  }

  async function seedStrandedIssueFixture(input: {
    status: "todo" | "in_progress";
    runStatus: "failed" | "timed_out" | "cancelled" | "succeeded";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | null;
    runSource?: string | null;
    assignToUser?: boolean;
    activePauseHold?: boolean;
    livenessState?: "completed" | "advanced" | "plan_only" | "empty_response" | "blocked" | "failed" | "needs_followup" | null;
    runErrorCode?: string | null;
    runError?: string | null;
    // RUAAAAA-5326: the sweep's own attempt budget, carried on the run's
    // contextSnapshot. Deliberately NOT the `continuationAttempt` column,
    // which belongs to the liveness continuation ladder.
    sweepContinuationAttempt?: number | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const rootIssueId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
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
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: input.retryReason === "assignment_recovery" ? "issue_assignment_recovery" : "issue_assigned",
      payload: { issueId },
      status: input.runStatus === "cancelled" ? "cancelled" : "failed",
      runId,
      claimedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus,
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: input.retryReason === "assignment_recovery"
          ? "issue_assignment_recovery"
          : input.retryReason ?? "issue_assigned",
        ...(input.retryReason ? { retryReason: input.retryReason } : {}),
        ...(input.runSource ? { source: input.runSource } : {}),
        ...(input.sweepContinuationAttempt
          ? { sweepContinuationAttempt: input.sweepContinuationAttempt }
          : {}),
      },
      startedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      updatedAt: new Date("2026-03-19T00:05:00.000Z"),
      errorCode: input.runStatus === "succeeded"
        ? null
        : ("runErrorCode" in input ? input.runErrorCode : "process_lost"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
      livenessState: input.livenessState ?? null,
    });

    await db.insert(issues).values([
      ...(input.activePauseHold
        ? [{
          id: rootIssueId,
          companyId,
          title: "Paused recovery root",
          status: "todo",
          priority: "medium",
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        }]
        : []),
      {
        id: issueId,
        companyId,
        parentId: input.activePauseHold ? rootIssueId : null,
        title: "Recover stranded assigned work",
        status: input.status,
        priority: "medium",
        assigneeAgentId: input.assignToUser ? null : agentId,
        assigneeUserId: input.assignToUser ? "user-1" : null,
        checkoutRunId: input.status === "in_progress" ? runId : null,
        executionRunId: null,
        issueNumber: input.activePauseHold ? 2 : 1,
        identifier: `${issuePrefix}-${input.activePauseHold ? 2 : 1}`,
        startedAt: input.status === "in_progress" ? now : null,
      },
    ]);

    if (input.activePauseHold) {
      await db.insert(issueTreeHolds).values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "pause recovery subtree",
        releasePolicy: { strategy: "manual" },
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId, rootIssueId };
  }

  async function seedAssignedTodoNoRunFixture(input?: {
    agentStatus?: "paused" | "idle" | "running";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned todo work that never received a heartbeat",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function expectSourceScopedStrandedRecoveryAction(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
    previousStatus: "todo" | "in_progress";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | null;
    cause?: string;
    kind?: string;
  }) {
    const action = await waitForValue(async () =>
      db.select().from(issueRecoveryActions).where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.sourceIssueId, input.issueId),
        ),
      ).then((rows) => rows[0] ?? null),
    );
    if (!action) throw new Error("Expected source-scoped stranded recovery action to be created");

    expect(action).toMatchObject({
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      recoveryIssueId: null,
      kind: input.kind ?? "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: input.agentId,
      previousOwnerAgentId: input.agentId,
      returnOwnerAgentId: input.agentId,
      cause: input.cause ?? "stranded_assigned_issue",
      attemptCount: 1,
      maxAttempts: null,
    });
    expect(action.evidence).toMatchObject({
      sourceIssueId: input.issueId,
      previousStatus: input.previousStatus,
      latestRunId: input.runId,
      retryReason: input.retryReason ?? null,
    });
    expect(action.nextAction).toContain(
      input.kind === "missing_disposition" ? "valid issue disposition" : "Restore a live execution path",
    );

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, "stranded_issue_recovery"),
        eq(issues.originId, input.issueId),
      ));
    expect(recoveryIssues).toHaveLength(0);

    const recoveryWakeup = await waitForValue(async () => {
      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, input.agentId));
      return wakeups.find((wakeup) => {
        const payload = wakeup.payload as Record<string, unknown> | null;
        return payload?.issueId === input.issueId &&
          payload?.sourceIssueId === input.issueId &&
          payload?.recoveryActionId === action.id &&
          payload?.strandedRunId === input.runId;
      }) ?? null;
    });
    expect(recoveryWakeup).toMatchObject({
      companyId: input.companyId,
      reason: "source_scoped_recovery_action",
      source: "assignment",
      payload: expect.objectContaining({ modelProfile: "cheap" }),
    });

    const recoveryRun = recoveryWakeup?.runId
      ? await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, recoveryWakeup.runId))
        .then((rows) => rows[0] ?? null)
      : null;
    expect(recoveryRun?.contextSnapshot).toMatchObject({
      issueId: input.issueId,
      taskId: input.issueId,
      source: "issue_recovery_action",
      recoveryActionId: action.id,
      sourceIssueId: input.issueId,
      strandedRunId: input.runId,
      modelProfile: "cheap",
    });
    await waitForHeartbeatIdle(db);
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0] ?? null);
    expect(sourceIssue?.status).toBe("blocked");

    return action;
  }

  async function sourceBlockerIssueIds(companyId: string, sourceIssueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, sourceIssueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function seedQueuedIssueRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
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
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
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
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry transient Codex failure without blocking",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.livenessState).toBe("failed");
    expect(failedRun?.livenessReason).toContain("process_lost");
    expect(failedRun?.resultJson).toMatchObject({
      stopReason: "process_lost",
      timeoutConfigured: false,
      timeoutFired: false,
    });
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);
    expect(retryRun?.contextSnapshot).toMatchObject({ modelProfile: "cheap" });

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("releases active environment leases when an orphaned run is reaped", async () => {
    const { runId, issueId, companyId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const { leaseId } = await seedEnvironmentLeaseFixture({
      companyId,
      runId,
      issueId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const lease = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
    expect(lease?.status).toBe("failed");
    expect(lease?.releasedAt).toBeTruthy();
  });

  it.skipIf(process.platform === "win32")("reaps orphaned descendant process groups when the parent pid is already gone", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);

    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    expect(await waitForPidExit(orphan.descendantPid, 2_000)).toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("descendant process group");

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.status).toBe("queued");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("blocks the issue when process-loss retry is exhausted and the immediate continuation recovery also fails", async () => {
    mockAdapterExecute.mockRejectedValueOnce(new Error("continuation recovery failed"));

    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const resolvedBlockerId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: resolvedBlockerId,
      companyId,
      title: "Already completed prerequisite",
      status: "done",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: resolvedBlockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    expect(runs.find((row) => row.id === runId)?.status).toBe("failed");
    const continuationRun = runs.find((row) => row.id !== runId);
    expect(continuationRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
    });

    const blockedIssue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue?.status === "blocked" ? issue : null;
      })
    );
    expect(blockedIssue?.status).toBe("blocked");
    expect(blockedIssue?.executionRunId).toBeNull();
    expect(blockedIssue?.checkoutRunId).toBeNull();
    if (!continuationRun?.id) throw new Error("Expected continuation recovery run to exist");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId: continuationRun.id,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  it("blocks failed recovery work in place during immediate terminal-run cleanup", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const recoveryIssue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue?.status === "blocked" ? issue : null;
      })
    );
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);
    expect(recoveryIssue?.executionRunId).toBeNull();

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).not.toContain("sk-test-recovery-secret");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("does not block paused-tree work when immediate continuation recovery is suppressed by the hold", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "pause immediate recovery subtree",
      releasePolicy: { strategy: "manual" },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("schedules a bounded retry for codex transient upstream failures instead of blocking the issue immediately", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      errorMessage:
        "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
      provider: "openai",
      model: "gpt-5.4",
      resultJson: {
        errorFamily: "transient_upstream",
      },
    });

    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const runs = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows.length >= 2 ? rows : null;
    });
    expect(runs).toHaveLength(2);

    const failedRun = runs?.find((row) => row.id === runId);
    const retryRun = runs?.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("adapter_failed");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("transient_upstream");
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.contextSnapshot).toMatchObject({
      codexTransientFallbackMode: "same_session",
      modelProfile: "cheap",
    });

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("queues one finish-handoff wake when a successful run leaves in-progress work without a next action", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Implemented the backend detector, but did not choose a final issue state.",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Implemented the backend detector, but did not choose a final issue state.",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(1);
    expect(handoffWakeups[0]?.idempotencyKey).toBe(`finish_successful_run_handoff:${issueId}:${runId}:1`);
    expect(handoffWakeups[0]?.payload).toMatchObject({
      issueId,
      sourceRunId: runId,
      handoffRequired: true,
      handoffReason: "successful_run_missing_state",
      handoffAttempt: 1,
      maxHandoffAttempts: 1,
      resumeIntent: true,
      resumeFromRunId: runId,
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const handoffComment = comments.find((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    expect(handoffComment).toBeTruthy();
    expect(handoffComment?.authorType).toBe("system");
    expect(handoffComment?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "warning",
      detailsDefaultOpen: false,
    });
    expect(handoffComment?.metadata).toMatchObject({
      version: 1,
      sections: expect.arrayContaining([
        expect.objectContaining({
          title: "Required action",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
          ]),
        }),
        expect.objectContaining({
          title: "Run evidence",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "run_link", runId }),
            expect.objectContaining({ type: "key_value", label: "Normalized cause", value: SUCCESSFUL_RUN_MISSING_STATE_REASON }),
          ]),
        }),
      ]),
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity.some((event) => event.action === "issue.successful_run_handoff_required")).toBe(true);
  });

  it("requeues a missing-disposition handoff when the previous corrective wake was cancelled", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const idempotencyKey = `finish_successful_run_handoff:${issueId}:${runId}:1`;
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "finish_successful_run_handoff",
      payload: {
        issueId,
        sourceRunId: runId,
        handoffRequired: true,
        handoffReason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      },
      status: "cancelled",
      idempotencyKey,
      requestedAt: new Date("2026-03-19T00:00:01.000Z"),
      finishedAt: new Date("2026-03-19T00:00:02.000Z"),
      updatedAt: new Date("2026-03-19T00:00:02.000Z"),
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Implemented recovery handling, but did not choose a final issue state.",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Implemented recovery handling, but did not choose a final issue state.",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
      const requeued = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return requeued.length > 1 ? requeued : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(2);
    expect(handoffWakeups.filter((wakeup) => wakeup.status === "cancelled")).toHaveLength(1);
    expect(handoffWakeups.some((wakeup) => wakeup.status !== "cancelled")).toBe(true);
  });

  it("queues one missing-disposition handoff for artifact-producing successful runs left in progress", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Drafted the Phase 3 test plan but did not choose a final issue disposition.",
      });
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Regression test plan",
        format: "markdown",
        latestBody: "# Regression test plan\n\n- Cover artifact-producing successful runs",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Regression test plan",
        format: "markdown",
        body: "# Regression test plan\n\n- Cover artifact-producing successful runs",
        createdByAgentId: agentId,
        createdByRunId: ctx.runId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "plan",
      });
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "report",
        provider: "test",
        externalId: "phase-3-report",
        title: "Phase 3 regression notes",
        status: "ready",
        summary: "Successful run produced a visible artifact.",
        createdByRunId: ctx.runId,
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Created comments, a plan document, and a work product without choosing a disposition.",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    const settledRun = await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);
    const classifiedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(classifiedRun?.status ?? settledRun?.status).toBe("succeeded");
    expect(classifiedRun?.livenessState).toBe("advanced");
    expect(handoffWakeups).toHaveLength(1);
    expect(handoffWakeups[0]?.idempotencyKey).toBe(`finish_successful_run_handoff:${issueId}:${runId}:1`);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.filter((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY)).toHaveLength(1);
    expect(comments.some((comment) => comment.body.startsWith("Drafted the Phase 3 test plan"))).toBe(true);

    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(workProducts).toHaveLength(1);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
  });

  it("redacts secret-bearing successful-run detected progress before handoff disclosure", async () => {
    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const bearerSecret = "live-bearer-token-value";
    const apiKeySecret = "sk-testsuccessfulhandoffsecret";
    const redactedDetectedSummary = redactDetectedSuccessfulRunProgressSummaryForBoard(
      `Next action noted: Authorization: Bearer ${bearerSecret} OPENAI_API_KEY=${apiKeySecret}`,
      { enabled: false },
    );
    expect(redactedDetectedSummary).toContain("***REDACTED***");
    expect(redactedDetectedSummary).not.toContain(bearerSecret);
    expect(redactedDetectedSummary).not.toContain(apiKeySecret);

    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Made progress but left the issue open.",
      resultJson: {
        message: `Next action: Authorization: Bearer ${bearerSecret} OPENAI_API_KEY=${apiKeySecret}`,
      },
      provider: "test",
      model: "test-model",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 5_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(1);
    const wakeupPayloadText = JSON.stringify(handoffWakeups[0]?.payload ?? {});
    expect(wakeupPayloadText).not.toContain(bearerSecret);
    expect(wakeupPayloadText).not.toContain(apiKeySecret);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const handoffComment = comments.find((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    expect(handoffComment).toBeTruthy();
    expect(handoffComment?.body).not.toContain(bearerSecret);
    expect(handoffComment?.body).not.toContain(apiKeySecret);
    expect(JSON.stringify(handoffComment?.metadata ?? {})).not.toContain(bearerSecret);
    expect(JSON.stringify(handoffComment?.metadata ?? {})).not.toContain(apiKeySecret);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    const handoffActivity = activity.find((event) => event.action === "issue.successful_run_handoff_required");
    expect(handoffActivity).toBeTruthy();
    const activityDetailsText = JSON.stringify(handoffActivity?.details ?? {});
    expect(activityDetailsText).not.toContain(bearerSecret);
    expect(activityDetailsText).not.toContain(apiKeySecret);
  });

  it("escalates an exhausted failed successful-run handoff without using generic continuation recovery first", async () => {
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      runErrorCode: "adapter_failed",
      runError: "Authorization: Bearer sk-test-successful-handoff-secret",
    });
    const sourceRunId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "finish_successful_run_handoff",
          sourceRunId,
          resumeFromRunId: sourceRunId,
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          missingDisposition: "clear_next_step",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.successfulRunHandoffEscalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: null,
      cause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      kind: "missing_disposition",
    });
    expect(recoveryAction.evidence).toMatchObject({
      sourceRunId,
      missingDisposition: "clear_next_step",
      latestRunStatus: "failed",
      latestRunErrorCode: "adapter_failed",
      recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
    });
    expect(JSON.stringify(recoveryAction.evidence)).not.toContain("sk-test-successful-handoff-secret");

    const sourceIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(sourceIssue?.status).toBe("blocked");
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments[0]?.body).toBe(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      detailsDefaultOpen: false,
    });
    expect(comments[0]?.metadata).toMatchObject({
      version: 1,
      sections: expect.arrayContaining([
        expect.objectContaining({
          title: "Recovery owner",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Recovery action", value: recoveryAction.id }),
            expect.objectContaining({ type: "agent_link", label: "Recovery owner", name: "CodexCoder" }),
          ]),
        }),
        expect.objectContaining({
          title: "Run evidence",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Normalized cause", value: SUCCESSFUL_RUN_MISSING_STATE_REASON }),
            expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
          ]),
        }),
      ]),
    });
    expect(comments[0]?.body).not.toContain("sk-test-successful-handoff-secret");
    expect(JSON.stringify(comments[0]?.metadata ?? {})).not.toContain("sk-test-successful-handoff-secret");

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activity.some((event) => event.action === "issue.successful_run_handoff_escalated")).toBe(true);
  });

  it("escalates an exhausted successful handoff run that still leaves no disposition", async () => {
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const sourceRunId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "finish_successful_run_handoff",
          sourceRunId,
          resumeFromRunId: sourceRunId,
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          missingDisposition: "clear_next_step",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.successfulContinuationObserved).toBe(0);
    expect(result.successfulRunHandoffEscalated).toBe(1);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: null,
      cause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      kind: "missing_disposition",
    });
    expect(recoveryAction.evidence).toMatchObject({
      sourceRunId,
      latestRunStatus: "succeeded",
      missingDisposition: "clear_next_step",
    });
  });

  it("auto-clears the missing_disposition recovery action when the source issue has open child issues (RUAAAAA-1817)", async () => {
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const sourceRunId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "finish_successful_run_handoff",
          sourceRunId,
          resumeFromRunId: sourceRunId,
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          missingDisposition: "clear_next_step",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    // Seed an active missing_disposition recovery action (as if a previous
    // reconciliation pass had already escalated the source issue and a
    // corrective agent run has since re-set the source to in_progress).
    const recoveryActionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "missing_disposition",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      previousOwnerAgentId: agentId,
      returnOwnerAgentId: agentId,
      cause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      fingerprint: `source_scoped_recovery:${companyId}:${issueId}:${SUCCESSFUL_RUN_MISSING_STATE_REASON}`,
      evidence: {
        sourceIssueId: issueId,
        previousStatus: "in_progress",
        latestIssueStatus: "in_progress",
        latestRunId: runId,
        latestRunStatus: "succeeded",
        sourceRunId,
        correctiveRunId: runId,
        missingDisposition: "clear_next_step",
        handoffAttempt: 1,
        maxHandoffAttempts: 1,
      },
      nextAction: "Choose and record a valid issue disposition without copying transcript content.",
      attemptCount: 1,
    });
    // Seed an open child issue to act as the delegated follow-up continuation path.
    const childIssueId = randomUUID();
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      title: "Delegate child for continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      parentId: issueId,
      issueNumber: 999,
      identifier: `RA-999`,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffAutoCleared).toBe(1);
    expect(result.successfulRunHandoffEscalated).toBe(0);

    // Source issue should remain in_progress (not force-blocked).
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("in_progress");

    // Recovery action should be resolved with outcome=continuing.
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      kind: "missing_disposition",
      status: "resolved",
      outcome: "continuing",
    });
    expect(actionRows[0].resolutionNote).toMatch(
      /valid continuation path recorded by run .*open child issue/i,
    );
    expect(actionRows[0].resolvedAt).toBeTruthy();
  });

  it("auto-clears the stranded_assigned_issue recovery action when the timed_out continuation retry created child issues before the gateway wait-timeout fired (RUAAAAA-2072)", async () => {
    // Pattern from RUAAAAA-2061 (2026-06-22): a long-running Lead run on
    // an openclaw_gateway adapter timed out at the 300s gateway boundary
    // AFTER the Lead had already filed child issues and posted progress
    // comments. The reconciliation sweep was re-rolling the source issue
    // to `blocked` on every retry cycle even though the work was durable.
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "timed_out",
      runErrorCode: "timeout",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
    });
    // Seed an active stranded_assigned_issue recovery action as if a
    // prior reconciliation pass had already created it (the actual 2061
    // recovery action has attemptCount=6 at the time of investigation).
    const recoveryActionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      previousOwnerAgentId: agentId,
      returnOwnerAgentId: agentId,
      cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${companyId}:${issueId}:stranded_assigned_issue`,
      evidence: {
        sourceIssueId: issueId,
        previousStatus: "in_progress",
        latestIssueStatus: "in_progress",
        latestRunId: runId,
        latestRunStatus: "timed_out",
        retryReason: "issue_continuation_needed",
        latestRunErrorCode: "timeout",
        missingDisposition: null,
      },
      nextAction: "Restore a live execution path or record a manual resolution.",
      attemptCount: 6,
    });
    // Seed an open child issue that the timed-out run created before the
    // 300s gateway wait-timeout fired (this is the durable-progress
    // signal the auto-clear guard is looking for).
    const childIssueId = randomUUID();
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      title: "Delegated follow-up that landed before the gateway timeout",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      parentId: issueId,
      issueNumber: 1001,
      identifier: `RA-1001`,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffAutoCleared).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.continuationRequeued).toBe(0);

    // Source issue must stay at in_progress (not force-blocked).
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("in_progress");

    // Recovery action must be resolved with outcome=continuing.
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      kind: "stranded_assigned_issue",
      status: "resolved",
      outcome: "continuing",
    });
    expect(actionRows[0].resolutionNote).toMatch(
      /timed-out continuation retry recorded durable progress/i,
    );
    expect(actionRows[0].resolutionNote).toMatch(/1 open child issue/i);
    expect(actionRows[0].resolvedAt).toBeTruthy();
  });

  it("still escalates stranded_assigned_issue when the timed_out continuation retry left no durable progress (RUAAAAA-2072)", async () => {
    // Same shape as the auto-clear test, but with NO open child issues,
    // NO comments created by the run, and NO work products. This is the
    // "real stall" case — the run timed out before producing anything
    // durable and the recovery action should still escalate to `blocked`.
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "timed_out",
      runErrorCode: "timeout",
      retryReason: "issue_continuation_needed",
      livenessState: "failed",
    });
    const recoveryActionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      previousOwnerAgentId: agentId,
      returnOwnerAgentId: agentId,
      cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${companyId}:${issueId}:stranded_assigned_issue`,
      evidence: {
        sourceIssueId: issueId,
        previousStatus: "in_progress",
        latestIssueStatus: "in_progress",
        latestRunId: runId,
        latestRunStatus: "timed_out",
        retryReason: "issue_continuation_needed",
        latestRunErrorCode: "timeout",
        missingDisposition: null,
      },
      nextAction: "Restore a live execution path or record a manual resolution.",
      attemptCount: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffAutoCleared).toBe(0);
    expect(result.escalated).toBe(1);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("blocked");
  });

  // ---------------------------------------------------------------------------
  // RUAAAAA-2184 — cycle-1 ordering bug fix.
  //
  // The 2072 cycle-2+ guard requires an existing active recovery action,
  // which means cycle 1 always slipped through and force-blocked the source
  // issue even when the timed-out run had already produced durable progress.
  // The cycle-1 guard below runs the evidence check BEFORE the recovery
  // action is created, so a fresh reconciliation cycle with no pre-existing
  // action still has a chance to skip escalation.
  // ---------------------------------------------------------------------------

  it("cycle-1 auto-clears stranded_assigned_issue when a fresh timed_out continuation retry created child issues (RUAAAAA-2184)", async () => {
    // Pattern from RUAAAAA-2169 (2026-06-24): a long-running HoE run timed
    // out 6 seconds after posting 2 durable comments, the recovery sweep
    // force-blocked the source issue with a stranded_assigned_issue
    // action, and the 2072 cycle-2+ guard could not fire because the
    // action did not exist yet at cycle-1 evidence-check time.
    //
    // This test deliberately does NOT seed a pre-existing recovery action —
    // it exercises the cycle-1 path where ensure + resolve happens inside
    // a single reconciliation pass.
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "timed_out",
      runErrorCode: "timeout",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
    });
    // Seed an open child issue that the timed-out run created before the
    // 300s gateway wait-timeout fired.
    const childIssueId = randomUUID();
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      title: "Delegated follow-up that landed before the gateway timeout",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      parentId: issueId,
      issueNumber: 2001,
      identifier: `RA-2001`,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffAutoCleared).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.continuationRequeued).toBe(0);

    // Source issue must stay at in_progress (not force-blocked).
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("in_progress");

    // A recovery action must exist (ensure materialized it), but it must
    // be resolved with outcome=continuing.
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      kind: "stranded_assigned_issue",
      status: "resolved",
      outcome: "continuing",
    });
    expect(actionRows[0].resolutionNote).toMatch(
      /reconciliation cycle 1.*timed-out continuation retry recorded durable progress/i,
    );
    expect(actionRows[0].resolutionNote).toMatch(/1 open child issue/i);
    expect(actionRows[0].resolvedAt).toBeTruthy();

    // Activity log must contain the auto-cleared entry with cycle=1 marker.
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.recovery_action_auto_cleared"),
        ),
      );
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]?.details as Record<string, unknown>).toMatchObject({
      recoveryCause: "stranded_assigned_issue",
      outcome: "continuing",
      cycle: 1,
      source: "recovery.reconcile_timed_out_continuation_auto_clear",
    });
  });

  it("cycle-1 auto-clears stranded_assigned_issue when a fresh timed_out continuation retry created comments (RUAAAAA-2184)", async () => {
    // Cycle-1 path with comment evidence (the actual RUAAAAA-2169 shape).
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "timed_out",
      runErrorCode: "timeout",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
    });
    // Seed 2 comments created by the timed-out run (mimics the 2169 case:
    // identity analysis + disposition refresh posted 6s before timeout).
    await db.insert(issueComments).values([
      {
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: runId,
        body: "Full path + identity analysis (2169 comment 1)",
      },
      {
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: runId,
        body: "Disposition refresh: terminal operating posture, parked at in_progress (2169 comment 2)",
      },
    ]);
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffAutoCleared).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.continuationRequeued).toBe(0);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      kind: "stranded_assigned_issue",
      status: "resolved",
      outcome: "continuing",
    });
    expect(actionRows[0].resolutionNote).toMatch(/2 issue comment.* landed before timeout/i);

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.recovery_action_auto_cleared"),
        ),
      );
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]?.details as Record<string, unknown>).toMatchObject({
      continuationSignal: "issue_comments_landed",
      cycle: 1,
    });
  });

  it("cycle-1 auto-clears stranded_assigned_issue when a fresh timed_out continuation retry created work products (RUAAAAA-2184)", async () => {
    // Cycle-1 path with work-product evidence.
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "timed_out",
      runErrorCode: "timeout",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "report",
      provider: "test",
      externalId: "2184-wp-1",
      title: "Timed-out run work product",
      status: "ready",
      summary: "Durable artifact from the timed-out run.",
      createdByRunId: runId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffAutoCleared).toBe(1);
    expect(result.escalated).toBe(0);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      kind: "stranded_assigned_issue",
      status: "resolved",
      outcome: "continuing",
    });
    expect(actionRows[0].resolutionNote).toMatch(/1 work product.* landed before timeout/i);
  });

  it("cycle-1 still escalates stranded_assigned_issue when the timed_out continuation retry left no durable progress (RUAAAAA-2184)", async () => {
    // Real-stall case for cycle-1: timed_out + in_progress + NO open
    // children, NO comments from the run, NO work products. Must
    // escalate (preserve existing behavior).
    const { companyId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "timed_out",
      runErrorCode: "timeout",
      retryReason: "issue_continuation_needed",
      livenessState: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffAutoCleared).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.continuationRequeued).toBe(0);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("blocked");

    // Recovery action must exist (escalation created it) and remain active.
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]?.status).toBe("active");
    expect(actionRows[0]?.outcome).toBeNull();
    expect(actionRows[0]?.resolvedAt).toBeNull();
  });

  it("cycle-1 guard does not trigger when the latest run succeeded (not timed_out) (RUAAAAA-2184)", async () => {
    // A successful run + in_progress + concrete evidence must NOT trigger
    // the cycle-1 guard. It should fall through to the
    // missing_disposition / productive-continuation branches. We don't
    // pre-seed a missing_disposition action here either — the
    // productive-terminal run lands and gets a continuation retry
    // queued instead (matches the existing behavior).
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
    });
    // Add some durable evidence so the cycle-1 guard's evidence check
    // would fire if it were misapplied to a successful run.
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body: "Successful run posted a progress comment.",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    // Either continuationRequeued (productive-terminal path) or
    // auto-cleared (missing-disposition path) — never the timed_out
    // cycle-1 path, and never an escalation on a successful run.
    expect(result.escalated).toBe(0);
    const totalHandling = result.successfulRunHandoffAutoCleared + result.continuationRequeued;
    expect(totalHandling).toBeGreaterThanOrEqual(0);

    // No stranded_assigned_issue recovery action must be created by the
    // cycle-1 guard (the missing-disposition path uses a different
    // kind and would be a separate count).
    const strandedActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
          eq(issueRecoveryActions.kind, "stranded_assigned_issue"),
        ),
      );
    expect(strandedActions).toHaveLength(0);
  });

  it("cycle-1 guard does not trigger when the timed_out run's source issue is not in_progress (RUAAAAA-2184)", async () => {
    // A timed_out run on a `todo` issue must NOT trigger the cycle-1
    // guard — the guard is specifically for in_progress. This matches
    // the existing detection pre-condition (issue.status must be
    // in_progress) and protects against accidentally auto-clearing
    // recovery actions on stale `todo` issues whose agents have not
    // started work yet.
    const { companyId, runId, issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "timed_out",
      runErrorCode: "timeout",
      retryReason: "issue_continuation_needed",
      livenessState: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    // The todo branch is upstream of the cycle-1 guard and handles its
    // own escalation. We just need to verify the guard did not fire and
    // leave a stranded_assigned_issue resolution behind.
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    const resolvedByCycle1Guard = actionRows.filter(
      (row) => row.status === "resolved" && row.outcome === "continuing",
    );
    expect(resolvedByCycle1Guard).toHaveLength(0);
    // Reference the unused runId so eslint doesn't complain.
    expect(runId).toBeTruthy();
  });

  it("cycle-2 auto-clear still works after the cycle-1 guard is added (RUAAAAA-2184)", async () => {
    // Regression: the existing 2072 cycle-2+ guard must still resolve
    // an existing active stranded_assigned_issue recovery action when
    // a fresh timed_out run lands durable progress. This is the path
    // exercised by the original 2072 test but spelled out here to
    // confirm the cycle-1 guard does not pre-empt or double-fire
    // when a recovery action is already present.
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "timed_out",
      runErrorCode: "timeout",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
    });
    // Pre-seed an active stranded_assigned_issue recovery action as if
    // a prior reconciliation pass had already created it (attemptCount=6
    // matches the actual 2061 reproduction).
    const recoveryActionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      previousOwnerAgentId: agentId,
      returnOwnerAgentId: agentId,
      cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${companyId}:${issueId}:stranded_assigned_issue`,
      evidence: {
        sourceIssueId: issueId,
        previousStatus: "in_progress",
        latestIssueStatus: "in_progress",
        latestRunId: runId,
        latestRunStatus: "timed_out",
        retryReason: "issue_continuation_needed",
        latestRunErrorCode: "timeout",
        missingDisposition: null,
      },
      nextAction: "Restore a live execution path or record a manual resolution.",
      attemptCount: 6,
    });
    // Seed durable progress (open child issue).
    const childIssueId = randomUUID();
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      title: "Delegated follow-up that landed before the gateway timeout",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      parentId: issueId,
      issueNumber: 2002,
      identifier: `RA-2002`,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffAutoCleared).toBe(1);
    expect(result.escalated).toBe(0);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      id: recoveryActionId,
      kind: "stranded_assigned_issue",
      status: "resolved",
      outcome: "continuing",
    });
    // The cycle-1 guard would have created a separate ensure result;
    // since we pre-seeded the action, the cycle-2 guard resolves the
    // pre-seeded action directly (no duplicate resolution).
  });

  // RUAAAAA-2253 — succeeded-with-live-continuation auto-clear.
  // The recovery service's `escalateStrandedAssignedIssue` path was
  // creating false-positive stranded_assigned_issue actions on issues
  // that were correctly `in_progress` because of an active
  // ask_user_questions / request_confirmation / suggest_tasks
  // interaction with `continuationPolicy = wake_assignee`. The latest
  // run had completed `succeeded` (a healthy state-verification /
  // continuation-maintenance pass) and the issue correctly stayed
  // `in_progress` because it was in coordination phase, awaiting the
  // user/board/CEO answer. The new auto-clear guards mirror the 2072 /
  // 2184 cycle-1 + cycle-2+ pattern but for the succeeded case.

  it("cycle-1 auto-clears stranded_assigned_issue when a fresh succeeded continuation retry landed on an in_progress issue with a pending ask_user_questions (RUAAAAA-2253)", async () => {
    // Reproduction: source issue is `in_progress` with the live
    // continuation path = pending ask_user_questions with
    // `continuationPolicy = wake_assignee` (the RUAAAAA-1509/2135
    // case). The latest run completed succeeded (a healthy
    // state-verification pass; the issue correctly stays
    // `in_progress` because the ask_user_questions is the live
    // execution path). Without the 2253 guard this would escalate
    // with kind `stranded_assigned_issue` and wake the owner with
    // `wake_reason: source_scoped_recovery_action`.
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
    });
    // Seed the live continuation path: pending ask_user_questions
    // with `continuationPolicy = wake_assignee`. Mirrors the 1509
    // reproduction where the question was re-issued under RUAAAAA-2135
    // (2026-06-23) and is still pending.
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      title: "ruah.dev public-edge: choose Path A / B / C",
      summary: "Awaiting board decision on which path to take to restore the public edge.",
      payload: {
        questions: [
          {
            id: "q1",
            question: "Which path should we take?",
            header: "Path",
            options: [
              { label: "Path A", description: "Re-point DNS to a new origin." },
              { label: "Path B", description: "Restore from edge backup." },
              { label: "Path C", description: "Re-deploy Godines web app on the active edge." },
            ],
            multiSelect: false,
          },
        ],
      },
      createdByAgentId: agentId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    // The cycle-1 guard must have fired and prevented the escalation.
    expect(result.successfulRunHandoffAutoCleared).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.continuationRequeued).toBe(0);

    // Source issue must stay at in_progress (not force-blocked).
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("in_progress");

    // A recovery action must exist (cycle-1 guard materialized it) and
    // be resolved with outcome=continuing.
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      kind: "stranded_assigned_issue",
      status: "resolved",
      outcome: "continuing",
    });
    expect(actionRows[0].resolutionNote).toMatch(
      /live continuation path recorded by ask_user_questions/i,
    );
    expect(actionRows[0].resolutionNote).toMatch(
      new RegExp(`\\\`${interactionId}\\\``),
    );
    expect(actionRows[0].resolvedAt).toBeTruthy();

    // Activity log must contain the auto-cleared entry with cycle=1.
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.recovery_action_auto_cleared"),
        ),
      );
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]?.details as Record<string, unknown>).toMatchObject({
      recoveryCause: "stranded_assigned_issue",
      outcome: "continuing",
      continuationSignal: "ask_user_questions",
      interactionId,
      cycle: 1,
      source: "recovery.reconcile_succeeded_live_continuation_auto_clear",
    });
  });

  it("cycle-1 auto-clear fires for pending request_confirmation wake_assignee interactions (RUAAAAA-2253)", async () => {
    // Same shape as the ask_user_questions test but with
    // request_confirmation — the guard must work for any of the
    // three ISSUE_THREAD_INTERACTION_KINDS, not just one.
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
    });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      title: "Confirm implementation plan before RUAAAAA-2253 lands",
      summary: "Awaiting board approval of the auto-clear plan.",
      payload: {
        target: { kind: "plan", revisionId: "rev-2253" },
        prompt: "Approve the 2253 auto-clear pattern?",
      },
      createdByAgentId: agentId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffAutoCleared).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.continuationRequeued).toBe(0);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      kind: "stranded_assigned_issue",
      status: "resolved",
      outcome: "continuing",
    });
    expect(actionRows[0].resolutionNote).toMatch(
      /live continuation path recorded by request_confirmation/i,
    );

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.recovery_action_auto_cleared"),
        ),
      );
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]?.details as Record<string, unknown>).toMatchObject({
      continuationSignal: "request_confirmation",
      interactionId,
      cycle: 1,
    });
  });

  it("cycle-1 guard does not fire when the succeeded run's source issue has no pending interaction (RUAAAAA-2253)", async () => {
    // Negative case: same shape as the ask_user_questions test but
    // without a pending issueThreadInteraction. The 2253 guard must
    // not fire and the existing escalation behavior must be preserved
    // (this matches the actual 3532 "blocks stranded in-progress work
    // after a productive continuation retry was already used" test
    // pattern at the field level).
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);
    expect(result.successfulRunHandoffAutoCleared).toBe(0);
    expect(result.continuationRequeued).toBe(0);

    // Source issue must be force-blocked (existing behavior preserved
    // when no live continuation path is present).
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("blocked");

    // A stranded_assigned_issue recovery action must exist and be
    // active (not auto-cleared).
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      kind: "stranded_assigned_issue",
      status: "active",
    });
    expect(actionRows[0].outcome).toBeNull();
    expect(actionRows[0].resolvedAt).toBeNull();

    // No auto-cleared activity log entry must be written.
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.recovery_action_auto_cleared"),
        ),
      );
    expect(activityRows).toHaveLength(0);

    // Reference the unused agentId / runId so eslint doesn't complain.
    expect(agentId).toBeTruthy();
    expect(runId).toBeTruthy();
  });

  it("cycle-1 guard does not fire when the pending interaction has continuationPolicy = wake_assignee_on_accept (RUAAAAA-2253)", async () => {
    // Defensive coverage: wake_assignee_on_accept does NOT count as a
    // live continuation path for the 2253 guard because the wake only
    // fires on acceptance, not on the pending interaction. The guard
    // must still escalate in that case.
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
    });
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee_on_accept",
      title: "Plan requires explicit accept before resuming",
      summary: "Engine resume is gated on board accept, not the pending state.",
      payload: {
        target: { kind: "plan", revisionId: "rev-2253-gated" },
        prompt: "Accept the plan to resume the engine.",
      },
      createdByAgentId: agentId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);
    expect(result.successfulRunHandoffAutoCleared).toBe(0);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("blocked");

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      kind: "stranded_assigned_issue",
      status: "active",
    });

    expect(agentId).toBeTruthy();
    expect(runId).toBeTruthy();
  });

  it("cycle-2 auto-clear resolves an existing stranded_assigned_issue when a succeeded run lands on an in_progress issue with a pending ask_user_questions (RUAAAAA-2253)", async () => {
    // Cycle-2+ safety net: an active stranded_assigned_issue recovery
    // action is already present (from a previous cycle's escalation
    // that slipped through because the interaction was created in
    // between). The cycle-2 guard must resolve it cleanly without
    // creating a duplicate.
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
    });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      title: "ruah.dev public-edge: choose Path A / B / C",
      summary: "Awaiting board decision on which path to take.",
      payload: {
        questions: [
          {
            id: "q1",
            question: "Which path should we take?",
            header: "Path",
            options: [{ label: "Path A" }, { label: "Path B" }],
            multiSelect: false,
          },
        ],
      },
      createdByAgentId: agentId,
    });
    // Pre-seed an active stranded_assigned_issue recovery action as if
    // a prior reconciliation pass had already created it.
    const recoveryActionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      previousOwnerAgentId: agentId,
      returnOwnerAgentId: agentId,
      cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${companyId}:${issueId}:stranded_assigned_issue`,
      evidence: {
        sourceIssueId: issueId,
        previousStatus: "in_progress",
        latestIssueStatus: "in_progress",
        latestRunId: runId,
        latestRunStatus: "succeeded",
        retryReason: "issue_continuation_needed",
        latestRunErrorCode: null,
        missingDisposition: null,
      },
      nextAction: "Restore a live execution path or record a manual resolution.",
      attemptCount: 3,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffAutoCleared).toBe(1);
    expect(result.escalated).toBe(0);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("in_progress");

    // The pre-seeded recovery action must be resolved with
    // outcome=continuing — and no duplicate action must be created.
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      id: recoveryActionId,
      kind: "stranded_assigned_issue",
      status: "resolved",
      outcome: "continuing",
    });
    expect(actionRows[0].resolutionNote).toMatch(
      /live continuation path recorded by ask_user_questions/i,
    );
    expect(actionRows[0].resolvedAt).toBeTruthy();

    // Activity log must reference the cycle-2+ source marker
    // (NOT the cycle-1 marker).
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.recovery_action_auto_cleared"),
        ),
      );
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]?.details as Record<string, unknown>).toMatchObject({
      recoveryActionId,
      recoveryCause: "stranded_assigned_issue",
      outcome: "continuing",
      continuationSignal: "ask_user_questions",
      interactionId,
      source: "recovery.reconcile_succeeded_live_continuation_auto_clear",
    });
    // The cycle marker must NOT be set on cycle-2+ clears (the cycle=1
    // marker is reserved for the cycle-1 sibling guard).
    expect((activityRows[0]?.details as Record<string, unknown>).cycle).toBeUndefined();
  });

  it("auto-clears the missing_disposition recovery action when the corrective handoff run recorded resumeIntent (RUAAAAA-1817)", async () => {
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const sourceRunId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "finish_successful_run_handoff",
          sourceRunId,
          resumeFromRunId: sourceRunId,
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          missingDisposition: "clear_next_step",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
          resumeIntent: true,
          followUpRequested: true,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    // Seed an active missing_disposition recovery action.
    const recoveryActionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "missing_disposition",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      previousOwnerAgentId: agentId,
      returnOwnerAgentId: agentId,
      cause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      fingerprint: `source_scoped_recovery:${companyId}:${issueId}:${SUCCESSFUL_RUN_MISSING_STATE_REASON}`,
      evidence: {
        sourceIssueId: issueId,
        previousStatus: "in_progress",
        latestIssueStatus: "in_progress",
        latestRunId: runId,
        latestRunStatus: "succeeded",
        sourceRunId,
        correctiveRunId: runId,
        missingDisposition: "clear_next_step",
        handoffAttempt: 1,
        maxHandoffAttempts: 1,
      },
      nextAction: "Choose and record a valid issue disposition without copying transcript content.",
      attemptCount: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.successfulRunHandoffAutoCleared).toBe(1);
    expect(result.successfulRunHandoffEscalated).toBe(0);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      kind: "missing_disposition",
      status: "resolved",
      outcome: "continuing",
    });
    expect(actionRows[0].resolutionNote).toMatch(
      /explicit continuation intent \(resume=true\)/i,
    );
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("tracks the first heartbeat with the agent role instead of adapter type", async () => {
    const { agentId, runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(runId);

    expect(mockTrackAgentFirstHeartbeat).toHaveBeenCalledWith(
      mockTelemetryClient,
      expect.objectContaining({
        agentRole: "engineer",
        agentId,
      }),
    );
  });

  it("records manual cancellation stop metadata", async () => {
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.resultJson).toMatchObject({
      stopReason: "cancelled",
      effectiveTimeoutSec: 0,
      timeoutConfigured: false,
      timeoutFired: false,
    });
  });

  it("dispatches assigned todo work with no prior run as a normal assignment wake", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId,
        mutation: "assigned_todo_liveness_dispatch",
        modelProfile: "cheap",
      }),
    });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.retryOfRunId).toBeNull();
    expect(runs[0]?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "issue_assigned",
      source: "issue.assigned_todo_liveness_dispatch",
      modelProfile: "cheap",
    });
    expect((runs[0]?.contextSnapshot as Record<string, unknown>)?.retryReason).toBeUndefined();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    if (runs[0]?.id) {
      await waitForRunToSettle(heartbeat, runs[0].id);
    }
  });

  it("does not duplicate initial assigned todo dispatch when a queued wake already exists", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "assigned_todo_liveness_dispatch" },
      status: "queued",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("skips budget-blocked assigned todo work with no prior run and continues the sweep", async () => {
    const blocked = await seedAssignedTodoNoRunFixture();
    const unblocked = await seedAssignedTodoNoRunFixture();
    await db.insert(budgetPolicies).values({
      companyId: blocked.companyId,
      scopeType: "agent",
      scopeId: blocked.agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: blocked.companyId,
      agentId: blocked.agentId,
      issueId: blocked.issueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([unblocked.issueId]);

    const blockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, blocked.agentId));
    expect(blockedWakeups).toHaveLength(0);
    const blockedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, blocked.agentId));
    expect(blockedRuns).toHaveLength(0);

    const blockedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blocked.issueId))
      .then((rows) => rows[0] ?? null);
    expect(blockedIssue?.status).toBe("todo");

    const unblockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, unblocked.agentId));
    expect(unblockedWakeups).toHaveLength(1);
    expect(unblockedWakeups[0]).toMatchObject({
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId: unblocked.issueId,
        mutation: "assigned_todo_liveness_dispatch",
        modelProfile: "cheap",
      }),
    });
    const unblockedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, unblocked.agentId));
    expect(unblockedRuns).toHaveLength(1);
    if (unblockedRuns[0]?.id) {
      await waitForRunToSettle(heartbeat, unblockedRuns[0].id);
    }
  });

  it("does not dispatch assigned todo work with no prior run when the agent is paused", async () => {
    const { agentId, issueId } = await seedAssignedTodoNoRunFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("re-enqueues assigned todo work when the last issue run died and no wake remains", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    expect(retryRun?.contextSnapshot).toMatchObject({ modelProfile: "cheap" });
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it.each([
    ["failed", "adapter_failed"],
    ["failed", "process_lost"],
    ["timed_out", "adapter_timed_out"],
  ] as const)(
    "re-enqueues stranded in-progress work after a %s/%s run before escalating",
    async (runStatus, runErrorCode) => {
      const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus,
        runErrorCode,
      });
      const heartbeat = heartbeatService(db);

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.dispatchRequeued).toBe(0);
      expect(result.continuationRequeued).toBe(1);
      expect(result.escalated).toBe(0);
      expect(result.issueIds).toEqual([issueId]);

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(2);

      const retryRun = runs.find((row) => row.id !== runId);
      expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
        issueId,
        taskId: issueId,
        retryReason: "issue_continuation_needed",
        retryOfRunId: runId,
        source: "issue.continuation_recovery",
        modelProfile: "cheap",
      });

      const recoveries = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "stranded_issue_recovery"),
            eq(issues.originId, issueId),
          ),
        );
      expect(recoveries).toHaveLength(0);

      if (retryRun?.id) {
        await waitForRunToSettle(heartbeat, retryRun.id);
      }
    },
  );

  it("still re-enqueues stranded assigned todo recovery when an old queued wake exists", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    expect(retryRun?.contextSnapshot).toMatchObject({ modelProfile: "cheap" });
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("blocks assigned todo work after the one automatic dispatch recovery was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "assignment_recovery",
    });
    expect(JSON.stringify(recoveryAction.evidence)).not.toContain("sk-test-recovery-secret");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried dispatch");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  it("blocks an already stranded recovery issue without creating a recovery child", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
    });
    const sourceIssueId = randomUUID();
    const sourceRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original source issue",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue from previous adapter failure",
        parentId: sourceIssueId,
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
        originRunId: sourceRunId,
        originFingerprint: [
          "stranded_issue_recovery",
          companyId,
          sourceIssueId,
          sourceRunId,
        ].join(":"),
      })
      .where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]).toMatchObject({
      id: issueId,
      status: "blocked",
      parentId: sourceIssueId,
      originId: sourceIssueId,
      originRunId: sourceRunId,
    });
    expect(recoveryIssues[0]?.checkoutRunId).toBeNull();
    expect(recoveryIssues[0]?.executionRunId).toBeNull();

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    expect(comments[0]?.body).toContain(`Recovery issue: [${recoveryIssues[0]?.identifier}]`);
    expect(comments[0]?.body).toContain("Next action:");
  });

  it("assigns open unassigned blockers back to their creator agent", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const blockedAssigneeAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "SecurityEngineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAssigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Fix blocker",
        status: "todo",
        priority: "high",
        createdByAgentId: creatorAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked work",
        status: "blocked",
        priority: "high",
        assigneeAgentId: blockedAssigneeAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
      createdByAgentId: creatorAgentId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.orphanBlockersAssigned).toBe(1);
    expect(result.issueIds).toContain(blockerIssueId);

    const blocker = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(blocker?.assigneeAgentId).toBe(creatorAgentId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockerIssueId));
    expect(comments[0]?.body).toContain("Assigned Orphan Blocker");
    expect(comments[0]?.body).toContain(`[${issuePrefix}-2](/${issuePrefix}/issues/${issuePrefix}-2)`);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, creatorAgentId));
    expect(wakeups).toEqual([
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: blockerIssueId,
          mutation: "unassigned_blocker_recovery",
        }),
      }),
    ]);

    const runId = wakeups[0]?.runId;
    if (runId) {
      await waitForRunToSettle(heartbeat, runId);
    }
  });

  it("re-enqueues continuation for stranded in-progress work with no active run", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("issue_continuation_needed");
    expect(retryRun?.contextSnapshot).toMatchObject({ modelProfile: "cheap" });
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("does not continue seeded in-progress work that has no run linkage", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Seeded in-flight work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
  });

  it("classifies actionable plan-only recovery and enqueues one liveness continuation", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "I will inspect the repo next and then implement the fix.",
      provider: "test",
      model: "test-model",
    });
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();

    const livenessWake = await waitForValue(async () => {
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      return rows.find((row) => row.reason === "run_liveness_continuation") ?? null;
    });
    expect(livenessWake).toBeTruthy();
    expect(livenessWake?.payload).toMatchObject({
      issueId,
      livenessState: "plan_only",
      continuationAttempt: 1,
    });

    const sourceRunId = (livenessWake?.payload as Record<string, unknown> | null)?.sourceRunId;
    expect(sourceRunId).toBeTruthy();
    const sourceRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, String(sourceRunId)))
      .then((rows) => rows[0] ?? null);
    if (sourceRun?.id) {
      await waitForRunToSettle(heartbeat, sourceRun.id, 5_000);
    }
    expect(sourceRun?.id).not.toBe(runId);
    expect(sourceRun?.livenessState).toBe("plan_only");
  });

  it("treats a plan document update as progress and does not enqueue liveness continuation", async () => {
    const { agentId, companyId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Plan",
        format: "markdown",
        latestBody: "# Plan\n\n- Inspect files\n- Implement fix",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\n- Inspect files\n- Implement fix",
        createdByAgentId: agentId,
        createdByRunId: ctx.runId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "plan",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Plan:\n- Inspect files\n- Implement fix",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();

    const retryRun = await waitForValue(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      return rows.find((row) => row.id !== runId && row.livenessState === "advanced") ?? null;
    }, 5_000);
    if (retryRun?.id) {
      await waitForRunToSettle(heartbeat, retryRun.id, 5_000);
    }
    expect(retryRun?.livenessState).toBe("advanced");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.some((row) => row.reason === "run_liveness_continuation")).toBe(false);
  });
  it("blocks stranded in-progress work after the continuation retry was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  it("redacts error-code-only stranded recovery failures in issue copy", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "adapter_exit_code",
      runError: null,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
    expect(recoveryAction.evidence).toMatchObject({
      latestRunErrorCode: "adapter_exit_code",
    });
    expect(JSON.stringify(recoveryAction.evidence)).not.toContain("- Failure: none recorded");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).not.toContain("- Failure: none recorded");
  });

  it("reuses the raced stranded recovery issue when duplicate active recovery creation conflicts", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => heartbeat.reconcileStrandedAssignedIssues()),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
      ));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.attemptCount).toBeGreaterThanOrEqual(1);
    const recoveries = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, "stranded_issue_recovery"),
        eq(issues.originId, issueId),
      ));
    expect(recoveries).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);
  });

  it("blocks stranded recovery issues in place instead of creating nested recovery issues", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(recoveryIssue?.status).toBe("blocked");
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("keeps repeated recovery failures on the same canonical recovery issue", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const firstResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(firstResult.escalated).toBe(1);
    expect(firstResult.issueIds).toEqual([issueId]);

    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        source: "stranded_issue_recovery",
      },
      startedAt: new Date("2030-03-19T00:10:00.000Z"),
      finishedAt: new Date("2030-03-19T00:15:00.000Z"),
      createdAt: new Date("2030-03-19T00:10:00.000Z"),
      updatedAt: new Date("2030-03-19T00:15:00.000Z"),
      errorCode: "adapter_failed",
      error: "adapter failed while retrying recovery issue",
    });
    await db
      .update(issues)
      .set({
        status: "in_progress",
        checkoutRunId: secondRunId,
        executionRunId: null,
      })
      .where(eq(issues.id, issueId));

    const secondResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(secondResult.dispatchRequeued).toBe(0);
    expect(secondResult.continuationRequeued).toBe(0);
    expect(secondResult.escalated).toBe(1);
    expect(secondResult.issueIds).toEqual([issueId]);

    const recoveryIssuesForSource = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, sourceIssueId)));
    expect(recoveryIssuesForSource.map((issue) => issue.id)).toEqual([issueId]);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(2);
    expect(comments[1]?.body).toContain("Latest retry failure details were withheld from the issue thread");
  });

  it("does not escalate paused-tree recovery when the automatic continuation retry was cancelled by the hold", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      activePauseHold: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBeTruthy();

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
  });

  it("re-enqueues recovery when the latest in-progress continuation made progress but left no live path", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.productiveContinuationObserved).toBe(0);
    expect(result.successfulContinuationObserved).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
      modelProfile: "cheap",
    });

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(2);
  });

  // RUAAAAA-5326 — the periodic recovery sweep is a third re-enqueue path,
  // outside both bounded ladders (the comment ladder in `heartbeat.ts` and
  // `DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS` in
  // `run-liveness-continuations.ts`). It used to carry no chain counter, so
  // the top of the retry ladder was re-seeded without a cumulative attempt
  // count. These three tests are a PAIR on purpose:
  //
  //   * "carries the chain counter" proves the counter is actually WRITTEN on
  //     the seeded run. Without it, the two cut tests below pass vacuously —
  //     a guard that reads a field nobody populates always sees 0 and always
  //     says "enqueue".
  //   * the two cut tests prove the budget is read and spent.
  //
  // Reverting the guard (`decideSweepContinuation`) makes both cut tests fail:
  // each sees a re-enqueue instead of an exhausted handoff.

  it("RUAAAAA-5326: carries the chain counter onto the run the sweep re-enqueues", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.continuationExhausted).toBe(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const seededRun = runs.find((row) => row.id !== runId);
    expect(seededRun).toBeTruthy();
    // The next sweep pass reads this key back, so it has to land on the run.
    expect(seededRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      sweepContinuationAttempt: 1,
      sweepContinuationMaxAttempts: DEFAULT_MAX_SWEEP_CONTINUATION_ATTEMPTS,
    });
    // And it must NOT touch the liveness continuation ladder's own counter —
    // a run seeded by the sweep arrives at `decideRunLivenessContinuation`
    // with its full budget, not one already spent.
    expect(seededRun?.continuationAttempt ?? 0).toBe(0);
    // ...and the sweep's read path actually sees it.
    expect(readSweepContinuationAttempt(seededRun?.contextSnapshot)).toBe(1);

    if (seededRun) {
      await waitForRunToSettle(heartbeat, seededRun.id);
    }
  });

  it("RUAAAAA-5326: cuts the sweep chain at the continuation rung and posts the human handoff instead of re-queueing", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      // The sweep already re-seeded this run once. Attempt 1 == the budget.
      sweepContinuationAttempt: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.continuationExhausted).toBe(1);
    expect(result.escalated).toBe(0);

    // No new run, and no new wakeup request: the sweep did not re-seed.
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.map((row) => row.id)).toEqual([runId]);
    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);

    // `exhausted` must hand off, not silently skip.
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body.startsWith(SWEEP_CONTINUATION_EXHAUSTED_COMMENT_PREFIX)).toBe(true);
    expect(comments[0]?.body).toContain("1/1");
    expect(comments[0]?.body).toContain("issue_continuation_needed");

    // The issue stays put — this is a handoff, not a forced block.
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    // Idempotent: a later sweep pass must not stack a second notice.
    const second = await heartbeat.reconcileStrandedAssignedIssues();
    expect(second.continuationExhausted).toBe(1);
    const commentsAfter = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(commentsAfter).toHaveLength(1);
  });

  it("RUAAAAA-5326: cuts the sweep chain at the productive rung too", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
      // No `retryReason`/`source`, so the pre-existing
      // `isRepeatedProductiveContinuationRecovery` guard does NOT match and
      // this run genuinely reaches the productive enqueue site. The seeded
      // attempt budget is the only thing that can cut it here.
      sweepContinuationAttempt: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.continuationExhausted).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.successfulRunHandoffAutoCleared).toBe(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.map((row) => row.id)).toEqual([runId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body.startsWith(SWEEP_CONTINUATION_EXHAUSTED_COMMENT_PREFIX)).toBe(true);
  });

  it("blocks stranded in-progress work after a productive continuation retry was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("automatically retried continuation");
    expect(comments[0]?.body).toContain("still has no live execution path");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recoveryAction.id}\``);
    expect(comments[0]?.body).toContain("Recovery owner: [CodexCoder]");
  });

  it("allows one productive-terminal recovery after regular continuation recovery made progress", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.continuation_recovery",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
      modelProfile: "cheap",
    });
  });

  it("does not treat a productive terminal run as healthy when in-progress work has no live path", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const sourceIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(sourceIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      executionRunId: null,
    });

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"])));
    expect(activeRuns).toHaveLength(0);

    const liveWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
    expect(liveWakeups).toHaveLength(0);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.productiveContinuationObserved).toBe(0);
    expect(result.continuationRequeued + result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    const followupRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(comments).toHaveLength(0);
    expect(recoveryIssues).toHaveLength(0);
    expect(followupRuns).toHaveLength(2);
    const retryRun = followupRuns.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
      modelProfile: "cheap",
    });
  });

  it("does not reconcile user-assigned work through the agent stranded-work recovery path", async () => {
    const { issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      assignToUser: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runs).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // RUAAAAA-2377 — write-tooling failure classifier.
  //
  // Pattern: when an agent has run N consecutive times against the same issue
  // and every run failed/timed_out without producing a single
  // issueComments.createdByRunId === run.id or issueWorkProducts row, the
  // lane they were handed is not writeable from their adapter. The
  // classifier routes the recovery action to Engineering (or the fallback
  // chain) instead of the assignee, breaking the false-positive churn
  // pattern that motivated RUAAAAA-2369 → 2374 → 2375.
  //
  // Threshold: WRITE_TOOLING_FAILURE_CONSECUTIVE_RUN_THRESHOLD = 3.
  // ---------------------------------------------------------------------------

  /**
   * Seed a fixture where the assignee has run N consecutive times against
   * the same issue, with every run in failed/timed_out state. Optional
   * `writeOnRunIndexes` inserts an issue comment for the indexed runs
   * (0 = oldest, N-1 = newest) to simulate "this run landed a write" and
   * break the consecutive-zero-write counter.
   */
  async function seedConsecutiveFailedRunsFixture(input: {
    runCount: number;
    runStatuses?: ("failed" | "timed_out")[];
    writeOnRunIndexes?: number[];
    engineeringAgentTitle?: string | null;
    includeEngineeringAgent?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const engineeringAgentId = randomUUID();
    const runIds: string[] = [];
    const wakeupRequestIds: string[] = [];
    const issueId = randomUUID();
    const now = new Date("2026-06-15T00:00:00.000Z");
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
      name: "HermesLocalAgent",
      role: "general",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    if (input.includeEngineeringAgent !== false) {
      await db.insert(agents).values({
        id: engineeringAgentId,
        companyId,
        name: "Head of Engineering",
        role: "general",
        title: input.engineeringAgentTitle ?? "Head of Engineering",
        status: "idle",
        adapterType: "openclaw_gateway",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }

    // Insert the issue FIRST so the runs and any seeded comments can
    // reference it without violating the issue_comments.issue_id FK.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Source issue for write-tooling classifier test",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    for (let i = 0; i < input.runCount; i += 1) {
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      runIds.push(runId);
      wakeupRequestIds.push(wakeupRequestId);
      // Older runs come first (i=0 oldest), newer runs come last.
      const runStartedAt = new Date(now.getTime() + i * 60_000);
      const runFinishedAt = new Date(now.getTime() + i * 60_000 + 30_000);
      const runStatus = input.runStatuses?.[i] ?? "failed";
      const retryReason = i === 0 ? "issue_assignment_recovery" : "issue_continuation_needed";

      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: retryReason === "issue_assignment_recovery" ? "issue_assignment_recovery" : "issue_assigned",
        payload: { issueId },
        status: "failed",
        runId,
        claimedAt: runStartedAt,
        finishedAt: runFinishedAt,
        error: "silent write failure: PAPERCLIP_API_KEY injected JWT path returned 401 on every mutation",
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: runStatus,
        wakeupRequestId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: retryReason === "issue_assignment_recovery" ? "issue_assignment_recovery" : "issue_assigned",
          retryReason,
        },
        startedAt: runStartedAt,
        finishedAt: runFinishedAt,
        updatedAt: runFinishedAt,
        errorCode: runStatus === "timed_out" ? "timeout" : "auth_silent_401",
        error: "silent write failure: PAPERCLIP_API_KEY injected JWT path returned 401 on every mutation",
        livenessState: null,
      });

      const writeOnThisRun = input.writeOnRunIndexes?.includes(i);
      if (writeOnThisRun) {
        await db.insert(issueComments).values({
          companyId,
          issueId,
          authorAgentId: agentId,
          createdByRunId: runId,
          body: `Durable progress note from run ${runId} (index ${i}).`,
          authorType: "agent",
        });
      }
    }

    // Set the most recent run as the executionRunId / checkoutRunId
    // (so the recovery sweep finds latestRun.status === failed/timed_out).
    await db.update(issues)
      .set({
        checkoutRunId: runIds[runIds.length - 1] ?? null,
        executionRunId: runIds[runIds.length - 1] ?? null,
      })
      .where(eq(issues.id, issueId));

    return { companyId, agentId, engineeringAgentId, runIds, wakeupRequestIds, issueId };
  }

  it("handoff_to_engineering recovery action after 3 consecutive zero-write failed runs (RUAAAAA-2377)", async () => {
    // RUAAAAA-2369 churn pattern: hermes_local agent has run 3 times
    // against the same issue, every run failed silently (the JWT-path
    // 401), zero comments / work products landed. The recovery sweep
    // must route to Engineering (the lane that owns paperclip-side
    // auth/tooling), not the assignee.
    const { companyId, agentId, engineeringAgentId, runIds, issueId } =
      await seedConsecutiveFailedRunsFixture({
        runCount: 3,
        writeOnRunIndexes: [],
        includeEngineeringAgent: true,
      });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.writeToolingFailureHandoff).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.dispatchRequeued).toBe(0);

    // Source issue must be flipped to blocked with the engineering
    // owner as the new assignee.
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("blocked");
    expect(sourceIssue?.assigneeAgentId).toBe(engineeringAgentId);

    // A handoff_to_engineering recovery action must exist with the
    // expected fingerprint and evidence. The cause is the stable
    // discriminator the HoE dashboard will filter on.
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    const action = actionRows[0];
    expect(action).toMatchObject({
      kind: "handoff_to_engineering",
      cause: "agent_completed_with_zero_writes",
      ownerAgentId: engineeringAgentId,
      previousOwnerAgentId: agentId,
      returnOwnerAgentId: agentId,
      status: "active",
    });
    const evidence = action.evidence as Record<string, unknown>;
    expect(evidence).toMatchObject({
      sourceIssueId: issueId,
      previousStatus: "in_progress",
      consecutiveZeroWriteRuns: 3,
      threshold: 3,
      lane: "engineering",
      ownerAgentId: engineeringAgentId,
    });
    expect(evidence.sampleRunIds).toEqual(runIds.slice().reverse());

    // Activity log must record the handoff with the discriminator.
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.updated"),
        ),
      );
    const handoffActivity = activityRows.find((row) => {
      const details = row.details as Record<string, unknown> | undefined;
      return details?.source === "recovery.reconcile_write_tooling_failure_handoff";
    });
    expect(handoffActivity).toBeTruthy();
    expect(handoffActivity?.details as Record<string, unknown>).toMatchObject({
      status: "blocked",
      previousStatus: "in_progress",
      recoveryCause: "agent_completed_with_zero_writes",
      recoveryKind: "handoff_to_engineering",
      recoveryLane: "engineering",
      consecutiveZeroWriteRuns: 3,
      threshold: 3,
    });
  });

  it("does not fire write-tooling classifier when one of the recent runs produced a comment (RUAAAAA-2377)", async () => {
    // The third (newest) run landed a comment, so the lane was
    // writeable at that point. The classifier must NOT fire because
    // the consecutive-zero-write counter is only 2 (the first two),
    // which is below the threshold of 3.
    const { companyId, engineeringAgentId, issueId } =
      await seedConsecutiveFailedRunsFixture({
        runCount: 3,
        writeOnRunIndexes: [2], // newest run produced a write
        includeEngineeringAgent: true,
      });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.writeToolingFailureHandoff).toBe(0);
    expect(result.escalated).toBe(1); // falls through to existing escalation

    // Source issue must stay with the assignee (the existing
    // stranded_assigned_issue escalation reassigns to a recovery owner
    // from the fallback chain — but Engineering must NOT be the
    // recovery owner for this case, because the pattern didn't match).
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("blocked");
    expect(sourceIssue?.assigneeAgentId).not.toBe(engineeringAgentId);

    // No handoff_to_engineering action must have been created.
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows.filter((row) => row.kind === "handoff_to_engineering")).toHaveLength(0);
  });

  it("does not fire write-tooling classifier when the agent ships at least one write per run (RUAAAAA-2377)", async () => {
    // Healthy agent that writes a comment every run. Even with 5
    // failed runs in a row, every run produced a write, so the
    // classifier must never fire — this is a real productivity
    // failure, not a write-tooling failure.
    const { companyId, engineeringAgentId, issueId } =
      await seedConsecutiveFailedRunsFixture({
        runCount: 5,
        writeOnRunIndexes: [0, 1, 2, 3, 4], // every run wrote a comment
        includeEngineeringAgent: true,
      });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.writeToolingFailureHandoff).toBe(0);

    // No handoff_to_engineering action must have been created.
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows.filter((row) => row.kind === "handoff_to_engineering")).toHaveLength(0);

    // Engineering lane must NOT have been selected as the assignee.
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.assigneeAgentId).not.toBe(engineeringAgentId);
  });

  it("falls back to the existing recovery-owner chain when no engineering lane is invokable (RUAAAAA-2377)", async () => {
    // Same 3 consecutive zero-write failed runs as the happy-path
    // test, but the company has no agent with "engineering" in the
    // title. The classifier still fires, but the owner is picked
    // from the existing fallback chain. The assignee itself is the
    // first invokable candidate in that chain (no manager, no cto,
    // no ceo), so the action records lane=fallback_chain and the
    // owner is the assignee. The source issue gets flipped to
    // blocked so the operator notices; the recovery action text
    // names the missing engineering lane and tells the next operator
    // to either restore the assignee's write capability or
    // reassign.
    const { companyId, agentId, issueId } =
      await seedConsecutiveFailedRunsFixture({
        runCount: 3,
        writeOnRunIndexes: [],
        includeEngineeringAgent: false,
      });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.writeToolingFailureHandoff).toBe(1);

    // Source issue gets flipped to blocked (so the operator notices)
    // and the assignee stays the assignee (the fallback chain picked
    // the assignee because they are invokable + on budget).
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("blocked");
    expect(sourceIssue?.assigneeAgentId).toBe(agentId);

    // The handoff_to_engineering action is created with
    // lane=fallback_chain so operators can still see why a
    // write-tooling recovery action is pointing at the assignee
    // (the engineering lane was missing).
    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
        ),
      );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      kind: "handoff_to_engineering",
      cause: "agent_completed_with_zero_writes",
      ownerAgentId: agentId,
    });
    expect((actionRows[0].evidence as Record<string, unknown>).lane).toBe("fallback_chain");
  });
});
