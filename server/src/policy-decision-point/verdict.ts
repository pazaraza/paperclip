/**
 * RUAAAAA-1949-A: Runtime PDP verdict function library.
 *
 * Pure decision function that takes a tool-call attempt and returns a verdict.
 * No side effects (telemetry post + webhook emit live in middleware.ts/webhook.ts).
 *
 * Decision table (5 rows, in order — first match wins):
 *
 *   #  Check                                                       Verdict
 *   1  toolName in active bundle's requiredTools ∪ optionalTools?  hard_stop  (tool_not_in_bundle)
 *   2  runToken.maxRiskClass ∈ {R2,R3,R4}? is the call going       hard_stop  (wrapper_missing_for_r2_plus)
 *      through the matching defaultWrapper from the matrix?
 *   3  runToken.maxRiskClass ∈ {R3,R4}? is there a reviewer         soft_pause (awaiting_reviewer_signoff)
 *      signoff in the issue thread (request_confirmation accepted
 *      from any of context.reviewerChain)?
 *   4  runToken.maxRiskClass === R4? is there a CEO                 hard_stop  (ceo_signoff_missing_for_r4)
 *      signoff (request_confirmation accepted from any of
 *      context.ceoApproverChain)?
 *   5  all checks passed                                           allow      (ok)
 *
 * Edge case: if `runToken` is missing, return `hard_stop` with reason
 * `run_token_missing` BEFORE any bundle lookup. The PDP never silently
 * allows a call without a run identity.
 *
 * Phase handling lives in middleware.ts; the verdict function itself is
 * phase-agnostic. The middleware decides whether to call this function at
 * all (phase=2) or to log + skip (phase=1).
 *
 * Lane: in-house, Engineering (HoE). See _default/RUAAAAA-1949-runtime-pdp-v0.md
 * for the full design, the source-of-truth table, and the coordination with
 * 1948 / 1953 / 1944 / 1888 / 1902.
 */

export type Verdict = "allow" | "soft_pause" | "hard_stop";

export type ReasonCode =
  | "tool_not_in_bundle"
  | "wrapper_missing_for_r2_plus"
  | "awaiting_reviewer_signoff"
  | "ceo_signoff_missing_for_r4"
  | "run_token_missing"
  | "ok";

/**
 * R0–R4 risk class ladder from the safe-wrapper-approval-matrix.json
 * (RUAAAAA-1943). The PDP enforces the R2+ → wrapper, R3+ → reviewer,
 * R4 → CEO rules based on the active bundle's `approverClass`.
 */
export type RiskClass = "R0" | "R1" | "R2" | "R3" | "R4";

export interface RunToken {
  runId: string;
  agentId: string;
  issueId: string;
  activeBundleId: string | null;
  /**
   * The MAX risk class the active bundle exposes (e.g. a bundle that uses
   * R2 tools but no R3+ tools has maxRiskClass="R2"). The PDP treats this
   * as the ceiling for the run; any tool call at a higher R-class than
   * the runToken carries returns `tool_not_in_bundle` (the bundle was
   * never authorized to use that R-class).
   */
  maxRiskClass: RiskClass;
}

export interface ActiveBundle {
  bundleId: string;
  name: string;
  /**
   * The bundle's effective risk class. Mirrors `safe-wrapper-approval-matrix.json
   * .byBundleKind[*].defaultRisk` and the bundle's own `approverClass` field.
   */
  approverClass: RiskClass;
  /** Required tools (must be present). */
  requiredTools: string[];
  /** Optional tools (may be present). */
  optionalTools: string[];
  /**
   * The default safe-wrapper name from `safe-wrapper-approval-matrix.json
   * .byToolFamily[family].defaultWrapper` for each tool the bundle uses.
   * If the call is going through a different wrapper (or none), the PDP
   * returns `wrapper_missing_for_r2_plus` for R2+ bundles.
   */
  wrappersByTool: Record<string, string>;
}

export interface PdpContext {
  activeBundles: ActiveBundle[];
  /** The wrappers the current call is going through, keyed by tool name. */
  wrapperRegistry: Record<string, string>;
  /**
   * Reviewer signoff chain. The PDP checks for an accepted
   * `request_confirmation` interaction from any of these agent/user ids
   * for the active run's issue thread.
   */
  reviewerChain: string[];
  /**
   * CEO approver chain. The PDP checks for an accepted
   * `request_confirmation` interaction from any of these agent/user ids
   * for the active run's issue thread. Two-step confirmation per
   * `safe-wrapper-approval-matrix.json .approvalInteractionDefinitions.two_step_confirmation`.
   */
  ceoApproverChain: string[];
}

export interface PdpInput {
  toolName: string;
  args: unknown;
  runToken: RunToken | null;
  context: PdpContext;
  /**
   * The accepted signoff actor ids, populated by the middleware from the
   * issue thread (R3 reviewer, R4 CEO). The verdict function does not
   * read the issue thread itself; it just consults what the middleware
   * already loaded.
   */
  acceptedReviewerActorIds: string[];
  acceptedCeoActorIds: string[];
}

export interface PdpOutput {
  verdict: Verdict;
  reason: ReasonCode;
  /** SHA-256 of `JSON.stringify(args)` so the run ledger can replay the call without re-exposing the args. */
  argsHash: string;
  /** The bundle that decided the verdict (the active bundle for this call). */
  bundleId: string | null;
  /** The decision path taken — useful for telemetry / debugging. */
  decisionPath: DecisionStep[];
}

