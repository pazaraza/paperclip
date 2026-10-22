import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeServiceReport,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import crypto, { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

type SessionKeyStrategy = "fixed" | "issue" | "run";

type WakePayload = {
  runId: string;
  agentId: string;
  companyId: string;
  taskId: string | null;
  issueId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  issueIds: string[];
};

type GatewayDeviceIdentity = {
  deviceId: string;
  publicKeyRawBase64Url: string;
  privateKeyPem: string;
  source: "configured" | "ephemeral";
};

type GatewayRequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
};

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  expectFinal: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

type GatewayResponseError = Error & {
  gatewayCode?: string;
  gatewayDetails?: Record<string, unknown>;
  /**
   * Postgres-specific conflict identity promoted out of `gatewayDetails` by
   * `handleMessage` (RUAAAAA-5209). Present only when both a 5-digit SQLSTATE
   * `code` and a `constraint` name were recoverable from the error frame, so
   * `isRoutineExecutionOpenConflict` can recognise a real constraint
   * violation that travelled through the gateway instead of falling back to
   * 'generic wake error'.
   */
  postgresCode?: string;
  postgresConstraint?: string;
};

type GatewayClientOptions = {
  url: string;
  headers: Record<string, string>;
  onEvent: (frame: GatewayEventFrame) => Promise<void> | void;
  onLog: AdapterExecutionContext["onLog"];
};

type GatewayClientRequestOptions = {
  timeoutMs: number;
  expectFinal?: boolean;
};

const PROTOCOL_VERSION = 4;
const DEFAULT_SCOPES = ["operator.admin"];
const DEFAULT_CLIENT_ID = "gateway-client";
const DEFAULT_CLIENT_MODE = "backend";
const DEFAULT_CLIENT_VERSION = "paperclip";
const DEFAULT_ROLE = "operator";

// RUAAAAA-5062: cooldown-aware retry/backoff for openclaw_gateway.
const COOLDOWN_ERROR_PATTERNS: RegExp[] = [
  /provider\s+([\w.-]+)\s+is in cooldown/i,
  /provider\s+([\w.-]+)\s+is in cooldown\s*\(([^)]+)\)/i,
  /auth profile\s+'([^']+)'\s+is temporarily unavailable/i,
  /billing\s+cooldown\s+(?:until|expires?\s+at)\s+([\w:./+-]+)/i,
  /(?<![\w-])cooldown(?![\w-])/i,
];

const COOLDOWN_BACKOFF_SEQUENCE_DEFAULT_MS = [30_000, 60_000, 120_000];
const COOLDOWN_BACKOFF_MIN_MS = 100;
const COOLDOWN_BACKOFF_MAX_MS = 10 * 60_000;
const COOLDOWN_WAIT_SLICE_DEFAULT_MS = 30_000;
// RUAAAAA-5199: slack slices allowed past the nominal waitTimeoutMs/sliceMs ratio so a slow-but-alive
// gateway can still finish, while a gateway that returns `timeout` instantly can never spin forever.
export const WAIT_SLICE_OVERRUN_SLACK = 4;
export const WAIT_SLICE_MIN_SLICES = 4;
// RUAAAAA-5256: admission-control feedback. When the gateway is over-committed it ACCEPTS the
// dispatch but never STARTS it, and every `agent.wait` slice comes back as
// `{status:"timeout", timeoutPhase:"queue"|"gateway_draining", providerStarted:false}`.
// RUAAAAA-5199 taught the loop to keep polling those non-terminal `timeout` slices, which is
// correct for a slow-but-alive run and catastrophic for a queued one: every saturated dispatch
// burned the whole `waitTimeoutMs` (600s) and then died as `timed_out`, which in turn fired a
// `stranded_assigned_issue` recovery action. So probe the queue on a short slice while the run
// has still never started, and give up fast with a distinct `openclaw_gateway_saturated` code.
const SATURATED_PROBE_SLICE_DEFAULT_MS = 5_000;
const SATURATED_PROBE_SLICE_MIN_MS = 1_000;
const SATURATED_MIN_QUEUED_SLICES_DEFAULT = 3;
const SATURATED_RETRY_DELAY_DEFAULT_MS = 120_000;
const SATURATED_RETRY_DELAY_MAX_MS = 60 * 60_000;

export function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return null;
}

export function parseCooldownBackoffSequence(value: unknown): number[] {
  if (Array.isArray(value)) {
    const out = value.map(parsePositiveInteger).filter((n): n is number => n !== null && n >= COOLDOWN_BACKOFF_MIN_MS);
    return out.length > 0 ? out.map((n) => Math.min(n, COOLDOWN_BACKOFF_MAX_MS)) : [...COOLDOWN_BACKOFF_SEQUENCE_DEFAULT_MS];
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const out = value.split(",").map((s) => parsePositiveInteger(s.trim())).filter((n): n is number => n !== null && n >= COOLDOWN_BACKOFF_MIN_MS);
    return out.length > 0 ? out.map((n) => Math.min(n, COOLDOWN_BACKOFF_MAX_MS)) : [...COOLDOWN_BACKOFF_SEQUENCE_DEFAULT_MS];
  }
  return [...COOLDOWN_BACKOFF_SEQUENCE_DEFAULT_MS];
}

export type WaitSliceDecision = "done" | "cooldown_check" | "error" | "unexpected";

/**
 * RUAAAAA-5199: classify one `agent.wait` slice response.
 *
 * A slice that reports `timeout` (or omits `status`) has simply outlived its own window while the
 * run stayed in flight — it is NOT terminal. Only `error` and genuinely unknown statuses are
 * terminal; the aggregate `waitTimeoutMs` budget, not an individual slice, decides a real timeout.
 */
export function classifyWaitSliceStatus(status: unknown): WaitSliceDecision {
  const s = nonEmpty(typeof status === "string" ? status : undefined)?.toLowerCase() ?? "";
  if (s === "ok") return "done";
  if (s === "timeout" || s === "") return "cooldown_check";
  if (s === "error") return "error";
  return "unexpected";
}

export type WaitSliceSaturation = {
  /** True when this payload proves the gateway accepted the run but never started it. */
  saturated: boolean;
  reason: "queued_not_started" | "gateway_draining" | "explicit_saturated" | null;
  timeoutPhase: string | null;
  providerStarted: boolean;
  /**
   * RUAAAAA-5280: whether the gateway actually reported a `providerStarted` field. `queue`
   * slices carry it; `gateway_draining` slices deliberately OMIT it. Absence means unknown,
   * never "not started".
   */
  providerStartedKnown: boolean;
  status: string | null;
};

/**
 * RUAAAAA-5256: decide whether one `agent`/`agent.wait` payload is an admission-control signal
 * (the gateway is saturated) rather than a merely-slow run.
 *
 * The gateway answers an over-committed dispatch with a queued-but-unstarted run instead of an
 * error, so there is no failure text to grep: the only proof is `providerStarted !== true`
 * combined with a queue/draining `timeoutPhase` (or an explicit `saturated` code). A started run
 * — even one that outlives its slice — must keep polling, so this never fires on
 * `providerStarted: true`, on a payload that carries `endedAt`/`stopReason`, or on a bare
 * `status: "timeout"` with no queue evidence at all (that is the RUAAAAA-5199 slow-run case).
 */
export function detectWaitSliceSaturation(payload: unknown): WaitSliceSaturation {
  const record = asRecord(payload);
  const status = nonEmpty(record?.status)?.toLowerCase() ?? null;
  const timeoutPhase = nonEmpty(record?.timeoutPhase)?.toLowerCase() ?? null;
  const code = nonEmpty(record?.code)?.toLowerCase() ?? null;
  const providerStartedKnown = typeof record?.providerStarted === "boolean";
  const providerStarted = record?.providerStarted === true;
  const finished =
    nonEmpty(record?.endedAt) !== null ||
    nonEmpty(record?.stopReason) !== null ||
    status === "ok" ||
    status === "error";
  const base: WaitSliceSaturation = {
    saturated: false,
    reason: null,
    timeoutPhase,
    providerStarted,
    providerStartedKnown,
    status,
  };

  if (code === "saturated" || status === "saturated") {
    return { ...base, saturated: true, reason: "explicit_saturated" };
  }
  if (finished || providerStarted) return base;

  // RUAAAAA-5280: `queue` genuinely means "accepted but parked" — that is the over-commit
  // signature RUAAAAA-5256 was opened for, and it holds whether or not the flag is present.
  if (status === "pending" || timeoutPhase === "queue") {
    return { ...base, saturated: true, reason: "queued_not_started" };
  }

  // RUAAAAA-5280: `gateway_draining` is NOT a non-start signal. The gateway only emits this
  // phase when an active chat entry IS registered but its snapshot is not published yet
  // (`waitForTurn`: `...activeRunRegistered ? {} : { providerStarted: false }`) — it omits the
  // flag exactly when the run is alive. Treating the absent field as "never started" made every
  // healthy dispatch look saturated and drove the fleet to 0% success from 20:22:44Z to 21:33Z.
  // Require an explicit `providerStarted: false` before believing a drain.
  if (timeoutPhase === "gateway_draining" && providerStartedKnown && !providerStarted) {
    return { ...base, saturated: true, reason: "gateway_draining" };
  }
  return base;
}

