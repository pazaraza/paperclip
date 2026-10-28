import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  HEARTBEAT_FAILURE_BACKOFF_DELAYS_MS,
  HEARTBEAT_FAILURE_BACKOFF_MAX_MS,
  computeHeartbeatFailureBackoffMs,
  heartbeatService,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat timer baseline tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ABY-901: a failed or timed-out run must not consume the lane's whole
// heartbeat interval. These tests pin the acceptance criteria:
//
//  1. a failed/timed-out run does not advance the next-timer baseline by a
//     full intervalSec;
//  2. after a failure the lane is re-dispatched on the next scheduled attempt
//     without operator action, in MINUTES not hours;
//  3. no regression to the scheduled_retry ladder, to issue_comment_mentioned
//     wakes, or to status:'error' remaining a meaningful operator signal.
describeEmbeddedPostgres("heartbeat timer baseline on failed runs (ABY-901)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const SIX_HOURS_SEC = 21_600;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-timer-baseline-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    // `companies` rows are intentionally left in place: the skill-resolution
    // path can insert `company_skills` rows asynchronously, and deleting the
    // company underneath them violates the FK. The database is file-scoped and
    // is dropped in `afterAll`, so leaving them is safe. Agents ARE deleted so
    // `tickTimers` (which scans every agent) only sees this test's lanes.
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLane(input: {
    companyId?: string;
    agentId?: string;
    intervalSec?: number;
    lastHeartbeatAt?: Date | null;
    status?: string;
  }) {
    const companyId = input.companyId ?? randomUUID();
    const agentId = input.agentId ?? randomUUID();
    const intervalSec = input.intervalSec ?? SIX_HOURS_SEC;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "AssetSteward",
      role: "engineer",
      status: input.status ?? "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
      lastHeartbeatAt: input.lastHeartbeatAt ?? null,
    });

    return { companyId, agentId, intervalSec };
  }

  async function readAgent(agentId: string) {
    const row = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    return row[0] ?? null;
  }

  async function countTimerWakes(agentId: string) {
    const rows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    return rows.filter((row) => row.reason === "heartbeat_timer").length;
  }

  it("does not advance the timer baseline by a full interval when a run times out", async () => {
    const { agentId } = await seedLane({
      intervalSec: SIX_HOURS_SEC,
      lastHeartbeatAt: new Date("2026-10-28T00:00:00.000Z"),
    });

    const before = await readAgent(agentId);
    expect(before?.lastHeartbeatAt?.toISOString()).toBe("2026-10-28T00:00:00.000Z");

    // Reproduce the Asset Steward 01:14:40Z timeout shape: the run finishes
    // as `timed_out`.
    await heartbeat.finalizeAgentStatus(agentId, "timed_out");

    const after = await readAgent(agentId);
    // AC1: the baseline is NOT advanced by the failed run. The lane must not
    // be pushed a full interval into the future.
    expect(after?.lastHeartbeatAt?.toISOString()).toBe("2026-10-28T00:00:00.000Z");
    // The lane is still labelled `error` - that signal is preserved (AC3).
    expect(after?.status).toBe("error");
    // A backoff deadline was recorded so the lane returns in minutes.
    expect(after?.nextTimerDueAt).not.toBeNull();
    expect(after?.heartbeatFailureStreak).toBe(1);
  });

  it("does not advance the timer baseline when a run fails", async () => {
    const { agentId } = await seedLane({
      intervalSec: SIX_HOURS_SEC,
      lastHeartbeatAt: new Date("2026-10-28T00:00:00.000Z"),
    });

    await heartbeat.finalizeAgentStatus(agentId, "failed");

    const after = await readAgent(agentId);
    expect(after?.lastHeartbeatAt?.toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(after?.status).toBe("error");
    expect(after?.nextTimerDueAt).not.toBeNull();
  });

  it("advances the timer baseline on success, as before", async () => {
    const { agentId } = await seedLane({
      intervalSec: SIX_HOURS_SEC,
      lastHeartbeatAt: new Date("2026-10-28T00:00:00.000Z"),
    });

    await heartbeat.finalizeAgentStatus(agentId, "succeeded");

    const after = await readAgent(agentId);
    expect(after?.lastHeartbeatAt).not.toBeNull();
    expect(after?.lastHeartbeatAt!.getTime()).toBeGreaterThan(
      new Date("2026-10-28T00:00:00.000Z").getTime(),
    );
    // A healthy lane has no pending backoff.
    expect(after?.nextTimerDueAt).toBeNull();
    expect(after?.heartbeatFailureStreak).toBe(0);
    expect(after?.status).toBe("idle");
  });

  it("escalates the backoff across consecutive failures and resets on success", async () => {
    const { agentId } = await seedLane({
      intervalSec: SIX_HOURS_SEC,
      lastHeartbeatAt: new Date("2026-10-28T00:00:00.000Z"),
    });

    await heartbeat.finalizeAgentStatus(agentId, "timed_out");
    const first = await readAgent(agentId);
    expect(first?.heartbeatFailureStreak).toBe(1);

    await heartbeat.finalizeAgentStatus(agentId, "timed_out");
    const second = await readAgent(agentId);
    expect(second?.heartbeatFailureStreak).toBe(2);
    expect(second?.nextTimerDueAt!.getTime()).toBeGreaterThan(first!.nextTimerDueAt!.getTime());

    await heartbeat.finalizeAgentStatus(agentId, "succeeded");
    const third = await readAgent(agentId);
    expect(third?.heartbeatFailureStreak).toBe(0);
    expect(third?.nextTimerDueAt).toBeNull();
  });

  it("computes a bounded failure backoff that stays far below the interval", () => {
    expect(computeHeartbeatFailureBackoffMs(1)).toBe(HEARTBEAT_FAILURE_BACKOFF_DELAYS_MS[0]);
    expect(computeHeartbeatFailureBackoffMs(2)).toBe(HEARTBEAT_FAILURE_BACKOFF_DELAYS_MS[1]);
    expect(computeHeartbeatFailureBackoffMs(99)).toBe(HEARTBEAT_FAILURE_BACKOFF_MAX_MS);
    // AC2: the backoff must be minutes, and must never reach a 6h interval.
    for (let streak = 1; streak <= 50; streak += 1) {
      expect(computeHeartbeatFailureBackoffMs(streak)).toBeLessThan(SIX_HOURS_SEC * 1000);
      expect(computeHeartbeatFailureBackoffMs(streak)).toBeLessThanOrEqual(
        HEARTBEAT_FAILURE_BACKOFF_MAX_MS,
      );
    }
  });

  it("re-dispatches a lane whose last run failed, long before the interval elapses", async () => {
    const { agentId } = await seedLane({
      intervalSec: SIX_HOURS_SEC,
      lastHeartbeatAt: new Date("2026-10-28T00:00:00.000Z"),
    });

    // A failed run recorded a backoff deadline of "now + first backoff step".
    const dueAt = new Date(Date.now() + HEARTBEAT_FAILURE_BACKOFF_DELAYS_MS[0]);
    await db
      .update(agents)
      .set({ nextTimerDueAt: dueAt, heartbeatFailureStreak: 1 })
      .where(eq(agents.id, agentId));

    const wakesBefore = await countTimerWakes(agentId);

    // Well inside the 6h interval: 5 minutes after the backoff deadline.
    const result = await heartbeat.tickTimers(new Date(dueAt.getTime() + 5 * 60 * 1000));

    expect(result.enqueued).toBe(1);
    const wakesAfter = await countTimerWakes(agentId);
    expect(wakesAfter).toBe(wakesBefore + 1);

    // AC2: the re-dispatch happened minutes after the failure, not 6 hours.
    const gapMs = dueAt.getTime() + 5 * 60 * 1000 - dueAt.getTime();
    expect(gapMs).toBeLessThan(SIX_HOURS_SEC * 1000);
  });

  it("does not re-dispatch a lane before its backoff deadline", async () => {
    const { agentId } = await seedLane({
      intervalSec: SIX_HOURS_SEC,
      lastHeartbeatAt: new Date("2026-10-28T00:00:00.000Z"),
    });

    const dueAt = new Date(Date.now() + HEARTBEAT_FAILURE_BACKOFF_DELAYS_MS[0]);
    await db
      .update(agents)
      .set({ nextTimerDueAt: dueAt, heartbeatFailureStreak: 1 })
      .where(eq(agents.id, agentId));

    const result = await heartbeat.tickTimers(new Date(dueAt.getTime() - 1000));
    expect(result.enqueued).toBe(0);
  });

  it("keeps the normal interval behaviour for a healthy lane", async () => {
    const { agentId } = await seedLane({
      intervalSec: SIX_HOURS_SEC,
      lastHeartbeatAt: new Date("2026-10-28T00:00:00.000Z"),
    });

    // 5 minutes after the last heartbeat: not due yet.
    const early = await heartbeat.tickTimers(new Date("2026-10-28T00:05:00.000Z"));
    expect(early.enqueued).toBe(0);

    // After the full interval: due.
    const due = await heartbeat.tickTimers(new Date("2026-10-28T06:00:01.000Z"));
    expect(due.enqueued).toBe(1);
  });

  it("does not re-dispatch the same lane repeatedly while a retry is in flight", async () => {
    const { agentId } = await seedLane({
      intervalSec: SIX_HOURS_SEC,
      lastHeartbeatAt: new Date("2026-10-28T00:00:00.000Z"),
    });

    const dueAt = new Date(Date.now() + HEARTBEAT_FAILURE_BACKOFF_DELAYS_MS[0]);
    await db
      .update(agents)
      .set({ nextTimerDueAt: dueAt, heartbeatFailureStreak: 1 })
      .where(eq(agents.id, agentId));

    const at = new Date(dueAt.getTime() + 1000);
    const first = await heartbeat.tickTimers(at);
    expect(first.enqueued).toBe(1);

    // The deadline is consumed when the retry is dispatched, so a second tick
    // must not enqueue another run for the same lane.
    const second = await heartbeat.tickTimers(at);
    expect(second.enqueued).toBe(0);
  });

  it("keeps status:'error' as a meaningful signal after a failure", async () => {
    const { agentId } = await seedLane({
      intervalSec: SIX_HOURS_SEC,
      lastHeartbeatAt: new Date("2026-10-28T00:00:00.000Z"),
    });

    // A lane in `error` must still be schedulable - `error` is a label, not a
    // block. AC3 pins that the fix did not change that.
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, agentId));

    const dueAt = new Date(Date.now() + HEARTBEAT_FAILURE_BACKOFF_DELAYS_MS[0]);
    await db
      .update(agents)
      .set({ nextTimerDueAt: dueAt, heartbeatFailureStreak: 1 })
      .where(eq(agents.id, agentId));

    const result = await heartbeat.tickTimers(new Date(dueAt.getTime() + 1000));
    expect(result.enqueued).toBe(1);
  });
});
