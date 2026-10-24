import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issues } from "@paperclipai/db";
import type { RunLivenessState } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { withRecoveryContext } from "./status-only-context.js";
import { RECOVERY_REASON_KINDS } from "./origins.js";

export const RUN_LIVENESS_CONTINUATION_REASON = RECOVERY_REASON_KINDS.runLivenessContinuation;
export const DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS = 2;

const ACTIONABLE_LIVENESS_STATES = new Set<RunLivenessState>(["plan_only", "empty_response"]);
const CONTINUATION_ACTIVE_ISSUE_STATUSES = new Set(["todo", "in_progress"]);
// A prior adapter error should not permanently suppress bounded liveness
// continuations; the max-attempt/idempotency guards prevent unbounded retries.
const CONTINUATION_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);
const IDEMPOTENT_WAKE_STATUSES = ["queued", "deferred_issue_execution", "completed"];

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type IssueRow = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "identifier" | "title" | "status" | "assigneeAgentId" | "executionState" | "projectId"
>;
type AgentRow = Pick<typeof agents.$inferSelect, "id" | "companyId" | "status">;

// RUAAAAA-5326 — the periodic recovery sweep in `recovery/service.ts` is a
// THIRD re-enqueue path. It is not the comment ladder (hard-bounded to 1 in
// `heartbeat.ts`) and not the liveness continuation ladder above (bounded by
// `DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS`). It used to carry no attempt
// budget at all, so the top of the retry ladder was re-seeded on every sweep
// interval for any issue that stayed `in_progress` while its runs ended
// without a terminal disposition.
//
// The counter lives in the run's `contextSnapshot`, NOT in the
// `heartbeatRuns.continuationAttempt` column. RUAAAAA-5326 originally proposed
// reusing that column; doing so demonstrably steals budget from the liveness
// ladder above, because `decideRunLivenessContinuation` reads the same column
// off whatever run it is finalising. A sweep-seeded run written with
// `continuationAttempt: 1` arrives at that ladder with one of its two attempts
// already spent. That is visible as
// `heartbeat-process-recovery.test.ts > "classifies actionable plan-only
// recovery and enqueues one liveness continuation"` flipping from
// `continuationAttempt: 1` to `2`. A separate snapshot key keeps both budgets
// intact and needs no migration.
export const DEFAULT_MAX_SWEEP_CONTINUATION_ATTEMPTS = 1;
export const SWEEP_CONTINUATION_ATTEMPT_SNAPSHOT_KEY = "sweepContinuationAttempt";
export const SWEEP_CONTINUATION_EXHAUSTED_COMMENT_PREFIX =
  "Bounded sweep continuation exhausted";

export type SweepContinuationDecision =
  | {
      kind: "enqueue";
      nextAttempt: number;
      maxAttempts: number;
    }
  | {
      kind: "exhausted";
      attempt: number;
      maxAttempts: number;
      comment: string;
    }
  | {
      kind: "skip";
      reason: string;
    };

export type RunContinuationDecision =
  | {
      kind: "enqueue";
      nextAttempt: number;
      idempotencyKey: string;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    }
  | {
      kind: "exhausted";
      attempt: number;
      maxAttempts: number;
      comment: string;
    }
  | {
      kind: "skip";
      reason: string;
    };