/** RUAAAAA-5256: clamp an operator-supplied saturation knob into a sane range. */
export function parseSaturatedDuration(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = parsePositiveInteger(value);
  if (parsed === null) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function parseSaturatedMinQueuedSlices(value: unknown): number {
  const parsed = parsePositiveInteger(value);
  if (parsed === null) return SATURATED_MIN_QUEUED_SLICES_DEFAULT;
  return Math.max(1, Math.min(20, parsed));
}

type CooldownSignal = { detected: boolean; provider?: string; reason?: string; untilMs?: number; untilIso?: string; };

export function detectCooldownSignal(messages: Array<string | null | undefined>): CooldownSignal {
  for (const raw of messages) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    const hasInCooldown = /provider\s+[\w.-]+\s+is in cooldown/i.test(raw);
    const hasAuthProfile = /auth profile\s+'[^']+'\s+is temporarily unavailable/i.test(raw);
    const hasBilling = /billing\s+cooldown/i.test(raw) || /\(\s*billing\s*\)/i.test(raw);
    const hasGenericCooldown = /(?<![\w-])cooldown(?![\w-])/i.test(raw) && /(provider|model|account)/i.test(raw);
    if (hasInCooldown || hasAuthProfile || hasBilling || hasGenericCooldown) {
      let provider: string | undefined;
      const providerMatch = raw.match(/provider\s+([\w.-]+)\s+is in cooldown/i);
      if (providerMatch) provider = providerMatch[1];
      const profileMatch = raw.match(/auth profile\s+'([^']+)'/i);
      if (!provider && profileMatch) provider = profileMatch[1];
      let untilMs: number | undefined, untilIso: string | undefined;
      const isoMatch = raw.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/);
      if (isoMatch) {
        const parsed = Date.parse(isoMatch[1]);
        if (Number.isFinite(parsed)) { untilMs = parsed; untilIso = new Date(parsed).toISOString(); }
      }
      const secondsMatch = raw.match(/in\s+(\d+)\s*seconds?/i);
      if (!untilMs && secondsMatch) {
        const secs = Number.parseInt(secondsMatch[1], 10);
        if (Number.isFinite(secs)) { untilMs = Date.now() + Math.max(0, secs) * 1000; untilIso = new Date(untilMs).toISOString(); }
      }
      return { detected: true, provider, reason: hasAuthProfile ? "auth_profile_unavailable" : hasBilling ? "billing_cooldown" : "provider_cooldown", untilMs, untilIso };
    }
  }
  return { detected: false };
}

function clampCooldownBackoffToBudget(backoffMs: number, remainingBudgetMs: number): number {
  if (!Number.isFinite(backoffMs) || backoffMs <= 0) return 0;
  if (remainingBudgetMs <= 0) return 0;
  return Math.min(backoffMs, Math.max(0, remainingBudgetMs));
}

function backoffForAttempt(sequence: number[], attemptIndex: number): number {
  if (sequence.length === 0) return COOLDOWN_BACKOFF_SEQUENCE_DEFAULT_MS[0];
  const idx = Math.max(0, Math.min(attemptIndex, sequence.length - 1));
  return sequence[idx];
}

/**
 * RUAAAAA-5256: shape the saturated verdict.
 *
 * `timedOut: false` is the load-bearing part — a saturated run is a real failure of *admission*,
 * not of *execution*, and marking it `timedOut` is what produced 600s `timed_out` runs and the
 * `stranded_assigned_issue` recovery actions that followed them. `errorFamily: transient_upstream`
 * is what makes `issue_recovery` retry it cleanly with backoff rather than treating it as a dead
 * agent; `retryNotBefore` supplies the floor for that backoff.
 */
export function buildSaturatedResult(input: {
  stage: "dispatch" | "wait";
  reason: string;
  payload: Record<string, unknown> | null;
  elapsedMs: number;
  sliceCount: number;
  waitTimeoutMs: number;
  retryDelayMs: number;
  /**
   * RUAAAAA-5299: the gateway run id still owned by the gateway when the wait was abandoned.
   * Non-null means the session survived this fail-fast and may still execute to completion, so the
   * caller must not treat the run as terminally failed.
   */
  liveSessionRunId: string | null;
}): AdapterExecutionResult {
  const retryNotBefore = new Date(Date.now() + input.retryDelayMs).toISOString();
  // RUAAAAA-5299: both cited instances were `stage=wait` abandonments of a session the gateway
  // still owned. The run row went terminal `failed` at the fail-fast while the session went on to
  // finish the work, and the bounded retry fired against the superseded snapshot. Saying so
  // explicitly here is what lets the server keep the run non-terminal and hold the issue lock.
  const sessionLive = input.liveSessionRunId !== null;
  const message =
    `OpenClaw gateway saturated: dispatch accepted but never provider-started ` +
    `(stage=${input.stage} reason=${input.reason} elapsed=${input.elapsedMs}ms slices=${input.sliceCount} ` +
    `waitTimeoutMs=${input.waitTimeoutMs}ms); failing fast instead of waiting out the full budget` +
    (sessionLive ? `; abandoned wait only, gateway session ${input.liveSessionRunId} is still live` : "");
  const evidence = {
    saturation: {
      stage: input.stage,
      reason: input.reason,
      elapsedMs: input.elapsedMs,
      sliceCount: input.sliceCount,
      waitTimeoutMs: input.waitTimeoutMs,
      retryDelayMs: input.retryDelayMs,
      retryNotBefore,
      sessionLive,
      liveSessionRunId: input.liveSessionRunId,
    },
  };
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: message,
    errorCode: "openclaw_gateway_saturated",
    errorFamily: "transient_upstream",
    retryNotBefore,
    errorMeta: evidence,
    sessionLive,
    liveSessionRunId: input.liveSessionRunId,
    resultJson: { ...(input.payload ?? {}), ...evidence },
  };
}

/**
 * RUAAAAA-5302: which limit ended the wait loop.
 *
 * RUAAAAA-5302 exists because the old timeout message could not be reconciled with itself:
 * `elapsed 136182ms across 24 polling slice(s) of 30000ms` against a `waitTimeoutMs=600000ms`
 * budget is arithmetically impossible in three directions at once. It was not a formatting bug —
 * it was the visible symptom of the slice cap firing early (see the `maxSlices` comment), and it
 * left an operator unable to tell a slow run from a stuck one. An operator reads this string to
 * decide whether to wait or intervene, so it now names the cadence actually used and the limit
 * actually reached instead of asserting a nominal slice that may never have been used.
 */
export type WaitEndReason = "budget" | "slice_cap";

export function buildWaitTimeoutResult(input: {
  payload: Record<string, unknown> | null;
  elapsedMs: number;
  sliceCount: number;
  maxSlices: number;
  waitTimeoutMs: number;
  /** Nominal full-cadence slice. */
  waitSliceMs: number;
  /** Probe slice used until the run reports provider-started. */
  probeSliceMs: number;
  providerEverStarted: boolean;
  endReason: WaitEndReason;
  cooldownSignal: CooldownSignal | null;
  cooldownAttempts: number;
  cooldownBackoffSequenceMs: number[];
  liveSessionRunId: string | null;
}): AdapterExecutionResult {
  const sessionLive = input.liveSessionRunId !== null;
  const cooldown = input.cooldownSignal;
  // Report the cadence the loop could actually use. Pre-provider-start slices run on
  // `min(waitSliceMs, probeSliceMs)`; after provider-start they run on the full nominal slice.
  const shortestSliceMs = Math.max(1, Math.min(input.waitSliceMs, input.probeSliceMs));
  const cadence = input.providerEverStarted
    ? `${input.waitSliceMs}ms`
    : `${shortestSliceMs}-${input.waitSliceMs}ms probe cadence (run never reported provider-started)`;
  // Name the limit that ended the loop. `slice_cap` reached while budget remained is exactly the
  // truncation that produced the unreconcilable string in the first place; saying so out loud is
  // what lets an operator tell "slow" from "cut short".
  // Only two endings are distinguishable here. A run that ran out of budget *while sleeping
  // through provider cooldown* also lands on `budget`, but that is already unambiguous in the
  // message: `cooldownSignal` is set, and the message says the cooldown ended it.
  const endedBy =
    input.endReason === "slice_cap"
      ? `ended when the wait slice cap (${input.maxSlices} slices) was reached after ${input.elapsedMs}ms, ` +
        `BEFORE the ${input.waitTimeoutMs}ms budget was spent`
      : `ended when the ${input.waitTimeoutMs}ms wait budget was spent`;
  const messageParts = cooldown
    ? [
        `OpenClaw gateway run timed out after ${input.waitTimeoutMs}ms while provider "${cooldown.provider ?? "unknown"}" was in cooldown (${cooldown.reason ?? "unknown"})`,
        cooldown.untilIso ? `cooldownUntilIso=${cooldown.untilIso}` : null,
        `cooldownAttempts=${input.cooldownAttempts}`,
        endedBy,
      ].filter((e): e is string => Boolean(e))
    : [
        `OpenClaw gateway run did not complete within waitTimeoutMs=${input.waitTimeoutMs}ms (elapsed ${input.elapsedMs}ms across ${input.sliceCount} polling slice(s), ${cadence}; ${endedBy}; no cooldown signal in slice response or lifecycle stream)`,
        `lastSliceStatus=${nonEmpty(asRecord(input.payload)?.status)?.toLowerCase() ?? "none"}`,
      ];
  // RUAAAAA-5302: an operator reading this string in the run log has to be able to tell "the
  // session died" from "we stopped watching". `timed_out` says neither on its own, so say it here
  // rather than making them go read `sessionLive` out of resultJson.
  if (sessionLive) {
    messageParts.push(`wait abandoned only, gateway session ${input.liveSessionRunId} is still live`);
  }
  const evidence = {
    waitTimeout: {
      sessionLive,
      liveSessionRunId: input.liveSessionRunId,
      endReason: input.endReason,
      elapsedMs: input.elapsedMs,
      sliceCount: input.sliceCount,
      maxSlices: input.maxSlices,
      waitTimeoutMs: input.waitTimeoutMs,
      waitSliceMs: input.waitSliceMs,
      probeSliceMs: input.probeSliceMs,
      providerEverStarted: input.providerEverStarted,
      budgetExhausted: input.endReason !== "slice_cap",
      cooldownAttempts: input.cooldownAttempts,
      cooldownBackoffSequenceMs: input.cooldownBackoffSequenceMs,
    },
  };
  return {
    exitCode: 1,
    signal: null,
    // RUAAAAA-5302: this stays `true`. The run genuinely did exhaust the wait budget, and the
    // `timed_out` record is the honest history of the adapter. What was NOT true is that the
    // session was dead — see `sessionLive`. The server consults `sessionLive` first, so the run is
    // held non-terminal and reconciled instead of being failed and retried.
    timedOut: true,
    errorMessage: messageParts.join("; "),
    errorCode: cooldown ? "openclaw_gateway_wait_timeout_in_cooldown" : "openclaw_gateway_wait_timeout",
    sessionLive,
    liveSessionRunId: input.liveSessionRunId,
    errorMeta: evidence,
    resultJson: {
      ...asRecord(input.payload),
      ...evidence,
      ...(cooldown
        ? {
            cooldown: {
              provider: cooldown.provider ?? null,
              reason: cooldown.reason ?? null,
              untilIso: cooldown.untilIso ?? null,
              untilMs: cooldown.untilMs ?? null,
              attempts: input.cooldownAttempts,
              backoffSequenceMs: input.cooldownBackoffSequenceMs,
            },
          }
        : {}),
    },
  };
}

