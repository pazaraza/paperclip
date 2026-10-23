import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
  DEFAULT_MAX_SWEEP_CONTINUATION_ATTEMPTS,
  RUN_LIVENESS_CONTINUATION_REASON,
  SWEEP_CONTINUATION_EXHAUSTED_COMMENT_PREFIX,
  buildRunLivenessContinuationIdempotencyKey,
  decideRunLivenessContinuation,
  decideSweepContinuation,
  readSweepContinuationAttempt,
} from "../services/run-continuations.ts";

const companyId = "company-1";
const agentId = "agent-1";
const issueId = "issue-1";
const runId = "run-1";

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    companyId,
    agentId,
    continuationAttempt: 0,
    ...overrides,
  } as never;
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    identifier: "PAP-1577",
    title: "Add bounded liveness continuation wakes",
    status: "in_progress",
    assigneeAgentId: agentId,
    executionState: null,
    projectId: null,
    ...overrides,
  } as never;
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId,
    status: "idle",
    ...overrides,
  } as never;
}

describe("run liveness continuations", () => {
  it("enqueues the first plan_only continuation for the same issue and assignee", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Planned without acting",
      nextAction: "Take the first concrete action now.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(1);
    expect(decision.idempotencyKey).toBe(
      buildRunLivenessContinuationIdempotencyKey({
        issueId,
        sourceRunId: runId,
        livenessState: "plan_only",
        nextAttempt: 1,
      }),
    );
    expect(decision.payload).toMatchObject({
      issueId,
      sourceRunId: runId,
      livenessState: "plan_only",
      livenessReason: "Planned without acting",
      continuationAttempt: 1,
      maxContinuationAttempts: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
      instruction: "Take the first concrete action now.",
      modelProfile: "cheap",
    });
    expect(decision.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: RUN_LIVENESS_CONTINUATION_REASON,
      modelProfile: "cheap",
      livenessContinuationAttempt: 1,
      livenessContinuationMaxAttempts: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
      livenessContinuationSourceRunId: runId,
      livenessContinuationState: "plan_only",
      livenessContinuationReason: "Planned without acting",
      livenessContinuationInstruction: "Take the first concrete action now.",
    });
  });

  it("enqueues the second empty_response continuation", () => {
    const decision = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 1 }),
      issue: issue(),
      agent: agent(),
      livenessState: "empty_response",
      livenessReason: "No useful output",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(2);
  });

  it("leaves advanced terminal runs to stranded issue recovery instead of bounded liveness continuation", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: created an issue comment",
      nextAction: "Resume the implementation from the remaining acceptance criteria.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision).toEqual({
      kind: "skip",
      reason: "liveness state is not actionable for continuation",
    });
  });

  it("does not enqueue a third continuation and returns an exhaustion comment", () => {
    const decision = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 2 }),
      issue: issue(),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Still planning",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("exhausted");
    if (decision.kind !== "exhausted") return;
    expect(decision.comment).toContain("Bounded liveness continuation exhausted");
    expect(decision.comment).toContain("Attempts used: 2/2");
  });

  it("skips non-actionable and guarded issues", () => {
    const guardedCases = [
      { livenessState: "advanced" as const },
      { issue: issue({ status: "done" }) },
      { issue: issue({ assigneeAgentId: "other-agent" }) },
      { issue: issue({ executionState: { status: "pending" } }) },
      { agent: agent({ status: "paused" }) },
      { budgetBlocked: true },
      { idempotentWakeExists: true },
    ];

    for (const guarded of guardedCases) {
      const decision = decideRunLivenessContinuation({
        run: run(),
        issue: guarded.issue ?? issue(),
        agent: guarded.agent ?? agent(),
        livenessState: guarded.livenessState ?? "plan_only",
        livenessReason: "No progress",
        nextAction: null,
        budgetBlocked: guarded.budgetBlocked ?? false,
        idempotentWakeExists: guarded.idempotentWakeExists ?? false,
      });

      expect(decision.kind).toBe("skip");
    }
  });
});

// RUAAAAA-5326 — the periodic recovery sweep in `recovery/service.ts` is a
// third re-enqueue path, outside both ladders above. It carries the same
// `continuationAttempt` number so all three bounds read one counter.
describe("sweep continuation budget (RUAAAAA-5326)", () => {
  it("reads the sweep budget out of the run contextSnapshot and nothing else", () => {
    expect(readSweepContinuationAttempt({ sweepContinuationAttempt: 2 })).toBe(2);
    // The liveness ladder's counter must not be mistaken for the sweep's.
    expect(readSweepContinuationAttempt({ continuationAttempt: 2 })).toBe(0);
    expect(readSweepContinuationAttempt({ livenessContinuationAttempt: 2 })).toBe(0);
    expect(readSweepContinuationAttempt({})).toBe(0);
    expect(readSweepContinuationAttempt(null)).toBe(0);
    expect(readSweepContinuationAttempt({ sweepContinuationAttempt: "3" })).toBe(3);
  });
  it("enqueues the first sweep re-enqueue and carries attempt 1 forward", () => {
    const decision = decideSweepContinuation({
      sourceRunAttempt: 0,
      retryReason: "issue_continuation_needed",
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(1);
    expect(decision.maxAttempts).toBe(DEFAULT_MAX_SWEEP_CONTINUATION_ATTEMPTS);
  });

  it("treats a missing or unparseable source attempt as the first attempt, not as a spent budget", () => {
    for (const sourceRunAttempt of [undefined, null, "", "not-a-number", 0, -3]) {
      const decision = decideSweepContinuation({
        sourceRunAttempt,
        retryReason: "issue_continuation_needed",
      });
      expect(decision.kind).toBe("enqueue");
    }
  });

  it("exhausts with a human-handoff comment once the budget is spent", () => {
    const decision = decideSweepContinuation({
      sourceRunAttempt: DEFAULT_MAX_SWEEP_CONTINUATION_ATTEMPTS,
      retryReason: "issue_continuation_needed",
    });

    expect(decision.kind).toBe("exhausted");
    if (decision.kind !== "exhausted") return;
    expect(decision.attempt).toBe(DEFAULT_MAX_SWEEP_CONTINUATION_ATTEMPTS);
    expect(decision.maxAttempts).toBe(DEFAULT_MAX_SWEEP_CONTINUATION_ATTEMPTS);
    expect(decision.comment.startsWith(SWEEP_CONTINUATION_EXHAUSTED_COMMENT_PREFIX)).toBe(true);
    expect(decision.comment).toContain(`1/${DEFAULT_MAX_SWEEP_CONTINUATION_ATTEMPTS}`);
    expect(decision.comment).toContain("issue_continuation_needed");
    expect(decision.comment).toMatch(/human|manager/i);
  });

  it("keeps enqueueing below an explicitly raised budget", () => {
    const decision = decideSweepContinuation({
      sourceRunAttempt: 1,
      retryReason: "issue_continuation_needed",
      maxAttempts: 3,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(2);
    expect(decision.maxAttempts).toBe(3);
  });
});
