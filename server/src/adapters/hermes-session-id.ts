/**
 * hermes_local adapter guards: session-id format (RUAAAAA-5244), held-session
 * recovery (RUAAAAA-5296), and compaction-stall recovery (RUAAAAA-5339).
 *
 * Hermes Agent mints every session id in the shape
 * `<YYYYMMDD>_<HHMMSS>_<6 lowercase hex>` (e.g. `20260706_234011_dc2cf9`).
 * Nothing else is a session id.
 *
 * The adapter scrapes the id out of hermes stdout/stderr with
 * `SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i`,
 * which happily captures the next prose word. "Session saved from the previous
 * run" yields `sessionId: "from"`. The adapter's own codec only checks
 * non-empty, and `resolveNextSessionState()` in heartbeat.ts falls back to
 * `readNonEmptyString(adapterResult.sessionId)` without validation, so the
 * garbage word lands in `agent_task_sessions.session_params_json` /
 * `agent_runtime_state.session_id` and the next run shells out
 * `hermes --resume from`.
 *
 * This module is the server-side choke point: it fails closed. A value that
 * does not match the shape is never persisted, never displayed, and never
 * handed back to the adapter as a resume target.
 */
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { logger } from "../middleware/logger.js";

/** The only shape a hermes session id can have. */
export const HERMES_SESSION_ID_PATTERN = /^\d{8}_\d{6}_[0-9a-f]{6}$/;

/**
 * True only for a well-formed hermes session id. `from`, `20260827`, an
 * empty string, and a whitespace-padded id all return false.
 */
export function isHermesSessionId(value: unknown): value is string {
  return typeof value === "string" && HERMES_SESSION_ID_PATTERN.test(value.trim());
}

/**
 * Return the session id when it is well-formed, otherwise `null`.
 *
 * `null` is the fail-closed value: `serialize()` turns it into "persist
 * nothing" and `getDisplayId()` turns it into "display nothing". It is never a
 * fallback word.
 */
export function sanitizeHermesSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return HERMES_SESSION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export type HermesSessionIdRejection = {
  field: string;
  value: string;
};

function readSessionIdField(params: Record<string, unknown> | null): string | null {
  if (!params) return null;
  const direct = sanitizeHermesSessionId(params.sessionId);
  if (direct) return direct;
  return sanitizeHermesSessionId(params.session_id);
}

