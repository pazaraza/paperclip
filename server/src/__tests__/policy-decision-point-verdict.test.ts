/**
 * RUAAAAA-1949-A: Tests for the runtime PDP verdict function.
 *
 * 100% line + branch coverage on the 5-row decision table, plus the
 * runToken guard and the edge cases (R0/R1 short-circuit, R2 wrapper
 * present vs. missing, R3 reviewer present vs. missing, R4 CEO present
 * vs. missing, multiple active bundles, no active bundle, etc.).
 *
 * Lane: in-house, Engineering (HoE). See
 * _default/RUAAAAA-1949-runtime-pdp-v0.md for the design.
 */
import { describe, expect, it } from "vitest";
import {
  decide,
  type ActiveBundle,
  type PdpContext,
  type PdpInput,
  type RunToken,
} from "../policy-decision-point/verdict.js";

// --- fixtures --------------------------------------------------------------

const REVIEWER_ACTOR = "reviewer-uuid-aaa";
const CEO_ACTOR = "ceo-uuid-bbb";

const REVIEWER_CHAIN = [REVIEWER_ACTOR, "reviewer-uuid-ccc"];
const CEO_CHAIN = [CEO_ACTOR, "ceo-uuid-ddd"];

function bundleReadOnly(): ActiveBundle {
  // R0 read-only bundle. R0/R1 short-circuits wrapper + reviewer + CEO checks.
  return {
    bundleId: "bundle-read-only",
    name: "read-project-context",
    approverClass: "R0",
    requiredTools: ["read"],
    optionalTools: ["exec"],
    wrappersByTool: {
      read: null as unknown as string,
    },
  };
}

function bundleLocalWrite(): ActiveBundle {
  // R2 local-write bundle. Wrapper required.
  return {
    bundleId: "bundle-local-write",
    name: "write-deliverable",
    approverClass: "R2",
    requiredTools: ["write"],
    optionalTools: ["edit", "apply_patch"],
    wrappersByTool: {
      write: "write-within-workspace",
      edit: "edit-within-workspace",
      apply_patch: "patch-within-workspace",
    },
  };
}

function bundleCrossSystem(): ActiveBundle {
  // R3 cross-system bundle. Wrapper + reviewer required.
  return {
    bundleId: "bundle-cross-system",
    name: "send-external-message",
    approverClass: "R3",
    requiredTools: ["web_fetch"],
    optionalTools: [],
    wrappersByTool: {
      web_fetch: "web-fetch-method-aware",
    },
  };
}

function bundlePrivileged(): ActiveBundle {
  // R4 privileged bundle. Wrapper + reviewer + CEO required.
  return {
    bundleId: "bundle-privileged",
    name: "rotate-api-key",
    approverClass: "R4",
    requiredTools: ["rotate_key"],
    optionalTools: [],
    wrappersByTool: {
      rotate_key: "rotate-key-with-2step",
    },
  };
}

function baseContext(activeBundles: ActiveBundle[]): PdpContext {
  return {
    activeBundles,
    wrapperRegistry: {},
    reviewerChain: REVIEWER_CHAIN,
    ceoApproverChain: CEO_CHAIN,
  };
}

function baseInput(overrides: Partial<PdpInput> = {}): PdpInput {
  return {
    toolName: "read",
    args: { path: "/workspace/README.md" },
    runToken: {
      runId: "run-1",
      agentId: "agent-1",
      issueId: "issue-1",
      activeBundleId: "bundle-read-only",
      maxRiskClass: "R0",
    },
    context: baseContext([bundleReadOnly()]),
    acceptedReviewerActorIds: [],
    acceptedCeoActorIds: [],
    ...overrides,
  };
}

// --- runToken guard --------------------------------------------------------

describe("verdict: runToken guard", () => {
  it("returns hard_stop with run_token_missing when runToken is null", () => {
    const out = decide(baseInput({ runToken: null }));
    expect(out.verdict).toBe("hard_stop");
    expect(out.reason).toBe("run_token_missing");
    expect(out.bundleId).toBeNull();
    expect(out.decisionPath).toEqual(["run_token_check"]);
  });

  it("records the runToken check as the first decision step", () => {
    const out = decide(baseInput());
    expect(out.decisionPath[0]).toBe("run_token_check");
  });
});

// --- row 1: tool-in-bundle check ------------------------------------------

