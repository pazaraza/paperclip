import { and, asc, desc, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  type IssueGraphLivenessAutoRecoveryPreview,
  type IssueGraphLivenessAutoRecoveryPreviewItem,
} from "@paperclipai/shared";
import {
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  issueComments,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueWorkProducts,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { runningProcesses } from "../../adapters/index.js";
import { forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { redactSensitiveText } from "../../redaction.js";
import { logActivity } from "../activity-log.js";
import { budgetService } from "../budgets.js";
import { instanceSettingsService } from "../instance-settings.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { issueService } from "../issues.js";
import { getRunLogStore } from "../run-log-store.js";
import {
  DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  buildSuccessfulRunHandoffExhaustedNotice,
  noticeMetadataReferencesRecoveryAction,
  type SuccessfulRunHandoffNotice,
} from "./successful-run-handoff.js";
import {
  RECOVERY_ORIGIN_KINDS,
  buildIssueGraphLivenessLeafKey,
  isStrandedIssueRecoveryOriginKind,
  parseIssueGraphLivenessIncidentKey,
} from "./origins.js";
import {
  classifyIssueGraphLiveness,
  type IssueLivenessFinding,
} from "./issue-graph-liveness.js";
import {
  SWEEP_CONTINUATION_ATTEMPT_SNAPSHOT_KEY,
  SWEEP_CONTINUATION_EXHAUSTED_COMMENT_PREFIX,
  decideSweepContinuation,
  readSweepContinuationAttempt,
} from "./run-liveness-continuations.js";
import { reconcileStrandedTimedOutRunLiveness } from "../run-liveness-reconcile.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";

const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = ["failed", "cancelled", "timed_out"] as const;
export const ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS = 30 * 60 * 1000;
const ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES = 8 * 1024;
const STRANDED_ISSUE_RECOVERY_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;

// RUAAAAA-2377 — write-tooling failure classifier.
//
// Detects the churn pattern where an agent has run N consecutive times
// against the same issue and every run failed/timed_out without
// producing a single `issueComments.createdByRunId === run.id` or
// `issueWorkProducts.createdByRunId === run.id` row. The agent itself
// is not the problem in this case; the lane they were handed is not
// writeable from their adapter (auth-tooling, wrong API base,
// malformed token, etc.). Escalating the same agent back into the
// next recovery sweep just churns them — RUAAAAA-2369 is the canonical
// example: it kept getting re-blocked because every retry attempt at
// the same retryable action produced identical silent-write-failure
// runs. The correct routing is to escalate to the lane that owns the
// auth/tooling (Engineering for paperclip-side tooling), not the
// assignee.
//
// The threshold of 3 is the minimum needed to distinguish "agent ran
// but the lane is broken" (≥3 consecutive zero-write runs) from a
// single transient failure (which the existing
// `didAutomaticRecoveryFail` branch already handles with retry+block).
// The `agent_completed_with_zero_writes` reason is stable so the HoE
// dashboard can filter on the recovery action `kind` field
// (`handoff_to_engineering`).
const WRITE_TOOLING_FAILURE_CONSECUTIVE_RUN_THRESHOLD = 3;
const WRITE_TOOLING_FAILURE_CAUSE = "agent_completed_with_zero_writes";
const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";

type RecoveryWakeupOptions = {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
};

type RecoveryWakeup = (
  agentId: string,
  opts?: RecoveryWakeupOptions,
) => Promise<typeof heartbeatRuns.$inferSelect | null>;

type LatestIssueRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  "id" | "agentId" | "status" | "error" | "errorCode" | "contextSnapshot" | "livenessState"
> | null;
type SuccessfulLatestIssueRun = NonNullable<LatestIssueRun> & { status: "succeeded" };

type StrandedRecoveryCause =
  | "stranded_assigned_issue"
  | typeof SUCCESSFUL_RUN_MISSING_STATE_REASON
  | typeof WRITE_TOOLING_FAILURE_CAUSE;

type SuccessfulRunHandoffRecoveryEvidence = {
  sourceRunId: string | null;
  correctiveRunId: string;
  missingDisposition: string;
  handoffAttempt: number;
  maxHandoffAttempts: number;
};

type WatchdogDecisionActor =
  | { type: "board"; userId?: string | null; runId?: string | null }
  | { type: "agent"; agentId?: string | null; runId?: string | null }
  | { type: "none" };

export type RunOutputSilenceSummary = {
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  silenceStartedAt: Date | null;
  silenceAgeMs: number | null;
  level: "not_applicable" | "ok" | "suspicious" | "critical" | "snoozed";
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  snoozedUntil: Date | null;
  evaluationIssueId: string | null;
  evaluationIssueIdentifier: string | null;
  evaluationIssueAssigneeAgentId: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function summarizeRunFailureForIssueComment(run: LatestIssueRun) {
  if (!run) return null;

  if (readNonEmptyString(run.error) || readNonEmptyString(run.errorCode)) {
    return " Latest retry failure details were withheld from the issue thread; inspect the linked run for evidence.";
  }
  return null;
}

function didAutomaticRecoveryFail(
  latestRun: LatestIssueRun,
  expectedRetryReason: "assignment_recovery" | "issue_continuation_needed",
) {
  if (!latestRun) return false;

  const latestContext = parseObject(latestRun.contextSnapshot);
  const latestRetryReason = readNonEmptyString(latestContext.retryReason);
  return latestRetryReason === expectedRetryReason &&
    UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    );
}

function successfulRunHandoffRecoveryEvidence(latestRun: LatestIssueRun): SuccessfulRunHandoffRecoveryEvidence | null {
  if (!latestRun) return null;

  const context = parseObject(latestRun.contextSnapshot);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const handoffReason = readNonEmptyString(context.handoffReason);
  const isSuccessfulRunHandoff =
    wakeReason === FINISH_SUCCESSFUL_RUN_HANDOFF_REASON ||
    handoffReason === SUCCESSFUL_RUN_MISSING_STATE_REASON ||
    asBoolean(context.handoffRequired, false) === true;
  if (!isSuccessfulRunHandoff) return null;

  const handoffAttempt = asNumber(context.handoffAttempt, 1);
  const maxHandoffAttempts = asNumber(
    context.maxHandoffAttempts,
    DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  );
  return {
    sourceRunId: readNonEmptyString(context.sourceRunId) ?? readNonEmptyString(context.resumeFromRunId),
    correctiveRunId: latestRun.id,
    missingDisposition: readNonEmptyString(context.missingDisposition) ?? "clear_next_step",
    handoffAttempt,
    maxHandoffAttempts,
  };
}

function isExhaustedSuccessfulRunHandoff(latestRun: LatestIssueRun) {
  const evidence = successfulRunHandoffRecoveryEvidence(latestRun);
  if (!evidence) return null;
  if (evidence.handoffAttempt < evidence.maxHandoffAttempts) return { ...evidence, exhausted: false };
  return { ...evidence, exhausted: true };
}

function issueIdFromRunContext(contextSnapshot: unknown) {
  const context = parseObject(contextSnapshot);
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

function issueIdFromWakePayload(payload: unknown) {
  const parsed = parseObject(payload);
  const nestedContext = parseObject(parsed[DEFERRED_WAKE_CONTEXT_KEY]);
  return readNonEmptyString(parsed.issueId) ??
    readNonEmptyString(nestedContext.issueId) ??
    readNonEmptyString(nestedContext.taskId);
}

function issueUiLink(issue: { identifier: string | null; id: string }, prefix: string) {
  const label = issue.identifier ?? issue.id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function runUiLink(run: { id: string; agentId: string }, prefix: string) {
  return `[${run.id}](/${prefix}/agents/${run.agentId}/runs/${run.id})`;
}

function agentUiLink(agent: { id: string; name: string | null } | null, prefix: string) {
  if (!agent) return "unknown";
  return `[${agent.name ?? agent.id}](/${prefix}/agents/${agent.id})`;
}

function formatDuration(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatIssueLinksForComment(relations: Array<{ identifier?: string | null }>) {
  const identifiers = [
    ...new Set(
      relations
        .map((relation) => relation.identifier)
        .filter((identifier): identifier is string => Boolean(identifier)),
    ),
  ];
  if (identifiers.length === 0) return "another open issue";
  return identifiers
    .slice(0, 5)
    .map((identifier) => {
      const prefix = identifier.split("-")[0] || "PAP";
      return `[${identifier}](/${prefix}/issues/${identifier})`;
    })
    .join(", ");
}

function unwrapDatabaseConflictError(error: unknown) {
  if (!error || typeof error !== "object") return null;

  const candidate = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
    cause?: unknown;
  };

  if (
    typeof candidate.code === "string" ||
    typeof candidate.constraint === "string" ||
    typeof candidate.constraint_name === "string"
  ) {
    return candidate;
  }

  const cause = candidate.cause;
  if (!cause || typeof cause !== "object") return candidate;

  return cause as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
  };
}

function isAgentInvokable(agent: typeof agents.$inferSelect | null | undefined) {
  return Boolean(agent && !["paused", "terminated", "pending_approval"].includes(agent.status));
}

function isStrandedIssueRecoveryIssue(issue: Pick<typeof issues.$inferSelect, "originKind">) {
  return isStrandedIssueRecoveryOriginKind(issue.originKind);
}

function isUnsuccessfulTerminalIssueRun(latestRun: LatestIssueRun) {
  return Boolean(
    latestRun &&
      UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
        latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
      ),
  );
}

function isSuccessfulInProgressContinuationRun(latestRun: LatestIssueRun): latestRun is SuccessfulLatestIssueRun {
  return latestRun?.status === "succeeded";
}

function isProductiveContinuationRun(latestRun: LatestIssueRun) {
  return latestRun?.status === "succeeded" &&
    (latestRun.livenessState === "advanced" ||
      latestRun.livenessState === "completed" ||
      latestRun.livenessState === "blocked" ||
      latestRun.livenessState === "needs_followup");
}

function isRepeatedProductiveContinuationRecovery(latestRun: SuccessfulLatestIssueRun) {
  const latestContext = parseObject(latestRun.contextSnapshot);
  return readNonEmptyString(latestContext.retryReason) === "issue_continuation_needed" &&
    readNonEmptyString(latestContext.source) === "issue.productive_terminal_continuation_recovery" &&
    isProductiveContinuationRun(latestRun);
}

function parseLivenessIncidentKey(incidentKey: string | null | undefined) {
  if (!incidentKey) return null;
  return parseIssueGraphLivenessIncidentKey(incidentKey);
}

function livenessRecoveryLeafIssueId(finding: IssueLivenessFinding) {
  return finding.recoveryIssueId;
}

function livenessRecoveryLeafFingerprint(finding: IssueLivenessFinding) {
  return buildIssueGraphLivenessLeafKey({
    companyId: finding.companyId,
    state: finding.state,
    leafIssueId: livenessRecoveryLeafIssueId(finding),
  });
}

function livenessRecoveryLeafKey(companyId: string, state: string, leafIssueId: string) {
  return buildIssueGraphLivenessLeafKey({ companyId, state, leafIssueId });
}

function isUniqueLivenessRecoveryConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: string; constraint?: string; message?: string };
  return maybe.code === "23505" &&
    (
      maybe.constraint === "issues_active_liveness_recovery_incident_uq" ||
      maybe.constraint === "issues_active_liveness_recovery_leaf_uq" ||
      typeof maybe.message === "string" &&
        (
          maybe.message.includes("issues_active_liveness_recovery_incident_uq") ||
          maybe.message.includes("issues_active_liveness_recovery_leaf_uq")
        )
    );
}

function formatDependencyPath(finding: IssueLivenessFinding) {
  return finding.dependencyPath
    .map((entry) => entry.identifier ?? entry.issueId)
    .join(" -> ");
}

function buildLivenessEscalationDescription(finding: IssueLivenessFinding) {
  const source = finding.dependencyPath[0];
  const recovery = finding.dependencyPath.find((entry) => entry.issueId === finding.recoveryIssueId);
  const selectedOwner = finding.recommendedOwnerAgentId ?? "none";

  return [
    "Paperclip detected a harness-level issue graph liveness incident.",
    "",
    "## Source",
    "",
    `- Source issue: ${source?.identifier ?? source?.issueId ?? finding.issueId}`,
    `- Recovery target issue: ${recovery?.identifier ?? recovery?.issueId ?? finding.recoveryIssueId}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Detected invariant: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    "",
    "## Ownership",
    "",
    `- Selected owner agent: \`${selectedOwner}\``,
    `- Candidate owner agents: ${finding.recommendedOwnerCandidateAgentIds.length > 0 ? finding.recommendedOwnerCandidateAgentIds.map((id) => `\`${id}\``).join(", ") : "none"}`,
    "",
    "## Next Action",
    "",
    finding.recommendedAction,
    "",
    "Resolve the blocked chain, then mark this escalation issue done so the original issue can resume when all blockers are cleared.",
  ].join("\n");
}

function buildLivenessOriginalIssueComment(finding: IssueLivenessFinding, escalation: typeof issues.$inferSelect) {
  return [
    "Paperclip detected a harness-level liveness incident in this issue's dependency graph.",
    "",
    `- Escalation issue: ${escalation.identifier ?? escalation.id}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Finding: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    `- Manager action requested: ${finding.recommendedAction}`,
    "",
    "This issue now keeps its existing blockers and is also blocked by the escalation issue so dependency wakeups remain explicit.",
  ].join("\n");
}

