import { describe, expect, it } from "vitest";
import { sessionCodec as hermesSessionCodec } from "@paperclipai/hermes-paperclip-adapter/server";
import {
  createGuardedHermesSessionCodec,
  HERMES_SESSION_ID_PATTERN,
  isHermesSessionId,
  sanitizeHermesExecutionResult,
  sanitizeHermesSessionId,
} from "../adapters/hermes-session-id.js";

/**
 * RUAAAAA-5244 regression guard, ported onto the reconciled master
 * (RUAAAAA-5418).
 *
 * The adapter's legacy stdout parser is
 *   /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i
 * so any hermes output containing the words "session saved" / "session id"
 * followed by ordinary prose yields that prose word as the session id. In
 * production it captured "from" from a sentence like
 * "Session saved from the previous context" and persisted it into
 * agent_task_sessions.session_params_json for 30 rows across 10 agents, which
 * then shelled out `hermes --resume from`.
 *
 * The accepted shape is the canonical hermes session-id rule that upstream
 * master already applies server-side
 * (isCanonicalSessionIdForAdapter in services/heartbeat/run-state.ts). The
 * guard must not be stricter than that rule, or wiring it would drop session
 * ids the server is willing to resume and break session continuity.
 */

const VALID = "20260706_234011_dc2cf9";

function guarded(onReject?: Parameters<typeof createGuardedHermesSessionCodec>[1]) {
  return createGuardedHermesSessionCodec(hermesSessionCodec, onReject);
}

describe("hermes session id format guard (RUAAAAA-5244)", () => {
  it("only accepts the real hermes session id shape", () => {
    expect(HERMES_SESSION_ID_PATTERN.test(VALID)).toBe(true);
    expect(isHermesSessionId(VALID)).toBe(true);
    expect(isHermesSessionId(` ${VALID} `)).toBe(true);
  });

  it("rejects the literal word 'from' and other prose", () => {
    for (const bad of ["from", "to", "the", "previous", "session", "context"]) {
      expect(isHermesSessionId(bad)).toBe(false);
      expect(sanitizeHermesSessionId(bad)).toBeNull();
    }
  });

  it("rejects shapes that are not hermes session ids", () => {
    for (const bad of [
      "20260706_234011-dc2cf9",
      "20260706_234011",
      "20260706_234011_",
      "20260706_2340_dc2cf9",
      "20260706_234011_dc2",
      "",
      "   ",
    ]) {
      expect(isHermesSessionId(bad)).toBe(false);
    }
    expect(isHermesSessionId(42)).toBe(false);
    expect(isHermesSessionId(null)).toBe(false);
    expect(isHermesSessionId(undefined)).toBe(false);
  });

  it("accepts every shape the server-side canonical rule accepts", () => {
    // The guard is wired in front of the vendored hermes adapter, so it must
    // never reject an id that upstream's canonical rule
    // (isCanonicalSessionIdForAdapter) considers valid. A stricter guard would
    // silently break "hermes --resume" continuity for those agents.
    for (const good of [
      "20260706_234011_dc2cf9",
      "20260706_234011_dc2cf99",
      "20260706_234011_dc2cf",
      "20260706_234011_DC2CF9",
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    ]) {
      expect(isHermesSessionId(good)).toBe(true);
    }
  });

  it("fails closed on a persisted sessionId of 'from'", () => {
    const codec = guarded();
    expect(codec.deserialize({ sessionId: "from" })).toBeNull();
    expect(codec.serialize({ sessionId: "from" })).toBeNull();
    expect(codec.getDisplayId?.({ sessionId: "from" })).toBeNull();
  });

  it("still round-trips a valid session id", () => {
    const codec = guarded();
    expect(codec.deserialize({ sessionId: VALID })).toEqual({ sessionId: VALID });
    expect(codec.serialize({ sessionId: VALID })).toEqual({ sessionId: VALID });
    expect(codec.getDisplayId?.({ sessionId: VALID })).toBe(VALID);
  });

  it("reports the rejection once so operators can see it", () => {
    const rejections: { field: string; value: string }[] = [];
    const codec = guarded((items) => rejections.push(...items));
    codec.deserialize({ sessionId: "from" });
    expect(rejections).toEqual([{ field: "sessionId", value: "from" }]);
  });

  it("drops a malformed sessionId from an adapter execution result", () => {
    const sanitized = sanitizeHermesExecutionResult({ sessionId: "from" });
    // null (not undefined) so heartbeat.ts reports it as explicitly absent
    // instead of falling through to "keep the previous session".
    expect(sanitized.sessionId).toBeNull();
  });

  it("strips a malformed id nested in sessionParams", () => {
    const sanitized = sanitizeHermesExecutionResult({
      sessionParams: { sessionId: "from", cwd: "/tmp/workspace" },
    });
    expect(sanitized.sessionParams).toEqual({ cwd: "/tmp/workspace" });
  });

  it("empties sessionParams when the malformed id was the only field", () => {
    const sanitized = sanitizeHermesExecutionResult({ sessionParams: { sessionId: "from" } });
    expect(sanitized.sessionParams).toBeNull();
  });

  it("leaves a valid execution result untouched", () => {
    const original = { sessionId: VALID, sessionParams: { sessionId: VALID } };
    expect(sanitizeHermesExecutionResult(original)).toBe(original);
  });

  it("does not mutate the caller's execution result", () => {
    const original = { sessionId: "from" };
    sanitizeHermesExecutionResult(original);
    expect(original.sessionId).toBe("from");
  });

  it("clears a malformed display id as well", () => {
    const sanitized = sanitizeHermesExecutionResult({ sessionDisplayId: "from" });
    expect(sanitized.sessionDisplayId).toBeNull();
  });

  it("clears the vendored adapter's truncated display id", () => {
    // The vendored hermes adapter reports sessionDisplayId as
    // sessionId.slice(0, 16). That truncated form is not a session id, and
    // upstream's canonical rule rejects it too - the server then falls back to
    // the full session id from sessionParams for display.
    const sanitized = sanitizeHermesExecutionResult({
      sessionId: VALID,
      sessionParams: { sessionId: VALID },
      sessionDisplayId: VALID.slice(0, 16),
    });
    expect(sanitized.sessionDisplayId).toBeNull();
    expect(sanitized.sessionParams).toEqual({ sessionId: VALID });
  });

  it("reproduces the production failure against the real adapter regex", () => {
    // The exact legacy pattern shipped in the hermes adapter dist.
    const legacy = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;
    const stdout = [
      "Reviewed the pricing doc and left three comments.",
      "Session saved from the previous context.",
      "",
    ].join("\n");

    const captured = stdout.match(legacy)?.[1];
    expect(captured).toBe("from");
    // The guard is what stops that word from ever reaching the database.
    expect(isHermesSessionId(captured)).toBe(false);
    expect(guarded().serialize({ sessionId: captured })).toBeNull();
  });

  it("reproduces the quiet-mode variant where 'from' follows session_id:", () => {
    const quiet = /^session_id:\s*(\S+)/m;
    const captured = "done\nsession_id: from\n".match(quiet)?.[1];
    expect(captured).toBe("from");
    expect(isHermesSessionId(captured)).toBe(false);
  });
});