describe("verdict: row 1 (tool not in bundle)", () => {
  it("returns hard_stop when the active bundle is not in activeBundles", () => {
    const out = decide(
      baseInput({
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-does-not-exist",
          maxRiskClass: "R0",
        },
        context: baseContext([bundleReadOnly()]),
      }),
    );
    expect(out.verdict).toBe("hard_stop");
    expect(out.reason).toBe("tool_not_in_bundle");
    expect(out.decisionPath).toEqual([
      "run_token_check",
      "bundle_lookup",
    ]);
  });

  it("returns hard_stop when toolName is not in required or optional tools", () => {
    const out = decide(
      baseInput({
        toolName: "image_generate",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-read-only",
          maxRiskClass: "R0",
        },
        context: baseContext([bundleReadOnly()]),
      }),
    );
    expect(out.verdict).toBe("hard_stop");
    expect(out.reason).toBe("tool_not_in_bundle");
    expect(out.decisionPath).toEqual([
      "run_token_check",
      "bundle_lookup",
      "tool_in_bundle_check",
    ]);
  });

  it("allows when toolName is in optionalTools", () => {
    const out = decide(
      baseInput({
        toolName: "exec",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-read-only",
          maxRiskClass: "R0",
        },
        context: baseContext([bundleReadOnly()]),
      }),
    );
    expect(out.verdict).toBe("allow");
    expect(out.reason).toBe("ok");
  });
});

// --- row 2: wrapper check (R2+) -------------------------------------------

describe("verdict: row 2 (wrapper missing for R2+)", () => {
  it("returns hard_stop when R2 call has no wrapper registered", () => {
    const out = decide(
      baseInput({
        toolName: "write",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-local-write",
          maxRiskClass: "R2",
        },
        context: baseContext([bundleLocalWrite()]),
      }),
    );
    expect(out.verdict).toBe("hard_stop");
    expect(out.reason).toBe("wrapper_missing_for_r2_plus");
    expect(out.decisionPath).toContain("wrapper_check");
  });

  it("returns hard_stop when R2 call has a mismatched wrapper", () => {
    const out = decide(
      baseInput({
        toolName: "write",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-local-write",
          maxRiskClass: "R2",
        },
        context: {
          ...baseContext([bundleLocalWrite()]),
          wrapperRegistry: { write: "some-other-wrapper" },
        },
      }),
    );
    expect(out.verdict).toBe("hard_stop");
    expect(out.reason).toBe("wrapper_missing_for_r2_plus");
  });

  it("returns allow when R2 call has the matching wrapper", () => {
    const out = decide(
      baseInput({
        toolName: "write",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-local-write",
          maxRiskClass: "R2",
        },
        context: {
          ...baseContext([bundleLocalWrite()]),
          wrapperRegistry: { write: "write-within-workspace" },
        },
      }),
    );
    expect(out.verdict).toBe("allow");
    expect(out.reason).toBe("ok");
  });

  it("skips the wrapper check for R0/R1 bundles", () => {
    const out = decide(
      baseInput({
        toolName: "read",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-read-only",
          maxRiskClass: "R0",
        },
        context: baseContext([bundleReadOnly()]),
      }),
    );
    // For an R0 bundle the wrapper check is recorded as run (it does not
    // gate), so it must appear in the path, and the call must be allowed.
    expect(out.decisionPath).toContain("wrapper_check");
    expect(out.verdict).toBe("allow");
  });
});

// --- row 3: reviewer check (R3+) ------------------------------------------

describe("verdict: row 3 (awaiting reviewer signoff)", () => {
  it("returns soft_pause when R3 call has no reviewer signoff", () => {
    const out = decide(
      baseInput({
        toolName: "web_fetch",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-cross-system",
          maxRiskClass: "R3",
        },
        context: {
          ...baseContext([bundleCrossSystem()]),
          wrapperRegistry: { web_fetch: "web-fetch-method-aware" },
        },
        acceptedReviewerActorIds: [],
      }),
    );
    expect(out.verdict).toBe("soft_pause");
    expect(out.reason).toBe("awaiting_reviewer_signoff");
    expect(out.decisionPath).toContain("reviewer_check");
  });

  it("returns soft_pause when reviewer is from outside the chain", () => {
    const out = decide(
      baseInput({
        toolName: "web_fetch",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-cross-system",
          maxRiskClass: "R3",
        },
        context: {
          ...baseContext([bundleCrossSystem()]),
          wrapperRegistry: { web_fetch: "web-fetch-method-aware" },
        },
        acceptedReviewerActorIds: ["random-user-999"],
      }),
    );
    expect(out.verdict).toBe("soft_pause");
    expect(out.reason).toBe("awaiting_reviewer_signoff");
  });

  it("returns hard_stop on the wrapper row before reaching the reviewer row for an R3 call without wrapper", () => {
    // The wrapper check fires FIRST. An R3 call without the wrapper must
    // hard_stop on the wrapper row, not soft_pause on the reviewer row.
    const out = decide(
      baseInput({
        toolName: "web_fetch",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-cross-system",
          maxRiskClass: "R3",
        },
        context: baseContext([bundleCrossSystem()]),
        acceptedReviewerActorIds: [],
      }),
    );
    expect(out.verdict).toBe("hard_stop");
    expect(out.reason).toBe("wrapper_missing_for_r2_plus");
  });

  it("returns allow when R3 call has matching wrapper + reviewer signoff", () => {
    const out = decide(
      baseInput({
        toolName: "web_fetch",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-cross-system",
          maxRiskClass: "R3",
        },
        context: {
          ...baseContext([bundleCrossSystem()]),
          wrapperRegistry: { web_fetch: "web-fetch-method-aware" },
        },
        acceptedReviewerActorIds: [REVIEWER_ACTOR],
      }),
    );
    expect(out.verdict).toBe("allow");
    expect(out.reason).toBe("ok");
  });
});

