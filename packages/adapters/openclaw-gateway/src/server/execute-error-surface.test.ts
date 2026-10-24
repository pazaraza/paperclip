import { describe, expect, it } from "vitest";
import { extractPostgresConflictInfo } from "./execute.js";

describe("extractPostgresConflictInfo (RUAAAAA-5205 / RUAAAAA-5208)", () => {
  it("extracts 23505 + issues_open_routine_execution_uq from a flat details payload", () => {
    const info = extractPostgresConflictInfo({
      code: "23505",
      constraint: "issues_open_routine_execution_uq",
      message: 'duplicate key value violates unique constraint "issues_open_routine_execution_uq"',
    });
    expect(info).toEqual({
      code: "23505",
      constraint: "issues_open_routine_execution_uq",
    });
  });

  it("extracts 23505 + a different constraint when paired correctly", () => {
    const info = extractPostgresConflictInfo({
      code: "23505",
      constraint: "issue_recovery_actions_active_source_uq",
    });
    expect(info).toEqual({
      code: "23505",
      constraint: "issue_recovery_actions_active_source_uq",
    });
  });

  it("looks one level deep when the postgres payload is nested under pgError", () => {
    const info = extractPostgresConflictInfo({
      source: "paperclip.server",
      pgError: {
        code: "23505",
        constraint: "issues_open_routine_execution_uq",
        detail: "Key (company_id, origin_kind, origin_id)=(...) already exists.",
      },
    });
    expect(info).toEqual({
      code: "23505",
      constraint: "issues_open_routine_execution_uq",
    });
  });

  it("looks one level deep when nested under cause / error / postgres", () => {
    for (const wrapperKey of ["cause", "error", "postgres"] as const) {
      const info = extractPostgresConflictInfo({
        [wrapperKey]: {
          code: "23505",
          constraint: "issues_open_routine_execution_uq",
        },
      });
      expect(info.code).toBe("23505");
      expect(info.constraint).toBe("issues_open_routine_execution_uq");
    }
  });

  it("returns null for both fields when the payload is empty / null / undefined / non-object", () => {
    for (const v of [null, undefined, "string", 5, [], true]) {
      expect(extractPostgresConflictInfo(v)).toEqual({ code: null, constraint: null });
    }
  });

  it("returns the surface code/constraint verbatim when they are NOT a 23505 pair", () => {
    // Useful so a future caller can decide what to do with non-conflict
    // postgres errors (e.g. 40001 serialization_failure) without us
    // hiding the values.
    const info = extractPostgresConflictInfo({
      code: "40001",
      constraint: "some_other_index",
    });
    expect(info).toEqual({ code: "40001", constraint: "some_other_index" });
  });

  it("returns the constraint null when code is 23505 but constraint is absent", () => {
    const info = extractPostgresConflictInfo({ code: "23505" });
    expect(info).toEqual({ code: "23505", constraint: null });
  });

  it("returns code 23505 with a null constraint when the constraint string is empty/whitespace", () => {
    // A 23505 with no constraint name is incomplete and unreliable —
    // callers should not treat it as a recognised conflict. The helper
    // surfaces code 23505 verbatim so a future caller can decide, but
    // constraint is null because nonEmpty() trims to nothing.
    const info = extractPostgresConflictInfo({
      code: "23505",
      constraint: "   ",
    });
    expect(info.code).toBe("23505");
    expect(info.constraint).toBeNull();
  });
});
