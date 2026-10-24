import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

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

interface AdapterCtxOverrides {
  agent?: Record<string, unknown>;
  authToken?: string | undefined;
  runId?: string;
}

async function executeHermes(overrides: AdapterCtxOverrides = {}) {
  const adapter = requireServerAdapter("hermes_local");
  const ctx = {
    runId: overrides.runId ?? "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
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
  await adapter.execute(ctx);
  expect(hermesExecuteMock).toHaveBeenCalledTimes(1);
  return hermesExecuteMock.mock.calls[0][0];
}

describe("hermes_local PAPERCLIP_API_KEY injection (RUAAAAA-2375)", () => {
  let tmpRoot: string;
  let keyFile: string;
  let fsReadFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hermesExecuteMock.mockClear();
    unregisterServerAdapter("external_test");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-2375-"));
    keyFile = path.join(tmpRoot, "paperclip-claimed-api-key.json");
    fs.writeFileSync(
      keyFile,
      JSON.stringify({
        token: "pcp_stored_agent_token_abc123",
        agentId: "agent-123",
        agentName: "Hermes Agent",
        companyId: "company-123",
      }),
    );
    fsReadFileSpy = vi.spyOn(fs.promises, "readFile");
  });

  afterEach(() => {
    fsReadFileSpy.mockRestore();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("injects the stored api_key from adapterConfig.claimedApiKeyPath instead of the JWT", async () => {
    const patchedCtx = await executeHermes({
      authToken: "per-run-agent-jwt",
      agent: { adapterConfig: { claimedApiKeyPath: keyFile } },
    });

    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("pcp_stored_agent_token_abc123");
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).not.toBe("per-run-agent-jwt");
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_RUN_ID).toBe("run-123");
    // One filesystem read per execute() — the lookup is cached at run start.
    expect(fsReadFileSpy).toHaveBeenCalledTimes(1);
  });

  it("expands a leading ~ in claimedApiKeyPath against os.homedir", async () => {
    const homeStub = path.join(tmpRoot, "fake-home");
    fs.mkdirSync(path.join(homeStub, ".openclaw", "agents", "agent-123"), { recursive: true });
    const realKeyFile = path.join(homeStub, ".openclaw", "agents", "agent-123", "paperclip-claimed-api-key.json");
    fs.writeFileSync(
      realKeyFile,
      JSON.stringify({ token: "pcp_home_expanded_token" }),
    );

    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(homeStub);

    try {
      const patchedCtx = await executeHermes({
        authToken: "per-run-agent-jwt",
        agent: {
          adapterConfig: { claimedApiKeyPath: "~/.openclaw/agents/agent-123/paperclip-claimed-api-key.json" },
        },
      });
      expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("pcp_home_expanded_token");
      expect(fsReadFileSpy).toHaveBeenCalledWith(
        realKeyFile,
        expect.any(String),
      );
    } finally {
      homeSpy.mockRestore();
    }
  });

  it("falls back to the run-scoped agent JWT when claimedApiKeyPath is not configured", async () => {
    const patchedCtx = await executeHermes({
      authToken: "per-run-agent-jwt",
      agent: { adapterConfig: {} },
    });

    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("per-run-agent-jwt");
    expect(fsReadFileSpy).not.toHaveBeenCalled();
  });

  it("falls back to the run-scoped agent JWT when the configured file is missing", async () => {
    const missing = path.join(tmpRoot, "does-not-exist.json");
    const patchedCtx = await executeHermes({
      authToken: "per-run-agent-jwt",
      agent: { adapterConfig: { claimedApiKeyPath: missing } },
    });

    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("per-run-agent-jwt");
    expect(fsReadFileSpy).toHaveBeenCalledWith(missing, expect.any(String));
  });

  it("falls back to the run-scoped agent JWT when the configured file is malformed JSON", async () => {
    const malformed = path.join(tmpRoot, "malformed.json");
    fs.writeFileSync(malformed, "not-json{");
    const patchedCtx = await executeHermes({
      authToken: "per-run-agent-jwt",
      agent: { adapterConfig: { claimedApiKeyPath: malformed } },
    });

    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("per-run-agent-jwt");
    expect(fsReadFileSpy).toHaveBeenCalledWith(malformed, expect.any(String));
  });

  it("falls back to the run-scoped agent JWT when the token field is missing", async () => {
    const noToken = path.join(tmpRoot, "no-token.json");
    fs.writeFileSync(noToken, JSON.stringify({ agentId: "x" }));
    const ctx = await executeHermes({
      authToken: "j-missing", agent: { adapterConfig: { claimedApiKeyPath: noToken } },
    });
    expect(ctx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("j-missing");
  });

  it("falls back to the run-scoped agent JWT when the token is not pcp_-prefixed", async () => {
    const noPrefix = path.join(tmpRoot, "bad-prefix.json");
    fs.writeFileSync(noPrefix, JSON.stringify({ token: "jwt-shaped-token" }));
    const ctx = await executeHermes({
      authToken: "j-prefix", agent: { adapterConfig: { claimedApiKeyPath: noPrefix } },
    });
    expect(ctx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("j-prefix");
  });

  it("falls back to the run-scoped agent JWT when the token is an empty string", async () => {
    const blank = path.join(tmpRoot, "blank.json");
    fs.writeFileSync(blank, JSON.stringify({ token: "" }));
    const ctx = await executeHermes({
      authToken: "j-blank", agent: { adapterConfig: { claimedApiKeyPath: blank } },
    });
    expect(ctx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("j-blank");
  });

  it("falls back to the run-scoped agent JWT when the JSON root is not an object", async () => {
    const notObject = path.join(tmpRoot, "not-object.json");
    fs.writeFileSync(notObject, JSON.stringify(["nope"]));
    const ctx = await executeHermes({
      authToken: "j-not-object", agent: { adapterConfig: { claimedApiKeyPath: notObject } },
    });
    expect(ctx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("j-not-object");
  });

  it("never overwrites an explicit operator-supplied PAPERCLIP_API_KEY", async () => {
    const patchedCtx = await executeHermes({
      authToken: "per-run-agent-jwt",
      agent: {
        adapterConfig: {
          claimedApiKeyPath: keyFile,
          env: { PAPERCLIP_API_KEY: "operator-override-key" },
        },
      },
    });

    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("operator-override-key");
    // Even on the explicit-overrides branch we still do NOT want to leak the stored
    // token into the env — the file is only consulted for diagnostic intent and
    // its token is never injected because explicit took priority.
    expect(fsReadFileSpy).not.toHaveBeenCalled();
  });

  it("injects nothing and warns when no key source is available", async () => {
    // Suppress logs to keep test output clean.
    const loggerModule = await import("../middleware/logger.js");
    const warnSpy = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);

    try {
      const patchedCtx = await executeHermes({
        agent: { adapterConfig: {} },
      });

      // No authToken, no claimedApiKeyPath → child gets no PAPERCLIP_API_KEY (writes will 401).
      expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBeUndefined();
      expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_RUN_ID).toBe("run-123");
      // A diagnostic warn was emitted naming the agent and run.
      expect(warnSpy).toHaveBeenCalled();
      const lastCall = warnSpy.mock.calls[warnSpy.mock.calls.length - 1];
      expect(String(lastCall[1] ?? "")).toContain("no PAPERCLIP_API_KEY source");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs the key source AND whether a value was actually injected (RUAAAAA-5412)", async () => {
    const loggerModule = await import("../middleware/logger.js");
    const infoSpy = vi.spyOn(loggerModule.logger, "info").mockImplementation(() => undefined);

    try {
      await executeHermes({
        authToken: "per-run-agent-jwt",
        agent: { adapterConfig: {} },
      });

      const injectionCalls = infoSpy.mock.calls.filter((call) =>
        String(call[1] ?? "").startsWith("[hermes_local]"),
      );
      expect(injectionCalls).toHaveLength(1);

      const payload = injectionCalls[0][0] as Record<string, unknown>;
      expect(payload.source).toBe("authToken");
      // `source` records which branch ran; `injected` is derived from the
      // value, so it is the field that actually proves a key reached the child.
      expect(payload.injected).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("does not log an injection when no key source is available (RUAAAAA-5412)", async () => {
    const loggerModule = await import("../middleware/logger.js");
    const infoSpy = vi.spyOn(loggerModule.logger, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);

    try {
      await executeHermes({ agent: { adapterConfig: {} } });

      const injectionCalls = infoSpy.mock.calls.filter((call) =>
        String(call[1] ?? "").startsWith("[hermes_local]"),
      );
      expect(injectionCalls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("does not warn that the hermes_local key path is broken (RUAAAAA-5412)", async () => {
    const loggerModule = await import("../middleware/logger.js");
    const warnSpy = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);

    try {
      await executeHermes({
        authToken: "per-run-agent-jwt",
        agent: { adapterConfig: {} },
      });

      const warnings = warnSpy.mock.calls.map((call) => String(call[1] ?? ""));
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.join("\n")).not.toContain("broken for hermes_local");
      // The warning must name the token that is actually injected.
      expect(warnings.join("\n")).toContain("local-agent JWT");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("preserves Hermes command normalization when injecting the stored api_key", async () => {
    const patchedCtx = await executeHermes({
      authToken: "per-run-agent-jwt",
      agent: {
        adapterConfig: {
          claimedApiKeyPath: keyFile,
          command: "agent-hermes",
        },
      },
      runId: "run-2375",
    });

    expect(patchedCtx.config.hermesCommand).toBeUndefined();
    expect(patchedCtx.agent.adapterConfig.hermesCommand).toBe("agent-hermes");
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_API_KEY).toBe("pcp_stored_agent_token_abc123");
    expect(patchedCtx.agent.adapterConfig.env.PAPERCLIP_RUN_ID).toBe("run-2375");
  });

  it("keeps supportsLocalAgentJwt: true so other adapters retain the JWT path", () => {
    const adapter = requireServerAdapter("hermes_local") as ServerAdapterModule;
    // The fix intentionally preserves the JWT-path capability declaration on the
    // adapter module so claude_local / codex_local / etc. keep working. The
    // hermes_local branch decides locally which value to inject; the runtime
    // contract (supportsLocalAgentJwt) is unchanged.
    expect(adapter.supportsLocalAgentJwt).toBe(true);
  });
});
