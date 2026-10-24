import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireServerAdapter } from "../adapters/index.js";

/**
 * RUAAAAA-5418: the hermes session-id guard and the SESSION_NOT_OWNED
 * contention recovery have to be *wired* into the hermes_local adapter.
 *
 * Upstream vendored the hermes adapter in-tree (packages/adapters/hermes,
 * 0.3.1) and builds hermes_local straight from it, which left
 * server/src/adapters/hermes-session-id.ts with no call site at all. These
 * tests assert the wiring through the registry, so a future refactor that
 * drops the wrapper fails here instead of silently regressing production.
 */

const VALID_SESSION_ID = "20261021_120843_054c18";

const REFUSAL_STDERR = [
  "hermes-refusal-reason: SESSION_NOT_OWNED",
  "This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.",
  "Details: session 20261021_120843_054c18 opened by cli 7m ago.",
].join("\n");

function hermesLocalAdapter() {
  return requireServerAdapter("hermes_local");
}

async function writeFakeHermes(dir: string, script: string): Promise<string> {
  const commandPath = path.join(dir, "hermes");
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

function refusingHermes(): string {
  return `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(REFUSAL_STDERR)} + "\\n");
process.exit(1);
`;
}

function succeedingHermes(sessionId: string): string {
  return `#!/usr/bin/env node
process.stdout.write("done\\nsession_id: ${sessionId}\\n");
process.exit(0);
`;
}

function ctx(commandPath: string, runtimeSessionId?: string) {
  return {
    runId: "run-5418",
    agent: {
      id: "agent-5418",
      name: "Hermes Agent",
      companyId: "company-1",
      workspaceDir: os.tmpdir(),
      adapterType: "hermes_local",
    },
    runtime: {
      sessionParams: runtimeSessionId ? { sessionId: runtimeSessionId } : {},
      sessionDisplayId: runtimeSessionId ?? "",
      cwd: os.tmpdir(),
    },
    config: {
      hermesCommand: commandPath,
      persistSession: true,
      cwd: os.tmpdir(),
      model: "test-model",
      extraArgs: [],
    },
    context: {},
    onLog: async () => {},
  };
}

describe("hermes_local registry wiring (RUAAAAA-5418)", () => {
  it("registers a guarded session codec", () => {
    const adapter = hermesLocalAdapter();
    expect(adapter.sessionCodec).toBeDefined();

    // Fail closed: a prose word captured by hermes' legacy stdout parser must
    // never be persisted or handed back as a resume target.
    expect(adapter.sessionCodec?.serialize({ sessionId: "from" })).toBeNull();
    expect(adapter.sessionCodec?.deserialize({ sessionId: "from" })).toBeNull();
    expect(adapter.sessionCodec?.getDisplayId?.({ sessionId: "from" })).toBeNull();

    // A real hermes session id still round-trips.
    expect(adapter.sessionCodec?.serialize({ sessionId: VALID_SESSION_ID })).toEqual({
      sessionId: VALID_SESSION_ID,
    });
    expect(adapter.sessionCodec?.deserialize({ sessionId: VALID_SESSION_ID })).toEqual({
      sessionId: VALID_SESSION_ID,
    });
  });

  it("clears the pinned session when hermes refuses it (SESSION_NOT_OWNED)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-5418-refuse-"));
    try {
      const commandPath = await writeFakeHermes(dir, refusingHermes());
      const adapter = hermesLocalAdapter();

      const result = await adapter.execute(ctx(commandPath, VALID_SESSION_ID) as never);

      expect(result.clearSession).toBe(true);
      expect(result.errorCode).toBe("session_not_owned");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the session when hermes runs normally", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-5418-ok-"));
    try {
      const commandPath = await writeFakeHermes(dir, succeedingHermes(VALID_SESSION_ID));
      const adapter = hermesLocalAdapter();

      const result = await adapter.execute(ctx(commandPath) as never);

      expect(result.clearSession).toBeUndefined();
      expect(result.errorCode).toBeUndefined();
      expect(result.sessionParams).toEqual({ sessionId: VALID_SESSION_ID });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
