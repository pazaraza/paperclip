/**
 * hermes_local session-id format guard (RUAAAAA-5244).
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