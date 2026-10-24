/**
 * RUAAAAA-1956: PDP verdict fixture replay test.
 *
 * Slice 1949-C — extends the 1946 fixture harness so the 4 PDP verdict
 * cases reproduce their expected verdicts when fed through the runtime
 * PDP `decide()` function. The fixtures live in the Paperclip project's
 * `_default/` directory and are loaded here as the source of truth:
 *
 *   - `mcp-overload-events.fixture.jsonl`         (event stream; 4 pdp_verdict entries)
 *   - `mcp-ops-audit-overloaded-mcp-fixtures.json` (structured fixture; 4 pdpVerdicts entries)
 *
 * Self-test gate: `pnpm test fixtures` exits 0.
 *
 * The harness is purely a replay/oracle test:
 *  - Loads each fixture
 *  - Builds a PdpInput that reproduces the runtime scenario the fixture
 *    describes (tool not in bundle / R2+ wrapper missing / R3+ reviewer
 *    missing / R4 CEO missing)
 *  - Runs `decide()` and asserts the verdict, reason, argsHash format,
 *    and decisionPath match the fixture's contract
 *
 * Lane: in-house, Engineering (HoE). See _default/RUAAAAA-1956, _default/RUAAAAA-1954
 * (verdict function), and _default/RUAAAAA-1949-runtime-pdp-v0.md for the design.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decide,
  type ActiveBundle,
  type PdpContext,
  type PdpInput,
  type ReasonCode,
  type RiskClass,
  type RunToken,
  type Verdict,
} from "../policy-decision-point/verdict.js";

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

/**
 * Default location of the Paperclip project's `_default/` fixture directory.
 * Override with the `PDP_FIXTURE_ROOT` env var when running outside the
 * canonical location (CI, sandbox, etc.).
 */
const FIXTURE_ROOT =
  process.env.PDP_FIXTURE_ROOT ??
  "/Users/orionis/.paperclip/instances/default/projects/17962940-d69e-4909-bb45-c7bb534505e5/930849e3-de06-47ba-8027-63a527ae1baa/_default";

interface FixturePdp {
  verdict: Verdict;
  reason: ReasonCode;
  toolName: string;
  bundle: string;
  rClass?: RiskClass;
  /** The bundle's expected wrapper. Recorded when the wrapper check fired;
   *  null/missing for cases where the wrapper check passed. */
  wrapper?: string | null;
  reviewerSignoff?: string | null;
  operatorSignoff?: string | null;
  ceoSignoff?: string | null;
  argsHash: string;
  runId: string;
  expectedInteraction?: "request_confirmation" | null;
}

interface JsonlEvent {
  at: string;
  type: string;
  pdp?: FixturePdp;
}

function loadJsonl(path: string): JsonlEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JsonlEvent);
}

interface StructuredFixture {
  pdpVerdicts: (FixturePdp & { expectedVerdictRationale?: string })[];
}

function loadStructuredFixture(path: string): StructuredFixture {
  return JSON.parse(readFileSync(path, "utf8")) as StructuredFixture;
}

// ---------------------------------------------------------------------------
// Scenario builder
// ---------------------------------------------------------------------------

/** Reviewer chain. The verdict function checks for accepted actor ids in this chain. */
const REVIEWER_CHAIN = ["reviewer-uuid-aaa", "reviewer-uuid-ccc"];
/** CEO approver chain. R4 calls must have an accepted actor id in this chain. */
const CEO_CHAIN = ["ceo-uuid-bbb", "ceo-uuid-ddd"];

/**
 * Map a fixture record to a PdpInput that reproduces the runtime
 * scenario. The fixture is the description of what the runtime PDP
 * observed; the input is what the runtime PDP would have received.
 *
 * Per-case construction:
 *   case 1 (tool_not_in_bundle):
 *     - bundle's requiredTools does NOT include fixture.toolName
 *     - wrapper check is irrelevant (tool check fires first)
 *   case 2 (wrapper_missing_for_r2_plus):
 *     - bundle has the expected wrapper for fixture.toolName
 *     - wrapperRegistry is empty (call has no wrapper registered)
 *     - approverClass is R2+
 *   case 3 (awaiting_reviewer_signoff):
 *     - bundle has the expected wrapper; registry matches
 *     - acceptedReviewerActorIds is empty (no reviewer signoff)
 *     - approverClass is R3+
 *   case 4 (ceo_signoff_missing_for_r4):
 *     - bundle has the expected wrapper; registry matches
 *     - acceptedReviewerActorIds has a valid reviewer (in chain)
 *     - acceptedCeoActorIds is empty (no CEO signoff)
 *     - approverClass is R4
 */