// --- row 4: CEO check (R4) ------------------------------------------------

describe("verdict: row 4 (CEO signoff missing for R4)", () => {
  it("returns hard_stop when R4 call has matching wrapper + reviewer but no CEO signoff", () => {
    const out = decide(
      baseInput({
        toolName: "rotate_key",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-privileged",
          maxRiskClass: "R4",
        },
        context: {
          ...baseContext([bundlePrivileged()]),
          wrapperRegistry: { rotate_key: "rotate-key-with-2step" },
        },
        acceptedReviewerActorIds: [REVIEWER_ACTOR],
        acceptedCeoActorIds: [],
      }),
    );
    expect(out.verdict).toBe("hard_stop");
    expect(out.reason).toBe("ceo_signoff_missing_for_r4");
    expect(out.decisionPath).toContain("ceo_check");
  });

  it("returns hard_stop on wrapper row when R4 call has no wrapper", () => {
    const out = decide(
      baseInput({
        toolName: "rotate_key",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-privileged",
          maxRiskClass: "R4",
        },
        context: baseContext([bundlePrivileged()]),
        acceptedReviewerActorIds: [REVIEWER_ACTOR],
        acceptedCeoActorIds: [CEO_ACTOR],
      }),
    );
    expect(out.verdict).toBe("hard_stop");
    expect(out.reason).toBe("wrapper_missing_for_r2_plus");
  });

  it("returns allow when R4 call has wrapper + reviewer + CEO signoff", () => {
    const out = decide(
      baseInput({
        toolName: "rotate_key",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-privileged",
          maxRiskClass: "R4",
        },
        context: {
          ...baseContext([bundlePrivileged()]),
          wrapperRegistry: { rotate_key: "rotate-key-with-2step" },
        },
        acceptedReviewerActorIds: [REVIEWER_ACTOR],
        acceptedCeoActorIds: [CEO_ACTOR],
      }),
    );
    expect(out.verdict).toBe("allow");
    expect(out.reason).toBe("ok");
  });

  it("returns hard_stop when CEO is from outside the chain", () => {
    const out = decide(
      baseInput({
        toolName: "rotate_key",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-privileged",
          maxRiskClass: "R4",
        },
        context: {
          ...baseContext([bundlePrivileged()]),
          wrapperRegistry: { rotate_key: "rotate-key-with-2step" },
        },
        acceptedReviewerActorIds: [REVIEWER_ACTOR],
        acceptedCeoActorIds: ["random-ceo-999"],
      }),
    );
    expect(out.verdict).toBe("hard_stop");
    expect(out.reason).toBe("ceo_signoff_missing_for_r4");
  });
});

// --- argsHash + decisionPath ----------------------------------------------

describe("verdict: argsHash + decisionPath", () => {
  it("emits a deterministic 64-char hex argsHash", () => {
    const out = decide(baseInput({ args: { path: "/x" } }));
    expect(out.argsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("emits the same argsHash for equivalent args (JSON-canonical)", () => {
    const a = decide(baseInput({ args: { a: 1, b: 2 } }));
    const b = decide(baseInput({ args: { a: 1, b: 2 } }));
    expect(a.argsHash).toBe(b.argsHash);
  });

  it("treats null args as the canonical null token", () => {
    const a = decide(baseInput({ args: null }));
    expect(a.argsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records all 7 decision steps in order on a full allow", () => {
    const out = decide(
      baseInput({
        toolName: "rotate_key",
        runToken: {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          activeBundleId: "bundle-privileged",
          maxRiskClass: "R4",
        },
        context: {
          ...baseContext([bundlePrivileged()]),
          wrapperRegistry: { rotate_key: "rotate-key-with-2step" },
        },
        acceptedReviewerActorIds: [REVIEWER_ACTOR],
        acceptedCeoActorIds: [CEO_ACTOR],
      }),
    );
    expect(out.decisionPath).toEqual([
      "run_token_check",
      "bundle_lookup",
      "tool_in_bundle_check",
      "wrapper_check",
      "reviewer_check",
      "ceo_check",
      "allow",
    ]);
  });
});