/**
 * RUAAAAA-5302: the exhausted-cooldown give-up.
 *
 * `cooldownAttempts >= backoffSequence.length` abandons a run that is sitting in *provider
 * cooldown* — a transient state the gateway itself reported — not a run that is dead. The gateway
 * still owns it. Writing a terminal failure here lets the bounded retry scheduler queue a retry
 * against a run the provider is still holding, which is the RUAAAAA-5299 defect one branch over.
 *
 * Gated on the gateway-issued run id exactly like the saturation path: a `ctx.runId` fallback is
 * our own bookkeeping id and says nothing about whether a provider session exists.
 */
export function buildCooldownExhaustedResult(input: {
  payload: Record<string, unknown> | null;
  waitTimeoutMs: number;
  cooldownSignal: CooldownSignal;
  cooldownAttempts: number;
  cooldownBackoffSequenceMs: number[];
  liveSessionRunId: string | null;
}): AdapterExecutionResult {
  const sessionLive = input.liveSessionRunId !== null;
  const evidence = {
    cooldownExhausted: {
      sessionLive,
      liveSessionRunId: input.liveSessionRunId,
      provider: input.cooldownSignal.provider ?? null,
      reason: input.cooldownSignal.reason ?? null,
      untilIso: input.cooldownSignal.untilIso ?? null,
      untilMs: input.cooldownSignal.untilMs ?? null,
      attempts: input.cooldownAttempts,
      backoffSequenceMs: input.cooldownBackoffSequenceMs,
    },
  };
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage:
      `OpenClaw gateway run in cooldown: Provider "${input.cooldownSignal.provider ?? "unknown"}" ` +
      `reason=${input.cooldownSignal.reason ?? "unknown"} ` +
      `${input.cooldownSignal.untilIso ? `cooldownUntilIso=${input.cooldownSignal.untilIso}` : ""} ` +
      `cooldownAttempts=${input.cooldownAttempts} (backoff sequence exhausted against waitTimeoutMs=${input.waitTimeoutMs}ms)` +
      (sessionLive
        ? `; gave up waiting only, gateway session ${input.liveSessionRunId} is still live in provider cooldown`
        : ""),
    errorCode: "openclaw_gateway_wait_cooldown",
    // RUAAAAA-5302: deliberately NOT `transient_upstream`, even though the saturation path uses it.
    // That flag reroutes the run into the bounded backoff retry, which is the right treatment for a
    // cooldown — but this path's non-live case previously went through the stranded-issue recovery
    // route, and RUAAAAA-5294 buckets these codes. Changing retry routing is a policy call that
    // belongs with the drain-budget decision this issue escalates, not a side effect of marking a
    // live session. Raised there rather than smuggled in here.
    sessionLive,
    liveSessionRunId: input.liveSessionRunId,
    errorMeta: evidence,
    resultJson: {
      ...asRecord(input.payload),
      ...evidence,
      cooldown: {
        provider: input.cooldownSignal.provider ?? null,
        reason: input.cooldownSignal.reason ?? null,
        untilIso: input.cooldownSignal.untilIso ?? null,
        untilMs: input.cooldownSignal.untilMs ?? null,
        attempts: input.cooldownAttempts,
        backoffSequenceMs: input.cooldownBackoffSequenceMs,
      },
    },
  };
}


const SENSITIVE_LOG_KEY_PATTERN =
  /(^|[_-])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key)([_-]|$)|^x-openclaw-(auth|token)$/i;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return Math.max(1, Math.floor(parsed));
  }
  return null;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const normalized = asString(value, "issue").trim().toLowerCase();
  if (normalized === "fixed" || normalized === "run") return normalized;
  return "issue";
}

function prefixSessionKeyForAgent(sessionKey: string, agentId: string | null): string {
  if (!agentId || sessionKey.startsWith("agent:")) return sessionKey;
  return `agent:${agentId}:${sessionKey}`;
}

export function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  configuredSessionKey: string | null;
  agentId: string | null;
  runId: string;
  issueId: string | null;
}): string {
  const fallback = input.configuredSessionKey ?? "paperclip";
  if (input.strategy === "run") {
    return prefixSessionKeyForAgent(`paperclip:run:${input.runId}`, input.agentId);
  }
  if (input.strategy === "issue" && input.issueId) {
    return prefixSessionKeyForAgent(`paperclip:issue:${input.issueId}`, input.agentId);
  }
  return prefixSessionKeyForAgent(fallback, input.agentId);
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeScopes(value: unknown): string[] {
  const parsed = toStringArray(value);
  return parsed.length > 0 ? parsed : [...DEFAULT_SCOPES];
}

function uniqueScopes(scopes: string[]): string[] {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));
}

function headerMapGetIgnoreCase(headers: Record<string, string>, key: string): string | null {
  const match = Object.entries(headers).find(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase());
  return match ? match[1] : null;
}

function headerMapHasIgnoreCase(headers: Record<string, string>, key: string): boolean {
  return Object.keys(headers).some((entryKey) => entryKey.toLowerCase() === key.toLowerCase());
}

function getGatewayErrorDetails(err: unknown): Record<string, unknown> | null {
  if (!err || typeof err !== "object") return null;
  const candidate = (err as GatewayResponseError).gatewayDetails;
  return asRecord(candidate);
}

/**
 * Extract a Postgres-style conflict pair (`code: "23505"` + `constraint: ...`)
 * from a gateway error's `details` payload. The OpenClaw gateway passes
 * Paperclip-side error metadata through the JSON-RPC error frame's
 * `error.details` bag, so the unique-constraint identifiers we need live
 * either at the top level of `details` or one nesting level deep.
 *
 * Companion to `isRoutineExecutionOpenConflict` in
 * `server/src/services/issue-assignment-wakeup.ts`: the wakeup-recorder
 * path recognises the contention by reading top-level `code` and
 * `constraint` on the thrown error. The gateway's `handleResponse` does
 * NOT promote those into the surfaced error today (it surfaces only
 * `gatewayCode` + `gatewayDetails`), so callers that want the
 * server-side recognition to fire have to call this helper and use the
 * result explicitly. This helper is the regression-testable surface.
 *
 * Returns `{ code, constraint }`, either field being `null` if not present.
 */
export function extractPostgresConflictInfo(
  errorDetails: unknown,
): { code: string | null; constraint: string | null } {
  const record = asRecord(errorDetails);
  if (!record) return { code: null, constraint: null };

  const topCode = nonEmpty(record.code);
  const topConstraint = nonEmpty(record.constraint);
  if (topCode === "23505" && topConstraint) {
    return { code: topCode, constraint: topConstraint };
  }

  // The postgres error may be nested under a key like `pgError`, `cause`,
  // or `error`. Look one level deep so the wake recorder can still match.
  for (const nested of [record.pgError, record.cause, record.error, record.postgres]) {
    const nestedRecord = asRecord(nested);
    if (!nestedRecord) continue;
    const code = nonEmpty(nestedRecord.code);
    const constraint = nonEmpty(nestedRecord.constraint);
    if (code === "23505" && constraint) {
      return { code, constraint };
    }
  }

  return { code: topCode, constraint: topConstraint };
}

function extractPairingRequestId(err: unknown): string | null {
  const details = getGatewayErrorDetails(err);
  const fromDetails = nonEmpty(details?.requestId);
  if (fromDetails) return fromDetails;
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/requestId\s*[:=]\s*([A-Za-z0-9_-]+)/i);
  return match?.[1] ?? null;
}

function toAuthorizationHeaderValue(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (!trimmed) return trimmed;
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function tokenFromAuthHeader(rawHeader: string | null): string | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^bearer\s+(.+)$/i);
  return match ? nonEmpty(match[1]) : trimmed;
}

function resolveAuthToken(config: Record<string, unknown>, headers: Record<string, string>): string | null {
  const explicit = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  if (explicit) return explicit;

  const tokenHeader = headerMapGetIgnoreCase(headers, "x-openclaw-token");
  if (nonEmpty(tokenHeader)) return nonEmpty(tokenHeader);

  const authHeader =
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    headerMapGetIgnoreCase(headers, "authorization");
  return tokenFromAuthHeader(authHeader);
}

function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_LOG_KEY_PATTERN.test(key.trim());
}

function sha256Prefix(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function redactSecretForLog(value: string): string {
  return `[redacted len=${value.length} sha256=${sha256Prefix(value)}]`;
}

function truncateForLog(value: string, maxChars = 320): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function redactForLog(value: unknown, keyPath: string[] = [], depth = 0): unknown {
  const currentKey = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (isSensitiveLogKey(currentKey)) return redactSecretForLog(value);
    return truncateForLog(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 6) return "[array-truncated]";
    const out = value.slice(0, 20).map((entry, index) => redactForLog(entry, [...keyPath, `${index}`], depth + 1));
    if (value.length > 20) out.push(`[+${value.length - 20} more items]`);
    return out;
  }
  if (typeof value === "object") {
    if (depth >= 6) return "[object-truncated]";
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, 80)) {
      out[key] = redactForLog(entry, [...keyPath, key], depth + 1);
    }
    if (entries.length > 80) {
      out.__truncated__ = `+${entries.length - 80} keys`;
    }
    return out;
  }
  return String(value);
}

function stringifyForLog(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function buildWakePayload(ctx: AdapterExecutionContext): WakePayload {
  const { runId, agent, context } = ctx;
  return {
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
    taskId: nonEmpty(context.taskId) ?? nonEmpty(context.issueId),
    issueId: nonEmpty(context.issueId),
    wakeReason: nonEmpty(context.wakeReason),
    wakeCommentId: nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId),
    approvalId: nonEmpty(context.approvalId),
    approvalStatus: nonEmpty(context.approvalStatus),
    issueIds: Array.isArray(context.issueIds)
      ? context.issueIds.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [],
  };
}

