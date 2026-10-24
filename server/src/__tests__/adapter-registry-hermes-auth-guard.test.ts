import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const hermesExecuteMock = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
  })),
);

vi.mock("hermes-paperclip-adapter/server", () => ({
  execute: hermesExecuteMock,
  testEnvironment: async () => ({
    adapterType: "hermes_local",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  sessionCodec: null,
  listSkills: async () => [],
  syncSkills: async () => [],
  detectModel: async () => null,
}));

import { requireServerAdapter } from "../adapters/index.js";
import { HERMES_DEFAULT_PROMPT_TEMPLATE } from "../adapters/hermes-default-prompt-template.js";

const AUTH_GUARD_HEADING = "Paperclip API safety rule:";

async function executeHermes(adapterConfig: Record<string, unknown>) {
  const adapter = requireServerAdapter("hermes_local");
  await adapter.execute({
    runId: "run-5408",
    agent: {
      id: "agent-5408",
      companyId: "company-5408",
      name: "Hermes Agent",
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig,
    },
    runtime: {},
    config: {},
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
    authToken: "agent-run-jwt",
  });
  expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
  const [patchedCtx] = hermesExecuteMock.mock.calls[0];
  return patchedCtx.agent.adapterConfig as Record<string, unknown>;
}

describe("hermes_local auth guard on every wake (RUAAAAA-5408)", () => {
  beforeEach(() => {
    hermesExecuteMock.mockClear();
  });

  it("prepends the auth guard to the adapter default when the seat has no promptTemplate", async () => {
    const adapterConfig = await executeHermes({});
    const template = String(adapterConfig.promptTemplate);

    expect(template.startsWith(AUTH_GUARD_HEADING)).toBe(true);
    expect(template).toMatch(/Authorization: Bearer/);
    expect(template).toMatch(/X-Paperclip-Run-Id: \$PAPERCLIP_RUN_ID/);
    // The guard is prepended, not substituted: the adapter default is still
    // there, so the assigned issue / workflow / comment sections survive.
    expect(template).toContain(HERMES_DEFAULT_PROMPT_TEMPLATE);
    expect(template.endsWith(HERMES_DEFAULT_PROMPT_TEMPLATE)).toBe(true);
  });

  it("keeps the wake, task and comment sections for an empty-template seat", async () => {
    const adapterConfig = await executeHermes({});
    const template = String(adapterConfig.promptTemplate);

    expect(template).toContain("{{#taskId}}");
    expect(template).toContain("{{/taskId}}");
    expect(template).toContain("{{#noTask}}");
    expect(template).toContain("{{/noTask}}");
    expect(template).toContain("{{#commentId}}");
    expect(template).toContain("{{/commentId}}");
    expect(template).toContain("{{paperclipApiUrl}}");
  });

  it("keeps the base of a guarded prompt on the seat own template", async () => {
    const adapterConfig = await executeHermes({ promptTemplate: "Seat specific prompt" });
    const template = String(adapterConfig.promptTemplate);

    expect(template.startsWith(AUTH_GUARD_HEADING)).toBe(true);
    expect(template).toMatch(/Authorization: Bearer/);
    expect(template).toContain("Seat specific prompt");
    // A seat own template replaces the adapter default, as before.
    expect(template).not.toContain(HERMES_DEFAULT_PROMPT_TEMPLATE);
  });

  it("vendored adapter default matches the installed adapter byte for byte", () => {
    const requireFromTest = createRequire(import.meta.url);
    const adapterEntry = requireFromTest.resolve("hermes-paperclip-adapter/server");
    const adapterExecute = path.join(path.dirname(adapterEntry), "execute.js");
    const source = fs.readFileSync(adapterExecute, "utf8");
    const marker = "const DEFAULT_PROMPT_TEMPLATE = ";
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const literalStart = start + marker.length;
    expect(source[literalStart]).toBe("`");
    let index = literalStart + 1;
    let literal = "";
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        literal += char + source[index + 1];
        index += 2;
        continue;
      }
      if (char === "`") break;
      literal += char;
      index += 1;
    }
    const installed = vm.runInNewContext("`" + literal + "`") as string;
    expect(installed).toBe(HERMES_DEFAULT_PROMPT_TEMPLATE);
  });
});

