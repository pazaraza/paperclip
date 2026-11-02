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
import { requireServerAdapter } from "../adapters/index.js";

function hermesCtx(overrides: {
  agent?: Record<string, unknown>;
  authToken?: string;
} = {}) {
  return {
    runId: "run-5770",
    agent: {
      id: "agent-5770",
      companyId: "company-5770",
      name: "Hermes Agent",
      role: "engineer",
      adapterType: "hermes_local",
      ...(overrides.agent ?? {}),
    },
    runtime: {},
    config: {},
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
    ...(overrides.authToken === undefined ? {} : { authToken: overrides.authToken }),
  };
}

/**
 * RUAAAAA-5770: a claimed key file that EXISTS but holds an unusable token
 * must fail the run loudly. The old behaviour was a silent fall back to the
 * local-agent JWT, which can only answer 401 for a hermes_local seat - so the
 * seat looked alive and every Paperclip call failed with
 * 401 {"error":"Unauthorized","guard":"signature"} for ~30 hours.
 */
describe("hermes_local claimed API key guard (RUAAAAA-5770)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    hermesExecuteMock.mockClear();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-5770-guard-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  function writeKeyFile(name: string, contents: string): string {
    const file = path.join(tmpRoot, name);
    fs.writeFileSync(file, contents);
    return file;
  }

  it("fails the run when the claimed key file holds the placeholder token", async () => {
    const keyFile = writeKeyFile(
      "paperclip-claimed-api-key.json",
      JSON.stringify({ token: "pc_api_key_value_here" }),
    );
    const adapter = requireServerAdapter("hermes_local");

    await expect(
      adapter.execute(
        hermesCtx({
          authToken: "broken-local-agent-jwt",
          agent: { adapterConfig: { claimedApiKeyPath: keyFile } },
        }),
      ),
    ).rejects.toThrow(/claimed API key file/i);

    // The child must never run with the JWT fallback: that path only 401s.
    expect(hermesExecuteMock).not.toHaveBeenCalled();
  });

  it("fails the run when the claimed key file holds the scrubbed *** value", async () => {
    const keyFile = writeKeyFile(
      "paperclip-claimed-api-key.json",
      JSON.stringify({ token: "***" }),
    );
    const adapter = requireServerAdapter("hermes_local");

    await expect(
      adapter.execute(
        hermesCtx({
          authToken: "broken-local-agent-jwt",
          agent: { adapterConfig: { claimedApiKeyPath: keyFile } },
        }),
      ),
    ).rejects.toThrow(/claimed API key file/i);

    expect(hermesExecuteMock).not.toHaveBeenCalled();
  });

  it("fails the run when the claimed key file is not valid JSON", async () => {
    const keyFile = writeKeyFile("paperclip-claimed-api-key.json", "not-json{");
    const adapter = requireServerAdapter("hermes_local");

    await expect(
      adapter.execute(
        hermesCtx({
          authToken: "broken-local-agent-jwt",
          agent: { adapterConfig: { claimedApiKeyPath: keyFile } },
        }),
      ),
    ).rejects.toThrow(/claimed API key file/i);

    expect(hermesExecuteMock).not.toHaveBeenCalled();
  });

  it("still falls back to the local JWT when the agent never claimed a key", async () => {
    // A missing file is a legitimate state (the agent has not claimed yet),
    // so the fallback stays. Only an EXISTING but unusable file is fatal.
    const missing = path.join(tmpRoot, "never-claimed.json");
    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute(
      hermesCtx({
        authToken: "broken-local-agent-jwt",
        agent: { adapterConfig: { claimedApiKeyPath: missing } },
      }),
    );

    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    const patchedCtx = hermesExecuteMock.mock.calls[0][0];
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("broken-local-agent-jwt");
  });

  it("keeps the operator-supplied key and never reads the claimed key file", async () => {
    const keyFile = writeKeyFile(
      "paperclip-claimed-api-key.json",
      JSON.stringify({ token: "pc_api_key_value_here" }),
    );
    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute(
      hermesCtx({
        authToken: "broken-local-agent-jwt",
        agent: {
          adapterConfig: {
            claimedApiKeyPath: keyFile,
            env: { PAPERCLIP_API_KEY: "operator-override-key" },
          },
        },
      }),
    );

    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    const patchedCtx = hermesExecuteMock.mock.calls[0][0];
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("operator-override-key");
  });

  it("injects a valid claimed token and does not throw", async () => {
    const keyFile = writeKeyFile(
      "paperclip-claimed-api-key.json",
      JSON.stringify({ token: "pcp_valid_token_0123456789abcdef" }),
    );
    const adapter = requireServerAdapter("hermes_local");

    await adapter.execute(
      hermesCtx({
        authToken: "broken-local-agent-jwt",
        agent: { adapterConfig: { claimedApiKeyPath: keyFile } },
      }),
    );

    expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
    const patchedCtx = hermesExecuteMock.mock.calls[0][0];
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("pcp_valid_token_0123456789abcdef");
  });
});
