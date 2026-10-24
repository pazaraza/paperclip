/**
 * Run-liveness input building, classification persistence, and the
 * stranded-timed-out reconciliation pass (RUAAAAA-5323).
 *
 * `classifyRunLiveness` is a **one-shot** classifier. `heartbeatService`
 * evaluates it once inside the run-finalization path
 * (`heartbeat.ts` — the `reapOrphanedRuns` success/failure sites), so a
 * row written `timed_out` by the openclaw_gateway wait budget is classified
 * against the evidence that existed at that instant. When the gateway
 * never streamed an event back, that evidence is empty and the row is
 * frozen at `livenessState: failed` / `lastUsefulActionAt: null` — even
 * though the orphaned agent goes on to land real durable writes.
 *
 * This module exists so a **second** classification can run once that late
 * evidence has landed. It lives outside `heartbeat.ts` because
 * `heartbeat.ts` already imports `recovery/service.js`; the recovery
 * service calling back into `heartbeat.ts` would be a circular import.
 * Both callers now share one implementation.
 */
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  activityLog,
  documentRevisions,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import { asNumber, parseObject } from "../adapters/utils.js";
import { logActivity } from "./activity-log.js";
import { getIssueContinuationSummaryDocument } from "./issue-continuation-summary.js";
import {
  classifyRunLiveness,
  type RunLivenessClassification,
  type RunLivenessClassificationInput,
} from "./run-liveness.js";

/**
 * Activity actions that are liveness bookkeeping rather than task
 * progress. They must never count as evidence of a useful action, or a
 * run would credit itself for being classified. `heartbeat.run_liveness_reconciled`
 * belongs here for exactly that reason: without it, the reconciliation
 * pass would write its own activity row and the *next* pass would find
 * evidence that is really just the previous pass looking at itself.
 */
export const LIVENESS_BOOKKEEPING_ACTIVITY_ACTIONS = [
  "environment.lease_acquired",
  "environment.lease_released",
  "heartbeat.run_liveness_reconciled",
];

