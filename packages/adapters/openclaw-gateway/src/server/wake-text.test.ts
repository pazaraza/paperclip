import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildGatewayWakeText } from "./execute.js";

/**
 * RUAAAAA-5402 — the gateway wake text is the seat's only prompt surface, and
 * it used to be the *only* one: `adapterConfig.promptTemplate` was never read
 * by the adapter, so nothing a seat carried ever reached the agent. It also
 * handed out an unlabelled API base, and a base without `/api` answers the read
 * path with HTTP 200 and the SPA index — a silent false negative that reads as
 * "empty inbox" rather than as an error.
 */

function fakeCtx(
  config: Record<string, unknown>,
  context: Record<string, unknown> = {},
): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Gateway Seat",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context,
    onLog: async () => {},
  } as unknown as AdapterExecutionContext;
}

describe("buildGatewayWakeText (RUAAAAA-5402)", () => {
  const savedRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;

  afterEach(() => {
    if (savedRuntimeApiUrl === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
    else process.env.PAPERCLIP_RUNTIME_API_URL = savedRuntimeApiUrl;
  });

  it("carries the canonical read contract, preferred form first", () => {
    const text = buildGatewayWakeText(fakeCtx({ paperclipApiUrl: "http://100.67.204.21:3100" }));
    expect(text).toContain("GET http://100.67.204.21:3100/api/agents/me/inbox-lite");
    expect(text).toContain(
      "GET http://100.67.204.21:3100/api/companies/$PAPERCLIP_COMPANY_ID/issues?assigneeAgentId=$PAPERCLIP_AGENT_ID&status=todo,in_progress,in_review,blocked",
    );
  });

  it("keeps PAPERCLIP_API_URL in origin form when the seat carries the /api root", () => {
    const text = buildGatewayWakeText(
      fakeCtx({ paperclipApiUrl: "http://100.67.204.21:3100/api" }),
    );
    // The documented convention is `$PAPERCLIP_API_URL/api/...`; a seat that
    // carries the /api root must not be handed a base that doubles the prefix.
    expect(text).toContain("PAPERCLIP_API_URL=http://100.67.204.21:3100\n");
    expect(text).not.toContain("PAPERCLIP_API_URL=http://100.67.204.21:3100/api");
    expect(text).toContain("api_root=http://100.67.204.21:3100/api");
  });

  it("falls back to the server runtime base with the /api suffix", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://127.0.0.1:3100";
    const text = buildGatewayWakeText(fakeCtx({}));
    expect(text).toContain("api_root=http://127.0.0.1:3100/api");
    expect(text).toContain("GET http://127.0.0.1:3100/api/agents/me/inbox-lite");
  });

  it("renders adapterConfig.promptTemplate into the wake text", () => {
    const text = buildGatewayWakeText(
      fakeCtx({
        paperclipApiUrl: "http://100.67.204.21:3100/api",
        promptTemplate:
          "Read your inbox first: GET {{paperclipApiUrl}}/agents/me/inbox-lite (you are {{agent.name}}).",
      }),
    );
    expect(text).toContain("Agent prompt template (adapterConfig.promptTemplate, rendered):");
    expect(text).toContain(
      "Read your inbox first: GET http://100.67.204.21:3100/api/agents/me/inbox-lite (you are Gateway Seat).",
    );
  });

  it("omits the template section when the seat carries no template", () => {
    const text = buildGatewayWakeText(fakeCtx({ paperclipApiUrl: "http://100.67.204.21:3100" }));
    expect(text).not.toContain("Agent prompt template");
  });
});
