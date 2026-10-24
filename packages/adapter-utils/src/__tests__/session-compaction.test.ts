import { describe, expect, it } from "vitest";

import {
  ADAPTER_SESSION_MANAGEMENT,
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
} from "../session-compaction.js";

describe("session compaction policy resolution", () => {
  it("gives hermes_local rotation thresholds without an agent override (RUAAAAA-5242)", () => {
    // hermes' own compression stalls on long sessions, so a hermes agent must be
    // born protected rather than relying on native context management.
    const resolved = resolveSessionCompactionPolicy("hermes_local", undefined);

    expect(resolved.source).toBe("adapter_default");
    expect(resolved.policy.enabled).toBe(true);
    expect(hasSessionCompactionThresholds(resolved.policy)).toBe(true);
    expect(resolved.policy.maxSessionRuns).toBeGreaterThan(0);
    expect(resolved.policy.maxRawInputTokens).toBeGreaterThan(0);
    expect(resolved.policy.maxSessionAgeHours).toBeGreaterThan(0);
  });

  it("keeps threshold-based rotation off for adapters whose native compaction holds", () => {
    // Regression guard for the original RUAAAAA-5242 defect shape: an all-zero
    // policy silently disables rotation because hasSessionCompactionThresholds()
    // returns false. Only hermes_local was proven to stall, so the other
    // adapter-managed types must stay opted out.
    for (const adapterType of ["acpx_local", "claude_local", "codex_local"]) {
      const resolved = resolveSessionCompactionPolicy(adapterType, undefined);
      expect(hasSessionCompactionThresholds(resolved.policy)).toBe(false);
    }
  });

  it("still lets an agent override the hermes fleet default", () => {
    const resolved = resolveSessionCompactionPolicy("hermes_local", {
      heartbeat: { sessionCompaction: { maxSessionRuns: 3 } },
    });

    expect(resolved.source).toBe("agent_override");
    expect(resolved.policy.maxSessionRuns).toBe(3);
    // Unspecified thresholds fall through to the hermes fleet default.
    expect(resolved.policy.maxSessionAgeHours).toBe(
      ADAPTER_SESSION_MANAGEMENT.hermes_local?.defaultSessionCompaction.maxSessionAgeHours,
    );
  });

  it("lets an agent disable rotation entirely", () => {
    const resolved = resolveSessionCompactionPolicy("hermes_local", {
      heartbeat: { sessionCompaction: { enabled: false } },
    });

    expect(resolved.policy.enabled).toBe(false);
  });
});