export const STRANDED_TIMED_OUT_RUN_LIVENESS_RECONCILED_ACTION =
  "heartbeat.run_liveness_reconciled";

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}function countValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function dateValue(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function latestDate(...values: unknown[]) {
  let latest: Date | null = null;
  for (const value of values) {
    const parsed = dateValue(value);
    if (!parsed) continue;
    if (!latest || parsed.getTime() > latest.getTime()) latest = parsed;
  }
  return latest;
}

export async function buildRunLivenessInput(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  resultJson: Record<string, unknown> | null | undefined,
): Promise<RunLivenessClassificationInput> {
  const context = parseObject(run.contextSnapshot);
  const contextIssueId = readNonEmptyString(context.issueId);
  const continuationAttempt = asNumber(context.continuationAttempt, run.continuationAttempt ?? 0);

  const issue = contextIssueId
    ? await db
      .select({
        status: issues.status,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, contextIssueId)))
      .then((rows) => rows[0] ?? null)
    : null;

  const [commentStats] = contextIssueId
    ? await db
      .select({
        count: sql<number>`count(*)::int`,
        latestAt: sql<Date | null>`max(${issueComments.createdAt})`,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, run.companyId),
          eq(issueComments.issueId, contextIssueId),
          eq(issueComments.createdByRunId, run.id),
        ),
      )
    : [{ count: 0, latestAt: null }];

  const issueCommentBodies = contextIssueId
    ? await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, run.companyId),
          eq(issueComments.issueId, contextIssueId),
          eq(issueComments.createdByRunId, run.id),
        ),
      )
      .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
      .limit(5)
      .then((rows) => rows.reverse().map((row) => row.body))
    : [];

  const continuationSummary = contextIssueId
    ? await getIssueContinuationSummaryDocument(db, contextIssueId)
    : null;

  const [documentStats] = contextIssueId
    ? await db
      .select({
        count: sql<number>`count(*)::int`,
        planCount: sql<number>`count(*) filter (where ${issueDocuments.key} = 'plan')::int`,
        latestAt: sql<Date | null>`max(${documentRevisions.createdAt})`,
      })
      .from(documentRevisions)
      .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
      .where(
        and(
          eq(documentRevisions.companyId, run.companyId),
          eq(documentRevisions.createdByRunId, run.id),
          eq(issueDocuments.companyId, run.companyId),
          eq(issueDocuments.issueId, contextIssueId),
          sql`${issueDocuments.key} != ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}`,
        ),
      )
    : [{ count: 0, planCount: 0, latestAt: null }];

  const [workProductStats] = contextIssueId
    ? await db
      .select({
        count: sql<number>`count(*)::int`,
        latestAt: sql<Date | null>`max(${issueWorkProducts.createdAt})`,
      })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, run.companyId),
          eq(issueWorkProducts.issueId, contextIssueId),
          eq(issueWorkProducts.createdByRunId, run.id),
        ),
      )
    : [{ count: 0, latestAt: null }];

  const [workspaceOperationStats] = await db
    .select({
      count: sql<number>`count(*)::int`,
      latestAt: sql<Date | null>`max(${workspaceOperations.startedAt})`,
    })
    .from(workspaceOperations)
    .where(and(eq(workspaceOperations.companyId, run.companyId), eq(workspaceOperations.heartbeatRunId, run.id)));

  const [activityStats] = await db
    .select({
      count: sql<number>`count(*)::int`,
      latestAt: sql<Date | null>`max(${activityLog.createdAt})`,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, run.companyId),
        eq(activityLog.runId, run.id),
        notInArray(activityLog.action, LIVENESS_BOOKKEEPING_ACTIVITY_ACTIONS),
      ),
    );

  const [eventStats] = await db
    .select({
      count: sql<number>`count(*) filter (where ${heartbeatRunEvents.eventType} not in ('lifecycle', 'adapter.invoke', 'error'))::int`,
      latestAt: sql<Date | null>`max(${heartbeatRunEvents.createdAt}) filter (where ${heartbeatRunEvents.eventType} not in ('lifecycle', 'adapter.invoke', 'error'))`,
    })
    .from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id)));

  return {
    runStatus: run.status,
    issue,
    resultJson: resultJson ?? run.resultJson ?? null,
    issueCommentBodies,
    continuationSummaryBody: continuationSummary?.body ?? null,
    stdoutExcerpt: run.stdoutExcerpt ?? null,
    stderrExcerpt: run.stderrExcerpt ?? null,
    error: run.error ?? null,
    errorCode: run.errorCode ?? null,
    continuationAttempt,
    evidence: {
      issueCommentsCreated: countValue(commentStats?.count),
      documentRevisionsCreated: countValue(documentStats?.count),
      planDocumentRevisionsCreated: countValue(documentStats?.planCount),
      workProductsCreated: countValue(workProductStats?.count),
      workspaceOperationsCreated: countValue(workspaceOperationStats?.count),
      activityEventsCreated: countValue(activityStats?.count),
      toolOrActionEventsCreated: countValue(eventStats?.count),
      latestEvidenceAt: latestDate(
        commentStats?.latestAt,
        documentStats?.latestAt,
        workProductStats?.latestAt,
        workspaceOperationStats?.latestAt,
        activityStats?.latestAt,
        eventStats?.latestAt,
      ),
    },
  };
}

export async function persistRunLivenessClassification(
  db: Db,
  run: { id: string },
  classification: RunLivenessClassification,
) {
  return db
    .update(heartbeatRuns)
    .set({
      livenessState: classification.livenessState,
      livenessReason: classification.livenessReason,
      continuationAttempt: classification.continuationAttempt,
      lastUsefulActionAt: classification.lastUsefulActionAt,
      nextAction: classification.nextAction,
      updatedAt: new Date(),
    })
    .where(eq(heartbeatRuns.id, run.id))
    .returning()
    .then((rows) => rows[0] ?? null);
}

export async function classifyAndPersistRunLiveness(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  resultJson?: Record<string, unknown> | null,
) {
  const classification = classifyRunLiveness(await buildRunLivenessInput(db, run, resultJson));
  return persistRunLivenessClassification(db, run, classification);
}
export type StrandedTimedOutRunReconcileSkipReason =
  | "run_missing"
  | "not_timed_out"
  | "no_finished_at"
  | "no_late_evidence"
  | "already_reconciled";

export interface StrandedTimedOutRunReconcileInput {
  runStatus: string;
  finishedAt: Date | null;
  latestEvidenceAt: Date | null;
}

export type StrandedTimedOutRunReconcileDecision =
  | { reconcile: true; lateEvidenceAt: Date }
  | { reconcile: false; reason: StrandedTimedOutRunReconcileSkipReason };