function resolvePaperclipApiUrlOverride(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export const DEFAULT_CLAIMED_API_KEY_PATH = '$OPENCLAW_AGENT_DIR/../paperclip-claimed-api-key.json';

export function resolveClaimedApiKeyPath(value: unknown): string {
  return nonEmpty(value) ?? DEFAULT_CLAIMED_API_KEY_PATH;
}

function buildPaperclipEnvForWake(ctx: AdapterExecutionContext, wakePayload: WakePayload): Record<string, string> {
  const paperclipApiUrlOverride = resolvePaperclipApiUrlOverride(ctx.config.paperclipApiUrl);
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
  };

  if (paperclipApiUrlOverride) {
    paperclipEnv.PAPERCLIP_API_URL = paperclipApiUrlOverride;
  }
  if (wakePayload.taskId) paperclipEnv.PAPERCLIP_TASK_ID = wakePayload.taskId;
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(ctx.context);
  if (issueWorkMode) paperclipEnv.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakePayload.wakeReason) paperclipEnv.PAPERCLIP_WAKE_REASON = wakePayload.wakeReason;
  if (wakePayload.wakeCommentId) paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID = wakePayload.wakeCommentId;
  if (wakePayload.approvalId) paperclipEnv.PAPERCLIP_APPROVAL_ID = wakePayload.approvalId;
  if (wakePayload.approvalStatus) paperclipEnv.PAPERCLIP_APPROVAL_STATUS = wakePayload.approvalStatus;
  if (wakePayload.issueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = wakePayload.issueIds.join(",");
  }

  return paperclipEnv;
}

function buildWakeText(
  payload: WakePayload,
  paperclipEnv: Record<string, string>,
  structuredWakePrompt: string,
  claimedApiKeyPath: string,
): string {
  const orderedKeys = [
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_AGENT_ID",
    "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_TASK_ID",
    "PAPERCLIP_WAKE_REASON",
    "PAPERCLIP_WAKE_COMMENT_ID",
    "PAPERCLIP_APPROVAL_ID",
    "PAPERCLIP_APPROVAL_STATUS",
    "PAPERCLIP_LINKED_ISSUE_IDS",
  ];

  const envLines: string[] = [];
  for (const key of orderedKeys) {
    const value = paperclipEnv[key];
    if (!value) continue;
    envLines.push(`${key}=${value}`);
  }

  const issueIdHint = payload.taskId ?? payload.issueId ?? "";
  const apiBaseHint = paperclipEnv.PAPERCLIP_API_URL ?? "<set PAPERCLIP_API_URL>";

  const lines = [
    "Paperclip wake event for a cloud adapter.",
    "",
    "Run this procedure now. Do not guess undocumented endpoints and do not ask for additional heartbeat docs.",
    "",
    "Set these values in your run context:",
    ...envLines,
    `PAPERCLIP_API_KEY=<token from ${claimedApiKeyPath}>`,
    "",
    `Load PAPERCLIP_API_KEY from ${claimedApiKeyPath} (the token you saved after claim-api-key).`,
    "",
    `api_base=${apiBaseHint}`,
    `task_id=${payload.taskId ?? ""}`,
    `issue_id=${payload.issueId ?? ""}`,
    `wake_reason=${payload.wakeReason ?? ""}`,
    `wake_comment_id=${payload.wakeCommentId ?? ""}`,
    `approval_id=${payload.approvalId ?? ""}`,
    `approval_status=${payload.approvalStatus ?? ""}`,
    `linked_issue_ids=${payload.issueIds.join(",")}`,
    "",
    "HTTP rules:",
    "- Use Authorization: Bearer $PAPERCLIP_API_KEY on every API call.",
    "- Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every mutating API call.",
    "- Use only /api endpoints listed below.",
    "- Do NOT call guessed endpoints like /api/cloud-adapter/*, /api/cloud-adapters/*, /api/adapters/cloud/*, or /api/heartbeat.",
    "",
    "Workflow:",
    "1) GET /api/agents/me",
    `2) Determine issueId: PAPERCLIP_TASK_ID if present, otherwise issue_id (${issueIdHint}).`,
    "3) If issueId exists:",
    "   - POST /api/issues/{issueId}/checkout with {\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"expectedStatuses\":[\"todo\",\"backlog\",\"blocked\",\"in_review\"]}",
    "   - GET /api/issues/{issueId}",
    "   - GET /api/issues/{issueId}/comments",
    "   - Execute the issue instructions exactly. If the issue is actionable, take concrete action in this run; do not stop at a plan unless planning was requested.",
    "   - Leave durable progress with a clear next action. Use child issues for long or parallel delegated work instead of polling agents, sessions, or processes.",
    "   - Create child issues directly when you know what needs to be done; use POST /api/issues/{issueId}/interactions with kind suggest_tasks, ask_user_questions, or request_confirmation when the board/user must choose, answer, or confirm before you can continue.",
    "   - For plan approval, update the plan document first, then create request_confirmation targeting the latest plan revision with idempotencyKey confirmation:{issueId}:plan:{revisionId}; wait for acceptance before creating implementation subtasks.",
    "   - If blocked, PATCH /api/issues/{issueId} with {\"status\":\"blocked\",\"comment\":\"what is blocked, who owns the unblock, and the next action\"}.",
    "   - If instructions require a comment, POST /api/issues/{issueId}/comments with {\"body\":\"...\"}.",
    "   - PATCH /api/issues/{issueId} with {\"status\":\"done\",\"comment\":\"what changed and why\"}.",
    "4) If issueId does not exist:",
    "   - GET /api/companies/$PAPERCLIP_COMPANY_ID/issues?assigneeAgentId=$PAPERCLIP_AGENT_ID&status=todo,in_progress,in_review,blocked",
    "   - Pick in_progress first, then in_review when you were woken by a comment, then todo, then blocked, then execute step 3.",
    "",
    "Useful endpoints for issue work:",
    "- POST /api/issues/{issueId}/comments",
    "- PATCH /api/issues/{issueId}",
    "- POST /api/companies/{companyId}/issues (when asked to create a new issue)",
    ...(structuredWakePrompt
      ? [
          "",
          structuredWakePrompt,
        ]
      : []),
    "",
    "Complete the workflow in this run.",
  ];
  return lines.join("\n");
}

function appendWakeText(baseText: string, wakeText: string): string {
  const trimmedBase = baseText.trim();
  return trimmedBase.length > 0 ? `${trimmedBase}\n\n${wakeText}` : wakeText;
}

function joinWakePayloadSections(structuredWakePrompt: string, structuredWakeJson: string): string {
  const sections = [
    structuredWakePrompt.trim(),
    "Structured wake payload JSON:",
    "```json",
    structuredWakeJson,
    "```",
  ].filter((entry) => entry.trim().length > 0);
  return sections.join("\n");
}

function buildStandardPaperclipPayload(
  ctx: AdapterExecutionContext,
  wakePayload: WakePayload,
  paperclipEnv: Record<string, string>,
  payloadTemplate: Record<string, unknown>,
): Record<string, unknown> {
  const templatePaperclip = parseObject(payloadTemplate.paperclip);
  const workspace = asRecord(ctx.context.paperclipWorkspace);
  const workspaces = Array.isArray(ctx.context.paperclipWorkspaces)
    ? ctx.context.paperclipWorkspaces.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
    : [];
  const configuredWorkspaceRuntime = parseObject(ctx.config.workspaceRuntime);
  const runtimeServiceIntents = Array.isArray(ctx.context.paperclipRuntimeServiceIntents)
    ? ctx.context.paperclipRuntimeServiceIntents.filter(
        (entry): entry is Record<string, unknown> => Boolean(asRecord(entry)),
      )
    : [];

  const standardPaperclip: Record<string, unknown> = {
    runId: ctx.runId,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    taskId: wakePayload.taskId,
    issueId: wakePayload.issueId,
    issueIds: wakePayload.issueIds,
    wakeReason: wakePayload.wakeReason,
    wakeCommentId: wakePayload.wakeCommentId,
    approvalId: wakePayload.approvalId,
    approvalStatus: wakePayload.approvalStatus,
    apiUrl: paperclipEnv.PAPERCLIP_API_URL ?? null,
  };
  const structuredWake = parseObject(ctx.context.paperclipWake);
  if (Object.keys(structuredWake).length > 0) {
    standardPaperclip.wake = structuredWake;
  }

  if (workspace) {
    standardPaperclip.workspace = workspace;
  }
  if (workspaces.length > 0) {
    standardPaperclip.workspaces = workspaces;
  }
  if (runtimeServiceIntents.length > 0 || Object.keys(configuredWorkspaceRuntime).length > 0) {
    standardPaperclip.workspaceRuntime = {
      ...configuredWorkspaceRuntime,
      ...(runtimeServiceIntents.length > 0 ? { services: runtimeServiceIntents } : {}),
    };
  }

  return {
    ...templatePaperclip,
    ...standardPaperclip,
  };
}

function normalizeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), "utf8"))),
    ).toString("utf8");
  }
  return String(data ?? "");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const platform = params.platform?.trim() ?? "";
  const deviceFamily = params.deviceFamily?.trim() ?? "";
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

function resolveDeviceIdentity(config: Record<string, unknown>): GatewayDeviceIdentity {
  const configuredPrivateKey = nonEmpty(config.devicePrivateKeyPem);
  if (configuredPrivateKey) {
    const privateKey = crypto.createPrivateKey(configuredPrivateKey);
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const raw = derivePublicKeyRaw(publicKeyPem);
    return {
      deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
      publicKeyRawBase64Url: base64UrlEncode(raw),
      privateKeyPem: configuredPrivateKey,
      source: "configured",
    };
  }

  const generated = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = generated.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const raw = derivePublicKeyRaw(publicKeyPem);
  return {
    deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKeyRawBase64Url: base64UrlEncode(raw),
    privateKeyPem,
    source: "ephemeral",
  };
}

function isResponseFrame(value: unknown): value is GatewayResponseFrame {
  const record = asRecord(value);
  return Boolean(record && record.type === "res" && typeof record.id === "string" && typeof record.ok === "boolean");
}

function isEventFrame(value: unknown): value is GatewayEventFrame {
  const record = asRecord(value);
  return Boolean(record && record.type === "event" && typeof record.event === "string");
}

