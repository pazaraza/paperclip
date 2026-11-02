import { describe, expect, it } from "vitest";

import {
  isWakeAssigneeContinuationPolicy,
  resolveInteractionWakeTarget,
} from "../services/interaction-wake-target.js";

const ISSUE_ASSIGNEE = "11111111-1111-4111-8111-111111111111";
const CARD_CREATOR = "22222222-2222-4222-8222-222222222222";

describe("resolveInteractionWakeTarget", () => {
  it("prefers the issue assignee", () => {
    expect(
      resolveInteractionWakeTarget({
        issueAssigneeAgentId: ISSUE_ASSIGNEE,
        cardCreatorAgentId: CARD_CREATOR,
      }),
    ).toEqual({ agentId: ISSUE_ASSIGNEE, source: "issue_assignee" });
  });

  it("falls back to the card creator when the issue has no assignee", () => {
    expect(
      resolveInteractionWakeTarget({
        issueAssigneeAgentId: null,
        cardCreatorAgentId: CARD_CREATOR,
      }),
    ).toEqual({ agentId: CARD_CREATOR, source: "card_creator" });
  });

  it("falls back to the card creator when the issue assignee is blank", () => {
    expect(
      resolveInteractionWakeTarget({
        issueAssigneeAgentId: "   ",
        cardCreatorAgentId: CARD_CREATOR,
      }),
    ).toEqual({ agentId: CARD_CREATOR, source: "card_creator" });
  });

  it("returns null when neither the assignee nor the creator is known", () => {
    expect(
      resolveInteractionWakeTarget({
        issueAssigneeAgentId: null,
        cardCreatorAgentId: null,
      }),
    ).toBeNull();
    expect(resolveInteractionWakeTarget({})).toBeNull();
  });

  it("trims surrounding whitespace on the resolved agent id", () => {
    expect(
      resolveInteractionWakeTarget({
        issueAssigneeAgentId: "  " + ISSUE_ASSIGNEE + "  ",
        cardCreatorAgentId: null,
      }),
    ).toEqual({ agentId: ISSUE_ASSIGNEE, source: "issue_assignee" });
  });
});

describe("isWakeAssigneeContinuationPolicy", () => {
  it("matches the policies that wake a seat on resolution", () => {
    expect(isWakeAssigneeContinuationPolicy("wake_assignee")).toBe(true);
    expect(isWakeAssigneeContinuationPolicy("wake_assignee_on_accept")).toBe(true);
  });

  it("does not match the policies that wake nobody", () => {
    expect(isWakeAssigneeContinuationPolicy("none")).toBe(false);
    expect(isWakeAssigneeContinuationPolicy(null)).toBe(false);
    expect(isWakeAssigneeContinuationPolicy(undefined)).toBe(false);
    expect(isWakeAssigneeContinuationPolicy("wake_creator")).toBe(false);
  });
});