function scenarioFor(fixture: FixturePdp): PdpInput {
  const bundleId = fixture.bundle;
  const approverClass: RiskClass = fixture.rClass ?? "R0";
  const isToolNotInBundleCase = fixture.reason === "tool_not_in_bundle";

  // For case 1, the bundle's required tools must NOT include the tool
  // being called. For all other cases, the tool IS in the bundle.
  const requiredTools: string[] = isToolNotInBundleCase
    ? ["read", "exec", "list"]
    : [fixture.toolName];

  // The bundle's expected wrapper. The JSONL records this only when the
  // wrapper check fired (case 2). For cases 3/4, the wrapper check
  // passed but the fixture doesn't record which wrapper was used; we
  // use a default name that the registry will also have, so the wrapper
  // row passes and the next row can fire.
  const expectedWrapper: string | null =
    fixture.wrapper ??
    (fixture.reason === "awaiting_reviewer_signoff" ||
    fixture.reason === "ceo_signoff_missing_for_r4"
      ? `default-wrapper-for-${fixture.toolName}`
      : null);

  const wrappersByTool: Record<string, string> = expectedWrapper
    ? { [fixture.toolName]: expectedWrapper }
    : {};

  // The wrapperRegistry records what wrapper the call is going through.
  // Empty for case 2 (wrapper missing). Matches the expected wrapper
  // for cases 3 and 4. Empty for case 1 (irrelevant).
  const wrapperRegistry: Record<string, string> =
    fixture.reason === "wrapper_missing_for_r2_plus"
      ? {}
      : expectedWrapper
        ? { [fixture.toolName]: expectedWrapper }
        : {};

  // Reviewer signoff: needed to reach the CEO check for R4. For case 4
  // specifically, the reviewer signed but the CEO did not, so we
  // include a valid reviewer id and leave the CEO list empty.
  const acceptedReviewerActorIds: string[] =
    fixture.reason === "ceo_signoff_missing_for_r4" ? [...REVIEWER_CHAIN] : [];

  // None of the 4 cases has a CEO signoff (case 4 explicitly has
  // ceoSignoff=null in the structured JSON).
  const acceptedCeoActorIds: string[] = [];

  const runToken: RunToken = {
    runId: fixture.runId,
    agentId: "test-agent-pdp-fixtures",
    issueId: "test-issue-pdp-fixtures",
    activeBundleId: bundleId,
    maxRiskClass: approverClass,
  };

  const activeBundle: ActiveBundle = {
    bundleId,
    name: bundleId,
    approverClass,
    requiredTools,
    optionalTools: [],
    wrappersByTool,
  };

  const context: PdpContext = {
    activeBundles: [activeBundle],
    wrapperRegistry,
    reviewerChain: REVIEWER_CHAIN,
    ceoApproverChain: CEO_CHAIN,
  };

  return {
    toolName: fixture.toolName,
    // Stable args object per fixture case. The runtime computes a real
    // SHA-256 over JSON.stringify(args ?? null); the hash will be a
    // valid 64-char hex regardless of the value, so we just need
    // reproducibility (not a specific value) for this replay test.
    args: { runId: fixture.runId, scenario: fixture.reason },
    runToken,
    context,
    acceptedReviewerActorIds,
    acceptedCeoActorIds,
  };
}

// ---------------------------------------------------------------------------
// Per-case assertions
// ---------------------------------------------------------------------------

