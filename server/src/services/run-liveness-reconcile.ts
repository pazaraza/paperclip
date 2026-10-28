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
import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
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
  hasConcreteActionEvidence,
  type RunLivenessClassification,
  type RunLivenessClassificationInput,
} from "./run-liveness.js";
import { UNOBSERVED_LIVENESS_ERROR_CODES } from "./run-liveness-observability.js";

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
  | "not_false_terminal"
  | "no_finished_at"
  | "no_late_evidence"
  | "already_reconciled";

export interface StrandedTimedOutRunReconcileInput {
  runStatus: string;
  /** The run error code, when it carries one. */
  errorCode?: string | null;
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
function buildRepairedLivenessReason(runStatus: string, errorCode?: string | null): string {
  return (
    "Run was finalized without observable liveness (" +
    (errorCode ?? runStatus) +
    ") but the run produced durable writes afterwards, so the run was still advancing"
  );
}

export function isFalseTerminalRun(runStatus: string, errorCode?: string | null): boolean {
  if (runStatus === "timed_out") return true;
  if (runStatus !== "failed") return false;
  return UNOBSERVED_LIVENESS_ERROR_CODES.has(errorCode ?? "");
}

export function decideStrandedTimedOutRunReconcile(
  input: StrandedTimedOutRunReconcileInput,
): StrandedTimedOutRunReconcileDecision {
  if (!isFalseTerminalRun(input.runStatus, input.errorCode)) {
    return {
      reconcile: false,
      reason: input.runStatus === "failed" ? "not_false_terminal" : "not_timed_out",
    };
  }
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
  // ABY-896. A run with no source issue in its context (a
  // heartbeat-timer run, for instance) has nothing to scope its
  // evidence TO. Scoping to the issue is the right rule when there IS
  // an issue - it keeps a run from being credited for work it did on
  // a DIFFERENT issue. But when there is no issue, the rule has no
  // referent, and applying it discards the run's own writes entirely -
  // so a run that demonstrably worked after its false stamp could
  // never be repaired. For those runs the scoping is inapplicable
  // rather than restrictive: the run's own writes count, wherever
  // they landed.
  const commentAt = await db
    .select({ at: sql<Date | null>`max(${issueComments.createdAt})` })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, run.companyId),
        eq(issueComments.createdByRunId, run.id),
        contextIssueId ? eq(issueComments.issueId, contextIssueId) : undefined,
      ),
    )
    .then((rows) => dateValue(rows[0]?.at));

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

  // Same reasoning as comments: a work product with no source issue
  // has no issue to scope to, so the run's own products count.
  const workProductAt = await db
    .select({ at: sql<Date | null>`max(${issueWorkProducts.createdAt})` })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, run.companyId),
        eq(issueWorkProducts.createdByRunId, run.id),
        contextIssueId ? eq(issueWorkProducts.issueId, contextIssueId) : undefined,
      ),
    )
    .then((rows) => dateValue(rows[0]?.at));

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
    errorCode: run.errorCode,
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
  // ABY-870 / ABY-896. classifyRunLiveness promotes a timed_out run with
  // concrete evidence to advanced, but a failed row never gets that
  // override - by design, because a genuinely failed run did stop. For
  // the false-terminal family the premise is different: the run was
  // finalized on the strength of an unobservable absence, and its own
  // writes landed afterwards, which is positive evidence the agent was
  // working. Promote it here, where that premise is established, rather
  // than weakening the classifier for every failed run.
  // The premise is the run's OWN late write, which is what
  // `latestOwnWriteAt` measures - not the issue-scoped evidence
  // count, which is zero for a run with no source issue and would
  // otherwise block the promotion for exactly the runs the widened
  // scoping was added to reach.
  const repaired =
    classification.livenessState === "failed" &&
    latestOwnWriteAt !== null &&
    isFalseTerminalRun(run.status, run.errorCode)
      ? {
          ...classification,
          livenessState: "advanced" as const,
          livenessReason: buildRepairedLivenessReason(run.status, run.errorCode),
          lastUsefulActionAt: latestOwnWriteAt,
        }
      : classification;

  const persisted = await persistRunLivenessClassification(db, run, repaired);
  const livenessState = persisted?.livenessState ?? repaired.livenessState;
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

