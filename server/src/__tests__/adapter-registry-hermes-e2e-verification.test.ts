import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hermesExecuteMock = vi.hoisted(() =>
  vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false })),
);

vi.mock("hermes-paperclip-adapter/server", () => ({
  execute: hermesExecuteMock,
  testEnvironment: async () => ({ adapterType: "hermes_local", status: "pass", checks: [], testedAt: new Date(0).toISOString() }),
  sessionCodec: null,
  listSkills: async () => [],
  syncSkills: async () => ({ entries: [] }),
  detectModel: async () => null,
}));

import { requireServerAdapter, unregisterServerAdapter } from "../adapters/index.js";

describe("hermes_local e2e env shape (RUAAAAA-2375)", () => {
  let tmpRoot: string;
  let keyFile: string;

  beforeEach(() => {
    hermesExecuteMock.mockClear();
    unregisterServerAdapter("external_test");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-2375-e2e-"));
    keyFile = path.join(tmpRoot, "paperclip-claimed-api-key.json");
    fs.writeFileSync(
      keyFile,
      JSON.stringify({
        token: "pcp_e2e_test_token_DO_NOT_USE_42",
        agentId: "ec525db2-5cf7-467f-b64a-ffcbdecb52fb",
        agentName: "Admin & Compliance Lead",
        companyId: "17962940-d69e-4909-bb45-c7bb534505e5",
      }),
    );
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("the env shape the new code would inject for Admin's hermes_local child process is the stored token (not the JWT), with refreshed PAPERCLIP_RUN_ID", async () => {
    const adapter = requireServerAdapter("hermes_local");
    await adapter.execute({
      runId: "run-e2e-2375",
      agent: {
        id: "ec525db2-5cf7-467f-b64a-ffcbdecb52fb",
        companyId: "17962940-d69e-4909-bb45-c7bb534505e5",
        name: "Admin & Compliance Lead",
        role: "compliance",
        adapterType: "hermes_local",
        adapterConfig: {
          claimedApiKeyPath: keyFile,
          env: { OPENAI_API_KEY: "sk-llm-not-paperclip" },
        },
      },
      runtime: {},
      config: {},
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "broken-local-agent-jwt-from-heartbeat",
    });

    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    const [patchedCtx] = hermesExecuteMock.mock.calls[0];

    // This is the env that would land in the child process. In production it
    // would be merged with the rest of the child spawn env and inherited by
    // every `curl -H 'Authorization: Bearer $PAPERCLIP_API_KEY' ...` Hermes
    // issues against Paperclip.
    const env = patchedCtx.agent.adapterConfig.env;
    expect(env.PAPERCLIP_API_KEY).toBe("pcp_e2e_test_token_DO_NOT_USE_42");
    expect(env.PAPERCLIP_API_KEY).not.toBe("broken-local-agent-jwt-from-heartbeat");
    expect(env.PAPERCLIP_RUN_ID).toBe("run-e2e-2375");
    expect(env.OPENAI_API_KEY).toBe("sk-llm-not-paperclip");
    // Operator did not set a custom promptTemplate — Hermes default heartbeat
    // prompt is preserved (no auth-guard-only override).
    expect(patchedCtx.agent.adapterConfig.promptTemplate).toBeUndefined();
  });
});
