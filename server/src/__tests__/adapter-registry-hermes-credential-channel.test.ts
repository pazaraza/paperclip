import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  syncSkills: async () => ({ entries: [] }),
  detectModel: async () => null,
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  requireServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";

/**
 * RUAAAAA-5440: Hermes hosts the turn in a long-lived `hermes gateway run`
 * process whose environment was frozen at ITS start, so the adapter's env
 * injection never reaches the agent's shell. The auth guard must therefore
 * carry the credential SOURCE (the seat's claimed-key file) and the run id
 * (a literal), and the agent must be told to export both itself.
 */
describe("hermes_local auth guard carries the credential source (RUAAAAA-5440)", () => {
  let tmpRoot: string;
  let keyFile: string;

  beforeEach(() => {
    hermesExecuteMock.mockClear();
    unregisterServerAdapter("external_test");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-5440-"));
    keyFile = path.join(tmpRoot, "paperclip-claimed-api-key.json");
    fs.writeFileSync(
      keyFile,
      JSON.stringify({
        token: "pcp_stored_agent_token_abc123",
        agentId: "agent-123",
        companyId: "company-123",
      }),
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  async function executeHermes(agent: Record<string, unknown>, runId = "run-5440") {
    const adapter = requireServerAdapter("hermes_local");
    await adapter.execute({
      runId,
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Hermes Agent",
        role: "engineer",
        adapterType: "hermes_local",
        ...agent,
      },
      runtime: {},
      config: {},
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "broken-local-agent-jwt",
    });
    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    return hermesExecuteMock.mock.calls[0][0] as {
      agent: { adapterConfig: Record<string, Record<string, string> | string> };
    };
  }

  it("names the claimed-key file and the literal run id in the guard", async () => {
    const patchedCtx = await executeHermes({
      adapterConfig: {
        claimedApiKeyPath: keyFile,
        promptTemplate: "Custom seat template. Use $PAPERCLIP_API_KEY.",
      },
    });

    const template = String(patchedCtx.agent.adapterConfig.promptTemplate);
    expect(template).toContain(keyFile);
    expect(template).toContain("run-5440");
    // The guard restores the env contract the seat's own template expects.
    expect(template).toContain("export PAPERCLIP_API_KEY=");
    expect(template).toContain("export PAPERCLIP_RUN_ID=");
    // It must not be the only instruction: the seat's own template survives.
    expect(template).toContain("Custom seat template.");
  });

  it("keeps the secret out of the prompt", async () => {
    const patchedCtx = await executeHermes({
      adapterConfig: {
        claimedApiKeyPath: keyFile,
        promptTemplate: "Custom seat template.",
      },
    });

    const template = String(patchedCtx.agent.adapterConfig.promptTemplate);
    expect(template).not.toContain("pcp_stored_agent_token_abc123");
    expect(template).not.toContain("broken-local-agent-jwt");
  });

  it("tells a seat with no claimed key file that the credential is unavailable", async () => {
    const patchedCtx = await executeHermes({
      adapterConfig: { promptTemplate: "Custom seat template." },
    });

    const template = String(patchedCtx.agent.adapterConfig.promptTemplate);
    expect(template).not.toContain("export PAPERCLIP_API_KEY=");
    expect(template).toContain("credential is unavailable");
  });

  it("still injects the key and the run id into the child env", async () => {
    const patchedCtx = await executeHermes({
      adapterConfig: {
        claimedApiKeyPath: keyFile,
        promptTemplate: "Custom seat template.",
      },
    });

    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("pcp_stored_agent_token_abc123");
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_RUN_ID).toBe("run-5440");
  });
});