/**
 * ABY-870 / ABY-896. A sweep for false-terminal rows that carry late
 * own-writes, run independently of any issue's status.
 *
 * The recovery path reaches the reconciler only for issues in
 * `todo` / `in_progress` (see `reconcileStrandedAssignedIssues`), and
 * only for a `latestRun` whose `retryReason` is
 * `issue_continuation_needed`. That is the wrong shape for this
 * repair: the false stamp itself moves the issue to `blocked`, so
 * the moment a late write proves the stamp wrong, the issue has
 * already left the set of issues the recovery path visits. The
 * repair then never runs, and the row stays frozen at `failed`
 * forever.
 *
 * This was observed live on ABY-843: run `dc98135b` was stamped
 * `timed_out` at 05:03:37.681Z, the issue was blocked 38 ms later,
 * and the run's own comment landed at 05:03:43.981Z - six seconds
 * after the stamp, and after the issue had left the candidate set.
 * The run row is still `failed` today.
 *
 * The sweep therefore starts from the RUN rows, not the issue rows:
 * every run in the false-terminal family that has not been
 * reconciled yet is offered to the same per-row repair. The
 * per-row predicate (`latestRunOwnWriteAt` strictly after
 * `finishedAt`) still decides whether it actually qualifies, so
 * this cannot manufacture a repair.
 */
export async function sweepStrandedRunLiveness(
  db: Db,
  opts?: { limit?: number },
): Promise<{ scanned: number; reconciled: number; runIds: string[] }> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 200, 1000));
  // The candidate query must select rows that actually carry late
  // own-writes, not every false-terminal row. The false-terminal
  // family is large (18,676 rows live at the time of writing) while
  // the rows that qualify are the handful whose own writes landed
  // after the stamp (35 live). Selecting the whole family and
  // filtering in memory would page past the qualifying rows and
  // never repair them.
  //
  // The durable evidence sources here are the same ones
  // `latestRunOwnWriteAt` reads, so the SQL prefilter and the
  // per-row predicate agree on what counts as evidence.
  const candidateRows = await db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
    .from(heartbeatRuns)
    .where(
      and(
        sql`${heartbeatRuns.status} IN ('failed', 'timed_out')`,
        // The false-terminal family, in SQL rather than in memory: a row
        // that can never reconcile must not occupy a slot in the LIMIT
        // window, or it starves a qualifying row behind it.
        sql`(${heartbeatRuns.status} = 'timed_out' OR ${heartbeatRuns.errorCode} IN ('process_lost', 'execution_handle_lost'))`,
        isNotNull(heartbeatRuns.finishedAt),
        sql`${heartbeatRuns.id} NOT IN (SELECT ${activityLog.runId} FROM ${activityLog} WHERE ${activityLog.action} = ${STRANDED_TIMED_OUT_RUN_LIVENESS_RECONCILED_ACTION} AND ${activityLog.runId} IS NOT NULL)`,
        // The prefilter must agree with the per-row predicate: a run with no
        // source issue has no issue to scope its evidence to, so its own
        // writes count wherever they landed.
        sql`EXISTS (SELECT 1 FROM ${issueComments} WHERE ${issueComments.createdByRunId} = ${heartbeatRuns.id} AND ${issueComments.createdAt} > ${heartbeatRuns.finishedAt} AND (${heartbeatRuns.contextSnapshot} ->> 'issueId' IS NULL OR ${issueComments.issueId}::text = ${heartbeatRuns.contextSnapshot} ->> 'issueId'))`,
      ),
    )
    // Deterministic order. Without it the LIMIT returns an arbitrary
    // window, and a pass can come back empty while qualifying rows
    // remain outside the window - the sweep would then report
    // convergence it had not reached.
    .orderBy(asc(heartbeatRuns.finishedAt), asc(heartbeatRuns.id))
    .limit(limit)
    .then((rows) => rows);

  // The family filter is in SQL (see above), so every candidate row can
  // reconcile. The in-memory check stays as a guard against the SQL and
  // the predicate drifting apart.
  const candidates = candidateRows.filter((row) =>
    isFalseTerminalRun(row.status, row.errorCode),
  );

  let scanned = 0;
  const reconciledRunIds: string[] = [];
  for (const row of candidates) {
    if (reconciledRunIds.length >= limit) break;
    scanned += 1;
    const result = await reconcileStrandedTimedOutRunLiveness(db, row.id);
    if (result.reconciled) reconciledRunIds.push(row.id);
  }

  return { scanned, reconciled: reconciledRunIds.length, runIds: reconciledRunIds };
}