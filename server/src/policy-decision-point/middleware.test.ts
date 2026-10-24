/**
 * RUAAAAA-1955 (Slice 1949-B): Tests for the runtime PDP middleware.
 *
 * Coverage:
 *   - 1 test per verdict (allow, soft_pause, hard_stop for rows 1/2/3/4
 *     in the 5-row decision table) — 5 tests.
 *   - phase=1 short-circuit (verdict is `allow` even when the runtime
 *     would have returned `hard_stop`) — 1 test.
 *   - phase=2 enforcement (verdict is `hard_stop` when the runtime
 *     decides so) — 1 test.
 *   - phase flip observable across calls (1 → 2 mid-test) — 1 test.
 *   - run_token_missing (no runToken in body, no DB row) — 1 test.
 *   - explicit runToken in `runContext.runToken` skips the loader — 1 test.
 *   - emit is called exactly once per tool call (no double-emit on
 *     phase=1 vs phase=2) — 1 test.
 *   - emit failures are swallowed (the call still proceeds) — 1 test.
 *   - 404 path: missing body / wrong shape → `next()` is called and
 *     the middleware does not interfere with the route handler's
 *     downstream 400 — 1 test.
 *
 * Total: ≥12 test cases (currently 13). The self-test gate in the
 * issue spec (`pnpm test middleware` exits 0 with ≥12 cases) is met.
 *
 * Lane: in-house, Engineering (Head of Engineering, `584ea4bb-…`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createPdpMiddleware } from "./middleware.js";
import {
  decide,
  type ActiveBundle,
  type PdpContext,
  type PdpOutput,
  type RunToken,
} from "./verdict.js";
import type {
  PdpMiddlewareDeps,
  PdpMiddlewareResult,
  PdpToolExecuteBody,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REVIEWER_ACTOR = "reviewer-uuid-aaa";
const CEO_ACTOR = "ceo-uuid-bbb";
const REVIEWER_CHAIN = [REVIEWER_ACTOR, "reviewer-uuid-ccc"];
const CEO_CHAIN = [CEO_ACTOR, "ceo-uuid-ddd"];

function bundleReadOnly(): ActiveBundle {
  return {
    bundleId: "bundle-read-only",
    name: "read-project-context",
    approverClass: "R0",
    requiredTools: ["read"],
    optionalTools: ["exec"],
    wrappersByTool: {},
  };
}

function bundleLocalWrite(): ActiveBundle {
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

function baseContext(): PdpContext {
  return {
    activeBundles: [bundleReadOnly(), bundleLocalWrite(), bundleCrossSystem(), bundlePrivileged()],
    wrapperRegistry: {
      write: "write-within-workspace",
      edit: "edit-within-workspace",
      apply_patch: "patch-within-workspace",
      web_fetch: "web-fetch-method-aware",
      rotate_key: "rotate-key-with-2step",
    },
    reviewerChain: REVIEWER_CHAIN,
    ceoApproverChain: CEO_CHAIN,
  };
}

function makeRunToken(overrides: Partial<RunToken> = {}): RunToken {
  return {
    runId: "run-1",
    agentId: "agent-1",
    issueId: "issue-1",
    activeBundleId: "bundle-read-only",
    maxRiskClass: "R0",
    ...overrides,
  };
}

function makeBody(overrides: Partial<PdpToolExecuteBody> = {}): PdpToolExecuteBody {
  return {
    tool: "read",
    parameters: { path: "/workspace/README.md" },
    runContext: {
      agentId: "agent-1",
      runId: "run-1",
      companyId: "company-1",
      projectId: "project-1",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock objects (express req/res/next)
// ---------------------------------------------------------------------------

function makeReq(body: PdpToolExecuteBody | unknown): Request {
  return { body } as Request;
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

// ---------------------------------------------------------------------------
// Test deps factory
// ---------------------------------------------------------------------------

interface DepsHandle {
  deps: PdpMiddlewareDeps;
  emitted: PdpMiddlewareResult[];
  loadRunToken: ReturnType<typeof vi.fn>;
  loadAcceptedSignoff: ReturnType<typeof vi.fn>;
  emitVerdict: ReturnType<typeof vi.fn>;
  setPhase: (next: 1 | 2) => void;
  getContext: () => PdpContext;
  getPhase: () => 1 | 2;
}

function makeDeps(overrides: Partial<{
  loadRunToken: ReturnType<typeof vi.fn>;
  loadAcceptedSignoff: ReturnType<typeof vi.fn>;
  emitVerdict: ReturnType<typeof vi.fn>;
  runToken: RunToken | null;
  reviewer: string[];
  ceo: string[];
  context: PdpContext;
  initialPhase: 1 | 2;
}> = {}): DepsHandle {
  const emitted: PdpMiddlewareResult[] = [];
  const loadRunToken = overrides.loadRunToken ?? vi.fn().mockResolvedValue(overrides.runToken ?? makeRunToken());
  const loadAcceptedSignoff = overrides.loadAcceptedSignoff ?? vi.fn().mockResolvedValue({
    reviewer: overrides.reviewer ?? [],
    ceo: overrides.ceo ?? [],
  });
  const emitVerdict = overrides.emitVerdict ?? vi.fn().mockImplementation((v: PdpMiddlewareResult) => {
    emitted.push(v);
  });
  let phase: 1 | 2 = overrides.initialPhase ?? 2;
  const ctx = overrides.context ?? baseContext();
  const deps: PdpMiddlewareDeps = {
    decide,
    getPhase: () => phase,
    getContext: () => ctx,
    loadRunToken: loadRunToken as PdpMiddlewareDeps["loadRunToken"],
    loadAcceptedSignoff: loadAcceptedSignoff as PdpMiddlewareDeps["loadAcceptedSignoff"],
    emitVerdict: emitVerdict as unknown as PdpMiddlewareDeps["emitVerdict"],
  };
  return {
    deps,
    emitted,
    loadRunToken,
    loadAcceptedSignoff,
    emitVerdict,
    setPhase: (next) => { phase = next; },
    getContext: () => ctx,
    getPhase: () => phase,
  };
}

// ---------------------------------------------------------------------------
// 1) Verdict — allow
// ---------------------------------------------------------------------------

describe("pdpMiddleware: allow", () => {
  it("calls next() and emits a verdict=allow event for an R0 read", async () => {
    const h = makeDeps();
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "read" }));
    const { res, status, json } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].verdict.verdict).toBe("allow");
    expect(h.emitted[0].verdict.reason).toBe("ok");
    expect(h.emitted[0].toolName).toBe("read");
    expect(h.emitted[0].phase).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2) Verdict — hard_stop (tool not in bundle, row 1)
// ---------------------------------------------------------------------------

describe("pdpMiddleware: hard_stop (row 1 — tool not in bundle)", () => {
  it("returns 403 with reason=tool_not_in_bundle for an unknown tool", async () => {
    const h = makeDeps();
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "totally-unknown-tool", parameters: { foo: "bar" } }));
    const { res, status, json } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    const payload = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.verdict).toBe("hard_stop");
    expect(payload.reason).toBe("tool_not_in_bundle");
    expect(payload.argsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.decisionPath).toContain("bundle_lookup");
    expect(h.emitted[0].verdict.reason).toBe("tool_not_in_bundle");
  });
});

// ---------------------------------------------------------------------------
// 3) Verdict — hard_stop (wrapper missing for R2+, row 2)
// ---------------------------------------------------------------------------

describe("pdpMiddleware: hard_stop (row 2 — wrapper missing for R2+)", () => {
  it("returns 403 with reason=wrapper_missing_for_r2_plus when wrapperRegistry does not match", async () => {
    const h = makeDeps({
      runToken: makeRunToken({ activeBundleId: "bundle-local-write", maxRiskClass: "R2" }),
      // wrapperRegistry is missing the 'write' wrapper → mismatch
      context: {
        ...baseContext(),
        wrapperRegistry: { edit: "edit-within-workspace", apply_patch: "patch-within-workspace" },
      },
    });
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "write", parameters: { path: "/workspace/out.md" } }));
    const { res, status, json } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    const payload = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.verdict).toBe("hard_stop");
    expect(payload.reason).toBe("wrapper_missing_for_r2_plus");
    expect(payload.decisionPath).toContain("wrapper_check");
  });
});

// ---------------------------------------------------------------------------
// 4) Verdict — soft_pause (awaiting reviewer signoff, row 3)
// ---------------------------------------------------------------------------

describe("pdpMiddleware: soft_pause (row 3 — awaiting reviewer signoff)", () => {
  it("returns 202 with a request_confirmation payload when R3 has no reviewer signoff", async () => {
    const h = makeDeps({
      runToken: makeRunToken({ activeBundleId: "bundle-cross-system", maxRiskClass: "R3" }),
      reviewer: [], // no signoff
    });
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "web_fetch", parameters: { url: "https://api.example.com/post", method: "POST" } }));
    const { res, status, json } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(202);
    const payload = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.verdict).toBe("soft_pause");
    expect(payload.reason).toBe("awaiting_reviewer_signoff");
    expect(payload.phase).toBe(2);
    const interaction = payload.interaction as Record<string, unknown>;
    expect(interaction.kind).toBe("request_confirmation");
    expect(interaction.prompt).toContain("requires a reviewer signoff");
    expect(interaction.acceptLabel).toBe("Approve and run");
  });

  it("returns allow (next) for R3 when a reviewer signoff IS present", async () => {
    const h = makeDeps({
      runToken: makeRunToken({ activeBundleId: "bundle-cross-system", maxRiskClass: "R3" }),
      reviewer: [REVIEWER_ACTOR], // signoff present
    });
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "web_fetch", parameters: { url: "https://api.example.com/post", method: "POST" } }));
    const { res } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(h.emitted[0].verdict.verdict).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 5) Verdict — hard_stop (CEO signoff missing for R4, row 4)
// ---------------------------------------------------------------------------

describe("pdpMiddleware: hard_stop (row 4 — CEO signoff missing for R4)", () => {
  it("returns 403 with reason=ceo_signoff_missing_for_r4 when the CEO has not signed off", async () => {
    const h = makeDeps({
      runToken: makeRunToken({ activeBundleId: "bundle-privileged", maxRiskClass: "R4" }),
      reviewer: [REVIEWER_ACTOR], // R3 reviewer present
      ceo: [], // R4 CEO missing
    });
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "rotate_key", parameters: { keyId: "k-1" } }));
    const { res, status, json } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    const payload = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.verdict).toBe("hard_stop");
    expect(payload.reason).toBe("ceo_signoff_missing_for_r4");
    expect(payload.decisionPath).toContain("ceo_check");
  });

  it("returns allow for R4 when both reviewer AND CEO have signed off", async () => {
    const h = makeDeps({
      runToken: makeRunToken({ activeBundleId: "bundle-privileged", maxRiskClass: "R4" }),
      reviewer: [REVIEWER_ACTOR],
      ceo: [CEO_ACTOR],
    });
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "rotate_key", parameters: { keyId: "k-1" } }));
    const { res } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(h.emitted[0].verdict.verdict).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 6) Phase=1 short-circuit
// ---------------------------------------------------------------------------

describe("pdpMiddleware: phase=1 (observation mode)", () => {
  it("overrides the verdict to allow and still emits a pdp_verdict event with reason=ok", async () => {
    const h = makeDeps({
      initialPhase: 1,
      // R3 call WITH reviewer signoff present, but R4 call with no CEO
      // signoff: the decisionPath will include "ceo_check" so we can
      // assert the audit trail records what the runtime WOULD have
      // decided in phase=2.
      runToken: makeRunToken({ activeBundleId: "bundle-privileged", maxRiskClass: "R4" }),
      reviewer: [REVIEWER_ACTOR], // R3 reviewer present → falls through to ceo_check
      ceo: [], // R4 CEO missing → would hard_stop on cso_check
    });
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "rotate_key", parameters: { keyId: "k-1" } }));
    const { res } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(h.emitted).toHaveLength(1);
    // The verdict is forced to allow in phase=1
    expect(h.emitted[0].verdict.verdict).toBe("allow");
    expect(h.emitted[0].verdict.reason).toBe("ok");
    expect(h.emitted[0].phase).toBe(1);
    // The decisionPath still includes the ceo_check — the runtime
    // "would have" decided hard_stop in phase=2, so the audit trail
    // records what the runtime would have done.
    expect(h.emitted[0].verdict.decisionPath).toContain("ceo_check");
  });
});

// ---------------------------------------------------------------------------
// 7) Phase flip observable
// ---------------------------------------------------------------------------

describe("pdpMiddleware: phase flip takes effect on the next call", () => {
  it("flips from phase=1 to phase=2 mid-test and the next call enforces the verdict", async () => {
    const h = makeDeps({
      initialPhase: 1,
      // R4 with reviewer signoff present but CEO missing: phase=2 will
      // fire the ceo_check and return hard_stop. (R3-only would
      // soft_pause first and never reach the ceo_check.)
      runToken: makeRunToken({ activeBundleId: "bundle-privileged", maxRiskClass: "R4" }),
      reviewer: [REVIEWER_ACTOR],
      ceo: [],
    });
    const mw = createPdpMiddleware(h.deps);
    const { res, status, json } = makeRes();
    const next = vi.fn();

    // Call 1: phase=1 → allow
    await mw(makeReq(makeBody({ tool: "rotate_key" })), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(h.emitted[0].verdict.verdict).toBe("allow");

    // Flip to phase=2
    h.setPhase(2);

    // Call 2: phase=2 → hard_stop
    next.mockClear();
    status.mockClear();
    json.mockClear();
    await mw(makeReq(makeBody({ tool: "rotate_key" })), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    const payload = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.verdict).toBe("hard_stop");
    expect(payload.reason).toBe("ceo_signoff_missing_for_r4");
    expect(h.emitted[1].phase).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 8) run_token_missing
// ---------------------------------------------------------------------------

describe("pdpMiddleware: run_token_missing", () => {
  it("returns 403 with reason=run_token_missing when no runToken in body and the loader returns null", async () => {
    // We need an explicit loadRunToken mock because `runToken: null`
    // in the makeDeps overrides object is treated by `??` as "use the
    // default" — the loader would return a real runToken, not null.
    const h = makeDeps({
      loadRunToken: vi.fn().mockResolvedValue(null),
    });
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "read" }));
    const { res, status, json } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    const payload = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.verdict).toBe("hard_stop");
    expect(payload.reason).toBe("run_token_missing");
    expect(h.loadRunToken).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 9) Explicit runToken in runContext.runToken skips the loader
// ---------------------------------------------------------------------------

describe("pdpMiddleware: explicit runContext.runToken", () => {
  it("does not call the loader when runContext.runToken is present", async () => {
    const explicitToken = makeRunToken({ activeBundleId: "bundle-local-write", maxRiskClass: "R2" });
    const h = makeDeps({
      runToken: explicitToken, // loader would return this if called
    });
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({
      tool: "write",
      runContext: {
        agentId: "agent-1",
        runId: "run-1",
        companyId: "company-1",
        projectId: "project-1",
        runToken: explicitToken, // explicit in body
      },
    }));
    const { res } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(h.loadRunToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10) emit failures are swallowed
// ---------------------------------------------------------------------------

describe("pdpMiddleware: emitVerdict failure is swallowed", () => {
  it("proceeds with the call even when emitVerdict throws", async () => {
    const emit = vi.fn(() => { throw new Error("logger is on fire"); });
    const h = makeDeps({ emitVerdict: emit });
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "read" }));
    const { res } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 11) Defensive: missing body / wrong shape → call next() so the route
//      handler's downstream 400 can take over.
// ---------------------------------------------------------------------------

describe("pdpMiddleware: missing body / wrong shape", () => {
  it("calls next() when req.body is null", async () => {
    const h = makeDeps();
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(null);
    const { res, status, json } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it("calls next() when req.body is missing the tool field", async () => {
    const h = makeDeps();
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq({ runContext: { agentId: "a", runId: "r", companyId: "c", projectId: "p" } });
    const { res, status, json } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 12) Signoff loader failure is swallowed (R3+ fail-closed)
// ---------------------------------------------------------------------------

describe("pdpMiddleware: signoff loader failure is swallowed", () => {
  it("treats a thrown signoff loader as empty arrays (R3+ fails closed)", async () => {
    const h = makeDeps({
      runToken: makeRunToken({ activeBundleId: "bundle-cross-system", maxRiskClass: "R3" }),
      loadAcceptedSignoff: vi.fn().mockRejectedValue(new Error("db is down")),
    });
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "web_fetch", parameters: { url: "https://api.example.com", method: "POST" } }));
    const { res, status, json } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(202);
    const payload = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.verdict).toBe("soft_pause");
    expect(payload.reason).toBe("awaiting_reviewer_signoff");
  });
});

// ---------------------------------------------------------------------------
// 13) runToken loader failure is swallowed (treated as run_token_missing)
// ---------------------------------------------------------------------------

describe("pdpMiddleware: runToken loader failure is swallowed", () => {
  it("treats a thrown runToken loader as run_token_missing", async () => {
    const h = makeDeps({
      loadRunToken: vi.fn().mockRejectedValue(new Error("db is down")),
    });
    const mw = createPdpMiddleware(h.deps);
    const req = makeReq(makeBody({ tool: "read" }));
    const { res, status, json } = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    const payload = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.verdict).toBe("hard_stop");
    expect(payload.reason).toBe("run_token_missing");
  });
});
