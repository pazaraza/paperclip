import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentRuntimeState, agents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

/**
 * Recognise a Postgres unique-constraint failure on
 * issues_open_routine_execution_uq. This is contention: an open issue with
 * the same (company_id, origin_kind='routine_execution', origin_id) tuple
 * already exists, so the new INSERT/UPDATE cannot claim the slot. The
 * assignee is NOT at fault — it is a legitimate "another issue is already
 * being executed for this routine" outcome. See RUAAAAA-5205.
 *
 * Two shapes are accepted, checked in order:
 *   1. top-level `code` + `constraint` (direct driver throw, Drizzle).
 *   2. `postgresCode` + `postgresConstraint` (RUAAAAA-5209) — the pair after
 *      the OpenClaw gateway adapter promoted it out of the JSON-RPC error
 *      frame's `details`, where a top-level lookup would miss it.
 */
export function isRoutineExecutionOpenConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as {
    code?: unknown;
    constraint?: unknown;
    postgresCode?: unknown;
    postgresConstraint?: unknown;
  };
  if (err.code === "23505" && err.constraint === "issues_open_routine_execution_uq") {
    return true;
  }
  return (
    err.postgresCode === "23505" &&
    err.postgresConstraint === "issues_open_routine_execution_uq"
  );
}

/**
 * Persist the most recent wake attempt into agent_runtime_state so the
 * fleet-health watch (paperclip-agent-fleet-health.sh) can detect
 * assignment-wake contention that left the last_run path clean. Distinct
 * from lastError which is reserved for run-time failures.
 *
 * Looks up company_id + adapter_type from `agents` on demand; the existing
 * agent_runtime_state row is updated if present, otherwise a new row is
 * inserted. Idempotent. Failures are swallowed (best-effort) so they
 * cannot mask the original wakeup error or bubble out of the catch arm.
 */
export async function recordAgentWakeAttempt(input: {
  db: Db;
  agentId: string;
  errorMessage: string | null;
}): Promise<void> {
  const now = new Date();
  try {
    const agentRow = await input.db
      .select({ companyId: agents.companyId, adapterType: agents.adapterType })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .then((rows) => rows[0] ?? null);
    if (!agentRow) {
      // Agent may have been deleted; nothing to record.
      return;
    }
    await input.db
      .insert(agentRuntimeState)
      .values({
        agentId: input.agentId,
        companyId: agentRow.companyId,
        adapterType: agentRow.adapterType,
        stateJson: {},
        lastWakeError: input.errorMessage,
        lastWakeAttemptedAt: now,
      })
      .onConflictDoUpdate({
        target: agentRuntimeState.agentId,
        set: {
          lastWakeError: input.errorMessage,
          lastWakeAttemptedAt: now,
          updatedAt: now,
        },
      });
  } catch (err) {
    logger.warn(
      { err, agentId: input.agentId },
      "failed to record agent wake attempt (best-effort)",
    );
  }
}

export interface QueueIssueAssignmentWakeupInput {
  heartbeat: IssueAssignmentWakeupDeps;
  /**
   * Optional handle for recording wake-attempt outcomes. When the wakeup
   * rejection is a unique-constraint contention on
   * issues_open_routine_execution_uq we downgrade the log line from warn
   * to info and persist `last_wake_error` on agent_runtime_state so the
   * fleet-health watch can act on it. Without this handle, behaviour
   * matches the prior warn-only path. See RUAAAAA-5205.
   */
  wakeRecorder?: {
    db: Db;
  };
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}

export function queueIssueAssignmentWakeup(input: QueueIssueAssignmentWakeupInput) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;
  const assigneeAgentId = input.issue.assigneeAgentId;

  return input.heartbeat
    .wakeup(assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource },
    })
    .catch(async (err) => {
      const openExecutionConflict = isRoutineExecutionOpenConflict(err);
      const recorder = input.wakeRecorder;
      if (recorder) {
        if (openExecutionConflict) {
          // Contention is not a fault. Log at info and record the wake
          // attempt on agent_runtime_state so the watch can clear the
          // agent out of status='error' if downstream logic pinned it.
          logger.info(
            { err, issueId: input.issue.id, agentId: assigneeAgentId },
            "skipped wake: open routine execution already exists for this routine",
          );
          await recordAgentWakeAttempt({
            db: recorder.db,
            agentId: assigneeAgentId,
            errorMessage:
              "issues_open_routine_execution_uq: another open execution already holds the routine lock",
          });
          if (input.rethrowOnError) throw err;
          return null;
        }
        await recordAgentWakeAttempt({
          db: recorder.db,
          agentId: assigneeAgentId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      logger.warn(
        { err, issueId: input.issue.id },
        "failed to wake assignee on issue assignment",
      );
      if (input.rethrowOnError) throw err;
      return null;
    });
}
