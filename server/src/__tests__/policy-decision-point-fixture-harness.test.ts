/**
 * RUAAAAA-1949-C (v0.2 fixture harness): structural validation of the 4 PDP
 * verdict cases added to the 1946 fixtures.
 *
 * This is the v0.2 extension of the 1946 fixture harness per
 * `_default/RUAAAAA-1949-runtime-pdp-v0.md` §4 (Slice C) and §5 (acceptance).
 * The v0.2 extension:
 *   1. Loads the JSONL fixture and asserts that exactly 4 pdp_verdict events
 *      exist (one per reason code).
 *   2. Loads the structured fixture and asserts that the `pdpVerdicts` array
 *      has exactly 4 entries, one per reason code, with the expected
 *      verdicts.
 *   3. Cross-checks: the 4 events on the wire have the same set of reason
 *      codes as the 4 entries in the structured fixture.
 *   4. Asserts each pdp_verdict event has the required shape: verdict, reason,
 *      toolName, bundle, argsHash, runId.
 *   5. Asserts each structured-fixture entry has the required shape plus the
 *      expectedVerdictRationale string.
 *
 * The v0.2 harness does NOT replay the events against the verdict function
 * library yet — that's the next concrete step (a v0.3 extension that builds
 * a PdpInput from each pdpVerdict entry and asserts decide() returns the
 * expected verdict). The v0.3 step is unblocked by Slice A (verdict.ts,
 * 21/21 tests passing) and the 4 fixture cases added by this Slice C.
 *
 * Lane: in-house, Engineering (HoE). Run 1c6dc90a-… (2026-06-19 10:15 CDT).
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Absolute paths to the project workspace fixtures. The fixtures live in the
// paperclip instance project workspace, not in the server source tree, so
// the absolute path is the stable convention. If the workspace moves, this
// path must move with it; the alternative is a PAPERCLIP_PROJECT_ROOT env
// var, but for v0.2 the absolute path is simpler and the path is documented
// in the Lead's handoff comment on 1940 / 1949.
const JSONL_FIXTURE =
  "/Users/orionis/.paperclip/instances/default/projects/17962940-d69e-4909-bb45-c7bb534505e5/930849e3-de06-47ba-8027-63a527ae1baa/_default/mcp-overload-events.fixture.jsonl";
const STRUCTURED_FIXTURE =
  "/Users/orionis/.paperclip/instances/default/projects/17962940-d69e-4909-bb45-c7bb534505e5/930849e3-de06-47ba-8027-63a527ae1baa/_default/mcp-ops-audit-overloaded-mcp-fixtures.json";

const EXPECTED_REASONS = [
  "tool_not_in_bundle",
  "wrapper_missing_for_r2_plus",
  "awaiting_reviewer_signoff",
  "ceo_signoff_missing_for_r4",
] as const;

type PdPEvent = {
  at: string;
  type: string;
  pdp: {
    verdict: "allow" | "soft_pause" | "hard_stop";
    reason: string;
    toolName: string;
    bundle: string;
    rClass?: string;
    wrapper?: string;
    reviewerSignoff?: string | null;
    operatorSignoff?: string | null;
    ceoSignoff?: string | null;
    argsHash: string;
    runId: string;
    expectedInteraction: string | null;
  };
};

type StructuredFixture = {
  fixtureSet: string;
  title: string;
  generatedAt: string;
  scenario: string;
  inventory: unknown;
  expectedQAOutcomes: Record<string, string>;
  pdpVerdicts?: Array<{
    verdict: "allow" | "soft_pause" | "hard_stop";
    reason: string;
    toolName: string;
    bundle: string;
    rClass: string | null;
    wrapper: string | null;
    reviewerSignoff: string | null;
    operatorSignoff: string | null;
    ceoSignoff: string | null;
    argsHash: string;
    runId: string;
    expectedInteraction: string | null;
    expectedVerdictRationale: string;
  }>;
};

function loadJsonlFixture(): PdPEvent[] {
  const text = fs.readFileSync(JSONL_FIXTURE, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as PdPEvent);
}

function loadStructuredFixture(): StructuredFixture {
  const text = fs.readFileSync(STRUCTURED_FIXTURE, "utf8");
  return JSON.parse(text) as StructuredFixture;
}

// --- jsonl fixture: 4 pdp_verdict events ---------------------------------

describe("RUAAAAA-1949-C v0.2 fixture harness — jsonl events", () => {
  const events = loadJsonlFixture();
  const pdpEvents = events.filter((e) => e.type === "pdp_verdict");

  it("contains exactly 4 pdp_verdict events (one per reason code)", () => {
    expect(pdpEvents).toHaveLength(4);
  });

  it("covers all 4 expected reason codes", () => {
    const reasons = pdpEvents.map((e) => e.pdp.reason).sort();
    expect(reasons).toEqual([...EXPECTED_REASONS].sort());
  });

  it.each(EXPECTED_REASONS)(
    "pdp_verdict event for %s has the required shape",
    (reason) => {
      const ev = pdpEvents.find((e) => e.pdp.reason === reason);
      expect(ev, `missing event for ${reason}`).toBeDefined();
      expect(ev!.pdp.verdict).toMatch(/^(allow|soft_pause|hard_stop)$/);
      expect(ev!.pdp.toolName).toBeTypeOf("string");
      expect(ev!.pdp.bundle).toBeTypeOf("string");
      expect(ev!.pdp.argsHash).toMatch(/^sha256:/);
      expect(ev!.pdp.runId).toMatch(/^run-1949-fixture-/);
      expect(ev!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    },
  );

  it("the soft_pause event (awaiting_reviewer_signoff) declares request_confirmation as the expected interaction", () => {
    const ev = pdpEvents.find((e) => e.pdp.reason === "awaiting_reviewer_signoff")!;
    expect(ev.pdp.verdict).toBe("soft_pause");
    expect(ev.pdp.expectedInteraction).toBe("request_confirmation");
    expect(ev.pdp.reviewerSignoff).toBeNull();
  });

  it("the ceo_signoff_missing_for_r4 event has operatorSignoff set but ceoSignoff null", () => {
    const ev = pdpEvents.find((e) => e.pdp.reason === "ceo_signoff_missing_for_r4")!;
    expect(ev.pdp.operatorSignoff).toMatch(/^op-[0-9a-f]+$/);
    expect(ev.pdp.ceoSignoff).toBeNull();
  });
});

// --- structured fixture: pdpVerdicts array -------------------------------

describe("RUAAAAA-1949-C v0.2 fixture harness — structured pdpVerdicts", () => {
  const fixture = loadStructuredFixture();

  it("structured fixture has a pdpVerdicts array", () => {
    expect(fixture.pdpVerdicts).toBeDefined();
    expect(Array.isArray(fixture.pdpVerdicts)).toBe(true);
  });

  it("structured fixture has exactly 4 pdpVerdicts entries", () => {
    expect(fixture.pdpVerdicts).toHaveLength(4);
  });

  it("structured fixture covers all 4 expected reason codes", () => {
    const reasons = fixture.pdpVerdicts!.map((v) => v.reason).sort();
    expect(reasons).toEqual([...EXPECTED_REASONS].sort());
  });

  it.each(EXPECTED_REASONS)(
    "structured pdpVerdict entry for %s has the required shape",
    (reason) => {
      const v = fixture.pdpVerdicts!.find((x) => x.reason === reason);
      expect(v, `missing entry for ${reason}`).toBeDefined();
      expect(v!.verdict).toMatch(/^(allow|soft_pause|hard_stop)$/);
      expect(v!.toolName).toBeTypeOf("string");
      expect(v!.bundle).toBeTypeOf("string");
      expect(v!.argsHash).toMatch(/^sha256:/);
      expect(v!.runId).toMatch(/^run-1949-fixture-/);
      expect(v!.expectedVerdictRationale).toBeTypeOf("string");
      expect(v!.expectedVerdictRationale.length).toBeGreaterThan(10);
    },
  );

  it("expectedQAOutcomes includes the pdpVerdicts line", () => {
    expect(fixture.expectedQAOutcomes.pdpVerdicts).toMatch(/pdp/i);
  });
});

// --- cross-check: jsonl events == structured pdpVerdicts ---------------

describe("RUAAAAA-1949-C v0.2 fixture harness — cross-check", () => {
  const events = loadJsonlFixture();
  const pdpEvents = events.filter((e) => e.type === "pdp_verdict");
  const fixture = loadStructuredFixture();

  it("the set of reason codes on the wire matches the structured fixture", () => {
    const eventReasons = pdpEvents.map((e) => e.pdp.reason).sort();
    const structuredReasons = fixture.pdpVerdicts!.map((v) => v.reason).sort();
    expect(eventReasons).toEqual(structuredReasons);
  });

  it("for each reason, the verdict + toolName + bundle agree across jsonl and structured", () => {
    for (const reason of EXPECTED_REASONS) {
      const ev = pdpEvents.find((e) => e.pdp.reason === reason)!;
      const v = fixture.pdpVerdicts!.find((x) => x.reason === reason)!;
      expect(v.verdict, `verdict mismatch for ${reason}`).toBe(ev.pdp.verdict);
      expect(v.toolName, `toolName mismatch for ${reason}`).toBe(ev.pdp.toolName);
      expect(v.bundle, `bundle mismatch for ${reason}`).toBe(ev.pdp.bundle);
    }
  });
});
