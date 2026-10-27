import { describe, expect, it } from "vitest";
import { detectCooldownSignal, detectProviderQuotaExhausted } from "./execute.js";

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