function rejectIfMalformed(
  params: Record<string, unknown> | null,
  field: string,
): HermesSessionIdRejection | null {
  const raw = params?.[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return null;
  if (sanitizeHermesSessionId(raw)) return null;
  return { field, value: raw };
}

/**
 * Wrap the adapter's own session codec so every session id crossing the
 * server boundary is format-checked.
 *
 * The adapter's codec accepts any non-empty string. `serialize` and
 * `deserialize` return `null` for a malformed id (fail closed: no new value
 * is written and an already-persisted bad value stops being read back), and
 * `getDisplayId` never surfaces one.
 */
export function createGuardedHermesSessionCodec(
  base: AdapterSessionCodec,
  onReject?: (rejections: HermesSessionIdRejection[]) => void,
): AdapterSessionCodec {
  const report = (params: Record<string, unknown> | null) => {
    const rejection = rejectIfMalformed(params, "sessionId") ?? rejectIfMalformed(params, "session_id");
    if (rejection) onReject?.([rejection]);
  };

  return {
    deserialize(raw) {
      const parsed = base.deserialize(raw);
      report(parsed);
      const sessionId = readSessionIdField(parsed);
      // A malformed id deserializes to null: the caller falls back to "start
      // with no session" instead of resuming a garbage target.
      return sessionId ? { sessionId } : null;
    },
    serialize(params) {
      report(params);
      const sessionId = readSessionIdField(params);
      return sessionId ? { sessionId } : null;
    },
    getDisplayId(params) {
      return readSessionIdField(params);
    },
  };
}

type SessionIdCarrier = {
  sessionId?: unknown;
  sessionDisplayId?: unknown;
  sessionParams?: unknown;
};

/**
 * The refusal Hermes emits when the persisted session is open in an
 * interactive terminal:
 *
 *   hermes-refusal-reason: SESSION_NOT_OWNED
 *   This chat is open in another Hermes window/terminal. Use it there, or
 *   start a new chat here.
 *   Details: session 20261021_120843_054c18 opened by cli 7m ago.
 */
export const HERMES_SESSION_NOT_OWNED_PATTERN = /hermes-refusal-reason:\s*SESSION_NOT_OWNED/i;

/** Distinct run error code so this is not scored as `adapter_failed`. */
export const HERMES_SESSION_NOT_OWNED_ERROR_CODE = "session_not_owned";

/** True when the captured stderr shows the session-contention refusal. */
export function isHermesSessionNotOwned(text: string | null | undefined): boolean {
  return typeof text === "string" && HERMES_SESSION_NOT_OWNED_PATTERN.test(text);
}

type SessionContentionCarrier = SessionIdCarrier & {
  clearSession?: boolean;
  errorCode?: string | null;
};

/**
 * RUAAAAA-5339: the progress line Hermes prints while its own context
 * compaction runs. Observed form is `⟳ compacting context…` (U+27F3 arrow,
 * U+2026 ellipsis), but the decoration and punctuation vary between Hermes
 * versions and locales, so match on the stable words and allow any
 * non-alphanumeric decoration around them. Requiring the line to carry no
 * alphanumeric characters after "context" keeps real prose from matching.
 */
const HERMES_COMPACTION_SPINNER_LINE = /^[^A-Za-z0-9]*compacting\s+context[^A-Za-z0-9]*$/i;

/** Distinct run error code so a compaction stall is not scored as `timeout`. */
export const HERMES_COMPACTION_STALL_ERROR_CODE = "compaction_stall";

/**
 * True when Hermes burned its run budget in `⟳ compacting context…` and
 * produced no assistant output.
 *
 * Hermes' native compaction stalls on some sessions and never returns: it
 * reprints the spinner until the adapter's `timeoutSec` kills the child
 * (SIGINT, exit 130). Measured over 48h on 2026-10-23, 61 of 79
 * `hermes_local` timeouts showed this signature across 15 agents, and 0 of
 * 314 `openclaw_gateway` timeouts did — so it is specific to `hermes_local`.
 *
 * The stall is invisible in the run record because the adapter returns
 * `timedOut: true` with no `errorMessage`, and heartbeat.ts falls back to the
 * bare string "Timed out" (heartbeat.ts:7583). The `process` adapter does set
 * `Timed out after ${timeoutSec}s` (adapters/process/execute.ts:60); hermes
 * does not, so a hermes timeout carries no budget, no signal, and no cause.
 *
 * Detection reads the adapter's own `resultJson.result`, which for these runs
 * contains nothing but the spinner text: `parseHermesOutput` scrapes the last
 * prose it saw, and the spinner is all the child ever wrote.
 */
export function isHermesCompactionStall(result: string | null | undefined): boolean {
  if (typeof result !== "string") return false;
  const lines = result.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => HERMES_COMPACTION_SPINNER_LINE.test(line));
}

type CompactionStallCarrier = SessionContentionCarrier & {
  timedOut?: boolean;
  exitCode?: number | null;
  errorMessage?: string | null;
  signal?: string | null;
  resultJson?: { result?: unknown } | null;
};

/**
 * True when the run did not produce a usable result.
 *
 * A compaction stall is only a stall if the run also failed. Paperclip sets
 * `timedOut` only when its own wall-clock timer fires, so a child that dies
 * on its own is not covered by that flag. Two shapes were observed on
 * production: the Hermes CLI catches SIGINT and exits 130 (exit code 130, no
 * signal), and a child killed outright by a signal reports no exit code at
 * all (exit code null, signal set). The server files both as
 * failed/adapter_failed rather than timed_out, and the server's own
 * "succeeded" test requires both a zero exit code and no signal, so this
 * mirrors that rule exactly.
 */
export function isHermesNonSuccessExit(input: {
  timedOut?: boolean;
  exitCode?: number | null;
  signal?: string | null;
}): boolean {
  if (input.timedOut) return true;
  if (typeof input.exitCode === "number") return input.exitCode !== 0;
  // Killed by a signal: it never produced an exit code, so it never
  // succeeded either.
  return typeof input.signal === "string" && input.signal.length > 0;
}