export function recoveryService(db: Db, deps: { enqueueWakeup: RecoveryWakeup }) {
  const issuesSvc = issueService(db);
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const treeControlSvc = issueTreeControlService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const runLogStore = getRunLogStore();

  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  async function getAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  async function getLatestIssueRun(companyId: string, issueId: string): Promise<LatestIssueRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasActiveExecutionPath(companyId: string, issueId: string) {
    const [run, deferredWake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    return Boolean(run || deferredWake);
  }

  async function hasQueuedIssueWake(companyId: string, issueId: string) {
    return db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "queued"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function enqueueStrandedIssueRecovery(input: {
    issueId: string;
    agentId: string;
    reason: "issue_assignment_recovery" | "issue_continuation_needed";
    retryReason: "assignment_recovery" | "issue_continuation_needed";
    source: string;
    retryOfRunId?: string | null;
    // RUAAAAA-5326: `nextAttempt` threads the sweep's own attempt budget
    // forward on the seeded run's contextSnapshot. It is deliberately NOT the
    // `continuationAttempt` column: that column is the liveness continuation
    // ladder's budget, and writing to it makes a sweep-seeded run arrive at
    // `decideRunLivenessContinuation` with one of its two attempts already
    // spent.
    continuationAttempt?: number | null;
    maxContinuationAttempts?: number | null;
  }) {
    const continuationAttemptHints = input.continuationAttempt
      ? {
        [SWEEP_CONTINUATION_ATTEMPT_SNAPSHOT_KEY]: input.continuationAttempt,
        sweepContinuationMaxAttempts: input.maxContinuationAttempts ?? null,
      }
      : {};
    const queued = await deps.enqueueWakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: withRecoveryModelProfileHint({
        issueId: input.issueId,
        ...continuationAttemptHints,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: input.reason,
        retryReason: input.retryReason,
        source: input.source,
        ...continuationAttemptHints,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      }),
    });

    if (queued && input.retryOfRunId) {
      return db
        .update(heartbeatRuns)
        .set({
          retryOfRunId: input.retryOfRunId,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, queued.id))
        .returning()
        .then((rows) => rows[0] ?? queued);
    }

    return queued;
  }

  // RUAAAAA-5326: when the sweep's bounded budget is spent, hand the issue to
  // a human once instead of re-seeding the ladder on every later pass. Keyed on
  // the issue rather than a run id because the sweep has no run of its own.
  async function postSweepContinuationExhaustedCommentOnce(
    issue: Pick<typeof issues.$inferSelect, "id" | "companyId">,
    agentId: string,
    comment: string,
  ) {
    const existing = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, issue.companyId),
          eq(issueComments.issueId, issue.id),
          sql`${issueComments.body} like ${`${SWEEP_CONTINUATION_EXHAUSTED_COMMENT_PREFIX}%`}`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return;
    await issuesSvc.addComment(issue.id, comment, { agentId });
  }

  // RUAAAAA-5326: the sweep may chain from `issue.checkoutRunId` when there is
  // no latest run row, so the attempt budget has to be readable by id and not
  // only off the `getLatestIssueRun` projection.
  async function readRunSweepContinuationAttempt(runId: string | null | undefined) {
    if (!runId) return 0;
    const rows = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1);
    return readSweepContinuationAttempt(rows[0]?.contextSnapshot);
  }

  async function enqueueInitialAssignedTodoDispatch(issue: typeof issues.$inferSelect, agentId: string) {
    return deps.enqueueWakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: issue.id,
        mutation: "assigned_todo_liveness_dispatch",
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: issue.id,
        taskId: issue.id,
        wakeReason: "issue_assigned",
        source: "issue.assigned_todo_liveness_dispatch",
      }),
    });
  }

  async function isInvocationBudgetBlocked(issue: typeof issues.$inferSelect, agentId: string) {
    const budgetBlock = await budgets.getInvocationBlock(issue.companyId, agentId, {
      issueId: issue.id,
      projectId: issue.projectId,
    });
    return Boolean(budgetBlock);
  }

  async function reconcileUnassignedBlockingIssues() {
    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        createdByAgentId: issues.createdByAgentId,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.type, "blocks"),
          inArray(issues.status, ["todo", "blocked"]),
          isNull(issues.assigneeAgentId),
          isNull(issues.assigneeUserId),
          sql`${issues.createdByAgentId} is not null`,
          sql`exists (
            select 1
            from issues blocked_issue
            where blocked_issue.id = ${issueRelations.relatedIssueId}
              and blocked_issue.company_id = ${issues.companyId}
              and blocked_issue.status not in ('done', 'cancelled')
          )`,
        ),
      );

    let assigned = 0;
    let skipped = 0;
    const issueIds: string[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);

      const creatorAgentId = candidate.createdByAgentId;
      if (!creatorAgentId) {
        skipped += 1;
        continue;
      }
      const creatorAgent = await getAgent(creatorAgentId);
      if (!creatorAgent || creatorAgent.companyId !== candidate.companyId || !isAgentInvokable(creatorAgent)) {
        skipped += 1;
        continue;
      }

      const relations = await issuesSvc.getRelationSummaries(candidate.id);
      const blockingLinks = formatIssueLinksForComment(relations.blocks);
      const updated = await issuesSvc.update(candidate.id, {
        assigneeAgentId: creatorAgent.id,
        assigneeUserId: null,
      });
      if (!updated) {
        skipped += 1;
        continue;
      }

      await issuesSvc.addComment(
        candidate.id,
        [
          "## Assigned Orphan Blocker",
          "",
          `Paperclip found this issue is blocking ${blockingLinks} but had no assignee, so no heartbeat could pick it up.`,
          "",
          "- Assigned it back to the agent that created the blocker.",
          "- Next action: resolve this blocker or reassign it to the right owner.",
        ].join("\n"),
        {},
      );

      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: candidate.id,
        details: {
          identifier: candidate.identifier,
          assigneeAgentId: creatorAgent.id,
          source: "recovery.reconcile_unassigned_blocking_issue",
        },
      });

      const queued = await deps.enqueueWakeup(creatorAgent.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: candidate.id,
          mutation: "unassigned_blocker_recovery",
        }),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: candidate.id,
          taskId: candidate.id,
          wakeReason: "issue_assigned",
          source: "issue.unassigned_blocker_recovery",
        }),
      });

      if (queued) {
        assigned += 1;
        issueIds.push(candidate.id);
      } else {
        skipped += 1;
      }
    }

    return { assigned, skipped, issueIds };
  }

  async function getCompanyIssuePrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  function staleActiveRunOriginFingerprint(companyId: string, runId: string) {
    return `stale_active_run:${companyId}:${runId}`;
  }

  function silenceStartedAtForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">) {
    return run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
  }

  function silenceAgeMsForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">, now = new Date()) {
    const startedAt = silenceStartedAtForRun(run);
    return startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;
  }

  async function latestActiveOutputQuietUntilDecision(companyId: string, runId: string, now = new Date()) {
    const [row] = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          eq(heartbeatRunWatchdogDecisions.runId, runId),
          inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
          gt(heartbeatRunWatchdogDecisions.snoozedUntil, now),
        ),
      )
      .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
      .limit(1);
    return row ?? null;
  }

  async function findOpenStaleRunEvaluation(companyId: string, runId: string) {
    const [row] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, runId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function buildRunOutputSilence(
    run: Pick<
      typeof heartbeatRuns.$inferSelect,
      "id" | "companyId" | "status" | "lastOutputAt" | "lastOutputSeq" | "lastOutputStream" | "processStartedAt" | "startedAt" | "createdAt"
    >,
    now = new Date(),
  ): Promise<RunOutputSilenceSummary> {
    const [quietUntilDecision, evaluation] = await Promise.all([
      latestActiveOutputQuietUntilDecision(run.companyId, run.id, now),
      findOpenStaleRunEvaluation(run.companyId, run.id),
    ]);
    const silenceStartedAt = silenceStartedAtForRun(run);
    const silenceAgeMs = run.status === "running" ? silenceAgeMsForRun(run, now) : null;
    const level = run.status !== "running"
      ? "not_applicable"
      : quietUntilDecision
        ? "snoozed"
        : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS
          ? "critical"
          : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS
            ? "suspicious"
            : "ok";
    return {
      lastOutputAt: run.lastOutputAt ?? null,
      lastOutputSeq: run.lastOutputSeq ?? 0,
      lastOutputStream: (run.lastOutputStream === "stdout" || run.lastOutputStream === "stderr")
        ? run.lastOutputStream
        : null,
      silenceStartedAt,
      silenceAgeMs,
      level,
      suspicionThresholdMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
      criticalThresholdMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
      snoozedUntil: quietUntilDecision?.snoozedUntil ?? null,
      evaluationIssueId: evaluation?.id ?? null,
      evaluationIssueIdentifier: evaluation?.identifier ?? null,
      evaluationIssueAssigneeAgentId: evaluation?.assigneeAgentId ?? null,
    };
  }

  function redactWatchdogEvidenceText(value: string, currentUserRedactionOptions: Awaited<ReturnType<typeof getCurrentUserRedactionOptions>>) {
    return redactSensitiveText(redactCurrentUserText(value, currentUserRedactionOptions));
  }

  function truncateEvidenceText(value: string, maxChars = 4000) {
    if (value.length <= maxChars) return value;
    return `${value.slice(value.length - maxChars)}\n[truncated earlier evidence]`;
  }

  async function readRunLogTailForEvidence(run: typeof heartbeatRuns.$inferSelect) {
    if (!run.logStore || !run.logRef || !run.logBytes) return "";
    try {
      const offset = Math.max(0, run.logBytes - ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES);
      const result = await runLogStore.read(
        { store: run.logStore as "local_file", logRef: run.logRef },
        { offset, limitBytes: ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES },
      );
      return result.content;
    } catch (err) {
      logger.warn({ err, runId: run.id }, "failed to read stale-run watchdog evidence tail");
      return "";
    }
  }

  async function resolveStaleRunSourceIssue(run: typeof heartbeatRuns.$inferSelect) {
    const issueId = issueIdFromRunContext(run.contextSnapshot);
    if (!issueId) return null;
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId), isNull(issues.hiddenAt)))
      .limit(1);
    return issue ?? null;
  }

  // Recovery ownership routing for stale runs (companion to
  // resolveStrandedIssueRecoveryOwnerAgentId, see RUAAAAA-1703). The same
  // narrow rule applies: try the running agent / source assignee first so a
  // stale heartbeat does not silently promote work to the executive desk.
  async function resolveStaleRunOwnerAgentId(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
  }) {
    const candidateIds: string[] = [];
    candidateIds.push(input.runningAgent.id);
    if (input.sourceIssue?.assigneeAgentId) candidateIds.push(input.sourceIssue.assigneeAgentId);
    if (input.runningAgent.reportsTo) candidateIds.push(input.runningAgent.reportsTo);
    if (input.sourceIssue?.assigneeAgentId) {
      const sourceAssignee = await getAgent(input.sourceIssue.assigneeAgentId);
      if (sourceAssignee?.reportsTo) candidateIds.push(sourceAssignee.reportsTo);
    }
    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, input.run.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== input.run.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(input.run.companyId, candidate.id, {
        issueId: input.sourceIssue?.id ?? null,
        projectId: input.sourceIssue?.projectId ?? null,
      });
      if (isAgentInvokable(candidate) && !budgetBlock) return candidate.id;
    }

    return null;
  }

  async function collectStaleRunEvidence(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    prefix: string;
    now: Date;
  }) {
    const [tail, recentEvents, childIssues, blockers] = await Promise.all([
      readRunLogTailForEvidence(input.run),
      db
        .select({
          eventType: heartbeatRunEvents.eventType,
          level: heartbeatRunEvents.level,
          message: heartbeatRunEvents.message,
          createdAt: heartbeatRunEvents.createdAt,
        })
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, input.run.companyId), eq(heartbeatRunEvents.runId, input.run.id)))
        .orderBy(desc(heartbeatRunEvents.id))
        .limit(8),
      input.sourceIssue
        ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issues)
          .where(and(eq(issues.companyId, input.run.companyId), eq(issues.parentId, input.sourceIssue.id), isNull(issues.hiddenAt)))
          .orderBy(desc(issues.updatedAt))
          .limit(8)
        : Promise.resolve([]),
      input.sourceIssue
        ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issueRelations)
          .innerJoin(issues, eq(issueRelations.issueId, issues.id))
          .where(
            and(
              eq(issueRelations.companyId, input.run.companyId),
              eq(issueRelations.relatedIssueId, input.sourceIssue.id),
              eq(issueRelations.type, "blocks"),
            ),
          )
          .limit(8)
        : Promise.resolve([]),
    ]);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const safeTail = truncateEvidenceText(redactWatchdogEvidenceText(tail, currentUserRedactionOptions));
    const silenceAgeMs = silenceAgeMsForRun(input.run, input.now);
    return {
      safeTail,
      silenceAgeMs,
      recentEvents: recentEvents.reverse().map((event) => ({
        eventType: event.eventType,
        level: event.level,
        createdAt: event.createdAt.toISOString(),
        message: event.message ? truncateEvidenceText(redactWatchdogEvidenceText(event.message, currentUserRedactionOptions), 300) : null,
      })),
      childIssues,
      blockers,
    };
  }

  function buildStaleRunEvaluationDescription(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    prefix: string;
    evidence: Awaited<ReturnType<typeof collectStaleRunEvidence>>;
    level: "suspicious" | "critical";
    now: Date;
  }) {
    const sourceIssue = input.sourceIssue
      ? issueUiLink({ identifier: input.sourceIssue.identifier, id: input.sourceIssue.id }, input.prefix)
      : "none";
    const recentEvents = input.evidence.recentEvents.length > 0
      ? input.evidence.recentEvents.map((event) =>
        `- ${event.createdAt} \`${event.eventType}\`${event.level ? ` ${event.level}` : ""}: ${event.message ?? "(no message)"}`,
      ).join("\n")
      : "- none";
    const childIssues = input.evidence.childIssues.length > 0
      ? input.evidence.childIssues.map((issue) =>
        `- ${issueUiLink({ identifier: issue.identifier, id: issue.id }, input.prefix)} \`${issue.status}\`: ${issue.title}`,
      ).join("\n")
      : "- none detected";
    const blockers = input.evidence.blockers.length > 0
      ? input.evidence.blockers.map((issue) =>
        `- ${issueUiLink({ identifier: issue.identifier, id: issue.id }, input.prefix)} \`${issue.status}\`: ${issue.title}`,
      ).join("\n")
      : "- none detected";
    return [
      `Paperclip detected ${input.level} output silence on an active heartbeat run.`,
      "",
      "## Run",
      "",
      `- Run: ${runUiLink(input.run, input.prefix)}`,
      `- Agent: ${input.runningAgent.name} (${input.runningAgent.adapterType})`,
      `- Invocation: ${input.run.invocationSource}${input.run.triggerDetail ? ` / ${input.run.triggerDetail}` : ""}`,
      `- Source issue: ${sourceIssue}`,
      `- Started at: ${input.run.startedAt?.toISOString() ?? "unknown"}`,
      `- Process started at: ${input.run.processStartedAt?.toISOString() ?? "unknown"}`,
      `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
      `- Last output sequence: ${input.run.lastOutputSeq ?? 0}`,
      `- Silent for: ${formatDuration(input.evidence.silenceAgeMs)}`,
      `- Thresholds: suspicious after ${formatDuration(ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS)}, critical after ${formatDuration(ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS)}`,
      `- Process metadata: pid \`${input.run.processPid ?? "unknown"}\`, process group \`${input.run.processGroupId ?? "unknown"}\`, in-memory handle \`${runningProcesses.has(input.run.id) ? "yes" : "no"}\``,
      "",
      "## Last Output Excerpt",
      "",
      input.evidence.safeTail ? `\`\`\`text\n${input.evidence.safeTail}\n\`\`\`` : "_No run-log tail was available._",
      "",
      "## Recent Run Events",
      "",
      recentEvents,
      "",
      "## Related Work",
      "",
      "Active child issues:",
      childIssues,
      "",
      "Current source blockers:",
      blockers,
      "",
      "## Decision Checklist",
      "",
      "- Continue or snooze if the run is intentionally quiet.",
      "- Ask the run owner for context if work may be delegated outside the transcript.",
      "- Preserve artifacts, branch state, and useful output before cancellation.",
      "- Cancel or recover through the explicit run recovery controls when authorized.",
      "- Close this issue as a false positive only after recording the reason.",
    ].join("\n");
  }

  function isUniqueStaleRunEvaluationConflict(error: unknown) {
    const maybe = unwrapDatabaseConflictError(error);
    if (!maybe) return false;
    return maybe.code === "23505" &&
      (
        maybe.constraint === "issues_active_stale_run_evaluation_uq" ||
        maybe.constraint_name === "issues_active_stale_run_evaluation_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_stale_run_evaluation_uq")
      );
  }

  function isUniqueStrandedIssueRecoveryConflict(error: unknown) {
    const maybe = unwrapDatabaseConflictError(error);
    if (!maybe) return false;
    return maybe.code === "23505" &&
      (
        maybe.constraint === "issues_active_stranded_issue_recovery_uq" ||
        maybe.constraint_name === "issues_active_stranded_issue_recovery_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_stranded_issue_recovery_uq")
      );
  }

  async function ensureSourceIssueBlockedByStaleEvaluation(input: {
    sourceIssue: typeof issues.$inferSelect | null;
    evaluationIssue: { id: string; identifier: string | null };
    run: typeof heartbeatRuns.$inferSelect;
  }) {
    if (!input.sourceIssue || ["done", "cancelled"].includes(input.sourceIssue.status)) return false;
    const blockerIds = await existingBlockerIssueIds(input.sourceIssue.companyId, input.sourceIssue.id);
    if (blockerIds.includes(input.evaluationIssue.id)) return false;
    const nextBlockerIds = [...blockerIds, input.evaluationIssue.id];
    await issuesSvc.update(input.sourceIssue.id, {
      ...(input.sourceIssue.status === "blocked" ? {} : { status: "blocked" }),
      blockedByIssueIds: nextBlockerIds,
    });
    await issuesSvc.addComment(input.sourceIssue.id, [
      "Paperclip detected critical output silence on this issue's active run.",
      "",
      `- Evaluation issue: ${input.evaluationIssue.identifier ?? input.evaluationIssue.id}`,
      `- Run: \`${input.run.id}\``,
      "",
      "This blocks the source issue on the explicit review task without cancelling the active process.",
    ].join("\n"), { runId: input.run.id });
    await logActivity(db, {
      companyId: input.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.run.id,
      action: "heartbeat.output_stale_escalated",
      entityType: "issue",
      entityId: input.sourceIssue.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        evaluationIssueId: input.evaluationIssue.id,
        blockerIssueIds: nextBlockerIds,
      },
    });
    return true;
  }

  async function createOrUpdateStaleRunEvaluation(input: {
    run: typeof heartbeatRuns.$inferSelect;
    now: Date;
  }) {
    const runningAgent = await getAgent(input.run.agentId);
    if (!runningAgent || runningAgent.companyId !== input.run.companyId) return { kind: "skipped" as const };
    const sourceIssue = await resolveStaleRunSourceIssue(input.run);
    const prefix = await getCompanyIssuePrefix(input.run.companyId);
    const evidence = await collectStaleRunEvidence({
      run: input.run,
      runningAgent,
      sourceIssue,
      prefix,
      now: input.now,
    });
    const level = (evidence.silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS ? "critical" : "suspicious";
    const existing = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
    if (existing) {
      if (level === "critical" && existing.priority !== "high") {
        await issuesSvc.update(existing.id, {
          priority: "high",
        });
        await issuesSvc.addComment(existing.id, [
          "Critical output silence threshold crossed.",
          "",
          `- Run: \`${input.run.id}\``,
          `- Silent for: ${formatDuration(evidence.silenceAgeMs)}`,
          `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
        ].join("\n"), { runId: input.run.id });
        await ensureSourceIssueBlockedByStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
        return { kind: "escalated" as const, evaluationIssueId: existing.id };
      }
      if (level === "critical") {
        await ensureSourceIssueBlockedByStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
      }
      return { kind: "existing" as const, evaluationIssueId: existing.id };
    }

    const ownerAgentId = await resolveStaleRunOwnerAgentId({ run: input.run, runningAgent, sourceIssue });
    const description = buildStaleRunEvaluationDescription({
      run: input.run,
      runningAgent,
      sourceIssue,
      prefix,
      evidence,
      level,
      now: input.now,
    });
    let evaluation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      evaluation = await issuesSvc.create(input.run.companyId, {
        title: `Review silent active run for ${runningAgent.name}`,
        description,
        status: "todo",
        priority: level === "critical" ? "high" : "medium",
        parentId: sourceIssue && !["done", "cancelled"].includes(sourceIssue.status) ? sourceIssue.id : null,
        projectId: sourceIssue?.projectId ?? null,
        goalId: sourceIssue?.goalId ?? null,
        billingCode: sourceIssue?.billingCode ?? null,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides(),
        originKind: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
        originId: input.run.id,
        originRunId: input.run.id,
        originFingerprint: staleActiveRunOriginFingerprint(input.run.companyId, input.run.id),
      });
    } catch (error) {
      if (!isUniqueStaleRunEvaluationConflict(error)) throw error;
      const raced = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
      if (!raced) throw error;
      return { kind: "existing" as const, evaluationIssueId: raced.id };
    }

    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerAgentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_detected",
      entityType: "issue",
      entityId: evaluation.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        level,
        sourceIssueId: sourceIssue?.id ?? null,
        silenceAgeMs: evidence.silenceAgeMs,
        lastOutputAt: input.run.lastOutputAt?.toISOString() ?? null,
      },
    });
    if (level === "critical") {
      await ensureSourceIssueBlockedByStaleEvaluation({
        sourceIssue,
        evaluationIssue: evaluation,
        run: input.run,
      });
    }
    if (ownerAgentId) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: evaluation.id,
          staleRunId: input.run.id,
          sourceIssueId: sourceIssue?.id ?? null,
        }),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: evaluation.id,
          taskId: evaluation.id,
          wakeReason: "issue_assigned",
          source: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
          staleRunId: input.run.id,
          sourceIssueId: sourceIssue?.id ?? null,
        }),
      });
    }
    return { kind: "created" as const, evaluationIssueId: evaluation.id };
  }

  async function scanSilentActiveRuns(opts?: { now?: Date; companyId?: string }) {
    const now = opts?.now ?? new Date();
    const suspicionBefore = new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS);
    const candidates = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          opts?.companyId ? eq(heartbeatRuns.companyId, opts.companyId) : undefined,
          eq(heartbeatRuns.status, "running"),
          sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.processStartedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${suspicionBefore.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt))
      .limit(100);

    const result = {
      scanned: candidates.length,
      created: 0,
      existing: 0,
      escalated: 0,
      snoozed: 0,
      skipped: 0,
      evaluationIssueIds: [] as string[],
    };

    for (const run of candidates) {
      if (await latestActiveOutputQuietUntilDecision(run.companyId, run.id, now)) {
        result.snoozed += 1;
        continue;
      }
      const outcome = await createOrUpdateStaleRunEvaluation({ run, now });
      if (outcome.kind === "created") result.created += 1;
      else if (outcome.kind === "existing") result.existing += 1;
      else if (outcome.kind === "escalated") result.escalated += 1;
      else result.skipped += 1;
      if ("evaluationIssueId" in outcome && outcome.evaluationIssueId) {
        result.evaluationIssueIds.push(outcome.evaluationIssueId);
      }
    }

    return result;
  }

  async function recordWatchdogDecision(input: {
    runId: string;
    actor: WatchdogDecisionActor;
    decision: "snooze" | "continue" | "dismissed_false_positive";
    evaluationIssueId?: string | null;
    reason?: string | null;
    snoozedUntil?: Date | null;
    createdByRunId?: string | null;
    now?: Date;
  }) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .limit(1);
    if (!run) throw notFound("Heartbeat run not found");

    let evaluationIssue: {
      id: string;
      assigneeAgentId: string | null;
      companyId: string;
      originKind: string;
      originId: string | null;
      hiddenAt: Date | null;
      status: string;
    } | null = null;
    if (input.evaluationIssueId) {
      evaluationIssue = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          companyId: issues.companyId,
          originKind: issues.originKind,
          originId: issues.originId,
          hiddenAt: issues.hiddenAt,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.id, input.evaluationIssueId), eq(issues.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!evaluationIssue) throw notFound("Evaluation issue not found");
    }

    const boardActor = input.actor.type === "board";
    const assignedRecoveryOwner =
      input.actor.type === "agent" &&
      Boolean(input.actor.agentId) &&
      evaluationIssue !== null &&
      evaluationIssue.originKind === STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND &&
      evaluationIssue.originId === run.id &&
      evaluationIssue.hiddenAt === null &&
      !["done", "cancelled"].includes(evaluationIssue.status) &&
      evaluationIssue?.assigneeAgentId === input.actor.agentId;
    if (!boardActor && !assignedRecoveryOwner) {
      throw forbidden("Only the board or the assigned recovery owner can record watchdog decisions");
    }

    if (evaluationIssue && (
      evaluationIssue.originKind !== STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND ||
      evaluationIssue.originId !== run.id
    )) {
      throw forbidden("Watchdog decision evaluation issue is not bound to the target run");
    }

    if (input.actor.type === "agent" && !evaluationIssue) {
      throw forbidden("Agent watchdog decisions require the target evaluation issue");
    }

    const createdByRunId = input.actor.type === "agent"
      ? input.actor.runId ?? input.createdByRunId ?? null
      : input.actor.type === "board"
        ? input.actor.runId ?? input.createdByRunId ?? null
        : null;
    if (createdByRunId) {
      const [creatorRun] = await db
        .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, createdByRunId))
        .limit(1);
      const sameCompany = creatorRun?.companyId === run.companyId;
      const sameAgent = input.actor.type !== "agent" || creatorRun?.agentId === input.actor.agentId;
      if (!creatorRun || !sameCompany || !sameAgent) {
        throw forbidden("createdByRunId is not valid for this watchdog decision actor");
      }
    }

    const decisionNow = input.now ?? new Date();
    const effectiveSnoozedUntil = input.decision === "snooze"
      ? input.snoozedUntil ?? null
      : input.decision === "continue"
        ? input.snoozedUntil && input.snoozedUntil > decisionNow
          ? input.snoozedUntil
          : new Date(decisionNow.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS)
        : null;

    const [row] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId: run.companyId,
        runId: run.id,
        evaluationIssueId: input.evaluationIssueId ?? null,
        decision: input.decision,
        snoozedUntil: effectiveSnoozedUntil,
        reason: input.reason ?? null,
        createdByAgentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
        createdByUserId: input.actor.type === "board" ? input.actor.userId ?? null : null,
        createdByRunId,
      })
      .returning();

    await logActivity(db, {
      companyId: run.companyId,
      actorType: input.actor.type === "agent" ? "agent" : "user",
      actorId: input.actor.type === "agent"
        ? input.actor.agentId ?? "agent"
        : input.actor.type === "board"
          ? input.actor.userId ?? "board"
          : "unknown",
      agentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
      runId: run.id,
      action: input.decision === "snooze" ? "heartbeat.watchdog_snoozed" : "heartbeat.watchdog_decision_recorded",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: {
        source: "recovery.record_watchdog_decision",
        decision: input.decision,
        evaluationIssueId: input.evaluationIssueId ?? null,
        snoozedUntil: effectiveSnoozedUntil?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    });

    return row;
  }

  async function findOpenStrandedIssueRecoveryIssue(companyId: string, sourceIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STRANDED_ISSUE_RECOVERY_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function isStrandedIssueRecoveryIssue(issue: typeof issues.$inferSelect) {
    return issue.originKind === STRANDED_ISSUE_RECOVERY_ORIGIN_KIND;
  }

  async function buildNestedStrandedRecoveryLine(issue: typeof issues.$inferSelect, prefix: string) {
    const sourceIssueId = readNonEmptyString(issue.originId);
    const sourceIssue = sourceIssueId
      ? await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, sourceIssueId)))
        .then((rows) => rows[0] ?? null)
      : null;
    const sourceLine = sourceIssue
      ? `- Original source issue: ${issueUiLink(sourceIssue, prefix)}`
      : sourceIssueId
        ? `- Original source issue: \`${sourceIssueId}\``
        : "- Original source issue: unknown";

    return [
      "",
      "- Nested recovery: suppressed because this issue is already a `stranded_issue_recovery` issue.",
      sourceLine,
      "- Next action: the assigned recovery owner or board operator should fix the runtime/adapter problem, resolve or reassign the original source issue, then mark this recovery issue done or cancelled.",
    ].join("\n");
  }

  // Recovery ownership routing rule (RUAAAAA-1703, 2026-06-13):
  //   1. The original assignee (operating owner) is the default recovery owner. Routine
  //      work (Core Health Review, Fleet Health Watch, etc.) and stranded lead-owned
  //      issues must return to the lane that already owned the work, not the
  //      executive desk, when that lane is still invokable.
  //   2. The assignee's `reportsTo` is the manager escalation path, used only when the
  //      assignee is no longer invokable (paused/terminated/pending_approval or
  //      budget-blocked).
  //   3. The creator's chain (creator's manager, then creator) covers manually
  //      originated child issues where the operating owner has been reassigned.
  //   4. `cto`/`ceo` role agents are the executive integration fallback, reserved
  //      for board-created issues with no reachable operating owner.
  //   5. The original assignee is appended last as a final fallback so the recovery
  //      action can still be recorded against the source lane when the agent
  //      returns to service.
  // CEO/manager promotion is intentionally a *narrow* rule, not a default: the
  // previous behavior of trying `assignee.reportsTo` first caused specialist
  // routine residue to wake the CEO lane (see issue description for evidence).
  async function resolveStrandedIssueRecoveryOwnerAgentId(issue: typeof issues.$inferSelect) {
    const candidateIds: string[] = [];
    if (issue.assigneeAgentId) candidateIds.push(issue.assigneeAgentId);
    if (issue.assigneeAgentId) {
      const assignee = await getAgent(issue.assigneeAgentId);
      if (assignee?.reportsTo) candidateIds.push(assignee.reportsTo);
    }
    if (issue.createdByAgentId) {
      const creator = await getAgent(issue.createdByAgentId);
      if (creator?.reportsTo) candidateIds.push(creator.reportsTo);
      candidateIds.push(issue.createdByAgentId);
    }

    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, issue.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== issue.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.id, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (isAgentInvokable(candidate) && !budgetBlock) return candidate.id;
    }

    return null;
  }

  function buildStrandedIssueRecoveryDescription(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    prefix: string;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
    sourceAssignee?: Pick<typeof agents.$inferSelect, "id" | "name"> | null;
  }) {
    const sourceIssue = issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix);
    const runLink = input.latestRun
      ? `[\`${input.latestRun.id}\`](/${input.prefix}/agents/${input.latestRun.agentId}/runs/${input.latestRun.id})`
      : "none";
    if (input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON) {
      const sourceRunId = input.successfulRunHandoffEvidence?.sourceRunId;
      const sourceRunLink = sourceRunId && input.latestRun
        ? `[\`${sourceRunId}\`](/${input.prefix}/agents/${input.latestRun.agentId}/runs/${sourceRunId})`
        : "unknown";
      const missingDisposition = input.successfulRunHandoffEvidence?.missingDisposition ?? "clear_next_step";
      return [
        "Paperclip exhausted the bounded corrective handoff for a successful run that still has no valid issue disposition.",
        "",
        "This is not a runtime/adapter crash report. The source run succeeded; the remaining problem is the missing `done`, `in_review`, `blocked`, delegated follow-up, or explicit continuation path.",
        "",
        "## Safe Evidence",
        "",
        `- Source issue: ${sourceIssue}`,
        `- Source run: ${sourceRunLink}`,
        `- Corrective handoff run: ${runLink}`,
        `- Source assignee: ${agentUiLink(input.sourceAssignee ?? null, input.prefix)}`,
        `- Latest issue status: \`${input.issue.status}\``,
        `- Latest handoff run status: \`${input.latestRun?.status ?? "unknown"}\``,
        `- Normalized cause: \`${SUCCESSFUL_RUN_MISSING_STATE_REASON}\``,
        `- Missing disposition: \`${missingDisposition}\``,
        "- Suggested manager action: choose and record a valid issue disposition without copying transcript content.",
        "",
        "## Required Action",
        "",
        "- Inspect the source issue and run metadata, not raw transcript excerpts.",
        "- Choose a valid issue disposition: `done`/`cancelled`, `in_review` with an owner, `blocked` with first-class blockers, delegated follow-up work, or an explicit continuation path.",
        "- When the source issue has a clear owner and disposition, mark this recovery issue done.",
      ].join("\n");
    }

    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "unknown";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);

    return [
      "Paperclip exhausted automatic recovery for an assigned issue and created this explicit recovery task.",
      "",
      "## Source",
      "",
      `- Source issue: ${sourceIssue}`,
      `- Previous source status: \`${input.previousStatus}\``,
      `- Latest retry run: ${runLink}`,
      `- Latest retry status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Detected invariant: \`stranded_assigned_issue\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "",
      "## Ownership",
      "",
      "- Selected owner: the first invokable manager/creator/executive candidate with budget available.",
      "",
      "## Required Action",
      "",
      "- Inspect the latest run and source issue state.",
      "- Fix the runtime/adapter problem, reassign the source issue, or convert the source issue into a clear manual-review state.",
      "- When the source issue has a live execution path or has been intentionally resolved, mark this recovery issue done.",
    ].join("\n");
  }

  async function ensureStrandedIssueRecoveryIssue(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    if (isStrandedIssueRecoveryIssue(input.issue)) return null;

    const existing = await findOpenStrandedIssueRecoveryIssue(input.issue.companyId, input.issue.id);
    if (existing) return existing;

    const ownerAgentId = await resolveStrandedIssueRecoveryOwnerAgentId(input.issue);
    if (!ownerAgentId) return null;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    const sourceAssignee = input.issue.assigneeAgentId ? await getAgent(input.issue.assigneeAgentId) : null;
    const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
    let recovery: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      recovery = await issuesSvc.create(input.issue.companyId, {
        title: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
          ? `Recover missing next step ${input.issue.identifier ?? input.issue.title}`
          : `Recover stalled issue ${input.issue.identifier ?? input.issue.title}`,
        description: buildStrandedIssueRecoveryDescription({
          issue: input.issue,
          latestRun: input.latestRun,
          previousStatus: input.previousStatus,
          prefix,
          recoveryCause,
          successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
          sourceAssignee,
        }),
        status: "todo",
        priority: input.issue.priority,
        parentId: input.issue.id,
        projectId: input.issue.projectId,
        goalId: input.issue.goalId,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides(),
        originKind: STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
        originId: input.issue.id,
        originRunId: input.latestRun?.id ?? null,
        originFingerprint: [
          STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
          input.issue.companyId,
          input.issue.id,
          recoveryCause,
          input.latestRun?.id ?? "no-run",
        ].join(":"),
        billingCode: input.issue.billingCode,
        inheritExecutionWorkspaceFromIssueId: input.issue.id,
      });
    } catch (error) {
      if (!isUniqueStrandedIssueRecoveryConflict(error)) throw error;
      const raced = await findOpenStrandedIssueRecoveryIssue(input.issue.companyId, input.issue.id);
      if (!raced) throw error;
      return raced;
    }

    await deps.enqueueWakeup(ownerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: recovery.id,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause,
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: recovery.id,
        taskId: recovery.id,
        wakeReason: "issue_assigned",
        source: STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause,
      }),
    });

    return recovery;
  }

  function strandedRecoveryActionKind(cause: StrandedRecoveryCause) {
    if (cause === SUCCESSFUL_RUN_MISSING_STATE_REASON) return "missing_disposition" as const;
    if (cause === WRITE_TOOLING_FAILURE_CAUSE) return "handoff_to_engineering" as const;
    return "stranded_assigned_issue" as const;
  }

  function strandedRecoveryActionFingerprint(input: {
    issue: typeof issues.$inferSelect;
    recoveryCause: StrandedRecoveryCause;
  }) {
    return [
      "source_scoped_recovery",
      input.issue.companyId,
      input.issue.id,
      input.recoveryCause,
    ].join(":");
  }

  function buildStrandedRecoveryActionEvidence(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    recoveryCause: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    const context = parseObject(input.latestRun?.contextSnapshot);
    return {
      sourceIssueId: input.issue.id,
      sourceIdentifier: input.issue.identifier,
      previousStatus: input.previousStatus,
      latestIssueStatus: input.issue.status,
      latestRunId: input.latestRun?.id ?? null,
      latestRunStatus: input.latestRun?.status ?? null,
      latestRunErrorCode: input.latestRun?.errorCode ?? null,
      retryReason: readNonEmptyString(context.retryReason) ?? null,
      recoveryCause: input.recoveryCause,
      sourceRunId: input.successfulRunHandoffEvidence?.sourceRunId ?? null,
      correctiveRunId: input.successfulRunHandoffEvidence?.correctiveRunId ?? null,
      missingDisposition: input.successfulRunHandoffEvidence?.missingDisposition ?? null,
      handoffAttempt: input.successfulRunHandoffEvidence?.handoffAttempt ?? null,
      maxHandoffAttempts: input.successfulRunHandoffEvidence?.maxHandoffAttempts ?? null,
    };
  }

  async function ensureSourceScopedStrandedRecoveryAction(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
    const ownerAgentId = await resolveStrandedIssueRecoveryOwnerAgentId(input.issue);
    const now = new Date();
    const action = await recoveryActionsSvc.upsertSourceScoped({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      kind: strandedRecoveryActionKind(recoveryCause),
      ownerType: ownerAgentId ? "agent" : "board",
      ownerAgentId,
      previousOwnerAgentId: input.issue.assigneeAgentId,
      returnOwnerAgentId: input.issue.assigneeAgentId,
      cause: recoveryCause,
      fingerprint: strandedRecoveryActionFingerprint({
        issue: input.issue,
        recoveryCause,
      }),
      evidence: buildStrandedRecoveryActionEvidence({
        issue: input.issue,
        latestRun: input.latestRun,
        previousStatus: input.previousStatus,
        recoveryCause,
        successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
      }),
      nextAction: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "Choose and record a valid issue disposition without copying transcript content."
        : "Restore a live execution path, fix the runtime/adapter failure, or record an intentional manual resolution.",
      wakePolicy: ownerAgentId
        ? {
          type: "wake_owner",
          reason: "source_scoped_recovery_action",
          ownerAgentId,
        }
        : {
          type: "board_escalation",
          reason: "no_invokable_recovery_owner",
        },
      monitorPolicy: null,
      maxAttempts: null,
      lastAttemptAt: now,
    });

    return action;
  }

  async function enqueueSourceScopedStrandedRecoveryWake(input: {
    action: Awaited<ReturnType<typeof recoveryActionsSvc.upsertSourceScoped>>;
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    recoveryCause: StrandedRecoveryCause;
  }) {
    if (!input.action.ownerAgentId) return;
    await deps.enqueueWakeup(input.action.ownerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "source_scoped_recovery_action",
      idempotencyKey: `source_scoped_recovery_action:${input.action.id}:${input.action.attemptCount}`,
      payload: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        sourceIssueId: input.issue.id,
        recoveryActionId: input.action.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        taskId: input.issue.id,
        wakeReason: "source_scoped_recovery_action",
        skipIssueComment: true,
        source: "issue_recovery_action",
        recoveryActionId: input.action.id,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }),
    });
  }

  function buildRecoveryIssueInPlaceEscalationComment(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
    prefix: string;
  }) {
    const runLink = input.latestRun
      ? runUiLink({ id: input.latestRun.id, agentId: input.latestRun.agentId }, input.prefix)
      : "none";
    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "none";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);

    return [
      "Paperclip stopped automatic stranded-work recovery for this recovery issue.",
      "",
      `- Recovery issue: ${issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix)}`,
      `- Previous status: \`${input.previousStatus}\``,
      `- Latest run: ${runLink}`,
      `- Latest run status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "- Guard: recovery issues do not create nested `stranded_issue_recovery` issues.",
      "",
      "Next action: the current recovery owner should inspect the failed run evidence, restore a live execution path or record the manual resolution, then move this recovery issue out of `blocked`.",
    ].join("\n");
  }

  async function escalateStrandedRecoveryIssueInPlace(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
  }) {
    const updated = await issuesSvc.update(input.issue.id, { status: "blocked" });
    if (!updated) return null;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    await issuesSvc.addComment(
      input.issue.id,
      buildRecoveryIssueInPlaceEscalationComment({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
        prefix,
      }),
      {},
    );

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.previousStatus,
        source: "recovery.reconcile_stranded_recovery_issue",
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        originKind: input.issue.originKind,
        originId: input.issue.originId,
      },
    });

    return updated;
  }

  async function existingBlockerIssueIds(companyId: string, issueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function existingUnresolvedBlockerIssueIds(companyId: string, issueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, issueRelations.companyId),
          eq(issues.id, issueRelations.issueId),
        ),
      )
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  /**
   * Detect whether the latest run on a source issue has recorded a valid
   * in_progress continuation path. Returns the type of evidence found.
   *
   * The reconciliation pass uses this to auto-clear a `missing_disposition`
   * recovery action before force-blocking the source issue, so legitimate
   * long-running orchestration issues (parent + live child continuation)
   * do not accumulate repeated recovery wakes once the corrective handoff
   * run has already recorded a valid disposition.
   */
  async function detectValidInProgressContinuationPath(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
  }): Promise<
    | { hasContinuation: false; reason: string }
    | {
        hasContinuation: true;
        signal: "resume_intent" | "open_child_issues" | "continuation_summary";
        openChildIssueIds?: string[];
        correctiveRunId?: string | null;
      }
  > {
    if (input.issue.status !== "in_progress") {
      return { hasContinuation: false, reason: `source issue status ${input.issue.status} is not in_progress` };
    }
    if (!input.latestRun || input.latestRun.status !== "succeeded") {
      return { hasContinuation: false, reason: "latest run did not succeed" };
    }

    const context = parseObject(input.latestRun.contextSnapshot);
    const explicitResume = asBoolean(context.resumeIntent, false) || asBoolean(context.followUpRequested, false);
    if (explicitResume) {
      return {
        hasContinuation: true,
        signal: "resume_intent",
        correctiveRunId: input.latestRun.id,
      };
    }

    // Look for open child issues that represent delegated follow-up work.
    const openChildRows = await db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.issue.companyId),
          eq(issues.parentId, input.issue.id),
          notInArray(issues.status, ["done", "cancelled", "backlog"]),
        ),
      )
      .limit(8);
    if (openChildRows.length > 0) {
      return {
        hasContinuation: true,
        signal: "open_child_issues",
        openChildIssueIds: openChildRows.map((row) => row.id),
        correctiveRunId: input.latestRun.id,
      };
    }

    return { hasContinuation: false, reason: "no continuation signal recorded" };
  }

  /**
   * Auto-clear a `missing_disposition` recovery action when the source issue
   * has a valid in_progress continuation path. This is the fix for the
   * repeated-recovery-wake loop where a successful corrective handoff run
   * records a valid in_progress disposition but the recovery action keeps
   * re-firing because the schema historically forced the source issue to
   * `blocked` for resolution.
   *
   * Returns the resolved recovery action on success, or null if the
  /**
   * Detect whether a `timed_out` continuation retry on an in_progress issue
   * recorded durable progress (open child issues, comments, or work
   * products) BEFORE the gateway wait-timeout fired. This is the
   * stranded-after-write detector for the `stranded_assigned_issue` cause.
   *
   * The reconciliation pass uses this to auto-clear the recovery action
   * instead of force-blocking the source issue, so legitimate long-running
   * orchestration issues (parent + live child continuation, parent + open
   * review interactions, parent + comments) do not accumulate repeated
   * `source_scoped_recovery_action` wakes once the timed-out retry has
   * already produced durable evidence of advancing the issue.
   *
   * Returns the type of evidence found, or `hasContinuation: false` if the
   * timed-out run left no durable trace.
   */
  async function detectValidTimedOutContinuationPath(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
  }): Promise<
    | { hasContinuation: false; reason: string }
    | {
        hasContinuation: true;
        signal: "open_child_issues" | "issue_comments_landed" | "work_products_landed";
        openChildIssueIds?: string[];
        commentIds?: string[];
        workProductIds?: string[];
        correctiveRunId: string;
      }
  > {
    if (input.issue.status !== "in_progress") {
      return { hasContinuation: false, reason: `source issue status ${input.issue.status} is not in_progress` };
    }
    if (!input.latestRun || input.latestRun.status !== "timed_out") {
      return { hasContinuation: false, reason: "latest run did not time out" };
    }

    // Look for open child issues that represent delegated follow-up work
    // that landed before the gateway wait-timeout fired.
    const openChildRows = await db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.issue.companyId),
          eq(issues.parentId, input.issue.id),
          notInArray(issues.status, ["done", "cancelled", "backlog"]),
        ),
      )
      .limit(8);
    if (openChildRows.length > 0) {
      return {
        hasContinuation: true,
        signal: "open_child_issues",
        openChildIssueIds: openChildRows.map((row) => row.id),
        correctiveRunId: input.latestRun.id,
      };
    }

    // Look for issue comments that the timed-out run created. These are a
    // strong "wrote something durable" signal even when no child issues
    // were filed (e.g., review comments, progress notes, unblock notes).
    const commentRows = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, input.issue.id),
          eq(issueComments.createdByRunId, input.latestRun.id),
        ),
      )
      .limit(8);
    if (commentRows.length > 0) {
      return {
        hasContinuation: true,
        signal: "issue_comments_landed",
        commentIds: commentRows.map((row) => row.id),
        correctiveRunId: input.latestRun.id,
      };
    }

    // Look for work products the timed-out run created (e.g., attached
    // design docs, deployment artifacts). These also represent durable
    // progress that survived the timeout.
    const workProductRows = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, input.issue.companyId),
          eq(issueWorkProducts.issueId, input.issue.id),
          eq(issueWorkProducts.createdByRunId, input.latestRun.id),
        ),
      )
      .limit(8);
    if (workProductRows.length > 0) {
      return {
        hasContinuation: true,
        signal: "work_products_landed",
        workProductIds: workProductRows.map((row) => row.id),
        correctiveRunId: input.latestRun.id,
      };
    }

    return {
      hasContinuation: false,
      reason: "no durable progress (open children, comments, or work products) recorded by the timed-out run",
    };
  }

  /**
   * Auto-clear a `stranded_assigned_issue` recovery action when the latest
   * timed-out continuation retry recorded durable progress on the source
   * issue before the openclaw_gateway wait-timeout fired. This is the
   * paired fix for the false-positive recovery churn pattern observed on
   * 2026-06-22 (RUAAAAA-2061) where a long-running Lead run timed out at
   * the 300s gateway boundary AFTER creating child issues and posting
   * progress comments, and the reconciliation sweep kept force-blocking
   * the source issue on every retry cycle.
   *
   * Mirrors `tryAutoClearMissingDispositionContinuation` (the
   * successful_run_missing_state path) so the two auto-clear guards stay
   * structurally identical — both keep the source issue at `in_progress`
   * with the live continuation path rather than force-blocking it.
   *
   * Returns the resolved recovery action on success, or null if the
   * auto-clear was not applicable.
   */
  async function tryAutoClearTimedOutStrandedAssignedContinuation(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
  }): Promise<Awaited<ReturnType<typeof recoveryActionsSvc.resolveActiveForIssue>> | null> {
    if (input.latestRun?.status !== "timed_out") return null;
    const active = await recoveryActionsSvc.getActiveForIssue(
      input.issue.companyId,
      input.issue.id,
    );
    if (!active || active.kind !== "stranded_assigned_issue") return null;
    if (active.status !== "active" && active.status !== "escalated") return null;

    const detection = await detectValidTimedOutContinuationPath({
      issue: input.issue,
      latestRun: input.latestRun,
    });
    if (!detection.hasContinuation) return null;

    const signalLabel =
      detection.signal === "open_child_issues"
        ? `${detection.openChildIssueIds?.length ?? 0} open child issue(s) (delegated follow-up landed before timeout)`
        : detection.signal === "issue_comments_landed"
        ? `${detection.commentIds?.length ?? 0} issue comment(s) landed before timeout`
        : `${detection.workProductIds?.length ?? 0} work product(s) landed before timeout`;
    const resolutionNote = [
      "Auto-cleared by reconciliation: timed-out continuation retry recorded durable progress on the source issue.",
      `Run \`${detection.correctiveRunId}\` produced ${signalLabel}.`,
      "The 300s openclaw_gateway wait-timeout fired AFTER durable writes had already landed;",
      "the source issue is still advancing and the recovery action was triggered by run-finalization ordering, not a real stall.",
    ].join(" ");

    const resolved = await recoveryActionsSvc.resolveActiveForIssue({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      actionId: active.id,
      status: "resolved",
      outcome: "continuing",
      resolutionNote,
    });
    if (!resolved) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: detection.correctiveRunId,
      action: "issue.recovery_action_auto_cleared",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        recoveryActionId: resolved.id,
        recoveryCause: "stranded_assigned_issue",
        outcome: "continuing",
        continuationSignal: detection.signal,
        correctiveRunId: detection.correctiveRunId,
        openChildIssueIds: detection.openChildIssueIds ?? null,
        commentIds: detection.commentIds ?? null,
        workProductIds: detection.workProductIds ?? null,
        source: "recovery.reconcile_timed_out_continuation_auto_clear",
      },
    });

    return resolved;
  }

  /**
   * Cycle-1 auto-clear guard: detect durable progress on a `timed_out`
   * continuation retry BEFORE the recovery action is created. The
   * 2072 cycle-2+ guard (`tryAutoClearTimedOutStrandedAssignedContinuation`
   * above) requires an existing active recovery action of kind
   * `stranded_assigned_issue`, which means cycle 1 always slipped
   * through and force-blocked the source issue even when the timed-out
   * run had already produced durable progress (open child issues,
   * comments, or work products). After escalation created the recovery
   * action, the cycle-2+ guard was never re-invoked, so the false
   * positive persisted.
   *
   * This guard runs in the same reconciliation branch as the cycle-2+
   * guard, but it runs FIRST (so it has a chance to skip escalation
   * entirely on cycle 1) and it uses `ensureSourceScopedStrandedRecoveryAction`
   * to materialize the recovery action (so the audit log has a
   * consistent shape with cycle-2+ auto-clears) before immediately
   * resolving it with outcome=continuing. The ensure call is idempotent
   * (upsert by fingerprint) so if a prior cycle somehow already created
   * the action, this becomes a no-op ensure followed by the same
   * resolveActiveForIssue call.
   *
   * Mirrors `tryAutoClearMissingDispositionContinuation` so the two
   * cycle-1 auto-clear guards stay structurally identical.
   *
   * Reference: RUAAAAA-2184 — observed 2026-06-24 on RUAAAAA-2169
   * where a run timed out 6 seconds after posting 2 durable comments
   * (full path + identity analysis, disposition refresh), the recovery
   * sweep force-blocked the source issue with a `stranded_assigned_issue`
   * action, and the cycle-2+ guard could not fire because no recovery
   * action had existed at cycle-1 evidence-check time.
   */
  async function tryCycle1AutoClearTimedOutStrandedAssignedContinuation(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
  }): Promise<Awaited<ReturnType<typeof recoveryActionsSvc.resolveActiveForIssue>> | null> {
    // Only relevant for the cycle-1 case: timed_out run, in_progress
    // issue, no escalation has happened yet. Anything else falls
    // through to the cycle-2+ guard or escalation.
    if (input.latestRun?.status !== "timed_out") return null;
    if (input.issue.status !== "in_progress") return null;

    const detection = await detectValidTimedOutContinuationPath({
      issue: input.issue,
      latestRun: input.latestRun,
    });
    if (!detection.hasContinuation) return null;

    const signalLabel =
      detection.signal === "open_child_issues"
        ? `${detection.openChildIssueIds?.length ?? 0} open child issue(s) (delegated follow-up landed before timeout)`
        : detection.signal === "issue_comments_landed"
        ? `${detection.commentIds?.length ?? 0} issue comment(s) landed before timeout`
        : `${detection.workProductIds?.length ?? 0} work product(s) landed before timeout`;
    const resolutionNote = [
      "Auto-cleared by reconciliation cycle 1: timed-out continuation retry recorded durable progress on the source issue.",
      `Run \`${detection.correctiveRunId}\` produced ${signalLabel}.`,
      "The 300s openclaw_gateway wait-timeout fired AFTER durable writes had already landed;",
      "the source issue is still advancing and the recovery action was triggered by run-finalization ordering, not a real stall.",
    ].join(" ");

    // Materialize the recovery action so the audit log has a consistent
    // shape with cycle-2+ auto-clears. The ensure call is idempotent
    // (upsert by fingerprint), so if a prior cycle already created the
    // action this is a no-op.
    const action = await ensureSourceScopedStrandedRecoveryAction({
      issue: input.issue,
      previousStatus: "in_progress",
      latestRun: input.latestRun,
      recoveryCause: "stranded_assigned_issue",
    });

    const resolved = await recoveryActionsSvc.resolveActiveForIssue({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      actionId: action.id,
      status: "resolved",
      outcome: "continuing",
      resolutionNote,
    });
    if (!resolved) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: detection.correctiveRunId,
      action: "issue.recovery_action_auto_cleared",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        recoveryActionId: resolved.id,
        recoveryCause: "stranded_assigned_issue",
        outcome: "continuing",
        continuationSignal: detection.signal,
        correctiveRunId: detection.correctiveRunId,
        openChildIssueIds: detection.openChildIssueIds ?? null,
        commentIds: detection.commentIds ?? null,
        workProductIds: detection.workProductIds ?? null,
        cycle: 1,
        source: "recovery.reconcile_timed_out_continuation_auto_clear",
      },
    });

    return resolved;
  }

  /**
   * Detect whether an `in_progress` source issue has a live continuation
   * path recorded as a pending `issueThreadInteractions` row with
   * `continuationPolicy = wake_assignee`. This is the 2253 detector:
   * even when the latest run completes `succeeded` and the issue status
   * correctly stays `in_progress` (because the issue is in coordination
   * phase, awaiting the user/board/CEO), the recovery service should
   * NOT treat the issue as stranded.
   *
   * Live continuation paths include (all 3 kinds in
   * `ISSUE_THREAD_INTERACTION_KINDS`):
   *
   * - `ask_user_questions` (the RUAAAAA-1509/2135 case — Board/CEO Path
   *   A/B/C decision pending)
   * - `request_confirmation` (pending plan or implementation confirmation
   *   awaiting board approval)
   * - `suggest_tasks` (board has been asked to approve delegated tasks
   *   before Engineering creates them)
   *
   * Future continuation path kinds added to `ISSUE_THREAD_INTERACTION_KINDS`
   * are picked up automatically because the detector does not constrain
   * on `kind`. The only signal we require is `status = pending` and
   * `continuationPolicy = wake_assignee` so the recovery service treats
   * the interaction as a live execution path that wakes the assignee on
   * resolution.
   *
   * Returns the active interaction row, or null if none is present.
   */
  async function detectSucceededLiveContinuationPath(input: {
    issue: typeof issues.$inferSelect;
  }): Promise<{
    id: string;
    kind: string;
    title: string | null;
    summary: string | null;
    createdAt: Date;
  } | null> {
    if (input.issue.status !== "in_progress") return null;
    const [interaction] = await db
      .select({
        id: issueThreadInteractions.id,
        kind: issueThreadInteractions.kind,
        title: issueThreadInteractions.title,
        summary: issueThreadInteractions.summary,
        createdAt: issueThreadInteractions.createdAt,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, input.issue.companyId),
          eq(issueThreadInteractions.issueId, input.issue.id),
          eq(issueThreadInteractions.status, "pending"),
          eq(issueThreadInteractions.continuationPolicy, "wake_assignee"),
        ),
      )
      .orderBy(desc(issueThreadInteractions.createdAt))
      .limit(1);
    return interaction ?? null;
  }

  /**
   * RUAAAAA-2377 — write-tooling failure classifier.
   *
   * Detects the churn pattern where the same agent has run N consecutive
   * times against the same issue and every run failed/timed_out without
   * producing a single `issueComments.createdByRunId === run.id` or
   * `issueWorkProducts.createdByRunId === run.id` row. The agent itself
   * executed (it produced a failed/timed_out terminal status, not
   * "did nothing"), but its writes never landed on the source issue.
   *
   * Distinct from the existing `didAutomaticRecoveryFail` /
   * `issue_continuation_needed` branch in two ways:
   *
   * 1. Productivity failure (what today escalates): the agent ran, made
   *    no progress, and on the next sweep we either re-dispatch or
   *    force-block the source. Escalating the same agent back into the
   *    next sweep is the right action when the agent can be expected
   *    to do better next time.
   * 2. Write-tooling failure (what this classifier detects): the agent
   *    ran, but the lane they were handed is not writeable from their
   *    adapter. Re-dispatching the agent makes no progress because the
   *    next run will also produce zero writes for the same reason. The
   *    correct routing is to escalate to the lane that owns the
   *    auth/tooling (Engineering by default for paperclip-side
   *    tooling), not the assignee.
   *
   * Canonical churn pattern: RUAAAAA-2369 (2026-06-24). The same
   * hermes_local adapter kept failing silently because the JWT path was
   * broken in production — every retry attempt at the same retryable
   * action produced identical silent-write-failure runs. Escalating the
   * assignee back into the next sweep did not help; the issue had to be
   * routed to Engineering (RUAAAAA-2374 → 2375 → 2378) before the
   * silent-write pattern cleared.
   *
   * The classifier returns a stable signal so the recovery sweep can
   * route to a different lane than the assignee. The companion helper
   * `resolveWriteToolingFailureOwnerAgentId` picks the Engineering lane
   * (configurable via title match on "Engineering" today; can be
   * promoted to a per-company config field later). The companion
   * helper `tryEscalateWriteToolingFailure` materializes the handoff
   * recovery action and wakes the engineering owner.
   *
   * Threshold: `WRITE_TOOLING_FAILURE_CONSECUTIVE_RUN_THRESHOLD = 3`.
   * Three is the minimum needed to distinguish "agent ran but the lane
   * is broken" (≥3 consecutive zero-write failed/timed_out runs) from a
   * single transient failure (which the existing retry+block path
   * handles correctly).
   */
  async function detectAgentCompletedWithZeroWrites(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    lookbackRunLimit?: number;
  }): Promise<
    | { matches: false; reason: string }
    | {
        matches: true;
        consecutiveZeroWriteRuns: number;
        sampleRunIds: string[];
        threshold: number;
      }
  > {
    const limit = input.lookbackRunLimit ?? Math.max(
      WRITE_TOOLING_FAILURE_CONSECUTIVE_RUN_THRESHOLD * 3,
      12,
    );

    // The latest run must be in a failed-or-timed_out terminal state.
    // Succeeded / cancelled / queued / running / scheduled_retry runs
    // are not write-tooling failures — succeeded means writes landed,
    // the rest means the run has not finished yet.
    if (!input.latestRun) {
      return { matches: false, reason: "no latest run available" };
    }
    if (
      input.latestRun.status !== "failed" &&
      input.latestRun.status !== "timed_out"
    ) {
      return {
        matches: false,
        reason: `latest run status is ${input.latestRun.status}, not failed/timed_out`,
      };
    }

    // Pull the most recent N runs for this issue (any agent). We walk
    // backwards from the latest failed/timed_out run and count
    // consecutive zero-write runs. We stop counting as soon as we see a
    // run with at least one comment or work product, because that
    // proves the lane was writeable at that point.
    const recentRuns = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.issue.companyId),
          // `contextSnapshot.issueId` is the canonical pointer from a run
          // back to its source issue (same field the existing
          // `issueIdFromRunContext` helper uses to attach a run to an
          // issue). We also accept `contextSnapshot.taskId` for backward
          // compatibility with legacy runs.
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issue.id}`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${input.issue.id}`,
          ),
          inArray(heartbeatRuns.status, [
            "failed",
            "timed_out",
            "cancelled",
            "succeeded",
          ] as const),
        ),
      )
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(limit);

    if (recentRuns.length === 0) {
      return {
        matches: false,
        reason: "no recent runs found in the issue context for this issue",
      };
    }

    const sampleRunIds: string[] = [];
    let consecutiveZeroWriteRuns = 0;

    for (const run of recentRuns) {
      // Only failed/timed_out runs count toward the consecutive
      // counter. A succeeded run in the middle of the window proves
      // writes were landing at that point — the failure pattern is
      // newer than the most recent success. A cancelled run does not
      // count either; cancellation is a deliberate stop, not a
      // write-tooling failure.
      if (run.status !== "failed" && run.status !== "timed_out") {
        break;
      }

      const [commentCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, input.issue.id),
            eq(issueComments.createdByRunId, run.id),
          ),
        );
      const [workProductCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, input.issue.companyId),
            eq(issueWorkProducts.issueId, input.issue.id),
            eq(issueWorkProducts.createdByRunId, run.id),
          ),
        );

      const hadWrite = (commentCount?.count ?? 0) > 0 || (workProductCount?.count ?? 0) > 0;
      if (hadWrite) {
        // Write landed during this run — the lane was writeable at
        // this point. The current run, if it failed, is a different
        // failure mode (productivity, env, runtime, etc.). Stop the
        // consecutive counter here.
        break;
      }

      sampleRunIds.push(run.id);
      consecutiveZeroWriteRuns += 1;
    }

    if (consecutiveZeroWriteRuns < WRITE_TOOLING_FAILURE_CONSECUTIVE_RUN_THRESHOLD) {
      return {
        matches: false,
        reason: `only ${consecutiveZeroWriteRuns} consecutive zero-write failed/timed_out run(s); threshold is ${WRITE_TOOLING_FAILURE_CONSECUTIVE_RUN_THRESHOLD}`,
      };
    }

    return {
      matches: true,
      consecutiveZeroWriteRuns,
      sampleRunIds,
      threshold: WRITE_TOOLING_FAILURE_CONSECUTIVE_RUN_THRESHOLD,
    };
  }

  /**
   * RUAAAAA-2377 — resolve the recovery-owner agent for a
   * write-tooling failure. The default lane is Engineering (the lane
   * that owns paperclip-side auth/tooling); the lookup matches on
   * `agents.title` containing "engineering" (case-insensitive) within
   * the same company. If no engineering owner is invokable, fall back
   * to the existing `resolveStrandedIssueRecoveryOwnerAgentId` chain
   * (assignee → assignee.reportsTo → creator.reportsTo → creator →
   * cto → ceo) so the recovery action still gets a real owner.
   *
   * Future work: promote the "engineering lane" match to a per-company
   * config field (`lanes.write_tooling_failure = <role|title>`) so
   * deployments can route DevOps / SRE / Security instead of
   * Engineering. The default today is "any agent with 'engineering' in
   * the title" — which works for Ruah Innovations (Head of Engineering)
   * and any other company whose engineering owner is conventionally
   * titled.
   */
  async function resolveWriteToolingFailureOwnerAgentId(
    issue: typeof issues.$inferSelect,
  ): Promise<{ ownerAgentId: string; lane: "engineering" | "fallback_chain"; agent: typeof agents.$inferSelect } | null> {
    const engineeringCandidates = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, issue.companyId),
          sql`lower(coalesce(${agents.title}, '')) like '%engineering%'`,
        ),
      )
      .orderBy(asc(agents.createdAt));

    for (const candidate of engineeringCandidates) {
      if (!isAgentInvokable(candidate)) continue;
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.id, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (budgetBlock) continue;
      return { ownerAgentId: candidate.id, lane: "engineering", agent: candidate };
    }

    const fallbackId = await resolveStrandedIssueRecoveryOwnerAgentId(issue);
    if (!fallbackId) return null;
    const fallbackAgent = await getAgent(fallbackId);
    if (!fallbackAgent) return null;
    return { ownerAgentId: fallbackId, lane: "fallback_chain", agent: fallbackAgent };
  }

  /**
   * RUAAAAA-2377 — materialize a `handoff_to_engineering` recovery
   * action for a write-tooling failure. The action's `cause` field is
   * `agent_completed_with_zero_writes` (the explicit reason the issue
   * asks for); the `evidence` payload carries the run ids that
   * satisfied the classifier plus the engineering lane match.
   *
   * Mirrors `ensureSourceScopedStrandedRecoveryAction` for the
   * existing `stranded_assigned_issue` kind so the audit log has a
   * consistent shape across all source-scoped recovery actions.
   */
  async function ensureSourceScopedWriteToolingFailureRecoveryAction(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    consecutiveZeroWriteRuns: number;
    sampleRunIds: string[];
    ownerAgentId: string;
    lane: "engineering" | "fallback_chain";
    ownerAgent: typeof agents.$inferSelect;
  }) {
    const now = new Date();
    return recoveryActionsSvc.upsertSourceScoped({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      kind: "handoff_to_engineering",
      ownerType: "agent",
      ownerAgentId: input.ownerAgentId,
      previousOwnerAgentId: input.issue.assigneeAgentId,
      returnOwnerAgentId: input.issue.assigneeAgentId,
      cause: WRITE_TOOLING_FAILURE_CAUSE,
      fingerprint: [
        "source_scoped_write_tooling_failure",
        input.issue.companyId,
        input.issue.id,
        WRITE_TOOLING_FAILURE_CAUSE,
      ].join(":"),
      evidence: {
        sourceIssueId: input.issue.id,
        sourceIdentifier: input.issue.identifier,
        previousStatus: input.previousStatus,
        latestIssueStatus: input.issue.status,
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        consecutiveZeroWriteRuns: input.consecutiveZeroWriteRuns,
        threshold: WRITE_TOOLING_FAILURE_CONSECUTIVE_RUN_THRESHOLD,
        sampleRunIds: input.sampleRunIds,
        lane: input.lane,
        ownerAgentId: input.ownerAgentId,
        ownerAgentTitle: input.ownerAgent.title ?? null,
        ownerAgentRole: input.ownerAgent.role ?? null,
      },
      nextAction: input.lane === "engineering"
        ? "Inspect the auth/tooling surface used by the source assignee's adapter, restore write capability, then resolve this action. The source issue will stay at in_progress until this action resolves."
        : "No engineering lane is invokable in this company; restore the assignee's write capability (auth/tooling surface, API base, token) or reassign the source issue to a lane that can write.",
      wakePolicy: {
        type: "wake_owner",
        reason: "source_scoped_recovery_action",
        ownerAgentId: input.ownerAgentId,
      },
      monitorPolicy: null,
      maxAttempts: null,
      lastAttemptAt: now,
    });
  }

  /**
   * RUAAAAA-2377 — escalate a write-tooling failure to the engineering
   * lane (or fallback chain). Materializes the recovery action, sets
   * the source issue to `blocked` with the engineering owner as the
   * new assignee, posts a system comment naming the pattern and the
   * unblock owner, logs the activity, and wakes the engineering owner.
   *
   * Mirrors `escalateStrandedAssignedIssue` for the existing
   * `stranded_assigned_issue` cause so the board / comment / activity
   * shape stays consistent.
   */
  async function escalateWriteToolingFailure(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
    consecutiveZeroWriteRuns: number;
    sampleRunIds: string[];
  }): Promise<{ updated: typeof issues.$inferSelect | null; actionId: string | null }> {
    const owner = await resolveWriteToolingFailureOwnerAgentId(input.issue);
    if (!owner) return { updated: null, actionId: null };

    const action = await ensureSourceScopedWriteToolingFailureRecoveryAction({
      issue: input.issue,
      latestRun: input.latestRun,
      previousStatus: input.previousStatus,
      consecutiveZeroWriteRuns: input.consecutiveZeroWriteRuns,
      sampleRunIds: input.sampleRunIds,
      ownerAgentId: owner.ownerAgentId,
      lane: owner.lane,
      ownerAgent: owner.agent,
    });

    const blockerIds = await existingUnresolvedBlockerIssueIds(input.issue.companyId, input.issue.id);
    const updated = await issuesSvc.update(input.issue.id, {
      status: "blocked",
      blockedByIssueIds: blockerIds,
      assigneeAgentId: owner.ownerAgentId,
    });
    if (!updated) return { updated: null, actionId: action.id };

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    const sourceAssignee = input.issue.assigneeAgentId ? await getAgent(input.issue.assigneeAgentId) : null;
    const laneLabel = owner.lane === "engineering" ? "Engineering" : "the fallback recovery owner chain";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);
    const ownerLink = agentUiLink(owner.agent, prefix);
    const sourceLink = sourceAssignee
      ? agentUiLink(sourceAssignee, prefix)
      : "none";

    const sampleRunList = input.sampleRunIds.slice(0, 3).map((id) => `\`${id}\``).join(", ");
    const moreRuns = input.sampleRunIds.length > 3
      ? ` (+${input.sampleRunIds.length - 3} earlier)`
      : "";
    const commentBody = [
      "Paperclip detected a write-tooling failure pattern on this assigned issue:",
      `the assignee ran ${input.consecutiveZeroWriteRuns} consecutive times (most recent: ${sampleRunList}${moreRuns}) and every run failed/timed_out without producing a single issue comment or work product on the source issue.`,
      `Re-dispatching the assignee (\`${sourceAssignee?.name ?? input.issue.assigneeAgentId}\`) would just churn — the lane they were handed is not writeable from their adapter (auth-tooling, API base, malformed token, etc.).`,
      `Routing the recovery action to ${laneLabel} (${ownerLink}) instead.${failureSummary ?? ""}`,
      "",
      `- Recovery action: \`${action.id}\``,
      `- Recovery cause: \`${WRITE_TOOLING_FAILURE_CAUSE}\``,
      `- Recovery kind: \`handoff_to_engineering\``,
      `- Recovery lane: \`${owner.lane}\``,
      `- Source assignee: ${sourceLink}`,
      `- Consecutive zero-write failed/timed_out runs: ${input.consecutiveZeroWriteRuns} (threshold ${WRITE_TOOLING_FAILURE_CONSECUTIVE_RUN_THRESHOLD})`,
      "- Next action: the engineering owner should inspect the auth/tooling surface, restore write capability, and resolve this action; the source issue will return to in_progress once a writeable path is restored.",
    ].join("\n");

    // Only post the system comment on the first attempt so we don't
    // spam the issue thread on every reconciliation cycle.
    if (action.attemptCount === 1) {
      const escalationCommentMarker = `Recovery action: \`${action.id}\``;
      const hasEscalationComment = await db
        .select({ id: issueComments.id, body: issueComments.body })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, input.issue.id),
            eq(issueComments.authorType, "system"),
          ),
        )
        .orderBy(desc(issueComments.createdAt))
        .limit(50)
        .then((rows) => rows.some((row) => (row.body ?? "").includes(escalationCommentMarker)));

      if (!hasEscalationComment) {
        await issuesSvc.addComment(input.issue.id, commentBody, {}, {
          authorType: "system",
        });
      }
    }

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.latestRun?.id ?? null,
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.previousStatus,
        source: "recovery.reconcile_write_tooling_failure_handoff",
        recoveryCause: WRITE_TOOLING_FAILURE_CAUSE,
        recoveryKind: "handoff_to_engineering",
        recoveryLane: owner.lane,
        recoveryActionId: action.id,
        recoveryOwnerAgentId: action.ownerAgentId,
        previousOwnerAgentId: input.issue.assigneeAgentId,
        returnOwnerAgentId: action.returnOwnerAgentId,
        consecutiveZeroWriteRuns: input.consecutiveZeroWriteRuns,
        sampleRunIds: input.sampleRunIds,
        threshold: WRITE_TOOLING_FAILURE_CONSECUTIVE_RUN_THRESHOLD,
        blockerIssueIds: blockerIds,
      },
    });

    await enqueueSourceScopedStrandedRecoveryWake({
      action,
      issue: input.issue,
      latestRun: input.latestRun,
      recoveryCause: WRITE_TOOLING_FAILURE_CAUSE,
    });

    return { updated, actionId: action.id };
  }

  /**
   * Cycle-2+ auto-clear guard: resolve an existing active
   * `stranded_assigned_issue` recovery action when the source issue is
   * `in_progress` with a live continuation path recorded by a pending
   * `issueThreadInteractions` row with `continuationPolicy = wake_assignee`.
   * The latest run completed `succeeded` (the run was a healthy state
   * verification / continuation-maintenance pass, not a real stall) and
   * the issue correctly stays `in_progress` because it is awaiting the
   * user/board/CEO answer.
   *
   * This is the 2253 fix. Mirrors `tryAutoClearTimedOutStrandedAssignedContinuation`
   * (2072 cycle-2+ guard) but for the `succeeded` case. The cycle-1
   * sibling `tryCycle1AutoClearSucceededLiveContinuation` runs in the
   * same reconciliation branch BEFORE escalation so a fresh
   * succeeded-with-live-continuation cycle never creates the recovery
   * action in the first place; this cycle-2+ guard is the safety net
   * for the narrow case where a previous cycle's escalation somehow
   * slipped through (e.g. the interaction was created between cycles).
   *
   * Reference: RUAAAAA-2253 — observed 2026-06-27 on RUAAAAA-1509
   * where a healthy state-verification run completed succeeded at
   * 16:22:02Z and the recovery sweep force-blocked 1509 with a
   * `stranded_assigned_issue` action 6s later (16:22:08Z), waking
   * the owner with `wake_reason: source_scoped_recovery_action`,
   * even though 1509 was correctly `in_progress` because of the
   * pending `ask_user_questions 8405cf78-02e4-4905-87aa-23c3a84f45c3`
   * (re-issued under RUAAAAA-2135, `continuationPolicy: wake_assignee`).
   */
  async function tryAutoClearSucceededLiveContinuation(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
  }): Promise<Awaited<ReturnType<typeof recoveryActionsSvc.resolveActiveForIssue>> | null> {
    if (input.latestRun?.status !== "succeeded") return null;
    if (input.issue.status !== "in_progress") return null;

    const interaction = await detectSucceededLiveContinuationPath({ issue: input.issue });
    if (!interaction) return null;

    const active = await recoveryActionsSvc.getActiveForIssue(
      input.issue.companyId,
      input.issue.id,
    );
    if (!active || active.kind !== "stranded_assigned_issue") return null;
    if (active.status !== "active" && active.status !== "escalated") return null;

    const resolutionNote = [
      "Auto-cleared by reconciliation: source issue is in_progress with a live continuation path recorded by",
      `${interaction.kind} \`${interaction.id}\` (continuationPolicy=wake_assignee).`,
      `Run \`${input.latestRun.id}\` succeeded without changing issue status because the issue correctly`,
      "stays in_progress while awaiting the continuation path's resolution.",
    ].join(" ");

    const resolved = await recoveryActionsSvc.resolveActiveForIssue({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      actionId: active.id,
      status: "resolved",
      outcome: "continuing",
      resolutionNote,
    });
    if (!resolved) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.latestRun.id,
      action: "issue.recovery_action_auto_cleared",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        recoveryActionId: resolved.id,
        recoveryCause: "stranded_assigned_issue",
        outcome: "continuing",
        continuationSignal: interaction.kind,
        interactionId: interaction.id,
        correctiveRunId: input.latestRun.id,
        source: "recovery.reconcile_succeeded_live_continuation_auto_clear",
      },
    });

    return resolved;
  }

  /**
   * Cycle-1 auto-clear guard: detect a live continuation path BEFORE the
   * recovery action is created. The 2253 cycle-2+ guard
   * (`tryAutoClearSucceededLiveContinuation` above) requires an existing
   * active recovery action of kind `stranded_assigned_issue`, which means
   * cycle 1 always slipped through and force-blocked the source issue
   * even when a successful run had landed on an issue with a pending
   * `ask_user_questions` / `request_confirmation` / `suggest_tasks`
   * interaction with `continuationPolicy = wake_assignee`.
   *
   * This guard runs in the same reconciliation branch as the cycle-2+
   * guard, but it runs FIRST (so it has a chance to skip escalation
   * entirely on cycle 1) and it uses
   * `ensureSourceScopedStrandedRecoveryAction` to materialize the recovery
   * action (so the audit log has a consistent shape with cycle-2+
   * auto-clears) before immediately resolving it with
   * `outcome = continuing`. The ensure call is idempotent (upsert by
   * fingerprint) so if a prior cycle somehow already created the action
   * this becomes a no-op ensure followed by the same
   * `resolveActiveForIssue` call.
   *
   * Mirrors `tryCycle1AutoClearTimedOutStrandedAssignedContinuation` so
   * the two cycle-1 auto-clear guards stay structurally identical.
   *
   * Reference: RUAAAAA-2253 — observed 2026-06-27 on RUAAAAA-1509
   * (see the cycle-2+ guard doc comment for the full reproduction).
   */
  async function tryCycle1AutoClearSucceededLiveContinuation(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
  }): Promise<Awaited<ReturnType<typeof recoveryActionsSvc.resolveActiveForIssue>> | null> {
    // Only relevant for the cycle-1 case: succeeded run, in_progress
    // issue, no escalation has happened yet. Anything else falls
    // through to the cycle-2+ guard or escalation.
    if (input.latestRun?.status !== "succeeded") return null;
    if (input.issue.status !== "in_progress") return null;

    const interaction = await detectSucceededLiveContinuationPath({ issue: input.issue });
    if (!interaction) return null;

    // Materialize the recovery action so the audit log has a consistent
    // shape with cycle-2+ auto-clears. The ensure call is idempotent
    // (upsert by fingerprint), so if a prior cycle already created the
    // action this is a no-op.
    const action = await ensureSourceScopedStrandedRecoveryAction({
      issue: input.issue,
      previousStatus: "in_progress",
      latestRun: input.latestRun,
      recoveryCause: "stranded_assigned_issue",
    });

    const resolutionNote = [
      "Auto-cleared by reconciliation cycle 1: source issue is in_progress with a live continuation path recorded by",
      `${interaction.kind} \`${interaction.id}\` (continuationPolicy=wake_assignee).`,
      `Run \`${input.latestRun.id}\` succeeded without changing issue status because the issue correctly`,
      "stays in_progress while awaiting the continuation path's resolution.",
    ].join(" ");

    const resolved = await recoveryActionsSvc.resolveActiveForIssue({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      actionId: action.id,
      status: "resolved",
      outcome: "continuing",
      resolutionNote,
    });
    if (!resolved) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.latestRun.id,
      action: "issue.recovery_action_auto_cleared",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        recoveryActionId: resolved.id,
        recoveryCause: "stranded_assigned_issue",
        outcome: "continuing",
        continuationSignal: interaction.kind,
        interactionId: interaction.id,
        correctiveRunId: input.latestRun.id,
        cycle: 1,
        source: "recovery.reconcile_succeeded_live_continuation_auto_clear",
      },
    });

    return resolved;
  }

  /**
   * Auto-clear a `missing_disposition` recovery action when the source issue
   * has a valid in_progress continuation path. This is the fix for the
   * repeated-recovery-wake loop where a successful corrective handoff run
   * records a valid in_progress disposition but the recovery action keeps
   * re-firing because the schema historically forced the source issue to
   * `blocked` for resolution.
   *
   * Returns the resolved recovery action on success, or null if the
   * auto-clear was not applicable.
   */
  async function tryAutoClearMissingDispositionContinuation(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    recoveryCause: StrandedRecoveryCause;
  }): Promise<Awaited<ReturnType<typeof recoveryActionsSvc.resolveActiveForIssue>> | null> {
    if (input.recoveryCause !== SUCCESSFUL_RUN_MISSING_STATE_REASON) return null;
    const active = await recoveryActionsSvc.getActiveForIssue(
      input.issue.companyId,
      input.issue.id,
    );
    if (!active || active.kind !== "missing_disposition") return null;
    if (active.status !== "active" && active.status !== "escalated") return null;

    const detection = await detectValidInProgressContinuationPath({
      issue: input.issue,
      latestRun: input.latestRun,
    });
    if (!detection.hasContinuation) return null;

    const correctiveRunId = detection.correctiveRunId ?? input.latestRun?.id ?? null;
    const signalLabel =
      detection.signal === "resume_intent"
        ? "explicit continuation intent (resume=true)"
        : detection.signal === "open_child_issues"
        ? `${detection.openChildIssueIds?.length ?? 0} open child issue(s) (delegated follow-up)`
        : "issue continuation summary document";
    const resolutionNote = [
      "Auto-cleared by reconciliation: source issue is in_progress with a valid continuation path recorded by run",
      `\`${correctiveRunId}\` (${signalLabel}).`,
      "Recovery action kept the source issue at in_progress rather than force-blocking it.",
    ].join(" ");

    const resolved = await recoveryActionsSvc.resolveActiveForIssue({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      actionId: active.id,
      status: "resolved",
      outcome: "continuing",
      resolutionNote,
    });
    if (!resolved) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: correctiveRunId,
      action: "issue.recovery_action_auto_cleared",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        recoveryActionId: resolved.id,
        recoveryCause: input.recoveryCause,
        outcome: "continuing",
        continuationSignal: detection.signal,
        correctiveRunId,
        openChildIssueIds: detection.openChildIssueIds ?? null,
        source: "recovery.reconcile_successful_run_handoff_auto_clear",
      },
    });

    return resolved;
  }

  async function escalateStrandedAssignedIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
    comment?: string;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    if (isStrandedIssueRecoveryIssue(input.issue)) {
      return escalateStrandedRecoveryIssueInPlace({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
      });
    }

    const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
    const recoveryAction = await ensureSourceScopedStrandedRecoveryAction({
      issue: input.issue,
      previousStatus: input.previousStatus,
      latestRun: input.latestRun,
      recoveryCause,
      successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
    });
    const blockerIds = await existingUnresolvedBlockerIssueIds(input.issue.companyId, input.issue.id);
    const updated = await issuesSvc.update(input.issue.id, {
      status: "blocked",
      blockedByIssueIds: blockerIds,
      assigneeAgentId: recoveryAction.ownerAgentId ?? input.issue.assigneeAgentId,
    });
    if (!updated) return null;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    const recoveryOwner = recoveryAction.ownerAgentId ? await getAgent(recoveryAction.ownerAgentId) : null;
    const sourceAssignee = input.issue.assigneeAgentId ? await getAgent(input.issue.assigneeAgentId) : null;
    let notice: SuccessfulRunHandoffNotice | null = null;
    if (input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON && input.successfulRunHandoffEvidence) {
      notice = buildSuccessfulRunHandoffExhaustedNotice({
        issue: input.issue,
        sourceRun: input.successfulRunHandoffEvidence.sourceRunId
          ? { id: input.successfulRunHandoffEvidence.sourceRunId, status: "succeeded" }
          : null,
        correctiveRun: input.latestRun ? { id: input.latestRun.id, status: input.latestRun.status } : null,
        sourceAssignee,
        recoveryIssue: null,
        recoveryActionId: recoveryAction.id,
        recoveryOwner,
        latestIssueStatus: input.issue.status,
        latestHandoffRunStatus: input.latestRun?.status ?? "unknown",
        missingDisposition: input.successfulRunHandoffEvidence.missingDisposition,
      });
    }
    const recoveryLine = recoveryAction.ownerAgentId
      ? [
        "",
        `- Recovery action: \`${recoveryAction.id}\``,
        `- Recovery owner: ${agentUiLink(recoveryOwner, prefix)}`,
        "- Next action: the recovery owner should either restore a live execution path or record the manual resolution on the source issue.",
      ].join("\n")
      : [
        "",
        `- Recovery action: \`${recoveryAction.id}\``,
        "- Recovery owner: board escalation, because Paperclip could not find an invokable manager, creator, or executive owner with budget available.",
        "- Next action: a board operator should assign an invokable recovery owner, fix the agent/runtime state, or record an intentional manual resolution.",
      ].join("\n");

    if (recoveryAction.attemptCount === 1) {
      const escalationCommentMarker = `Recovery action: \`${recoveryAction.id}\``;

      const hasEscalationComment = await db
        .select({ id: issueComments.id, body: issueComments.body, metadata: issueComments.metadata })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, input.issue.id),
            eq(issueComments.authorType, "system"),
          ),
        )
        .orderBy(desc(issueComments.createdAt))
        .limit(50)
        .then((rows) => rows.some((row) =>
          (row.body ?? "").includes(escalationCommentMarker) ||
          noticeMetadataReferencesRecoveryAction(row.metadata, recoveryAction.id),
        ));

      if (!hasEscalationComment) {
        if (notice) {
          await issuesSvc.addComment(input.issue.id, notice.body, {}, {
            authorType: "system",
            presentation: notice.presentation,
            metadata: notice.metadata,
          });
        } else {
          await issuesSvc.addComment(input.issue.id, `${input.comment ?? ""}${recoveryLine}`, {}, {
            authorType: "system",
          });
        }
      }
    }

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "issue.successful_run_handoff_escalated"
        : "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.previousStatus,
        source: input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
          ? "recovery.reconcile_successful_run_handoff_missing_state"
          : "recovery.reconcile_stranded_assigned_issue",
        recoveryCause: input.recoveryCause ?? "stranded_assigned_issue",
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        recoveryActionId: recoveryAction.id,
        recoveryOwnerAgentId: recoveryAction.ownerAgentId,
        previousOwnerAgentId: recoveryAction.previousOwnerAgentId,
        returnOwnerAgentId: recoveryAction.returnOwnerAgentId,
        blockerIssueIds: blockerIds,
      },
    });

    await enqueueSourceScopedStrandedRecoveryWake({
      action: recoveryAction,
      issue: input.issue,
      latestRun: input.latestRun,
      recoveryCause,
    });

    if (recoveryAction.ownerAgentId && recoveryAction.ownerAgentId === input.issue.assigneeAgentId) {
      const [currentIssue] = await db
        .select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1);
      if (
        currentIssue &&
        (currentIssue.status !== "blocked" ||
          currentIssue.assigneeAgentId !== recoveryAction.ownerAgentId)
      ) {
        const reblocked = await issuesSvc.update(input.issue.id, {
          status: "blocked",
          blockedByIssueIds: blockerIds,
          assigneeAgentId: recoveryAction.ownerAgentId,
        });
        if (reblocked) return reblocked;
      }
    }

    return updated;
  }

  async function reconcileStrandedAssignedIssues() {
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["todo", "in_progress"]),
          sql`${issues.assigneeAgentId} is not null`,
        ),
      );

    const result = {
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      continuationExhausted: 0,
      productiveContinuationObserved: 0,
      successfulContinuationObserved: 0,
      orphanBlockersAssigned: 0,
      successfulRunHandoffEscalated: 0,
      successfulRunHandoffAutoCleared: 0,
      runLivenessReconciled: 0,
      escalated: 0,
      writeToolingFailureHandoff: 0,
      skipped: 0,
      issueIds: [] as string[],
    };

    for (const issue of candidates) {
      const agentId = issue.assigneeAgentId;
      if (!agentId) {
        result.skipped += 1;
        continue;
      }

      const agent = await getAgent(agentId);
      if (!agent || agent.companyId !== issue.companyId || !isAgentInvokable(agent)) {
        result.skipped += 1;
        continue;
      }

      if (await hasActiveExecutionPath(issue.companyId, issue.id)) {
        result.skipped += 1;
        continue;
      }

      if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
        result.skipped += 1;
        continue;
      }

      const latestRun = await getLatestIssueRun(issue.companyId, issue.id);
      if (isStrandedIssueRecoveryIssue(issue) && isUnsuccessfulTerminalIssueRun(latestRun)) {
        const updated = await escalateStrandedRecoveryIssueInPlace({
          issue,
          previousStatus: issue.status as "todo" | "in_progress",
          latestRun,
        });
        if (updated) {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (issue.status === "todo") {
        if (!latestRun) {
          if (await hasQueuedIssueWake(issue.companyId, issue.id)) {
            result.skipped += 1;
            continue;
          }

          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }

          const queued = await enqueueInitialAssignedTodoDispatch(issue, agentId);
          if (queued) {
            result.assignmentDispatched += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (latestRun.status === "succeeded") {
          result.skipped += 1;
          continue;
        }

        // RUAAAAA-2377 — write-tooling failure classifier (todo branch).
        // Same shape as the in_progress branch below, but earlier in the
        // todo state machine so the engineering handoff fires before any
        // `assignment_recovery` retry would queue the assignee again.
        const todoWriteTooling = await detectAgentCompletedWithZeroWrites({
          issue,
          latestRun,
        });
        if (todoWriteTooling.matches) {
          const escalated = await escalateWriteToolingFailure({
            issue,
            previousStatus: "todo",
            latestRun,
            consecutiveZeroWriteRuns: todoWriteTooling.consecutiveZeroWriteRuns,
            sampleRunIds: todoWriteTooling.sampleRunIds,
          });
          if (escalated.updated) {
            result.writeToolingFailureHandoff += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (didAutomaticRecoveryFail(latestRun, "assignment_recovery")) {
          const failureSummary = summarizeRunFailureForIssueComment(latestRun);
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "todo",
            latestRun,
            comment:
              "Paperclip automatically retried dispatch for this assigned `todo` issue after a lost wake/run, " +
              `but it still has no live execution path.${failureSummary ?? ""} ` +
              "Moving it to `blocked` so it is visible for intervention.",
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (await isInvocationBudgetBlocked(issue, agentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId,
          reason: "issue_assignment_recovery",
          retryReason: "assignment_recovery",
          source: "issue.assignment_recovery",
          retryOfRunId: latestRun.id,
        });
        if (queued) {
          result.dispatchRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (!latestRun && !issue.checkoutRunId && !issue.executionRunId) {
        result.skipped += 1;
        continue;
      }

      // Top-level auto-clear guard: a successful run on the source issue
      // recorded a valid in_progress continuation path (open child issues or
      // explicit resume intent). This stops the repeated missing_disposition
      // recovery wake loop for legitimate long-running orchestration issues
      // (parent + live child continuation). Runs before the handoffEvidence
      // and inProgressContinuation branches so it works for both the
      // corrective handoff run and any subsequent productive run.
      if (issue.status === "in_progress" && latestRun?.status === "succeeded") {
        const topLevelAutoCleared = await tryAutoClearMissingDispositionContinuation({
          issue,
          latestRun,
          recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
        });
        if (topLevelAutoCleared) {
          result.successfulRunHandoffAutoCleared += 1;
          result.issueIds.push(issue.id);
          continue;
        }
      }

      const handoffEvidence = isExhaustedSuccessfulRunHandoff(latestRun);
      if (handoffEvidence) {
        if (!handoffEvidence.exhausted) {
          result.skipped += 1;
          continue;
        }

        // Auto-clear guard: if the source issue is in_progress with a valid
        // continuation path, resolve the recovery action with outcome=continuing
        // rather than force-blocking the source. This stops the repeated
        // missing_disposition recovery wake loop for legitimate long-running
        // orchestration issues (parent + live child continuation).
        const autoCleared = await tryAutoClearMissingDispositionContinuation({
          issue,
          latestRun,
          recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
        });
        if (autoCleared) {
          result.successfulRunHandoffAutoCleared += 1;
          result.issueIds.push(issue.id);
          continue;
        }

        const updated = await escalateStrandedAssignedIssue({
          issue,
          previousStatus: "in_progress",
          latestRun,
          recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
          successfulRunHandoffEvidence: handoffEvidence,
        });
        if (updated) {
          result.successfulRunHandoffEscalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (isSuccessfulInProgressContinuationRun(latestRun)) {
        const successfulRun = latestRun;

        if (!isProductiveContinuationRun(successfulRun)) {
          result.successfulContinuationObserved += 1;
          result.skipped += 1;
          continue;
        }

        if (isRepeatedProductiveContinuationRecovery(successfulRun)) {
          // Cycle-2+ auto-clear guard (2253): if the source issue is
          // in_progress with a live continuation path recorded by a
          // pending issueThreadInteraction with continuationPolicy =
          // wake_assignee (ask_user_questions, request_confirmation,
          // suggest_tasks), resolve any existing stranded_assigned_issue
          // action with outcome=continuing rather than force-blocking the
          // source on every retry cycle. The interaction is the live
          // execution path; the run correctly maintained state.
          const liveContinuationCycle2 = await tryAutoClearSucceededLiveContinuation({
            issue,
            latestRun: successfulRun,
          });
          if (liveContinuationCycle2) {
            result.successfulRunHandoffAutoCleared += 1;
            result.issueIds.push(issue.id);
            continue;
          }

          // Cycle-1 auto-clear guard (2253): same detection as above,
          // but runs BEFORE escalation so a fresh succeeded run with a
          // live continuation path never creates a stranded action in
          // the first place. The ensure call is idempotent so if the
          // cycle-2+ guard somehow didn't fire this is a no-op ensure
          // followed by the same resolve.
          const liveContinuationCycle1 = await tryCycle1AutoClearSucceededLiveContinuation({
            issue,
            latestRun: successfulRun,
          });
          if (liveContinuationCycle1) {
            result.successfulRunHandoffAutoCleared += 1;
            result.issueIds.push(issue.id);
            continue;
          }

          // Auto-clear guard: if the source issue is in_progress with a valid
          // continuation path, resolve the recovery action with outcome=continuing
          // rather than force-blocking the source on every retry cycle.
          const autoCleared = await tryAutoClearMissingDispositionContinuation({
            issue,
            latestRun: successfulRun,
            recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
          });
          if (autoCleared) {
            result.successfulRunHandoffAutoCleared += 1;
            result.issueIds.push(issue.id);
            continue;
          }

          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_progress",
            latestRun: successfulRun,
            comment:
              "Paperclip automatically retried continuation for this assigned `in_progress` issue and the retry " +
              "made progress, but it still has no live execution path. Moving it to `blocked` so it is visible for intervention.",
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        // RUAAAAA-5326: this call site is outside both bounded ladders — the
        // latest run SUCCEEDED, so `didAutomaticRecoveryFail` never matches,
        // and `isRepeatedProductiveContinuationRecovery` string-matches the
        // `source` label, so it does not match a run the sibling site seeded.
        // Read the sweep's own attempt budget before re-seeding.
        const productiveSweepDecision = decideSweepContinuation({
          sourceRunAttempt: readSweepContinuationAttempt(successfulRun.contextSnapshot),
          retryReason: "issue_continuation_needed",
        });
        if (productiveSweepDecision.kind !== "enqueue") {
          if (productiveSweepDecision.kind === "exhausted") {
            await postSweepContinuationExhaustedCommentOnce(issue, agentId, productiveSweepDecision.comment);
            result.continuationExhausted += 1;
          }
          result.skipped += 1;
          continue;
        }

        if (await isInvocationBudgetBlocked(issue, agentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId,
          reason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
          source: "issue.productive_terminal_continuation_recovery",
          retryOfRunId: successfulRun.id,
          continuationAttempt: productiveSweepDecision.nextAttempt,
          maxContinuationAttempts: productiveSweepDecision.maxAttempts,
        });
        if (queued) {
          result.continuationRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      // RUAAAAA-2377 — write-tooling failure classifier (in_progress branch).
      // Fires when the latest run failed/timed_out AND the issue has
      // `WRITE_TOOLING_FAILURE_CONSECUTIVE_RUN_THRESHOLD` (3) consecutive
      // such runs with no comments/work products on the source issue.
      // Routes to Engineering instead of re-dispatching the assignee.
      // Mirrors the `todo` branch check above so the same pattern is
      // caught in both states.
      const inProgressWriteTooling = await detectAgentCompletedWithZeroWrites({
        issue,
        latestRun,
      });
      if (inProgressWriteTooling.matches) {
        const escalated = await escalateWriteToolingFailure({
          issue,
          previousStatus: "in_progress",
          latestRun,
          consecutiveZeroWriteRuns: inProgressWriteTooling.consecutiveZeroWriteRuns,
          sampleRunIds: inProgressWriteTooling.sampleRunIds,
        });
        if (escalated.updated) {
          result.writeToolingFailureHandoff += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (didAutomaticRecoveryFail(latestRun, "issue_continuation_needed")) {
        // RUAAAAA-5323: the run row was classified once, at run
        // finalization, against the evidence that existed at that
        // instant. When the openclaw_gateway wait budget expired
        // before the gateway streamed anything back, that evidence was
        // empty and the row froze at `livenessState: failed` /
        // `lastUsefulActionAt: null` — permanently, because nothing ever
        // asked again. The orphaned agent kept working and landed real
        // durable writes afterwards.
        //
        // Re-run the classification here, before the auto-clear guards
        // below, so they evaluate against a row that reflects the late
        // evidence. Guarded to runs finalized `timed_out` whose own
        // durable writes grew *after* `finishedAt`, and repaired at most
        // once per row, so settled rows are never churned.
        //
        // The reconciler re-fetches the run row by id on purpose: the
        // `latestRun` snapshot in this loop is the same stale-snapshot
        // shape that caused the original defect.
        const runLivenessReconciled = await reconcileStrandedTimedOutRunLiveness(
          db,
          latestRun?.id ?? null,
        );
        if (runLivenessReconciled.reconciled) {
          result.runLivenessReconciled += 1;
        }

        // Cycle-1 auto-clear: a `timed_out` continuation retry that
        // landed durable progress BEFORE the openclaw_gateway
        // wait-timeout fired is not a real stall. The evidence check
        // runs before the recovery action is created, so a fresh
        // reconciliation cycle with no pre-existing action still has
        // a chance to skip escalation. This is the fix for the
        // false-positive recovery churn observed on RUAAAAA-2169
        // (2026-06-24) where the 2072 cycle-2+ guard could not fire
        // because the recovery action had not existed at the moment
        // the cycle-1 evidence check would have run.
        const cycle1AutoCleared = await tryCycle1AutoClearTimedOutStrandedAssignedContinuation({
          issue,
          latestRun,
        });
        if (cycle1AutoCleared) {
          result.successfulRunHandoffAutoCleared += 1;
          result.issueIds.push(issue.id);
          continue;
        }

        // Cycle-2+ auto-clear: an existing active recovery action of
        // kind stranded_assigned_issue + a fresh timed_out run with
        // durable progress resolves the action with outcome=continuing.
        // This is the 2072 path and is preserved here for backward
        // compatibility — if the cycle-1 guard is somehow bypassed
        // (e.g. a manually-created action between cycles), this
        // guard still cleans up.
        const timedOutAutoCleared = await tryAutoClearTimedOutStrandedAssignedContinuation({
          issue,
          latestRun,
        });
        if (timedOutAutoCleared) {
          result.successfulRunHandoffAutoCleared += 1;
          result.issueIds.push(issue.id);
          continue;
        }

        const failureSummary = summarizeRunFailureForIssueComment(latestRun);
        const updated = await escalateStrandedAssignedIssue({
          issue,
          previousStatus: "in_progress",
          latestRun,
          comment:
            "Paperclip automatically retried continuation for this assigned `in_progress` issue after its live " +
            `execution disappeared, but it still has no live execution path.${failureSummary ?? ""} ` +
            "Moving it to `blocked` so it is visible for intervention.",
        });
        if (updated) {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      // RUAAAAA-5326: the 2253 sibling site. Same shape as the productive
      // branch above — outside both bounded ladders, so read the attempt budget
      // before re-seeding the top of the retry ladder. The source run can be
      // the checkout run when the issue has no latest run row yet.
      const continuationSweepDecision = decideSweepContinuation({
        sourceRunAttempt: latestRun
          ? readSweepContinuationAttempt(latestRun.contextSnapshot)
          : await readRunSweepContinuationAttempt(issue.checkoutRunId),
        retryReason: "issue_continuation_needed",
      });
      if (continuationSweepDecision.kind !== "enqueue") {
        if (continuationSweepDecision.kind === "exhausted") {
          await postSweepContinuationExhaustedCommentOnce(issue, agentId, continuationSweepDecision.comment);
          result.continuationExhausted += 1;
        }
        result.skipped += 1;
        continue;
      }

      if (await isInvocationBudgetBlocked(issue, agentId)) {
        result.skipped += 1;
        continue;
      }

      const queued = await enqueueStrandedIssueRecovery({
        issueId: issue.id,
        agentId,
        reason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.continuation_recovery",
        retryOfRunId: latestRun?.id ?? issue.checkoutRunId ?? null,
        continuationAttempt: continuationSweepDecision.nextAttempt,
        maxContinuationAttempts: continuationSweepDecision.maxAttempts,
      });
      if (queued) {
        result.continuationRequeued += 1;
        result.issueIds.push(issue.id);
      } else {
        result.skipped += 1;
      }
    }

    const orphanBlockerRecovery = await reconcileUnassignedBlockingIssues();
    result.orphanBlockersAssigned = orphanBlockerRecovery.assigned;
    result.skipped += orphanBlockerRecovery.skipped;
    result.issueIds.push(...orphanBlockerRecovery.issueIds);

    return result;
  }

  async function collectIssueGraphLivenessFindings() {
    const issueRowsPromise = Promise.resolve(db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        projectId: issues.projectId,
        goalId: issues.goalId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdByAgentId: issues.createdByAgentId,
        createdByUserId: issues.createdByUserId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorAttemptCount: issues.monitorAttemptCount,
      })
      .from(issues)
      .where(
        and(
          isNull(issues.hiddenAt),
          notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
        ),
      ));

    const [
      issueRows,
      relationRows,
      agentRows,
      activeRunRows,
      activeIssueRunRows,
      wakeRows,
      interactionRows,
      approvalRows,
      recoveryIssueRows,
      recoveryActionRows,
    ] = await Promise.all([
      issueRowsPromise,
      db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(eq(issueRelations.type, "blocks")),
      db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          role: agents.role,
          title: agents.title,
          status: agents.status,
          reportsTo: agents.reportsTo,
        })
        .from(agents),
      db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES])),
      db
        .select({
          companyId: issues.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          issueId: issues.id,
        })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            isNull(issues.hiddenAt),
            notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        ),
      db
        .select({
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])),
      db
        .select({
          companyId: issueThreadInteractions.companyId,
          issueId: issueThreadInteractions.issueId,
          status: issueThreadInteractions.status,
        })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.status, "pending")),
      db
        .select({
          companyId: issueApprovals.companyId,
          issueId: issueApprovals.issueId,
          status: approvals.status,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(inArray(approvals.status, ["pending", "revision_requested"])),
      db
        .select({
          companyId: issues.companyId,
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originId: issues.originId,
        })
        .from(issues)
        .where(
          and(
            isNull(issues.hiddenAt),
            inArray(issues.originKind, [
              STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
              RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
            ]),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        ),
      issueRowsPromise.then((rows) => {
        const issueIdsUnderAnalysis = rows.map((row) => row.id);
        return issueIdsUnderAnalysis.length === 0
          ? []
          : db
            .select({
              companyId: issueRecoveryActions.companyId,
              issueId: issueRecoveryActions.sourceIssueId,
              status: issueRecoveryActions.status,
            })
            .from(issueRecoveryActions)
            .where(
              and(
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
                inArray(issueRecoveryActions.sourceIssueId, issueIdsUnderAnalysis),
              ),
            );
      }),
    ]);

    const openRecoveryIssues = recoveryIssueRows.flatMap((row) => {
      if (row.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) {
        const parsed = parseIssueGraphLivenessIncidentKey(row.originId);
        if (!parsed || parsed.companyId !== row.companyId) return [];
        if (parsed.state !== "blocked_by_assigned_backlog_issue") return [];
        return [
          {
            companyId: row.companyId,
            issueId: parsed.issueId,
            status: row.status,
          },
          {
            companyId: row.companyId,
            issueId: parsed.leafIssueId,
            status: row.status,
          },
        ];
      }

      const issueId = readNonEmptyString(row.originId);
      if (!issueId) return [];
      return [{
        companyId: row.companyId,
        issueId,
        status: row.status,
      }];
    });

    return classifyIssueGraphLiveness({
      issues: issueRows,
      relations: relationRows,
      agents: agentRows,
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromRunContext(row.contextSnapshot),
      })).concat(activeIssueRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: row.issueId,
      }))),
      queuedWakeRequests: wakeRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromWakePayload(row.payload),
      })),
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
      openRecoveryIssues: openRecoveryIssues.concat(recoveryActionRows),
      now: new Date(),
    });
  }

  async function findOpenLivenessEscalation(companyId: string, incidentKey: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originId, incidentKey),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findOpenLivenessRecoveryIssueForLeaf(finding: IssueLivenessFinding) {
    const byFingerprint = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originFingerprint, livenessRecoveryLeafFingerprint(finding)),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (byFingerprint) return byFingerprint;

    const leafIssueId = livenessRecoveryLeafIssueId(finding);
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    return openRecoveries.find((row) => {
      const parsed = parseLivenessIncidentKey(row.originId);
      return parsed?.state === finding.state && parsed.leafIssueId === leafIssueId;
    }) ?? null;
  }

  async function removeRecoveryBlockerFromSource(recovery: typeof issues.$inferSelect) {
    const parsed = parseLivenessIncidentKey(recovery.originId);
    if (!parsed) return false;
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, recovery.companyId), eq(issues.id, parsed.issueId)))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) return false;

    const blockerIds = await existingBlockerIssueIds(sourceIssue.companyId, sourceIssue.id);
    if (!blockerIds.includes(recovery.id)) return false;
    await issuesSvc.update(sourceIssue.id, {
      blockedByIssueIds: blockerIds.filter((blockerId) => blockerId !== recovery.id),
    });
    return true;
  }

  async function hasActiveRunForIssueId(companyId: string, issueId: string) {
    const [contextRun, issueRun] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
              OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId})`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.id, issueId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(contextRun || issueRun);
  }

  async function retireObsoleteLivenessRecoveryIssues(findings: IssueLivenessFinding[]) {
    const currentIncidentKeys = new Set(findings.map((finding) => finding.incidentKey));
    const currentLeafKeys = new Set(
      findings.map((finding) =>
        livenessRecoveryLeafKey(
          finding.companyId,
          finding.state,
          livenessRecoveryLeafIssueId(finding),
        ),
      ),
    );
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    const result = {
      retired: 0,
      activeSkipped: 0,
      blockerRelationsRemoved: 0,
      retiredIssueIds: [] as string[],
    };

    for (const recovery of openRecoveries) {
      if (recovery.originId && currentIncidentKeys.has(recovery.originId)) continue;
      const parsed = parseLivenessIncidentKey(recovery.originId);
      if (!parsed) continue;
      if (
        currentLeafKeys.has(
          livenessRecoveryLeafKey(parsed.companyId, parsed.state, parsed.leafIssueId),
        )
      ) {
        continue;
      }
      if (await removeRecoveryBlockerFromSource(recovery)) {
        result.blockerRelationsRemoved += 1;
      }
      if (await hasActiveRunForIssueId(recovery.companyId, recovery.id)) {
        result.activeSkipped += 1;
        continue;
      }
      await issuesSvc.update(recovery.id, { status: "cancelled" });
      result.retired += 1;
      result.retiredIssueIds.push(recovery.id);
    }

    return result;
  }

  function normalizeIssueGraphLivenessAutoRecoveryLookbackHours(raw: unknown) {
    const numeric = Math.floor(asNumber(raw, DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS));
    return Math.min(
      MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
      Math.max(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS, numeric),
    );
  }

  function livenessDependencyIssueKey(companyId: string, issueId: string) {
    return `${companyId}:${issueId}`;
  }

  async function loadLivenessDependencyUpdatedAtByIssue(findings: IssueLivenessFinding[]) {
    const issueIds = [
      ...new Set(
        findings.flatMap((finding) => finding.dependencyPath.map((entry) => entry.issueId)),
      ),
    ];
    if (issueIds.length === 0) return new Map<string, Date>();
    const rows = await db
      .select({ id: issues.id, companyId: issues.companyId, updatedAt: issues.updatedAt })
      .from(issues)
      .where(inArray(issues.id, issueIds));
    return new Map(rows.map((row) => [
      livenessDependencyIssueKey(row.companyId, row.id),
      row.updatedAt,
    ]));
  }

  function latestDependencyUpdatedAtForLivenessFinding(
    finding: IssueLivenessFinding,
    updatedAtByIssueKey: Map<string, Date>,
  ) {
    const dependencyIssueIds = [...new Set(finding.dependencyPath.map((entry) => entry.issueId))];
    if (dependencyIssueIds.length === 0) return null;
    const timestamps = dependencyIssueIds.map((issueId) =>
      updatedAtByIssueKey.get(livenessDependencyIssueKey(finding.companyId, issueId)) ?? null
    );
    if (timestamps.some((timestamp) => !timestamp)) return null;
    const [firstTimestamp, ...remainingTimestamps] = timestamps as Date[];
    return remainingTimestamps.reduce((latest, updatedAt) =>
      updatedAt > latest ? updatedAt : latest,
    firstTimestamp!);
  }

  function isLivenessFindingInsideAutoRecoveryLookback(
    finding: IssueLivenessFinding,
    cutoff: Date,
    updatedAtByIssueKey: Map<string, Date>,
  ) {
    const latestUpdatedAt = latestDependencyUpdatedAtForLivenessFinding(finding, updatedAtByIssueKey);
    return Boolean(latestUpdatedAt && latestUpdatedAt >= cutoff);
  }

  async function buildIssueGraphLivenessAutoRecoveryPreview(
    opts?: { lookbackHours?: number; now?: Date },
  ): Promise<IssueGraphLivenessAutoRecoveryPreview> {
    const now = opts?.now ?? new Date();
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(opts?.lookbackHours);
    const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const findings = await collectIssueGraphLivenessFindings();
    const updatedAtByIssueKey = await loadLivenessDependencyUpdatedAtByIssue(findings);
    const issueIds = [...new Set(findings.map((finding) => finding.recoveryIssueId))];
    const recoveryRows = issueIds.length > 0
      ? await db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(inArray(issues.id, issueIds))
      : [];
    const recoveryById = new Map(recoveryRows.map((row) => [row.id, row]));
    const items: IssueGraphLivenessAutoRecoveryPreviewItem[] = [];
    let skippedOutsideLookback = 0;

    for (const finding of findings) {
      const latestDependencyUpdatedAt = latestDependencyUpdatedAtForLivenessFinding(
        finding,
        updatedAtByIssueKey,
      );
      if (!latestDependencyUpdatedAt || latestDependencyUpdatedAt < cutoff) {
        skippedOutsideLookback += 1;
        continue;
      }
      const recoveryIssue = recoveryById.get(finding.recoveryIssueId);
      items.push({
        issueId: finding.issueId,
        identifier: finding.identifier,
        title: finding.dependencyPath[0]?.title ?? finding.identifier ?? finding.issueId,
        state: finding.state,
        severity: finding.severity,
        reason: finding.reason,
        recoveryIssueId: finding.recoveryIssueId,
        recoveryIdentifier: recoveryIssue?.identifier ?? null,
        recoveryTitle: recoveryIssue?.title ?? null,
        recommendedOwnerAgentId: finding.recommendedOwnerAgentId,
        incidentKey: finding.incidentKey,
        latestDependencyUpdatedAt: latestDependencyUpdatedAt.toISOString(),
        dependencyPath: finding.dependencyPath,
      });
    }

    return {
      lookbackHours,
      cutoff: cutoff.toISOString(),
      generatedAt: now.toISOString(),
      findings: findings.length,
      recoverableFindings: items.length,
      skippedOutsideLookback,
      items,
    };
  }

  async function resolveEscalationOwnerAgentId(
    finding: IssueLivenessFinding,
    issue: typeof issues.$inferSelect,
  ) {
    const detailedCandidates = finding.recommendedOwnerCandidates.length > 0
      ? finding.recommendedOwnerCandidates
      : finding.recommendedOwnerCandidateAgentIds.map((agentId) => ({
        agentId,
        reason: "ordered_invokable_fallback" as const,
        sourceIssueId: finding.recoveryIssueId,
      }));
    const seenCandidates = new Set<string>();
    const candidates = detailedCandidates.filter((candidate) => {
      if (seenCandidates.has(candidate.agentId)) return false;
      seenCandidates.add(candidate.agentId);
      return true;
    });
    const budgetBlockedCandidateAgentIds: string[] = [];

    for (const candidate of candidates) {
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.agentId, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (!budgetBlock) {
        return {
          agentId: candidate.agentId,
          reason: candidate.reason,
          sourceIssueId: candidate.sourceIssueId,
          candidateAgentIds: candidates.map((entry) => entry.agentId),
          candidateReasons: candidates.map((entry) => ({
            agentId: entry.agentId,
            reason: entry.reason,
            sourceIssueId: entry.sourceIssueId,
          })),
          budgetBlockedCandidateAgentIds,
        };
      }
      budgetBlockedCandidateAgentIds.push(candidate.agentId);
    }

    return null;
  }

  function shouldReuseRecoveryExecutionWorkspace(input: {
    finding: IssueLivenessFinding;
    recoveryIssue: typeof issues.$inferSelect;
    ownerAgentId: string;
  }) {
    if (input.finding.recoveryIssueId === input.finding.issueId) return false;
    return input.recoveryIssue.assigneeAgentId === input.ownerAgentId;
  }

  async function ensureIssueBlockedByEscalation(input: {
    issue: typeof issues.$inferSelect;
    escalationIssueId: string;
    finding: IssueLivenessFinding;
    runId?: string | null;
  }) {
    const blockerIds = await existingBlockerIssueIds(input.issue.companyId, input.issue.id);
    const nextBlockerIds = [...new Set([...blockerIds, input.escalationIssueId])];
    const isAlreadyBlockedByEscalation = blockerIds.includes(input.escalationIssueId);
    const isAlreadyBlocked = input.issue.status === "blocked";
    if (isAlreadyBlockedByEscalation && isAlreadyBlocked) {
      return input.issue;
    }

    const update: Partial<typeof issues.$inferInsert> & { blockedByIssueIds: string[] } = {
      blockedByIssueIds: nextBlockerIds,
    };
    if (!isAlreadyBlocked) {
      update.status = "blocked";
    }

    const updated = await issuesSvc.update(input.issue.id, update);
    if (!updated) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.runId ?? null,
      action: "issue.blockers.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        blockerIssueIds: nextBlockerIds,
        escalationIssueId: input.escalationIssueId,
        status: update.status ?? input.issue.status,
        previousStatus: input.issue.status,
      },
    });

    return updated;
  }

  async function createIssueGraphLivenessEscalation(input: {
    finding: IssueLivenessFinding;
    runId?: string | null;
  }) {
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.finding.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.companyId !== input.finding.companyId) return { kind: "skipped" as const };
    if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
      return { kind: "skipped" as const };
    }

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.finding.recoveryIssueId), eq(issues.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!recoveryIssue) return { kind: "skipped" as const };

    const existing =
      await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
      await findOpenLivenessRecoveryIssueForLeaf(input.finding);
    if (existing) {
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: existing.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationIssueId: existing.id };
    }

    const ownerSelection = await resolveEscalationOwnerAgentId(input.finding, recoveryIssue);
    if (!ownerSelection) return { kind: "skipped" as const };
    const reuseRecoveryExecutionWorkspace = shouldReuseRecoveryExecutionWorkspace({
      finding: input.finding,
      recoveryIssue,
      ownerAgentId: ownerSelection.agentId,
    });

    let escalation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      escalation = await issuesSvc.create(issue.companyId, {
        title: `Unblock liveness incident for ${recoveryIssue.identifier ?? recoveryIssue.title}`,
        description: buildLivenessEscalationDescription(input.finding),
        status: "todo",
        priority: "high",
        parentId: recoveryIssue.id,
        projectId: recoveryIssue.projectId,
        goalId: recoveryIssue.goalId,
        assigneeAgentId: ownerSelection.agentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides(),
        originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        originId: input.finding.incidentKey,
        originFingerprint: livenessRecoveryLeafFingerprint(input.finding),
        billingCode: recoveryIssue.billingCode,
        ...(reuseRecoveryExecutionWorkspace
          ? { inheritExecutionWorkspaceFromIssueId: recoveryIssue.id }
          : {
            executionWorkspaceId: null,
            executionWorkspacePreference: null,
            executionWorkspaceSettings: null,
          }),
      });
    } catch (error) {
      if (!isUniqueLivenessRecoveryConflict(error)) throw error;
      const raced =
        await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
        await findOpenLivenessRecoveryIssueForLeaf(input.finding);
      if (!raced) throw error;
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: raced.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationIssueId: raced.id };
    }

    await ensureIssueBlockedByEscalation({
      issue,
      escalationIssueId: escalation.id,
      finding: input.finding,
      runId: input.runId ?? null,
    });

    await issuesSvc.addComment(
      issue.id,
      buildLivenessOriginalIssueComment(input.finding, escalation),
      { runId: input.runId ?? null },
    );

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerSelection.agentId,
      runId: input.runId ?? null,
      action: "issue.harness_liveness_escalation_created",
      entityType: "issue",
      entityId: escalation.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        sourceIssueId: issue.id,
        sourceIdentifier: issue.identifier,
        recoveryIssueId: recoveryIssue.id,
        recoveryIdentifier: recoveryIssue.identifier,
        escalationIssueId: escalation.id,
        escalationIdentifier: escalation.identifier,
        dependencyPath: input.finding.dependencyPath,
        ownerSelection: {
          selectedAgentId: ownerSelection.agentId,
          selectedReason: ownerSelection.reason,
          selectedSourceIssueId: ownerSelection.sourceIssueId,
          candidateAgentIds: ownerSelection.candidateAgentIds,
          candidateReasons: ownerSelection.candidateReasons,
          budgetBlockedCandidateAgentIds: ownerSelection.budgetBlockedCandidateAgentIds,
        },
        workspaceSelection: {
          reuseRecoveryExecutionWorkspace,
          inheritedExecutionWorkspaceFromIssueId: reuseRecoveryExecutionWorkspace ? recoveryIssue.id : null,
          projectWorkspaceSourceIssueId: recoveryIssue.id,
        },
      },
    });

    const wake = await deps.enqueueWakeup(ownerSelection.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: escalation.id,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: escalation.id,
        taskId: escalation.id,
        wakeReason: "issue_assigned",
        source: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }),
    });

    logger.warn({
      incidentKey: input.finding.incidentKey,
      findingState: input.finding.state,
      sourceIssueId: issue.id,
      recoveryIssueId: recoveryIssue.id,
      escalationIssueId: escalation.id,
      ownerAgentId: ownerSelection.agentId,
      ownerSelectionReason: ownerSelection.reason,
      wakeupRunId: wake?.id ?? null,
    }, "created issue graph liveness escalation");

    return { kind: "created" as const, escalationIssueId: escalation.id };
  }

  async function reconcileIssueGraphLiveness(opts?: {
    runId?: string | null;
    force?: boolean;
    lookbackHours?: number;
  }) {
    const findings = await collectIssueGraphLivenessFindings();
    const experimentalSettings = await instanceSettings.getExperimental();
    const autoRecoveryEnabled = asBoolean(
      experimentalSettings.enableIssueGraphLivenessAutoRecovery,
      true,
    ) || opts?.force === true;
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(
      opts?.lookbackHours ?? experimentalSettings.issueGraphLivenessAutoRecoveryLookbackHours,
    );
    const now = new Date();
    const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const obsoleteRecoveryCleanup = await retireObsoleteLivenessRecoveryIssues(findings);
    const updatedAtByIssueKey = await loadLivenessDependencyUpdatedAtByIssue(findings);
    const result = {
      findings: findings.length,
      autoRecoveryEnabled,
      lookbackHours,
      cutoff: cutoff.toISOString(),
      escalationsCreated: 0,
      existingEscalations: 0,
      skipped: 0,
      skippedAutoRecoveryDisabled: 0,
      skippedOutsideLookback: 0,
      obsoleteRecoveriesRetired: obsoleteRecoveryCleanup.retired,
      obsoleteRecoveriesActiveSkipped: obsoleteRecoveryCleanup.activeSkipped,
      obsoleteRecoveryBlockerRelationsRemoved: obsoleteRecoveryCleanup.blockerRelationsRemoved,
      issueIds: [] as string[],
      escalationIssueIds: [] as string[],
      retiredRecoveryIssueIds: obsoleteRecoveryCleanup.retiredIssueIds,
    };

    if (!autoRecoveryEnabled) {
      result.skippedAutoRecoveryDisabled = findings.length;
      return result;
    }

    for (const finding of findings) {
      if (!isLivenessFindingInsideAutoRecoveryLookback(finding, cutoff, updatedAtByIssueKey)) {
        result.skippedOutsideLookback += 1;
        result.skipped += 1;
        continue;
      }
      const escalation = await createIssueGraphLivenessEscalation({
        finding,
        runId: opts?.runId ?? null,
      });
      if (escalation.kind === "created") {
        result.escalationsCreated += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else if (escalation.kind === "existing") {
        result.existingEscalations += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else {
        result.skipped += 1;
      }
    }

    return result;
  }

  function readRecoveryTimerIntervalMs(raw: unknown, fallback: number) {
    return Math.max(1, Math.floor(asNumber(raw, fallback)));
  }

  return {
    buildRunOutputSilence,
    escalateStrandedRecoveryIssueInPlace,
    escalateStrandedAssignedIssue,
    detectAgentCompletedWithZeroWrites,
    resolveWriteToolingFailureOwnerAgentId,
    escalateWriteToolingFailure,
    recordWatchdogDecision,
    scanSilentActiveRuns,
    reconcileStrandedAssignedIssues,
    buildIssueGraphLivenessAutoRecoveryPreview,
    reconcileIssueGraphLiveness,
    readRecoveryTimerIntervalMs,
  };
}