function assertReplay(fixture: FixturePdp): void {
  const input = scenarioFor(fixture);
  const out = decide(input);

  // The verdict and reason must match the fixture exactly.
  expect(out.verdict).toBe(fixture.verdict);
  expect(out.reason).toBe(fixture.reason);

  // The argsHash in the fixture is a symbolic 16-char fingerprint
  // ("sha256:<16 hex>"), not a literal SHA-256. The runtime emits a
  // real 64-char hex SHA-256, so we assert format only.
  expect(out.argsHash).toMatch(/^[0-9a-f]{64}$/);

  // The bundleId is the bundle the runtime resolved from the runToken.
  // For case 1, the runToken names a bundle that may or may not be in
  // the activeBundles list; we always include it as the active bundle
  // in our scenario, so bundleId should match fixture.bundle.
  // (For case 1's tool_not_in_bundle path, the verdict returns
  // bundleId = bundle.bundleId since the bundle IS resolved — the tool
  // check is what fires.)
  expect(out.bundleId).toBe(fixture.bundle);

  // decisionPath sanity: it must contain the row that decided the verdict.
  expect(out.decisionPath).toContain("run_token_check");
  expect(out.decisionPath).toContain("bundle_lookup");
  switch (fixture.reason) {
    case "tool_not_in_bundle":
      expect(out.decisionPath).toContain("tool_in_bundle_check");
      expect(out.decisionPath).not.toContain("allow");
      break;
    case "wrapper_missing_for_r2_plus":
      expect(out.decisionPath).toContain("tool_in_bundle_check");
      expect(out.decisionPath).toContain("wrapper_check");
      expect(out.decisionPath).not.toContain("reviewer_check");
      expect(out.decisionPath).not.toContain("ceo_check");
      expect(out.decisionPath).not.toContain("allow");
      break;
    case "awaiting_reviewer_signoff":
      expect(out.decisionPath).toContain("tool_in_bundle_check");
      expect(out.decisionPath).toContain("wrapper_check");
      expect(out.decisionPath).toContain("reviewer_check");
      expect(out.decisionPath).not.toContain("ceo_check");
      expect(out.decisionPath).not.toContain("allow");
      break;
    case "ceo_signoff_missing_for_r4":
      expect(out.decisionPath).toContain("tool_in_bundle_check");
      expect(out.decisionPath).toContain("wrapper_check");
      expect(out.decisionPath).toContain("reviewer_check");
      expect(out.decisionPath).toContain("ceo_check");
      expect(out.decisionPath).not.toContain("allow");
      break;
  }
}

// ---------------------------------------------------------------------------
// Tests: JSONL replay
// ---------------------------------------------------------------------------

const JSONL_PATH = resolve(FIXTURE_ROOT, "mcp-overload-events.fixture.jsonl");
const JSONL_PDP_EVENTS: JsonlEvent[] = loadJsonl(JSONL_PATH).filter(
  (e) => e.type === "pdp_verdict" && e.pdp,
);

describe("pdp verdict fixtures: JSONL replay (mcp-overload-events.fixture.jsonl)", () => {
  it("loads at least 4 pdp_verdict events from the fixture", () => {
    expect(JSONL_PDP_EVENTS.length).toBeGreaterThanOrEqual(4);
  });

  for (const event of JSONL_PDP_EVENTS) {
    if (!event.pdp) continue;
    const pdp = event.pdp;
    it(`replays ${pdp.reason} (${pdp.runId})`, () => {
      assertReplay(pdp);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: structured JSON replay
// ---------------------------------------------------------------------------

const STRUCTURED_PATH = resolve(
  FIXTURE_ROOT,
  "mcp-ops-audit-overloaded-mcp-fixtures.json",
);
const STRUCTURED_FIXTURE: StructuredFixture = loadStructuredFixture(STRUCTURED_PATH);

describe("pdp verdict fixtures: structured JSON replay (mcp-ops-audit-overloaded-mcp-fixtures.json)", () => {
  it("loads at least 4 pdpVerdicts cases from the structured fixture", () => {
    expect(STRUCTURED_FIXTURE.pdpVerdicts.length).toBeGreaterThanOrEqual(4);
  });

  for (const pdp of STRUCTURED_FIXTURE.pdpVerdicts) {
    it(`replays ${pdp.reason} (${pdp.runId})`, () => {
      assertReplay(pdp);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-fixture invariant
// ---------------------------------------------------------------------------

describe("pdp verdict fixtures: cross-source invariant", () => {
  it("JSONL and structured JSON cover the same 4 reason codes", () => {
    const jsonlReasons = JSONL_PDP_EVENTS.map((e) => e.pdp!.reason).sort();
    const structuredReasons = STRUCTURED_FIXTURE.pdpVerdicts
      .map((p) => p.reason)
      .sort();
    expect(jsonlReasons).toEqual(structuredReasons);
    expect(jsonlReasons).toEqual([
      "awaiting_reviewer_signoff",
      "ceo_signoff_missing_for_r4",
      "tool_not_in_bundle",
      "wrapper_missing_for_r2_plus",
    ]);
  });

  it("all 4 fixture cases produce distinct verdicts", () => {
    const verdicts = JSONL_PDP_EVENTS.map((e) => e.pdp!.verdict).sort();
    // 3 hard_stops + 1 soft_pause
    expect(verdicts.filter((v) => v === "hard_stop")).toHaveLength(3);
    expect(verdicts.filter((v) => v === "soft_pause")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "allow")).toHaveLength(0);
  });
});