export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private challengePromise: Promise<string>;
  private resolveChallenge!: (nonce: string) => void;
  private rejectChallenge!: (err: Error) => void;

  constructor(private readonly opts: GatewayClientOptions) {
    this.challengePromise = new Promise<string>((resolve, reject) => {
      this.resolveChallenge = resolve;
      this.rejectChallenge = reject;
    });
    this.challengePromise.catch(() => {});
  }

  async connect(
    buildConnectParams: (nonce: string) => Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    this.ws = new WebSocket(this.opts.url, {
      headers: this.opts.headers,
      maxPayload: 25 * 1024 * 1024,
    });

    const ws = this.ws;

    ws.on("message", (data) => {
      this.handleMessage(rawDataToString(data));
    });

    ws.on("close", (code, reason) => {
      const reasonText = rawDataToString(reason);
      const err = new Error(`gateway closed (${code}): ${reasonText}`);
      this.failPending(err);
      this.rejectChallenge(err);
    });

    ws.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      void this.opts.onLog("stderr", `[openclaw-gateway] websocket error: ${message}\n`);
    });

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const onClose = (code: number, reason: Buffer) => {
          cleanup();
          reject(new Error(`gateway closed before open (${code}): ${rawDataToString(reason)}`));
        };
        const cleanup = () => {
          ws.off("open", onOpen);
          ws.off("error", onError);
          ws.off("close", onClose);
        };
        ws.once("open", onOpen);
        ws.once("error", onError);
        ws.once("close", onClose);
      }),
      timeoutMs,
      "gateway websocket open timeout",
    );

    const nonce = await withTimeout(this.challengePromise, timeoutMs, "gateway connect challenge timeout");
    const signedConnectParams = buildConnectParams(nonce);

    const hello = await this.request<Record<string, unknown> | null>("connect", signedConnectParams, {
      timeoutMs,
    });

    return hello;
  }

  async request<T>(
    method: string,
    params: unknown,
    opts: GatewayClientRequestOptions,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }

    const id = randomUUID();
    const frame: GatewayRequestFrame = {
      type: "req",
      id,
      method,
      params,
    };

    const payload = JSON.stringify(frame);
    const requestPromise = new Promise<T>((resolve, reject) => {
      const timer =
        opts.timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`gateway request timeout (${method})`));
            }, opts.timeoutMs)
          : null;

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal: opts.expectFinal === true,
        timer,
      });
    });

    this.ws.send(payload);
    return requestPromise;
  }

  close() {
    if (!this.ws) return;
    this.ws.close(1000, "paperclip-complete");
    this.ws = null;
  }

  private failPending(err: Error) {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (isEventFrame(parsed)) {
      if (parsed.event === "connect.challenge") {
        const payload = asRecord(parsed.payload);
        const nonce = nonEmpty(payload?.nonce);
        if (nonce) {
          this.resolveChallenge(nonce);
          return;
        }
      }
      void Promise.resolve(this.opts.onEvent(parsed)).catch(() => {
        // Ignore event callback failures and keep stream active.
      });
      return;
    }

    if (!isResponseFrame(parsed)) return;

    const pending = this.pending.get(parsed.id);
    if (!pending) return;

    const payload = asRecord(parsed.payload);
    const status = nonEmpty(payload?.status)?.toLowerCase();
    if (pending.expectFinal && status === "accepted") {
      return;
    }

    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(parsed.id);

    if (parsed.ok) {
      pending.resolve(parsed.payload ?? null);
      return;
    }

    const errorRecord = asRecord(parsed.error);
    const message =
      nonEmpty(errorRecord?.message) ??
      nonEmpty(errorRecord?.code) ??
      "gateway request failed";
    const err = new Error(message) as GatewayResponseError;
    const code = nonEmpty(errorRecord?.code);
    const details = asRecord(errorRecord?.details);
    if (code) err.gatewayCode = code;
    if (details) err.gatewayDetails = details;

    // RUAAAAA-5209: promote the postgres (SQLSTATE, constraint) pair out of
    // `details` onto the thrown error so the server-side
    // `isRoutineExecutionOpenConflict` can recognise the contention even when
    // it arrived inside a gateway JSON-RPC error frame. Both fields must be
    // present; a bare SQLSTATE without a constraint name is not actionable.
    const postgres = extractPostgresConflictInfo(errorRecord?.details);
    if (postgres.code && postgres.constraint) {
      err.postgresCode = postgres.code;
      err.postgresConstraint = postgres.constraint;
    }

    pending.reject(err);
  }
}

async function autoApproveDevicePairing(params: {
  url: string;
  headers: Record<string, string>;
  connectTimeoutMs: number;
  clientId: string;
  clientMode: string;
  clientVersion: string;
  role: string;
  scopes: string[];
  authToken: string | null;
  password: string | null;
  requestId: string | null;
  deviceId: string | null;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }> {
  if (!params.authToken && !params.password) {
    return { ok: false, reason: "shared auth token/password is missing" };
  }

  const approvalScopes = uniqueScopes([...params.scopes, "operator.pairing"]);
  const client = new GatewayWsClient({
    url: params.url,
    headers: params.headers,
    onEvent: () => {},
    onLog: params.onLog,
  });

  try {
    await params.onLog(
      "stdout",
      "[openclaw-gateway] pairing required; attempting automatic pairing approval via gateway methods\n",
    );

    await client.connect(
      () => ({
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: params.clientId,
          version: params.clientVersion,
          platform: process.platform,
          mode: params.clientMode,
        },
        role: params.role,
        scopes: approvalScopes,
        auth: {
          ...(params.authToken ? { token: params.authToken } : {}),
          ...(params.password ? { password: params.password } : {}),
        },
      }),
      params.connectTimeoutMs,
    );

    let requestId = params.requestId;
    if (!requestId) {
      const listPayload = await client.request<Record<string, unknown>>("device.pair.list", {}, {
        timeoutMs: params.connectTimeoutMs,
      });
      const pending = Array.isArray(listPayload.pending) ? listPayload.pending : [];
      const pendingRecords = pending
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry));
      const matching =
        (params.deviceId
          ? pendingRecords.find((entry) => nonEmpty(entry.deviceId) === params.deviceId)
          : null) ?? pendingRecords[pendingRecords.length - 1];
      requestId = nonEmpty(matching?.requestId);
    }

    if (!requestId) {
      return { ok: false, reason: "no pending device pairing request found" };
    }

    await client.request(
      "device.pair.approve",
      { requestId },
      {
        timeoutMs: params.connectTimeoutMs,
      },
    );

    return { ok: true, requestId };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

function parseUsage(value: unknown): AdapterExecutionResult["usage"] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const inputTokens = asNumber(record.inputTokens ?? record.input, 0);
  const outputTokens = asNumber(record.outputTokens ?? record.output, 0);
  const cachedInputTokens = asNumber(
    record.cachedInputTokens ?? record.cached_input_tokens ?? record.cacheRead ?? record.cache_read,
    0,
  );

  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

function extractRuntimeServicesFromMeta(meta: Record<string, unknown> | null): AdapterRuntimeServiceReport[] {
  if (!meta) return [];
  const reports: AdapterRuntimeServiceReport[] = [];

  const runtimeServices = Array.isArray(meta.runtimeServices)
    ? meta.runtimeServices.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
    : [];
  for (const entry of runtimeServices) {
    const serviceName = nonEmpty(entry.serviceName) ?? nonEmpty(entry.name);
    if (!serviceName) continue;
    const rawStatus = nonEmpty(entry.status)?.toLowerCase();
    const status =
      rawStatus === "starting" || rawStatus === "running" || rawStatus === "stopped" || rawStatus === "failed"
        ? rawStatus
        : "running";
    const rawLifecycle = nonEmpty(entry.lifecycle)?.toLowerCase();
    const lifecycle = rawLifecycle === "shared" ? "shared" : "ephemeral";
    const rawScopeType = nonEmpty(entry.scopeType)?.toLowerCase();
    const scopeType =
      rawScopeType === "project_workspace" ||
      rawScopeType === "execution_workspace" ||
      rawScopeType === "agent"
        ? rawScopeType
        : "run";
    const rawHealth = nonEmpty(entry.healthStatus)?.toLowerCase();
    const healthStatus =
      rawHealth === "healthy" || rawHealth === "unhealthy" || rawHealth === "unknown"
        ? rawHealth
        : status === "running"
          ? "healthy"
          : "unknown";

    reports.push({
      id: nonEmpty(entry.id),
      projectId: nonEmpty(entry.projectId),
      projectWorkspaceId: nonEmpty(entry.projectWorkspaceId),
      issueId: nonEmpty(entry.issueId),
      scopeType,
      scopeId: nonEmpty(entry.scopeId),
      serviceName,
      status,
      lifecycle,
      reuseKey: nonEmpty(entry.reuseKey),
      command: nonEmpty(entry.command),
      cwd: nonEmpty(entry.cwd),
      port: parseOptionalPositiveInteger(entry.port),
      url: nonEmpty(entry.url),
      providerRef: nonEmpty(entry.providerRef) ?? nonEmpty(entry.previewId),
      ownerAgentId: nonEmpty(entry.ownerAgentId),
      stopPolicy: asRecord(entry.stopPolicy),
      healthStatus,
    });
  }

  const previewUrl = nonEmpty(meta.previewUrl);
  if (previewUrl) {
    reports.push({
      serviceName: "preview",
      status: "running",
      lifecycle: "ephemeral",
      scopeType: "run",
      url: previewUrl,
      providerRef: nonEmpty(meta.previewId) ?? previewUrl,
      healthStatus: "healthy",
    });
  }

  const previewUrls = Array.isArray(meta.previewUrls)
    ? meta.previewUrls.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  previewUrls.forEach((url, index) => {
    reports.push({
      serviceName: index === 0 ? "preview" : `preview-${index + 1}`,
      status: "running",
      lifecycle: "ephemeral",
      scopeType: "run",
      url,
      providerRef: `${url}#${index}`,
      healthStatus: "healthy",
    });
  });

  return reports;
}

