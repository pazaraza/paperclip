/**
 * hermes_local session-id format guard (RUAAAAA-5244) and session-contention
 * recovery (RUAAAAA-5296).
 *
 * Ported onto the reconciled master in RUAAAAA-5418. Upstream moved the hermes
 * adapter in-tree at `packages/adapters/hermes` (0.3.1), so the guard is now
 * wired *around* the vendored adapter in `server/src/adapters/registry.ts`
 * rather than around the old in-tree adapter. The upstream adapter
 * construction is left intact; this module only wraps it.
 *
 * ── Why the session-id guard exists ─────────────────────────────────────
 *
 * Hermes Agent mints every session id in the shape
 * `<YYYYMMDD>_<HHMMSS>_<suffix>` (e.g. `20260706_234011_dc2cf9`).
 * Nothing else is a session id.
 *
 * The adapter scrapes the id out of hermes stdout/stderr with
 * `SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i`,
 * which happily captures the next prose word. "Session saved from the previous
 * run" yields `sessionId: "from"`. The adapter's own codec only checks
 * non-empty, so the garbage word used to land in
 * `agent_task_sessions.session_params_json` / `agent_runtime_state.session_id`
 * and the next run shelled out `hermes --resume from`.
 *
 * This module is the server-side choke point: it fails closed. A value that
 * does not match the shape is never persisted, never displayed, and never
 * handed back to the adapter as a resume target.
 */
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterSessionCodec,
} from "@paperclipai/adapter-utils";

/**
 * The canonical shape of a hermes session id.
 *
 * This is deliberately the *same* rule upstream master already enforces for
 * `hermes_local` in `server/src/services/heartbeat/run-state.ts`
 * (`isCanonicalSessionIdForAdapter`). That module imports this constant so
 * there is a single source of truth.
 *
 * The guard must never be *stricter* than the rule the server applies. A
 * stricter codec would reject session ids the server considers valid and
 * silently break `hermes --resume` continuity, because the session would be
 * dropped after every run (the agent would restart from scratch forever).
 * The upstream rule is therefore a superset of hermes' documented shape, and
 * this guard uses it verbatim.
 *
 * Accepted:
 *  - `<YYYYMMDD>_<HHMMSS>_<suffix>` with a suffix of at least four word
 *    characters (hermes' documented shape is six lowercase hex:
 *    `20260706_234011_dc2cf9`)
 *  - a canonical UUID
 *
 * Rejected: prose words captured by hermes' legacy stdout parser (`from`,
 * `to`, `previous`), the truncated display form `20260706_234011_`,
 * empty strings, and anything else.
 */
export const HERMES_SESSION_ID_PATTERN =
  /^(?:\d{8}_\d{6}_[A-Za-z0-9_-]{4,}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

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

/** True when the captured child output shows the session-contention refusal. */
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
 *
 * The vendored adapter reports `sessionDisplayId` as `sessionId.slice(0, 16)`
 * (`20260706_234011_`). That truncated form is not a session id, so it is
 * cleared here — exactly as upstream's canonical-session-id rule already
 * treats it. Upstream then falls back to the full session id from
 * `sessionParams` for the display id, so nothing is lost.
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

/** Upper bound on the child's stderr kept for refusal detection. */
export const HERMES_STDERR_CAPTURE_LIMIT = 16 * 1024;

export type HermesSessionGuardHooks = {
  /** Called when the adapter reported a session id that is not a hermes session id. */
  onRejectedSessionId?: (info: { agentId: string; runId: string; sessionId: string }) => void;
  /** Called when the child refused the pinned session (SESSION_NOT_OWNED). */
  onSessionContention?: (info: { agentId: string; runId: string }) => void;
};

/**
 * Wrap a hermes_local `execute` so the guard actually runs.
 *
 * Two things happen around the vendored adapter:
 *
 * 1. **Session-id guard (RUAAAAA-5244).** The adapter result is run through
 *    `sanitizeHermesExecutionResult`, so a malformed id (`"from"`) is dropped
 *    before the server can persist it into `agent_task_sessions` /
 *    `agent_runtime_state`. Upstream's server-side canonical-session-id rule
 *    already refuses to persist such an id; this closes the same hole at the
 *    adapter boundary and makes the rejection observable in the logs.
 *
 * 2. **Session-contention recovery (RUAAAAA-5296).** The vendored adapter does
 *    not surface the child's stderr on the result, and its own parser only
 *    keeps stderr lines matching /error|exception|traceback|failed/i — which
 *    the `SESSION_NOT_OWNED` refusal matches none of. So a bounded copy of the
 *    child's stderr is captured through `ctx.onLog` and matched against the
 *    refusal pattern. On a match the result gets `clearSession: true` and the
 *    distinct `session_not_owned` error code, which makes
 *    `resolveNextSessionState()` return nulls so the server calls
 *    `clearTaskSessions()` and the next dispatch starts a fresh session
 *    instead of re-pinning the refused one.
 */
export function createGuardedHermesLocalExecute(
  baseExecute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>,
  hooks: HermesSessionGuardHooks = {},
): (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult> {
  return async (ctx) => {
    const agentId = ctx.agent?.id ?? "unknown";
    const runId = ctx.runId ?? "unknown";

    let capturedStderr = "";
    const patchedCtx: AdapterExecutionContext = {
      ...ctx,
      onLog: async (stream, chunk) => {
        if (stream === "stderr" && capturedStderr.length < HERMES_STDERR_CAPTURE_LIMIT) {
          capturedStderr += chunk;
        }
        await ctx.onLog?.(stream, chunk);
      },
    };

    const raw = await baseExecute(patchedCtx);

    if (typeof raw?.sessionId === "string" && !isHermesSessionId(raw.sessionId)) {
      hooks.onRejectedSessionId?.({ agentId, runId, sessionId: raw.sessionId });
    }

    const sanitized = sanitizeHermesExecutionResult(raw);
    const recovered = applyHermesSessionContentionRecovery(sanitized, capturedStderr);
    if (recovered.clearSession) {
      hooks.onSessionContention?.({ agentId, runId });
    }
    return recovered;
  };
}