/**
 * The guard that decides whether a settled run row deserves to be asked
 * the liveness question a second time.
 *
 * Only the openclaw_gateway wait-budget family qualifies, and only when
 * evidence actually grew *after* the row was written. `latestEvidenceAt`
 * at-or-before `finishedAt` means the second classification would read
 * the same evidence the first one already read, so re-running it is pure
 * churn on an already-settled row.
 */
export function decideStrandedTimedOutRunReconcile(
  input: StrandedTimedOutRunReconcileInput,
): StrandedTimedOutRunReconcileDecision {
  if (input.runStatus !== "timed_out") return { reconcile: false, reason: "not_timed_out" };
  if (!input.finishedAt) return { reconcile: false, reason: "no_finished_at" };
  if (!input.latestEvidenceAt) return { reconcile: false, reason: "no_late_evidence" };
  if (input.latestEvidenceAt.getTime() <= input.finishedAt.getTime()) {
    return { reconcile: false, reason: "no_late_evidence" };
  }
  return { reconcile: true, lateEvidenceAt: input.latestEvidenceAt };
}

function sameTimestamp(a: unknown, b: unknown): boolean {
  const left = dateValue(a);
  const right = dateValue(b);
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.getTime() === right.getTime();
}

/** Run-event types that carry no task progress. */
const LIFECYCLE_ONLY_RUN_EVENT_TYPES = ["lifecycle", "adapter.invoke", "error"];

/**
 * The latest durable write the run *itself* produced, restricted to the
 * sources unambiguously scoped to writes the agent made: issue comments,
 * document revisions, work products, and non-lifecycle run events.
 *
 * `activityLog` is deliberately excluded. The control plane writes activity
 * rows scoped to a run id it did not produce — recovery escalation
 * (`issue.updated`), auto-clear bookkeeping, and this module's own
 * reconcile row all land on `heartbeatRuns.id`. Crediting those would let a
 * run that did no work be reclassified from `failed` to `advanced` on the
 * strength of the machinery examining it. The four sources above have no
 * such writer.
 */
async function latestRunOwnWriteAt(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  contextIssueId: string | null,
): Promise<Date | null> {
  const commentAt = contextIssueId
    ? await db
        .select({ at: sql<Date | null>`max(${issueComments.createdAt})` })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, run.companyId),
            eq(issueComments.issueId, contextIssueId),
            eq(issueComments.createdByRunId, run.id),
          ),
        )
        .then((rows) => dateValue(rows[0]?.at))
    : null;

  const documentAt = contextIssueId
    ? await db
        .select({ at: sql<Date | null>`max(${documentRevisions.createdAt})` })
        .from(documentRevisions)
        .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
        .where(
          and(
            eq(documentRevisions.companyId, run.companyId),
            eq(documentRevisions.createdByRunId, run.id),
            eq(issueDocuments.companyId, run.companyId),
            eq(issueDocuments.issueId, contextIssueId),
            sql`${issueDocuments.key} != ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}`,
          ),
        )
        .then((rows) => dateValue(rows[0]?.at))
    : null;

  const workProductAt = contextIssueId
    ? await db
        .select({ at: sql<Date | null>`max(${issueWorkProducts.createdAt})` })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, run.companyId),
            eq(issueWorkProducts.issueId, contextIssueId),
            eq(issueWorkProducts.createdByRunId, run.id),
          ),
        )
        .then((rows) => dateValue(rows[0]?.at))
    : null;

  const eventAt = await db
    .select({ at: sql<Date | null>`max(${heartbeatRunEvents.createdAt})` })
    .from(heartbeatRunEvents)
    .where(
      and(
        eq(heartbeatRunEvents.companyId, run.companyId),
        eq(heartbeatRunEvents.runId, run.id),
        notInArray(heartbeatRunEvents.eventType, LIFECYCLE_ONLY_RUN_EVENT_TYPES),
      ),
    )
    .then((rows) => dateValue(rows[0]?.at));

  return latestDate(commentAt, documentAt, workProductAt, eventAt);
}

/**
 * True once this pass has already repaired the row. A run gets a second
 * classification *once* — not a loop of re-derivations. Re-deriving on
 * every sweep would let a settled row walk backwards, because
 * `classifyRunLiveness` gates its `timed_out` override on
 * `issue.status === "in_progress"`: once recovery moves the issue to
 * `blocked`, the same evidence reclassifies back to `failed`.
 */