/**
 * RUAAAAA-5339: break the compaction-stall livelock.
 *
 * When a run times out mid-compaction it has executed no turns and its
 * `resultJson.result` is only spinner text. The session is persisted anyway
 * (`resolveNextSessionState()` keeps `previousParams` because the adapter
 * reports no new session), so the next dispatch resumes the same wedged
 * session and fails identically — an agent can sit at zero successful runs
 * for 50h while still dispatching every few hours.
 *
 * RUAAAAA-5242's rotation policy cannot catch this: it is threshold-based on
 * run count, token volume and session age, but a session can enter the stall
 * after 2 runs, long before `maxSessionRuns: 12`. Confirmed on 2026-10-23:
 * every stalled run had `paperclipSessionRotationReason` unset.
 *
 * So detect the stall from the run's own output and drop the session, the
 * same lever RUAAAAA-5296 uses for a held-session collision. The next
 * dispatch starts a fresh session and the agent recovers on its own.
 *
 * A stall is also given a real `errorMessage` (budget, signal, spinner count)
 * so the run stops scoring as a bare "Timed out" and names its own cause.
 */
export function applyHermesCompactionStallRecovery<TResult extends CompactionStallCarrier>(
  result: TResult,
): TResult {
  if (
    !isHermesNonSuccessExit({
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      signal: result.signal,
    })
  ) {
    return result;
  }
  const scraped = result.resultJson?.result;
  if (!isHermesCompactionStall(typeof scraped === "string" ? scraped : null)) return result;

  const spinnerLines = String(scraped).split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const signal = result.signal ? `, signal ${result.signal}` : "";
  const exit = typeof result.exitCode === "number" ? `, exit ${result.exitCode}` : "";
  const errorMessage =
    `Hermes stalled in context compaction for the whole run budget (${spinnerLines} ` +
    `progress lines, no assistant output${signal}${exit}); session dropped so the next ` +
    `dispatch starts fresh. See RUAAAAA-5339.`;

  logger.warn(
    { spinnerLines, signal: result.signal ?? null },
    "[hermes_local] compaction stall consumed the run budget with no output; clearing the wedged session (RUAAAAA-5339)",
  );

  return {
    ...result,
    errorMessage,
    clearSession: true,
    errorCode: HERMES_COMPACTION_STALL_ERROR_CODE,
  };
}

/**
 * RUAAAAA-5296: recover from a held-session collision.
 *
 * `persistSession` pins each dispatch to a session id, and `hermes --resume
 * <id>` is refused while a person holds that session interactively. The
 * refusal carries no `session_id`, so the adapter returns no `sessionParams`;
 * `resolveNextSessionState()` then falls back to `previousParams` and the
 * failure path re-persists the very id that was just refused. Every later
 * dispatch collides again — and because `parseHermesOutput` only keeps stderr
 * lines matching /error|exception|traceback|failed/i (which the refusal matches
 * none of), the run carries no error message and scores as `adapter_failed`.
 *
 * Setting `clearSession` makes `resolveNextSessionState()` return nulls so the
 * server calls `clearTaskSessions()` and the next dispatch starts a fresh
 * session. `errorCode` stops the derived index misreading an operator-state
 * collision as a runtime fault.
 */
export function applyHermesSessionContentionRecovery<TResult extends SessionContentionCarrier>(
  result: TResult,
  stderr: string | null | undefined,
): TResult {
  if (!isHermesSessionNotOwned(stderr)) return result;
  return { ...result, clearSession: true, errorCode: HERMES_SESSION_NOT_OWNED_ERROR_CODE };
}

/**
 * Drop a malformed session id from an adapter execution result.
 *
 * `heartbeat.ts` reads `adapterResult.sessionId` directly (it does not go
 * through the codec) and uses it for `agent_runtime_state.session_id`, so the
 * execute path needs its own guard. `null` — not `undefined` — is returned so
 * the value is explicitly reported as absent rather than falling through to
 * "keep the previous session".
 */
export function sanitizeHermesExecutionResult<TResult extends SessionIdCarrier>(
  result: TResult,
): TResult {
  const next: TResult = { ...result };
  let changed = false;

  const params = next.sessionParams;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const record = { ...(params as Record<string, unknown>) };
    if (rejectIfMalformed(record, "sessionId") || rejectIfMalformed(record, "session_id")) {
      delete record.sessionId;
      delete record.session_id;
      next.sessionParams = Object.keys(record).length > 0 ? record : null;
      changed = true;
    }
  }

  if (typeof next.sessionId === "string" && !sanitizeHermesSessionId(next.sessionId)) {
    next.sessionId = null;
    changed = true;
  }
  if (typeof next.sessionDisplayId === "string" && !sanitizeHermesSessionId(next.sessionDisplayId)) {
    next.sessionDisplayId = null;
    changed = true;
  }

  if (!changed) return result;
  return next;
}