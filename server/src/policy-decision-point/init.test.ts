/**
 * Tests for PDP runtime initialization helpers.
 */
import { describe, expect, it } from "vitest";

import { defaultResolveApproverChains } from "./init.js";

function fakeDb(rows: Array<{ id: string; role: string | null }>) {
  let whereCalled = false;
  const query = {
    from: () => ({
      where: async () => {
        whereCalled = true;
        return rows;
      },
      then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
    }),
  };
  return {
    db: {
      select: () => query,
    },
    wasWhereCalled: () => whereCalled,
  };
}

describe("defaultResolveApproverChains", () => {
  it("does not apply a company-id UUID filter during boot's all-company seed lookup", async () => {
    const { db, wasWhereCalled } = fakeDb([
      { id: "agent-ceo", role: "ceo" },
      { id: "agent-hoe", role: "head-of-engineering" },
      { id: "agent-lead", role: "lead" },
      { id: "agent-other", role: "analyst" },
    ]);

    const chains = await defaultResolveApproverChains(db as never, "");

    expect(wasWhereCalled()).toBe(false);
    expect(chains).toEqual({
      reviewer: ["agent-hoe", "agent-lead"],
      ceo: ["agent-ceo"],
    });
  });
});