function extractResultText(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;

  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((entry) => {
      const payload = asRecord(entry);
      return nonEmpty(payload?.text);
    })
    .filter((entry): entry is string => Boolean(entry));

  if (texts.length > 0) return texts.join("\n\n");
  return nonEmpty(record.text) ?? nonEmpty(record.summary) ?? null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const urlValue = asString(ctx.config.url, "").trim();
  if (!urlValue) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "OpenClaw gateway adapter missing url",
      errorCode: "openclaw_gateway_url_missing",
    };
  }

  const parsedUrl = normalizeUrl(urlValue);
  if (!parsedUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Invalid gateway URL: ${urlValue}`,
      errorCode: "openclaw_gateway_url_invalid",
    };
  }

  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Unsupported gateway URL protocol: ${parsedUrl.protocol}`,
      errorCode: "openclaw_gateway_url_protocol",
    };
  }

  const timeoutSec = Math.max(0, Math.floor(asNumber(ctx.config.timeoutSec, 120)));
  const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;
  const connectTimeoutMs = timeoutMs > 0 ? Math.min(timeoutMs, 15_000) : 10_000;
  const waitTimeoutMs = parseOptionalPositiveInteger(ctx.config.waitTimeoutMs) ?? (timeoutMs > 0 ? timeoutMs : 30_000);

  const payloadTemplate = parseObject(ctx.config.payloadTemplate);
  const transportHint = nonEmpty(ctx.config.streamTransport) ?? nonEmpty(ctx.config.transport);

  const headers = toStringRecord(ctx.config.headers);
  const authToken = resolveAuthToken(parseObject(ctx.config), headers);
  const password = nonEmpty(ctx.config.password);
  const deviceToken = nonEmpty(ctx.config.deviceToken);

  if (authToken && !headerMapHasIgnoreCase(headers, "authorization")) {
    headers.authorization = toAuthorizationHeaderValue(authToken);
  }

  const clientId = nonEmpty(ctx.config.clientId) ?? DEFAULT_CLIENT_ID;
  const clientMode = nonEmpty(ctx.config.clientMode) ?? DEFAULT_CLIENT_MODE;
  const clientVersion = nonEmpty(ctx.config.clientVersion) ?? DEFAULT_CLIENT_VERSION;
  const role = nonEmpty(ctx.config.role) ?? DEFAULT_ROLE;
  const scopes = normalizeScopes(ctx.config.scopes);
  const deviceFamily = nonEmpty(ctx.config.deviceFamily);
  const disableDeviceAuth = parseBoolean(ctx.config.disableDeviceAuth, false);

  const wakePayload = buildWakePayload(ctx);
  const paperclipEnv = buildPaperclipEnvForWake(ctx, wakePayload);
  const structuredWakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  const structuredWakeJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake);
  const wakeText = buildWakeText(
    wakePayload,
    paperclipEnv,
    structuredWakeJson
      ? joinWakePayloadSections(structuredWakePrompt, structuredWakeJson)
      : structuredWakePrompt,
    resolveClaimedApiKeyPath(ctx.config.claimedApiKeyPath),
  );

  const sessionKeyStrategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  // RUAAAAA-5256: admission-control feedback knobs. Defaults keep a saturated run under ~15s
  // (3 x 5s probe slices) so a 600s budget is never spent on a run that never started.
  const saturatedProbeSliceMs = parseSaturatedDuration(
    ctx.config.saturatedProbeIntervalMs,
    SATURATED_PROBE_SLICE_DEFAULT_MS,
    SATURATED_PROBE_SLICE_MIN_MS,
    Math.max(SATURATED_PROBE_SLICE_MIN_MS, waitTimeoutMs),
  );
  const saturatedMinQueuedSlices = parseSaturatedMinQueuedSlices(ctx.config.saturatedMinQueuedSlices);
  const saturatedRetryDelayMs = parseSaturatedDuration(
    ctx.config.saturatedRetryDelayMs,
    SATURATED_RETRY_DELAY_DEFAULT_MS,
    1_000,
    SATURATED_RETRY_DELAY_MAX_MS,
  );
  const configuredSessionKey = nonEmpty(ctx.config.sessionKey);
  const sessionKey = resolveSessionKey({
    strategy: sessionKeyStrategy,
    configuredSessionKey,
    agentId: nonEmpty(ctx.config.agentId),
    runId: ctx.runId,
    issueId: wakePayload.issueId,
  });

  const templateMessage = nonEmpty(payloadTemplate.message) ?? nonEmpty(payloadTemplate.text);
  const message = templateMessage ? appendWakeText(templateMessage, wakeText) : wakeText;
  const paperclipPayload = buildStandardPaperclipPayload(ctx, wakePayload, paperclipEnv, payloadTemplate);

  const agentParams: Record<string, unknown> = {
    ...payloadTemplate,
    message,
    sessionKey,
    idempotencyKey: ctx.runId,
  };
  delete agentParams.text;
  const sendPaperclipPayload = parseBoolean(ctx.config.sendPaperclipPayload, false);
  if (sendPaperclipPayload) {
    agentParams.paperclip = paperclipPayload;
  } else {
    await ctx.onLog(
      "stdout",
      "[openclaw-gateway] compatibility mode: omitting top-level paperclip payload for older/stable OpenClaw gateways\n",
    );
  }

  const configuredAgentId = nonEmpty(ctx.config.agentId);
  if (configuredAgentId && !nonEmpty(agentParams.agentId)) {
    agentParams.agentId = configuredAgentId;
  }

  if (typeof agentParams.timeout !== "number") {
    agentParams.timeout = waitTimeoutMs;
  }

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "openclaw_gateway",
      command: "gateway",
      commandArgs: ["ws", parsedUrl.toString(), "agent"],
      context: ctx.context,
    });
  }

  const outboundHeaderKeys = Object.keys(headers).sort();
  await ctx.onLog(
    "stdout",
    `[openclaw-gateway] outbound headers (redacted): ${stringifyForLog(redactForLog(headers), 4_000)}\n`,
  );
  await ctx.onLog(
    "stdout",
    `[openclaw-gateway] outbound payload (redacted): ${stringifyForLog(redactForLog(agentParams), 12_000)}\n`,
  );
  await ctx.onLog("stdout", `[openclaw-gateway] outbound header keys: ${outboundHeaderKeys.join(", ")}\n`);
  if (transportHint) {
    await ctx.onLog(
      "stdout",
      `[openclaw-gateway] ignoring streamTransport=${transportHint}; gateway adapter always uses websocket protocol\n`,
    );
  }
  if (parsedUrl.protocol === "ws:" && !isLoopbackHost(parsedUrl.hostname)) {
    await ctx.onLog(
      "stdout",
      "[openclaw-gateway] warning: using plaintext ws:// to a non-loopback host; prefer wss:// for remote endpoints\n",
    );
  }

  const autoPairOnFirstConnect = parseBoolean(ctx.config.autoPairOnFirstConnect, true);
  let autoPairAttempted = false;
  let latestResultPayload: unknown = null;

  while (true) {
    const trackedRunIds = new Set<string>([ctx.runId]);
    const assistantChunks: string[] = [];
    let lifecycleError: string | null = null;
    let deviceIdentity: GatewayDeviceIdentity | null = null;

    const onEvent = async (frame: GatewayEventFrame) => {
      if (frame.event !== "agent") {
        if (frame.event === "shutdown") {
          await ctx.onLog(
            "stdout",
            `[openclaw-gateway] gateway shutdown notice: ${stringifyForLog(frame.payload ?? {}, 2_000)}\n`,
          );
        }
        return;
      }

      const payload = asRecord(frame.payload);
      if (!payload) return;

      const runId = nonEmpty(payload.runId);
      if (!runId || !trackedRunIds.has(runId)) return;

      const stream = nonEmpty(payload.stream) ?? "unknown";
      const data = asRecord(payload.data) ?? {};
      await ctx.onLog(
        "stdout",
        `[openclaw-gateway:event] run=${runId} stream=${stream} data=${stringifyForLog(data, 8_000)}\n`,
      );

      if (stream === "assistant") {
        const delta = nonEmpty(data.delta);
        const text = nonEmpty(data.text);
        if (delta) {
          assistantChunks.push(delta);
        } else if (text) {
          assistantChunks.push(text);
        }
        return;
      }

      if (stream === "error") {
        lifecycleError = nonEmpty(data.error) ?? nonEmpty(data.message) ?? lifecycleError;
        return;
      }

      if (stream === "lifecycle") {
        const phase = nonEmpty(data.phase)?.toLowerCase();
        if (phase === "error" || phase === "failed" || phase === "cancelled") {
          lifecycleError = nonEmpty(data.error) ?? nonEmpty(data.message) ?? lifecycleError;
        }
      }
    };

    const client = new GatewayWsClient({
      url: parsedUrl.toString(),
      headers,
      onEvent,
      onLog: ctx.onLog,
    });

    try {
      deviceIdentity = disableDeviceAuth ? null : resolveDeviceIdentity(parseObject(ctx.config));
      if (deviceIdentity) {
        await ctx.onLog(
          "stdout",
          `[openclaw-gateway] device auth enabled keySource=${deviceIdentity.source} deviceId=${deviceIdentity.deviceId}\n`,
        );
      } else {
        await ctx.onLog("stdout", "[openclaw-gateway] device auth disabled\n");
      }

      await ctx.onLog("stdout", `[openclaw-gateway] connecting to ${parsedUrl.toString()}\n`);

      const hello = await client.connect((nonce) => {
        const signedAtMs = Date.now();
        const connectParams: Record<string, unknown> = {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: clientId,
            version: clientVersion,
            platform: process.platform,
            ...(deviceFamily ? { deviceFamily } : {}),
            mode: clientMode,
          },
          role,
          scopes,
          auth:
            authToken || password || deviceToken
              ? {
                  ...(authToken ? { token: authToken } : {}),
                  ...(deviceToken ? { deviceToken } : {}),
                  ...(password ? { password } : {}),
                }
              : undefined,
        };

        if (deviceIdentity) {
          const payload = buildDeviceAuthPayloadV3({
            deviceId: deviceIdentity.deviceId,
            clientId,
            clientMode,
            role,
            scopes,
            signedAtMs,
            token: authToken,
            nonce,
            platform: process.platform,
            deviceFamily,
          });
          connectParams.device = {
            id: deviceIdentity.deviceId,
            publicKey: deviceIdentity.publicKeyRawBase64Url,
            signature: signDevicePayload(deviceIdentity.privateKeyPem, payload),
            signedAt: signedAtMs,
            nonce,
          };
        }
        return connectParams;
      }, connectTimeoutMs);

      await ctx.onLog(
        "stdout",
        `[openclaw-gateway] connected protocol=${asNumber(asRecord(hello)?.protocol, PROTOCOL_VERSION)}\n`,
      );

      const acceptedPayload = await client.request<Record<string, unknown>>("agent", agentParams, {
        timeoutMs: connectTimeoutMs,
      });

      latestResultPayload = acceptedPayload;

      const acceptedStatus = nonEmpty(acceptedPayload?.status)?.toLowerCase() ?? "";
      const acceptedRunId = nonEmpty(acceptedPayload?.runId) ?? ctx.runId;
      // RUAAAAA-5299: distinguish a gateway-issued run id from our own Paperclip run-id fallback.
      // Only the former is a session the gateway still owns after we stop waiting for it.
      const gatewayOwnedRunId = nonEmpty(acceptedPayload?.runId);
      trackedRunIds.add(acceptedRunId);

      await ctx.onLog(
        "stdout",
        `[openclaw-gateway] agent accepted runId=${acceptedRunId} status=${acceptedStatus || "unknown"}\n`,
      );

      if (acceptedStatus === "error") {
        // RUAAAAA-3922: surface the lane-saturated fail-fast signal from the gateway admission-control
        // gate as a distinct errorCode so issue_recovery can route it into a backoff retry path
        // instead of consuming the full 600s `waitTimeoutMs`. Saturated is retriable backpressure,
        // NOT an abort or genuine dispatch failure.
        if (nonEmpty(acceptedPayload?.code) === "saturated") {
          const snapshot = asRecord(acceptedPayload?.snapshot);
          const errorMessage =
            nonEmpty(acceptedPayload?.summary) ??
            lifecycleError ??
            "OpenClaw gateway lane saturated (admission-control gate tripped)";
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage,
            errorCode: "openclaw_gateway_saturated",
            resultJson: acceptedPayload,
            ...(snapshot ? { errorMeta: snapshot } : {}),
          };
        }
        const errorMessage =
          nonEmpty(acceptedPayload?.summary) ?? lifecycleError ?? "OpenClaw gateway agent request failed";
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage,
          errorCode: "openclaw_gateway_agent_error",
          resultJson: acceptedPayload,
        };
      }

      if (acceptedStatus !== "ok") {
        // RUAAAAA-5256: the gateway can accept a dispatch and immediately report that it never got
        // a slot (admission closed / queue backpressure). That is a saturation verdict, not a run to
        // wait on: fail fast here instead of entering the wait loop and burning `waitTimeoutMs`.
        const acceptedSaturation = detectWaitSliceSaturation(acceptedPayload);
        if (acceptedSaturation.saturated && acceptedSaturation.reason !== "explicit_saturated") {
          await ctx.onLog(
            "stdout",
            `[openclaw-gateway] saturated at dispatch runId=${acceptedRunId} reason=${acceptedSaturation.reason} status=${acceptedSaturation.status ?? "unknown"} timeoutPhase=${acceptedSaturation.timeoutPhase ?? "none"} providerStarted=${acceptedSaturation.providerStarted}\n`,
          );
          return buildSaturatedResult({
            stage: "dispatch",
            reason: acceptedSaturation.reason ?? "queued_not_started",
            payload: acceptedPayload,
            elapsedMs: 0,
            sliceCount: 0,
            waitTimeoutMs,
            retryDelayMs: saturatedRetryDelayMs,
            liveSessionRunId: gatewayOwnedRunId,
          });
        }

        // RUAAAAA-5062: poll agent.wait in slices so we can detect cooldown
        const waitSliceMs = (function () {
          const configured = parsePositiveInteger(ctx.config.waitPollIntervalMs);
          if (configured !== null && configured >= 1_000) return Math.min(configured, waitTimeoutMs);
          return COOLDOWN_WAIT_SLICE_DEFAULT_MS;
        })();
        const cooldownBackoffSequence = parseCooldownBackoffSequence(ctx.config.cooldownBackoffMs);
        const waitCallTimeoutMs = waitTimeoutMs + connectTimeoutMs;
        const waitBudgetStart = Date.now();
        // RUAAAAA-5299: the slice cap is an ANTI-SPIN guard, not a second time budget.
        //
        // It used to be derived from `waitSliceMs`, which assumes every slice consumes its whole
        // window. A gateway that answers `agent.wait` early — exactly what RUAAAAA-5280's
        // `gateway_draining` slices are — burns that cap long before the wall-clock budget runs out.
        // Observed on this fleet: `waitTimeoutMs=600000` with 30s slices gave a cap of 24, and a
        // gateway answering in ~5s per slice hit it at ~125s. The run then reported
        //
        //   "did not complete within waitTimeoutMs=600000ms (elapsed 125558ms across 24 slices)"
        //
        // which is false on its face — it never ran for 600s. Worse, it wrote a terminal `timed_out`
        // while the session was still live, which spawned a continuation wake, which started another
        // run, which died at ~125s the same way. A self-sustaining loop off a false budget claim.
        //
        // Scale the cap by the SMALLEST slice the loop can actually use, so the wall-clock budget
        // (`remainingMs <= 0`) stays the authority on when a wait ends, and the cap only fires to
        // stop a genuine tight spin. `minSliceMs` is the saturated-probe slice while the provider has
        // not started and the full slice afterwards, so the cap is sized for the fast case.
        const minSliceMs = Math.max(1, Math.min(waitSliceMs, saturatedProbeSliceMs));
        const maxSlices = Math.max(
          WAIT_SLICE_MIN_SLICES,
          Math.ceil(waitTimeoutMs / minSliceMs) + WAIT_SLICE_OVERRUN_SLACK,
        );
        let cooldownSignal: CooldownSignal | null = null;
        let cooldownAttempts = 0;
        let waitPayload: Record<string, unknown> | null = null;
        let waitStatus = "";
        let shouldRetryOnCooldown = true;
        let sliceCount = 0;
        let pendingSliceCount = 0;
        // RUAAAAA-5256: saturation bookkeeping. A run that has never been provider-started and has
        // answered N consecutive slices as queued/draining is saturated, not slow.
        let providerEverStarted = false;
        let queuedSliceCount = 0;
        let saturationReason: WaitSliceSaturation["reason"] = null;
        let firstQueuedAtMs: number | null = null;
        let lastSaturationPayload: Record<string, unknown> | null = null;
        // RUAAAAA-5302: which limit ended the loop, and whether the give-up was a provider-cooldown
        // exhaustion. The old code inferred both from `waitStatus`, which conflated three distinct
        // endings (budget spent / slice cap reached / cooldown backoff ate the budget) into one
        // unreconcilable message, and reported `openclaw_gateway_wait_cooldown` for any `error`
        // that happened to follow a cooldown signal — including a plain gateway-reported slice
        // error. Track them explicitly instead of re-deriving them.
        let waitEndReason: WaitEndReason | null = null;
        let cooldownExhausted = false;

        while (true) {
          const elapsedMs = Date.now() - waitBudgetStart;
          const remainingMs = waitTimeoutMs - elapsedMs;
          if (remainingMs <= 0) { waitStatus = "timeout"; waitEndReason = "budget"; break; }
          // RUAAAAA-5256: probe on a short slice until the run has actually been provider-started,
          // so saturation is visible within seconds instead of only at the end of `waitTimeoutMs`.
          const effectiveSliceMs =
            providerEverStarted ? waitSliceMs : Math.min(waitSliceMs, saturatedProbeSliceMs);
          const sliceMs = Math.min(effectiveSliceMs, Math.max(1_000, remainingMs));
          const sliceCallTimeout = Math.min(waitCallTimeoutMs, sliceMs + connectTimeoutMs);
          let slicePayload: Record<string, unknown> | null = null;
          let sliceTimedOut = false;
          try {
            slicePayload = await client.request<Record<string, unknown>>(
              "agent.wait",
              { runId: acceptedRunId, timeoutMs: sliceMs },
              { timeoutMs: sliceCallTimeout },
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const lower = msg.toLowerCase();
            if (lower.includes("timeout")) sliceTimedOut = true;
            slicePayload = { status: sliceTimedOut ? "timeout" : "error", error: msg };
          }
          waitPayload = slicePayload;
          latestResultPayload = slicePayload;
          sliceCount += 1;
          const sliceStatus = nonEmpty(slicePayload?.status)?.toLowerCase() ?? "";
          const errorText = nonEmpty(slicePayload?.error) ?? (lifecycleError ?? undefined) ?? undefined;
          const sliceDecision = classifyWaitSliceStatus(slicePayload?.status);
          if (sliceDecision === "done") { waitStatus = "ok"; break; }
          // RUAAAAA-5256: admission-control verdict for this slice. A single queued slice is not
          // enough — a run that finishes right after its slice expires can also look queued — so we
          // require `saturatedMinQueuedSlices` consecutive answers before giving up.
          const sliceSaturation = detectWaitSliceSaturation(slicePayload);
          if (sliceSaturation.providerStarted) {
            providerEverStarted = true;
            queuedSliceCount = 0;
            firstQueuedAtMs = null;
            saturationReason = null;
          } else if (sliceSaturation.saturated) {
            queuedSliceCount += 1;
            saturationReason = sliceSaturation.reason;
            lastSaturationPayload = slicePayload;
            if (firstQueuedAtMs === null) firstQueuedAtMs = Date.now();
            await ctx.onLog(
              "stdout",
              `[openclaw-gateway] queued (not started) slice ${sliceCount}/${saturatedMinQueuedSlices} reason=${sliceSaturation.reason} timeoutPhase=${sliceSaturation.timeoutPhase ?? "none"} status=${sliceStatus || "none"} elapsed=${Date.now() - waitBudgetStart}ms\n`,
            );
            if (queuedSliceCount >= saturatedMinQueuedSlices) {
              waitStatus = "saturated";
              break;
            }
          } else if (queuedSliceCount > 0) {
            // Evidence went away (unknown/blank status): restart the streak rather than accreting
            // unrelated slices into a saturation verdict.
            queuedSliceCount = 0;
            firstQueuedAtMs = null;
            saturationReason = null;
          }
          const signal = detectCooldownSignal([
            typeof errorText === "string" ? errorText : null,
            sliceStatus === "error" ? nonEmpty(slicePayload?.summary) : null,
            sliceStatus === "error" ? nonEmpty(asRecord(slicePayload?.details)?.message) : null,
          ]);
          if (signal.detected && shouldRetryOnCooldown) {
            pendingSliceCount = 0;
            cooldownSignal = signal;
            const backoffSequence = cooldownBackoffSequence;
            if (cooldownAttempts >= backoffSequence.length) {
              shouldRetryOnCooldown = false;
              waitStatus = "error";
              cooldownExhausted = true;
              break;
            }
            const backoffAttempt = cooldownAttempts;
            const backoffMsRaw = backoffForAttempt(backoffSequence, backoffAttempt);
            const backoffMs = clampCooldownBackoffToBudget(backoffMsRaw, remainingMs);
            cooldownAttempts += 1;
            await ctx.onLog("stdout",
              `[openclaw-gateway] cooldown detected provider=${signal.provider ?? "unknown"} reason=${signal.reason ?? "unknown"} until=${signal.untilIso ?? "unknown"} backoffMs=${backoffMs} attempt=${backoffAttempt + 1}/${backoffSequence.length} budgetRemainingMs=${remainingMs}
`);
            if (backoffMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          // RUAAAAA-5199: `timeout` (and a missing status) from agent.wait means "this slice's window
          // closed while the run was still in flight" — it is NOT a terminal outcome. Poll the next
          // slice and let the aggregate waitTimeoutMs budget decide the final verdict. Breaking here
          // capped every run at COOLDOWN_WAIT_SLICE_DEFAULT_MS regardless of the configured budget,
          // which is what produced the fleet-wide `timed_out` clears under load.
          if (sliceStatus === "timeout" || sliceStatus === "") {
            pendingSliceCount += 1;
            if (sliceCount >= maxSlices || pendingSliceCount >= maxSlices) {
              waitStatus = "timeout";
              // RUAAAAA-5302: this is the truncation that made the old message unreadable — the
              // cap can fire with budget still unspent. Say which limit ended it.
              waitEndReason = "slice_cap";
              break;
            }
            await ctx.onLog(
              "stdout",
              `[openclaw-gateway] agent.wait slice ${sliceCount} still in flight (slice=${sliceMs}ms elapsed=${Date.now() - waitBudgetStart}ms remaining=${remainingMs}ms slices=${sliceCount}/${maxSlices}) — continuing poll\n`,
            );
            continue;
          }
          pendingSliceCount = 0;
          if (sliceStatus === "error") { waitStatus = "error"; break; }
          waitStatus = sliceStatus; break;
        }

        const finalElapsedMs = Date.now() - waitBudgetStart;
        if (waitStatus === "ok") {
          // ok
        } else if (waitStatus === "saturated") {
          // RUAAAAA-5256: fail fast on admission-control backpressure. `timedOut:false` plus a
          // saturated-specific code keeps this out of the timeout bucket, and
          // `transient_upstream` routes it into Paperclip's bounded backoff retry
          // (2m/10m/30m/2h) instead of the stranded-issue recovery path.
          await ctx.onLog(
            "stdout",
            `[openclaw-gateway] saturated after ${finalElapsedMs}ms across ${sliceCount} slice(s); abandoning waitTimeoutMs=${waitTimeoutMs}ms budget\n`,
          );
          return buildSaturatedResult({
            stage: "wait",
            reason: saturationReason ?? "queued_not_started",
            payload: lastSaturationPayload,
            elapsedMs: finalElapsedMs,
            sliceCount,
            waitTimeoutMs,
            retryDelayMs: saturatedRetryDelayMs,
            liveSessionRunId: gatewayOwnedRunId,
          });
        } else if (waitStatus === "timeout") {
          // RUAAAAA-5302: this is path (1) of two that used to write a terminal status over a live
          // session. Run `0707c344` on RUAAAAA-5299 went terminal `timed_out` at 22:13:54.718Z and
          // its session landed the full disposition 9m56s later — the adapter spent its wait
          // budget, the gateway did not spend the session. `sessionLive` records the second fact so
          // the server holds the run non-terminal instead of failing it and firing a stale retry.
          //
          // This supersedes the inline `exitReason` text from a2bd973a1d on #2, which fixed the same
          // unreadable string. `buildWaitTimeoutResult` carries the same "say which limit ended the
          // wait" intent, plus the slice cadence actually used and the live-session clause — and it
          // reads `endReason` from the break site instead of inferring it from
          // `finalElapsedMs >= waitTimeoutMs`, which is a guess that goes wrong if the last slice
          // overshoots the budget.
          return buildWaitTimeoutResult({
            payload: asRecord(waitPayload),
            elapsedMs: finalElapsedMs,
            sliceCount,
            maxSlices,
            waitTimeoutMs,
            waitSliceMs,
            probeSliceMs: saturatedProbeSliceMs,
            providerEverStarted,
            endReason: waitEndReason ?? "budget",
            cooldownSignal,
            cooldownAttempts,
            cooldownBackoffSequenceMs: cooldownBackoffSequence,
            liveSessionRunId: gatewayOwnedRunId,
          });
        }
        if (waitStatus === "error") {
          // RUAAAAA-5302: distinguish "we gave up because the provider is in cooldown" from "the
          // gateway reported a slice error". Only the former means the run is parked in a transient
          // provider state the gateway still owns. `cooldownSignal` alone cannot tell them apart:
          // a later plain `status:"error"` slice after an earlier cooldown signal satisfied the old
          // `cooldownSignal ? wait_cooldown : wait_error` test and inherited the cooldown code.
          if (cooldownExhausted && cooldownSignal) {
            return buildCooldownExhaustedResult({
              payload: asRecord(waitPayload),
              waitTimeoutMs,
              cooldownSignal,
              cooldownAttempts,
              cooldownBackoffSequenceMs: cooldownBackoffSequence,
              liveSessionRunId: gatewayOwnedRunId,
            });
          }
          return {
            exitCode: 1, signal: null, timedOut: false,
            errorMessage: nonEmpty(waitPayload?.error) ?? lifecycleError ?? "OpenClaw gateway run failed",
            errorCode: "openclaw_gateway_wait_error",
            resultJson: asRecord(waitPayload),
          };
        }
        if (waitStatus && waitStatus !== "ok") {
          return {
            exitCode: 1, signal: null, timedOut: false,
            errorMessage: `Unexpected OpenClaw gateway agent.wait status: ${waitStatus}`,
            errorCode: "openclaw_gateway_wait_status_unexpected",
            resultJson: waitPayload,
          };
        }
      }

      const summaryFromEvents = assistantChunks.join("").trim();
      const summaryFromPayload =
        extractResultText(asRecord(acceptedPayload?.result)) ??
        extractResultText(acceptedPayload) ??
        extractResultText(asRecord(latestResultPayload)) ??
        null;
      const summary = summaryFromEvents || summaryFromPayload || null;

      const acceptedResult = asRecord(acceptedPayload?.result);
      const latestPayload = asRecord(latestResultPayload);
      const latestResult = asRecord(latestPayload?.result);
      const acceptedMeta = asRecord(acceptedResult?.meta) ?? asRecord(acceptedPayload?.meta);
      const latestMeta = asRecord(latestResult?.meta) ?? asRecord(latestPayload?.meta);
      const mergedMeta = {
        ...(acceptedMeta ?? {}),
        ...(latestMeta ?? {}),
      };
      const agentMeta =
        asRecord(mergedMeta.agentMeta) ??
        asRecord(acceptedMeta?.agentMeta) ??
        asRecord(latestMeta?.agentMeta);
      const usage = parseUsage(agentMeta?.usage ?? mergedMeta.usage);
      const runtimeServices = extractRuntimeServicesFromMeta(agentMeta ?? mergedMeta);
      const provider = nonEmpty(agentMeta?.provider) ?? nonEmpty(mergedMeta.provider) ?? "openclaw";
      const model = nonEmpty(agentMeta?.model) ?? nonEmpty(mergedMeta.model) ?? null;
      const costUsd = asNumber(agentMeta?.costUsd ?? mergedMeta.costUsd, 0);

      await ctx.onLog(
        "stdout",
        `[openclaw-gateway] run completed runId=${Array.from(trackedRunIds).join(",")} status=ok\n`,
      );

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider,
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
        ...(costUsd > 0 ? { costUsd } : {}),
        resultJson: asRecord(latestResultPayload),
        ...(runtimeServices.length > 0 ? { runtimeServices } : {}),
        ...(summary ? { summary } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();
      const timedOut = lower.includes("timeout");
      const pairingRequired = lower.includes("pairing required");

      if (
        pairingRequired &&
        !disableDeviceAuth &&
        autoPairOnFirstConnect &&
        !autoPairAttempted &&
        (authToken || password)
      ) {
        autoPairAttempted = true;
        const pairResult = await autoApproveDevicePairing({
          url: parsedUrl.toString(),
          headers,
          connectTimeoutMs,
          clientId,
          clientMode,
          clientVersion,
          role,
          scopes,
          authToken,
          password,
          requestId: extractPairingRequestId(err),
          deviceId: deviceIdentity?.deviceId ?? null,
          onLog: ctx.onLog,
        });
        if (pairResult.ok) {
          await ctx.onLog(
            "stdout",
            `[openclaw-gateway] auto-approved pairing request ${pairResult.requestId}; retrying\n`,
          );
          continue;
        }
        await ctx.onLog(
          "stderr",
          `[openclaw-gateway] auto-pairing failed: ${pairResult.reason}\n`,
        );
      }

      const detailedMessage = pairingRequired
        ? `${message}. Approve the pending device in OpenClaw (for example: openclaw devices approve --latest --url <gateway-ws-url> --token <gateway-token>) and retry. Ensure this agent has a persisted adapterConfig.devicePrivateKeyPem so approvals are reused.`
        : message;

      await ctx.onLog("stderr", `[openclaw-gateway] request failed: ${detailedMessage}\n`);

      return {
        exitCode: 1,
        signal: null,
        timedOut,
        errorMessage: detailedMessage,
        errorCode: timedOut
          ? "openclaw_gateway_timeout"
          : pairingRequired
            ? "openclaw_gateway_pairing_required"
            : "openclaw_gateway_request_failed",
        resultJson: asRecord(latestResultPayload),
      };
    } finally {
      client.close();
    }
  }
}
