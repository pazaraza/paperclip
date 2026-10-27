import { describe, expect, it } from "vitest";
import {
  classifyProviderRefusal,
  detectCooldownSignal,
  extractProviderRefusalEvidence,
} from "./execute.js";

/**
 * PROVIDER-QUOTA: the refusal text has to be harvested from the lifecycle event stream.
 *
 * These fixtures are copied VERBATIM from production run 560120b4 (2026-10-27, Website IA
 * lane) - the run that died with `openclaw_gateway_wait_error` during the quota window.
 * The event sequence was:
 *
 *   lifecycle phase=finishing    error="⚠️ Token Plan usage limit reached ..."  <- the refusal
 *                                 errorObservation={httpStatus:429, ...}
 *   lifecycle phase=fallback_step fallbackStepFromFailureReason=rate_limit
 *   lifecycle phase=error        error="⚠️ Agent couldn't generate a response."  <- only the symptom
 *
 * and the terminal wait payload was a bare `{"error":"failed"}`.
 *
 * The previous implementation read the refusal text only from the wait payload and the
 * terminal lifecycle error. Both are useless here: the payload is "failed" and the terminal
 * error is the downstream symptom. So the classifier received the string "failed" and the
 * run was reported as a terminal agent fault with no bounded retry, which is exactly the
 * defect this patch exists to close.
 */
describe("extractProviderRefusalEvidence (PROVIDER-QUOTA, production shapes)", () => {
  it("extracts the refusal from the production `finishing` event", () => {
    const data = {
      phase: "finishing",
      error: "⚠️ Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)",
      errorObservation: {
        provider: "minimax",
        model: "MiniMax-M2.7-highspeed",
        failoverReason: "rate_limit",
        providerRuntimeFailureKind: "rate_limit",
        providerErrorType: "rate_limit_error",
        httpStatus: 429,
        providerErrorMessagePreview: "Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)",
      },
      aborted: false,
    };
    const evidence = extractProviderRefusalEvidence(data);
    expect(evidence).not.toBeNull();
    expect(evidence).toContain("Token Plan usage limit reached");
    expect(evidence).toContain("httpStatus=429");
    expect(evidence).toContain("providerRuntimeFailureKind=rate_limit");
  });

  it("extracts the refusal from the production `fallback_step` event", () => {
    const data = {
      phase: "fallback_step",
      fallbackStepType: "fallback_step",
      fallbackStepFromModel: "minimax/MiniMax-M2.7-highspeed",
      fallbackStepToModel: "ollama/qwen3.5:35b-a3b",
      fallbackStepFromFailureReason: "rate_limit",
      fallbackStepFromFailureDetail: "The AI service is temporarily rate-limited. Please try again in a moment.",
      fallbackStepChainPosition: 1,
      fallbackStepFinalOutcome: "next_fallback",
    };
    const evidence = extractProviderRefusalEvidence(data);
    expect(evidence).not.toBeNull();
    expect(evidence).toContain("failureReason=rate_limit");
    expect(evidence).toContain("temporarily rate-limited");
  });

  it("returns null for an event that carries no refusal evidence", () => {
    expect(extractProviderRefusalEvidence({ phase: "model", provider: "ollama" })).toBeNull();
    expect(extractProviderRefusalEvidence({ phase: "start" })).toBeNull();
    expect(extractProviderRefusalEvidence({})).toBeNull();
  });

  it("does NOT treat the downstream symptom as a refusal", () => {
    // The terminal error event is the symptom, not the cause. It must not by itself be
    // classified as a quota refusal, or every ordinary agent fault would be retried.
    const symptomOnly = extractProviderRefusalEvidence({
      phase: "error",
      error: "⚠️ Agent couldn't generate a response. Please try again.",
    });
    expect(symptomOnly).not.toBeNull();
    expect(classifyProviderRefusal(symptomOnly as string, false)).toEqual({
      kind: "unknown",
      retryable: false,
    });
  });
});

/**
 * The end-to-end shape of the production failure: harvest the evidence from the event
 * stream, then classify it. This is the regression that the previous implementation
 * could not pass, because its classifier input was the bare string "failed".
 */
describe("production quota failure is classified as retryable (PROVIDER-QUOTA)", () => {
  it("classifies the harvested evidence as a retryable provider quota", () => {
    const finishing = {
      phase: "finishing",
      error: "⚠️ Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)",
      errorObservation: {
        providerRuntimeFailureKind: "rate_limit",
        httpStatus: 429,
        providerErrorMessagePreview: "Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)",
      },
    };
    const fallbackStep = {
      phase: "fallback_step",
      fallbackStepFromFailureReason: "rate_limit",
      fallbackStepFromFailureDetail: "The AI service is temporarily rate-limited. Please try again in a moment.",
    };
    const terminalError = {
      phase: "error",
      error: "⚠️ Agent couldn't generate a response. Please try again.",
    };

    // The adapter accumulates evidence from every lifecycle event it sees.
    let evidence: string | null = null;
    for (const ev of [finishing, fallbackStep, terminalError]) {
      const part = extractProviderRefusalEvidence(ev);
      if (part) evidence = evidence ? `${evidence} || ${part}` : part;
    }

    expect(evidence).not.toBeNull();

    // The OLD behaviour: the classifier only ever saw the wait payload's "failed".
    const oldInput = "failed";
    expect(classifyProviderRefusal(oldInput, false)).toEqual({
      kind: "unknown",
      retryable: false,
    });

    // The NEW behaviour: the refusal is recovered and classified as retryable.
    expect(classifyProviderRefusal(evidence as string, false)).toEqual({
      kind: "provider_quota",
      retryable: true,
    });
  });

  it("detects the auth-profile cooldown from the harvested evidence", () => {
    const data = {
      phase: "finishing",
      error: 'Auth profile "minimax-portal:default" is temporarily unavailable for minimax-portal/MiniMax-M3.',
    };
    const evidence = extractProviderRefusalEvidence(data) as string;
    const signal = detectCooldownSignal([evidence]);
    expect(signal.detected).toBe(true);
    expect(signal.reason).toBe("auth_profile_unavailable");
    // And the quota verdict must win, so the run still gets a bounded retry.
    expect(classifyProviderRefusal(evidence, signal.detected)).toEqual({
      kind: "provider_quota",
      retryable: true,
    });
  });
});
