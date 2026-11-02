/**
 * Wake-target resolution for issue thread interactions.
 *
 * RUAAAAA-5786: a board card filed with `continuation_policy = wake_assignee`
 * delivers the board's answer by waking a seat. The wake target used to be the
 * issue's assignee and nothing else, so a card on an issue with no assignee
 * resolved to nobody: the board answered, and the answer was delivered nowhere
 * - silently, with no log, no error and no metric.
 *
 * The target is now resolved through an ordered chain, so a card cannot be
 * stranded:
 *
 *   1. `issue_assignee` - the issue's assignee (the unchanged primary target).
 *   2. `card_creator`   - the seat that filed the card. The seat that asked
 *                          the question is the natural recipient of the answer,
 *                          and it is the only target available to a filing seat
 *                          that has no `tasks:assign` permission.
 *
 * The board decision card on RUAAAAA-5781 is the authority for this shape.
 */

export type InteractionWakeTargetSource = "issue_assignee" | "card_creator";

export interface InteractionWakeTarget {
  /** The agent that will be woken when the card is resolved. */
  agentId: string;
  /** Which link of the fallback chain produced the target. */
  source: InteractionWakeTargetSource;
}

export interface InteractionWakeTargetInput {
  issueAssigneeAgentId?: string | null;
  cardCreatorAgentId?: string | null;
}

/**
 * Resolve the seat that must be woken when an interaction is resolved.
 *
 * Returns null only when neither the issue assignee nor the card creator is
 * known; callers treat that as "the answer would be delivered to nobody".
 */
export function resolveInteractionWakeTarget(
  input: InteractionWakeTargetInput,
): InteractionWakeTarget | null {
  const assignee = normalizeAgentId(input.issueAssigneeAgentId);
  if (assignee) return { agentId: assignee, source: "issue_assignee" };

  const creator = normalizeAgentId(input.cardCreatorAgentId);
  if (creator) return { agentId: creator, source: "card_creator" };

  return null;
}

/**
 * True for the continuation policies that wake a seat when the card resolves.
 */
export function isWakeAssigneeContinuationPolicy(
  continuationPolicy: string | null | undefined,
): boolean {
  return continuationPolicy === "wake_assignee"
    || continuationPolicy === "wake_assignee_on_accept";
}

function normalizeAgentId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