export function readContinuationAttempt(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

export function buildRunLivenessContinuationIdempotencyKey(input: {
  issueId: string;
  sourceRunId: string;
  livenessState: RunLivenessState;
  nextAttempt: number;
}) {
  return [
    RUN_LIVENESS_CONTINUATION_REASON,
    input.issueId,
    input.sourceRunId,
    input.livenessState,
    String(input.nextAttempt),
  ].join(":");
}


export function readSweepContinuationAttempt(contextSnapshot: unknown): number {
  const context = parseObject(contextSnapshot);
  return readContinuationAttempt(context[SWEEP_CONTINUATION_ATTEMPT_SNAPSHOT_KEY]);
}

export function buildSweepContinuationExhaustedComment(input: {
  retryReason: string;
  attempt: number;
  maxAttempts: number;
}) {
  return [
    SWEEP_CONTINUATION_EXHAUSTED_COMMENT_PREFIX,
    "",
    `- Retry reason: \`${input.retryReason}\``,
    `- Sweep re-enqueues used: ${input.attempt}/${input.maxAttempts}`,
    "- The periodic recovery sweep stopped re-enqueueing this issue: its runs keep ending without a terminal disposition, so every sweep pass would otherwise re-seed the top of the retry ladder.",
    "- Next action: a human or manager should inspect the runs, then either mark the issue blocked, assign a concrete follow-up, or close it.",
  ].join("\n");
}

/**
 * RUAAAAA-5326. Decides whether the periodic recovery sweep may re-enqueue a
 * continuation wake for an issue whose latest run left it `in_progress` with
 * no live execution path.
 *
 * The sweep is the last rung: both bounded ladders have already run by the
 * time it fires, so its budget is deliberately small — one re-enqueue, then a
 * human handoff. `sourceRunAttempt` is
 * `contextSnapshot.sweepContinuationAttempt` of the run the sweep would chain
 * from; the caller threads `nextAttempt` forward onto the seeded run's
 * `contextSnapshot`, which is where the next pass reads it back.
 *
 * Scope note: `didAutomaticRecoveryFail` and
 * `isRepeatedProductiveContinuationRecovery` already bound the *direct*
 * sweep-seeded loop, because a sweep-seeded run either fails terminally (first
 * guard) or keeps the productive `source` label (second guard). What neither
 * guard covers is a run seeded by one sweep site and re-seeded by the other —
 * `isRepeatedProductiveContinuationRecovery` string-matches
 * `issue.productive_terminal_continuation_recovery`, so a run seeded as
 * `issue.continuation_recovery` that then succeeds productively passes straight
 * through it and re-enters the ladder. The attempt budget is what cuts that
 * crossing, and it makes the bound explicit instead of emergent from a string
 * comparison.
 *
 * Known remaining gap: the counter lives on the run the sweep chains from, so
 * an unrelated wake landing between two sweeps (e.g. `issue_children_completed`
 * or `source_scoped_recovery_action`) resets it to 0 and buys one more
 * re-enqueue. That is a strictly smaller loop than the one this closes — it is
 * bounded by foreign wakes rather than by the sweep interval — and closing it
 * needs a per-issue chain record rather than a per-run snapshot key.
 */
export function decideSweepContinuation(input: {
  sourceRunAttempt: unknown;
  retryReason: string;
  maxAttempts?: number;
}): SweepContinuationDecision {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_SWEEP_CONTINUATION_ATTEMPTS;
  const attempt = readContinuationAttempt(input.sourceRunAttempt);
  if (attempt >= maxAttempts) {
    return {
      kind: "exhausted",
      attempt,
      maxAttempts,
      comment: buildSweepContinuationExhaustedComment({
        retryReason: input.retryReason,
        attempt,
        maxAttempts,
      }),
    };
  }
  return { kind: "enqueue", nextAttempt: attempt + 1, maxAttempts };
}

export async function findExistingRunLivenessContinuationWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, IDEMPOTENT_WAKE_STATUSES),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export function decideRunLivenessContinuation(input: {
  run: HeartbeatRunRow;
  issue: IssueRow | null;
  agent: AgentRow | null;
  livenessState: RunLivenessState | null;
  livenessReason: string | null;
  nextAction: string | null;
  budgetBlocked: boolean;
  idempotentWakeExists: boolean;
  maxAttempts?: number;
}): RunContinuationDecision {
  const {
    run,
    issue,
    agent,
    livenessState,
    livenessReason,
    nextAction,
    budgetBlocked,
    idempotentWakeExists,
  } = input;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS;

  if (!livenessState || !ACTIONABLE_LIVENESS_STATES.has(livenessState)) {
    return { kind: "skip", reason: "liveness state is not actionable for continuation" };
  }
  if (!issue) return { kind: "skip", reason: "issue not found" };
  if (!agent) return { kind: "skip", reason: "agent not found" };
  if (issue.companyId !== run.companyId || agent.companyId !== run.companyId) {
    return { kind: "skip", reason: "company scope mismatch" };
  }
  if (issue.assigneeAgentId !== run.agentId) {
    return { kind: "skip", reason: "issue is no longer assigned to the source run agent" };
  }
  if (!CONTINUATION_ACTIVE_ISSUE_STATUSES.has(issue.status)) {
    return { kind: "skip", reason: `issue status ${issue.status} is not continuable` };
  }
  if (issue.executionState) {
    return { kind: "skip", reason: "issue is blocked by execution policy state" };
  }
  if (!CONTINUATION_AGENT_STATUSES.has(agent.status)) {
    return { kind: "skip", reason: `agent status ${agent.status} is not invokable` };
  }
  if (budgetBlocked) {
    return { kind: "skip", reason: "budget hard stop blocks continuation" };
  }
  const currentAttempt = readContinuationAttempt(run.continuationAttempt);
  if (currentAttempt >= maxAttempts) {
    return {
      kind: "exhausted",
      attempt: currentAttempt,
      maxAttempts,
      comment: [
        "Bounded liveness continuation exhausted",
        "",
        `- Last liveness state: \`${livenessState}\``,
        `- Attempts used: ${currentAttempt}/${maxAttempts}`,
        `- Reason: ${livenessReason ?? "Run ended without concrete progress"}`,
        "- Next action: a human or manager should inspect the run and either clarify the task, mark it blocked, or assign a concrete follow-up.",
      ].join("\n"),
    };
  }

  const nextAttempt = currentAttempt + 1;
  const idempotencyKey = buildRunLivenessContinuationIdempotencyKey({
    issueId: issue.id,
    sourceRunId: run.id,
    livenessState,
    nextAttempt,
  });
  if (idempotentWakeExists) {
    return { kind: "skip", reason: "continuation wake already exists for this source run and attempt" };
  }

  const payload = withRecoveryContext({
    issueId: issue.id,
    sourceRunId: run.id,
    livenessState,
    livenessReason,
    continuationAttempt: nextAttempt,
    maxContinuationAttempts: maxAttempts,
    instruction:
      nextAction ??
      "The previous run ended without concrete progress. Take the first concrete action now or mark the issue blocked with a specific unblock request.",
  }, "normal_model");

  return {
    kind: "enqueue",
    nextAttempt,
    idempotencyKey,
    payload,
    contextSnapshot: withRecoveryContext({
      issueId: issue.id,
      taskId: issue.id,
      taskKey: issue.id,
      wakeReason: RUN_LIVENESS_CONTINUATION_REASON,
      livenessContinuationAttempt: nextAttempt,
      livenessContinuationMaxAttempts: maxAttempts,
      livenessContinuationSourceRunId: run.id,
      livenessContinuationState: livenessState,
      livenessContinuationReason: livenessReason,
      livenessContinuationInstruction: payload.instruction,
    }, "normal_model"),
  };
}
