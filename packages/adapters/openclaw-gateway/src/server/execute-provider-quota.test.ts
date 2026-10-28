import { describe, expect, it } from "vitest";
import { classifyProviderRefusal, detectCooldownSignal, detectProviderQuotaExhausted } from "./execute.js";

/**
 * PROVIDER-QUOTA: a provider quota/rate-limit exhaustion is a transient upstream
 * condition, exactly like a gateway restart. It must be detected so the run can be
 * reported through the transient-upstream family and retried, instead of being
 * classified as a terminal agent fault.
 */
describe("detectProviderQuotaExhausted (PROVIDER-QUOTA)", () => {
  it("detects the token-plan quota exhaustion the provider actually emits", () => {
    expect(
      detectProviderQuotaExhausted(
        "⚠️ Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056) | 429",
      ),
    ).toBe(true);
  });

  it("detects a bare HTTP 429 rate limit", () => {
    expect(detectProviderQuotaExhausted("429 Too Many Requests")).toBe(true);
    expect(detectProviderQuotaExhausted("rate limit exceeded")).toBe(true);
  });

  it("detects quota exhaustion reported through an auth profile", () => {
    expect(
      detectProviderQuotaExhausted(
        'Auth profile "minimax-portal:default" is temporarily unavailable for minimax-portal/MiniMax-M3.',
      ),
    ).toBe(true);
  });

  it("does not classify an agent or gateway fault as a quota exhaustion", () => {
    expect(detectProviderQuotaExhausted("OpenClaw gateway run failed")).toBe(false);
    expect(detectProviderQuotaExhausted("connect ECONNREFUSED 127.0.0.1:18789")).toBe(false);
    expect(detectProviderQuotaExhausted("")).toBe(false);
  });
});

/**
 * PROVIDER-QUOTA: the auth-profile cooldown detector only matched a single-quoted
 * profile name, but the provider emits a DOUBLE-quoted one. So the cooldown path
 * never fired for the message it was written for.
 */
describe("detectCooldownSignal auth-profile quoting (PROVIDER-QUOTA)", () => {
  it("detects the double-quoted auth profile the provider actually emits", () => {
    const signal = detectCooldownSignal([
      'Auth profile "minimax-portal:default" is temporarily unavailable for minimax-portal/MiniMax-M3.',
    ]);
    expect(signal.detected).toBe(true);
    expect(signal.reason).toBe("auth_profile_unavailable");
    expect(signal.provider).toBe("minimax-portal:default");
  });

  it("still detects the single-quoted form", () => {
    const signal = detectCooldownSignal([
      "Auth profile 'minimax-portal:default' is temporarily unavailable for minimax-portal/MiniMax-M3.",
    ]);
    expect(signal.detected).toBe(true);
    expect(signal.reason).toBe("auth_profile_unavailable");
    expect(signal.provider).toBe("minimax-portal:default");
  });
});

/**
 * PROVIDER-QUOTA: a provider refusal can match BOTH the quota patterns and the
 * cooldown patterns. The verdict must be decided by a rule, not by whichever
 * branch happens to be checked first, because the cooldown branch ends in a bare
 * error code with no `errorFamily` and therefore gets NO bounded retry.
 */
describe("classifyProviderRefusal precedence (PROVIDER-QUOTA)", () => {
  const QUOTA_TEXT =
    "\u26a0\ufe0f Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056) | 429";
  const AUTH_PROFILE_TEXT =
    'Auth profile "minimax-portal:default" is temporarily unavailable for minimax-portal/MiniMax-M3.';
  const COOLDOWN_TEXT =
    "All models failed (1): minimax-portal/MiniMax-M3: Provider minimax-portal is in cooldown (rate_limit) | MODEL_FALLBACK_SKIPPED";

  it("reports a plain quota exhaustion as a retryable provider quota", () => {
    const verdict = classifyProviderRefusal(QUOTA_TEXT, false);
    expect(verdict).toEqual({ kind: "provider_quota", retryable: true });
  });

  it("prefers the quota verdict when the text ALSO looks like a cooldown", () => {
    // The auth-profile text matches the quota patterns (rate limit) AND the
    // cooldown detector. If cooldown won, the run would carry no errorFamily
    // and the server would schedule no retry - the defect this patch closes.
    const cooldownDetected = detectCooldownSignal([AUTH_PROFILE_TEXT]).detected;
    expect(cooldownDetected).toBe(true);
    expect(classifyProviderRefusal(AUTH_PROFILE_TEXT, cooldownDetected)).toEqual({
      kind: "provider_quota",
      retryable: true,
    });
  });

  it("prefers the quota verdict for a provider cooldown reported as rate_limit", () => {
    const cooldownDetected = detectCooldownSignal([COOLDOWN_TEXT]).detected;
    expect(cooldownDetected).toBe(true);
    expect(classifyProviderRefusal(COOLDOWN_TEXT, cooldownDetected)).toEqual({
      kind: "provider_quota",
      retryable: true,
    });
  });

  it("reports a genuine cooldown with no quota shape as a retryable cooldown", () => {
    expect(classifyProviderRefusal("Provider minimax-portal is in cooldown", true)).toEqual({
      kind: "provider_cooldown",
      retryable: true,
    });
  });

  it("reports an agent fault or gateway transport failure as not retryable", () => {
    expect(classifyProviderRefusal("OpenClaw gateway run failed", false)).toEqual({
      kind: "unknown",
      retryable: false,
    });
    expect(classifyProviderRefusal("connect ECONNREFUSED 127.0.0.1:18789", false)).toEqual({
      kind: "unknown",
      retryable: false,
    });
    expect(classifyProviderRefusal("", false)).toEqual({ kind: "unknown", retryable: false });
  });
});