export type DecisionStep =
  | "run_token_check"
  | "bundle_lookup"
  | "tool_in_bundle_check"
  | "wrapper_check"
  | "reviewer_check"
  | "ceo_check"
  | "allow";

/** Numeric rank for the risk class. R4 > R3 > R2 > R1 > R0. */
const RISK_RANK: Record<RiskClass, number> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
};

function riskAtLeast(actual: RiskClass, threshold: RiskClass): boolean {
  return RISK_RANK[actual] >= RISK_RANK[threshold];
}

/**
 * Synchronous SHA-256 via the Node `crypto` module. The top-level
 * import works in both ESM (the server is `"type": "module"`) and CJS
 * (vitest forks); the `node:crypto` specifier is supported in any
 * browser/edge runtime that polyfills the Node crypto API.
 *
 * Originally shipped as a lazy `require()` (1954 v0.1) for polyfill
 * portability, but `require` is undefined in ESM and the 1955 self-test
 * caught the regression when running the dist directly via `node`.
 * Pinned in 1955 v0.1 to a real import statement.
 */
import { createHash } from "node:crypto";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The single pure decision function. Returns a PdpOutput; never throws.
 *
 * Contract:
 *  - pure: same input → same output, no side effects
 *  - total: handles every input shape (missing runToken, no bundles,
 *    empty reviewer chain, etc.)
 *  - fail-closed: missing runToken OR no matching bundle OR missing
 *    signoff → hard_stop or soft_pause, never `allow` by accident
 *  - decisionPath is the audit trail — every check the function ran
 *    is recorded in order, terminated by the row that decided the verdict
 */
export function decide(input: PdpInput): PdpOutput {
  const decisionPath: DecisionStep[] = [];
  const argsHash = sha256(JSON.stringify(input.args ?? null));

  // 0) runToken guard. No run identity → no call.
  if (!input.runToken) {
    decisionPath.push("run_token_check");
    return {
      verdict: "hard_stop",
      reason: "run_token_missing",
      argsHash,
      bundleId: null,
      decisionPath,
    };
  }
  decisionPath.push("run_token_check");

  const token = input.runToken;
  const bundle = input.context.activeBundles.find(
    (b) => b.bundleId === token.activeBundleId,
  );

  // 1) Active bundle lookup. If the runToken names a bundle that isn't
  //    in the activeBundles list, the run was issued against a stale
  //    catalog — fail-closed.
  if (!bundle) {
    decisionPath.push("bundle_lookup");
    return {
      verdict: "hard_stop",
      reason: "tool_not_in_bundle",
      argsHash,
      bundleId: token.activeBundleId,
      decisionPath,
    };
  }
  decisionPath.push("bundle_lookup");

  // 2) tool-in-bundle check.
  if (
    !bundle.requiredTools.includes(input.toolName) &&
    !bundle.optionalTools.includes(input.toolName)
  ) {
    decisionPath.push("tool_in_bundle_check");
    return {
      verdict: "hard_stop",
      reason: "tool_not_in_bundle",
      argsHash,
      bundleId: bundle.bundleId,
      decisionPath,
    };
  }
  decisionPath.push("tool_in_bundle_check");

  // 3) Wrapper check (R2+). The active wrapper for the call must match
  //    the bundle's expected wrapper for that tool.
  if (riskAtLeast(bundle.approverClass, "R2")) {
    const expectedWrapper = bundle.wrappersByTool[input.toolName];
    const actualWrapper = input.context.wrapperRegistry[input.toolName];
    if (expectedWrapper && expectedWrapper !== actualWrapper) {
      decisionPath.push("wrapper_check");
      return {
        verdict: "hard_stop",
        reason: "wrapper_missing_for_r2_plus",
        argsHash,
        bundleId: bundle.bundleId,
        decisionPath,
      };
    }
  }
  decisionPath.push("wrapper_check");

  // 4) Reviewer check (R3+). Need an accepted signoff from the
  //    reviewer chain for this run's issue.
  if (riskAtLeast(bundle.approverClass, "R3")) {
    const hasReviewer = input.acceptedReviewerActorIds.some((id) =>
      input.context.reviewerChain.includes(id),
    );
    if (!hasReviewer) {
      decisionPath.push("reviewer_check");
      return {
        verdict: "soft_pause",
        reason: "awaiting_reviewer_signoff",
        argsHash,
        bundleId: bundle.bundleId,
        decisionPath,
      };
    }
  }
  decisionPath.push("reviewer_check");

  // 5) CEO check (R4 only). The R4 ladder requires a SECOND accepted
  //    signoff from the CEO chain, independent of the reviewer.
  if (riskAtLeast(bundle.approverClass, "R4")) {
    const hasCeo = input.acceptedCeoActorIds.some((id) =>
      input.context.ceoApproverChain.includes(id),
    );
    if (!hasCeo) {
      decisionPath.push("ceo_check");
      return {
        verdict: "hard_stop",
        reason: "ceo_signoff_missing_for_r4",
        argsHash,
        bundleId: bundle.bundleId,
        decisionPath,
      };
    }
  }
  decisionPath.push("ceo_check");

  // 6) Default-allow. The caller has passed every check the bundle
  //    requires; the call proceeds.
  decisionPath.push("allow");
  return {
    verdict: "allow",
    reason: "ok",
    argsHash,
    bundleId: bundle.bundleId,
    decisionPath,
  };
}
