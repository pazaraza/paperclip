import { afterEach, describe, expect, it } from "vitest";
import { renderTemplate } from "@paperclipai/adapter-utils/server-utils";
import { buildCodexTemplateData } from "./execute.js";

/**
 * RUAAAAA-5402 — a codex seat that wanted the Paperclip API in its prompt
 * template could only write a literal base, because codex_local never put
 * `paperclipApiUrl` into the template data. `renderTemplate` resolves a missing
 * path to "", so `{{paperclipApiUrl}}` rendered as a broken URL rather than a
 * missing one.
 */

const agent = { id: "agent-1", companyId: "company-1" };

describe("codex prompt template data (RUAAAAA-5402)", () => {
  const savedRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;

  afterEach(() => {
    if (savedRuntimeApiUrl === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
    else process.env.PAPERCLIP_RUNTIME_API_URL = savedRuntimeApiUrl;
  });

  it("resolves {{paperclipApiUrl}} to the /api root, not the bare origin", () => {
    const data = buildCodexTemplateData({
      agent,
      runId: "run-1",
      context: {},
      configuredPaperclipApiUrl: "http://100.67.204.21:3100",
    });
    expect(data.paperclipApiUrl).toBe("http://100.67.204.21:3100/api");
    expect(renderTemplate("GET {{paperclipApiUrl}}/agents/me/inbox-lite", data)).toBe(
      "GET http://100.67.204.21:3100/api/agents/me/inbox-lite",
    );
  });

  it("keeps a configured /api root unchanged", () => {
    const data = buildCodexTemplateData({
      agent,
      runId: "run-1",
      context: {},
      configuredPaperclipApiUrl: "http://100.67.204.21:3100/api",
    });
    expect(data.paperclipApiUrl).toBe("http://100.67.204.21:3100/api");
  });

  it("falls back to the server runtime base with the /api suffix", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://127.0.0.1:3100";
    const data = buildCodexTemplateData({
      agent,
      runId: "run-1",
      context: {},
      configuredPaperclipApiUrl: undefined,
    });
    expect(data.paperclipApiUrl).toBe("http://127.0.0.1:3100/api");
  });

  it("never renders an empty base — a missing path used to render blank", () => {
    const data = buildCodexTemplateData({
      agent,
      runId: "run-1",
      context: {},
      configuredPaperclipApiUrl: undefined,
    });
    expect(String(data.paperclipApiUrl).length).toBeGreaterThan(0);
    expect(renderTemplate("{{paperclipApiUrl}}", data)).not.toBe("");
  });
});
