import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentRuntimeState,
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  isRoutineExecutionOpenConflict,
  queueIssueAssignmentWakeup,
  recordAgentWakeAttempt,
} from "../services/issue-assignment-wakeup.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";
import { logger } from "../middleware/logger.ts";

function uniqueCompanySlug(label: string) {
  return `${label}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

describe("issue-assignment-wakeup conflict handling (RUAAAAA-5205)", () => {
  let dbInstance: Awaited<ReturnType<typeof createDb>> | null = null;
  let stop: (() => Promise<void>) | null = null;
  let companyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-issue-assignment-wake-conflict-");
    dbInstance = createDb(started.connectionString);
    stop = started.stop;

    const companySlug = uniqueCompanySlug("ruai-wake-conflict");
    const inserted = await dbInstance
      .insert(companies)
      .values({
        name: `Ruai Wake Conflict ${companySlug}`,
        slug: companySlug,
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]!);
    companyId = inserted.id;

    const agent = await dbInstance
      .insert(agents)
      .values({
        companyId,
        name: `Wake Conflict Agent ${companySlug}`,
        role: "general",
        adapterType: "openclaw_gateway",
        status: "idle",
      })
      .returning()
      .then((rows) => rows[0]!);
    agentId = agent.id;

    const issue = await dbInstance
      .insert(issues)
      .values({
        companyId,
        title: "Wake conflict fixture",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByUserId: "test-fixture",
      })
      .returning()
      .then((rows) => rows[0]!);
    issueId = issue.id;
  }, 60_000);

  afterAll(async () => {
    await stop?.();
  });

  it("identifies the issues_open_routine_execution_uq constraint as a non-fatal contention", () => {
    expect(isRoutineExecutionOpenConflict(null)).toBe(false);
    expect(isRoutineExecutionOpenConflict(new Error("plain"))).toBe(false);
    expect(
      isRoutineExecutionOpenConflict({
        code: "23505",
        constraint: "some_other_constraint",
        message: "x",
      }),
    ).toBe(false);
    expect(
      isRoutineExecutionOpenConflict({
        code: "23505",
        constraint: "issues_open_routine_execution_uq",
        message: "duplicate key value violates unique constraint",
      }),
    ).toBe(true);
  });

  it("recognises the gateway-surfaced postgresCode/postgresConstraint pair (RUAAAAA-5209)", () => {
    // Shape produced by the OpenClaw gateway adapter after handleMessage
    // promotes the pair out of the JSON-RPC error frame's `details`.
    expect(
      isRoutineExecutionOpenConflict({
        message: "duplicate key value violates unique constraint",
        gatewayCode: "unique_violation",
        postgresCode: "23505",
        postgresConstraint: "issues_open_routine_execution_uq",
      }),
    ).toBe(true);

    // Wrong constraint on the prefixed pair must not match.
    expect(
      isRoutineExecutionOpenConflict({
        postgresCode: "23505",
        postgresConstraint: "agents_company_id_name_key",
      }),
    ).toBe(false);

    // Half-populated pair must not match.
    expect(isRoutineExecutionOpenConflict({ postgresCode: "23505" })).toBe(false);
    expect(
      isRoutineExecutionOpenConflict({
        postgresConstraint: "issues_open_routine_execution_uq",
      }),
    ).toBe(false);

    // Mismatched halves from two different errors must not match.
    expect(
      isRoutineExecutionOpenConflict({
        postgresCode: "23503",
        postgresConstraint: "issues_open_routine_execution_uq",
      }),
    ).toBe(false);
  });

  it("persists a wake attempt without pinning the agent to status='error'", async () => {
    // Simulate the server-side wakeup rejecting with the
    // issues_open_routine_execution_uq unique-constraint failure.
    const wakeupCalls: Array<{ agentId: string }> = [];
    const heartbeatMock = {
      wakeup: async (agentIdArg: string) => {
        wakeupCalls.push({ agentId: agentIdArg });
        const err: Error & { code?: string; constraint?: string } = new Error(
          "duplicate key value violates unique constraint \"issues_open_routine_execution_uq\"",
        );
        err.code = "23505";
        err.constraint = "issues_open_routine_execution_uq";
        throw err;
      },
    };

    const result = await queueIssueAssignmentWakeup({
      heartbeat: heartbeatMock,
      wakeRecorder: { db: dbInstance! },
      issue: {
        id: issueId,
        assigneeAgentId: agentId,
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
      // rethrowOnError omitted so the helper resolves null on the
      // contenting-path rejection rather than re-throwing.
    });

    expect(result).toBeNull();
    expect(wakeupCalls).toEqual([{ agentId }]);

    // The agent must not have been auto-pinned to status='error'.
    const agentRow = await dbInstance!
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(agentRow.status).toBe("idle");

    // The wake attempt MUST land in agent_runtime_state.last_wake_error.
    const stateRow = await dbInstance!
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(stateRow).not.toBeNull();
    expect(stateRow!.lastWakeError).toMatch(
      /issues_open_routine_execution_uq/,
    );
    expect(stateRow!.lastWakeAttemptedAt).toBeInstanceOf(Date);
  });

  it("records non-contention wake errors verbatim for the watch to pick up", async () => {
    const heartbeatMock = {
      wakeup: async () => {
        throw new Error("adapter offline");
      },
    };

    await queueIssueAssignmentWakeup({
      heartbeat: heartbeatMock,
      wakeRecorder: { db: dbInstance! },
      issue: {
        id: issueId,
        assigneeAgentId: agentId,
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
    });

    const stateRow = await dbInstance!
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(stateRow).not.toBeNull();
    expect(stateRow!.lastWakeError).toBe("adapter offline");
  });

  it("best-effort: recordAgentWakeAttempt swallows failures and never throws", async () => {
    // Use a non-existent agent id; the helper resolves company + adapter_type
    // by looking up agents and silently returns if the agent is gone.
    const unknownAgentId = "00000000-0000-0000-0000-000000000000";
    await expect(
      recordAgentWakeAttempt({
        db: dbInstance!,
        agentId: unknownAgentId,
        errorMessage: "should not throw",
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing for issues with no assignee or in backlog", async () => {
    const wakeupCalls: Array<{ agentId: string }> = [];
    const heartbeatMock = {
      wakeup: async (agentIdArg: string) => {
        wakeupCalls.push({ agentId: agentIdArg });
        throw new Error("should not be called");
      },
    };
    await queueIssueAssignmentWakeup({
      heartbeat: heartbeatMock,
      wakeRecorder: { db: dbInstance! },
      issue: {
        id: issueId,
        assigneeAgentId: null,
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
    });
    await queueIssueAssignmentWakeup({
      heartbeat: heartbeatMock,
      wakeRecorder: { db: dbInstance! },
      issue: {
        id: issueId,
        assigneeAgentId: agentId,
        status: "backlog",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
    });
    expect(wakeupCalls).toHaveLength(0);
  });
});