async function alreadyReconciled(db: Db, runId: string): Promise<boolean> {
  const rows = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.runId, runId),
        eq(activityLog.action, STRANDED_TIMED_OUT_RUN_LIVENESS_RECONCILED_ACTION),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface StrandedTimedOutRunReconcileResult {
  reconciled: boolean;
  reason: StrandedTimedOutRunReconcileSkipReason | "reconciled";
  runId: string | null;
  previousLivenessState: string | null;
  livenessState: string | null;
  lateEvidenceAt: Date | null;
}

function skipped(
  reason: StrandedTimedOutRunReconcileSkipReason,
  run: { id?: string; livenessState?: string | null } | null,
): StrandedTimedOutRunReconcileResult {
  return {
    reconciled: false,
    reason,
    runId: run?.id ?? null,
    previousLivenessState: run?.livenessState ?? null,
    livenessState: run?.livenessState ?? null,
    lateEvidenceAt: null,
  };
}

/**
 * Re-classify a run that outlived its waiter's budget.
 *
 * Called from the recovery reconciliation paths, which already know how
 * to settle the *issue* after a stranded timeout
 * (`tryAutoClearTimedOutStrandedAssignedContinuation` and its 2253
 * sibling) but which previously never revisited the *run* row. Re-fetching
 * the row by id rather than trusting the caller's snapshot is deliberate:
 * a stale snapshot is the same failure family this fix exists to correct.
 */
export async function reconcileStrandedTimedOutRunLiveness(
  db: Db,
  runId: string | null | undefined,
): Promise<StrandedTimedOutRunReconcileResult> {
  if (!runId) return skipped("run_missing", null);

  const run = await db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!run) return skipped("run_missing", null);

  const resultJson = parseObject(run.resultJson);
  const context = parseObject(run.contextSnapshot);
  const contextIssueId = readNonEmptyString(context.issueId);

  if (await alreadyReconciled(db, run.id)) return skipped("already_reconciled", run);

  const latestOwnWriteAt = await latestRunOwnWriteAt(db, run, contextIssueId);
  const decision = decideStrandedTimedOutRunReconcile({
    runStatus: run.status,
    finishedAt: dateValue(run.finishedAt),
    latestEvidenceAt: latestOwnWriteAt,
  });
  if (!decision.reconcile) return skipped(decision.reason, run);

  const base = await buildRunLivenessInput(db, run, resultJson);
  const evidence = base.evidence ?? {};
  const classification = classifyRunLiveness({
    ...base,
    evidence: {
      ...evidence,
      // See `latestRunOwnWriteAt`: activity the control plane wrote *about*
      // this run is not the run working. Zero it so a repair pass can never
      // manufacture evidence for itself.
      activityEventsCreated: 0,
      latestEvidenceAt: latestOwnWriteAt,
    },
  });

  const persisted = await persistRunLivenessClassification(db, run, classification);
  const livenessState = persisted?.livenessState ?? classification.livenessState;
  const lateEvidenceAt = persisted?.lastUsefulActionAt ?? decision.lateEvidenceAt;

  await logActivity(db, {
    companyId: run.companyId,
    actorType: "system",
    actorId: "system",
    agentId: null,
    runId: run.id,
    action: STRANDED_TIMED_OUT_RUN_LIVENESS_RECONCILED_ACTION,
    entityType: "heartbeat_run",
    entityId: run.id,
    details: {
      reconciledRunId: run.id,
      previousLivenessState: run.livenessState,
      previousLivenessReason: run.livenessReason,
      previousLastUsefulActionAt: run.lastUsefulActionAt,
      livenessState,
      livenessReason: persisted?.livenessReason ?? classification.livenessReason,
      lastUsefulActionAt: lateEvidenceAt,
      evidenceLandedAfterFinishedAt: decision.lateEvidenceAt,
      finishedAt: dateValue(run.finishedAt),
      issueCommentsCreated: evidence.issueCommentsCreated ?? 0,
      documentRevisionsCreated: evidence.documentRevisionsCreated ?? 0,
      workProductsCreated: evidence.workProductsCreated ?? 0,
      toolOrActionEventsCreated: evidence.toolOrActionEventsCreated ?? 0,
      source: "run_liveness.reconcile_stranded_timed_out_run",
    },
  });

  return {
    reconciled: true,
    reason: "reconciled",
    runId: run.id,
    previousLivenessState: run.livenessState,
    livenessState,
    lateEvidenceAt,
  };
}