import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/hermes-paperclip-adapter/server";
import {
  createGuardedHermesLocalExecute,
  HERMES_SESSION_NOT_OWNED_ERROR_CODE,
  applyHermesSessionContentionRecovery,
  isHermesSessionNotOwned,
} from "../adapters/hermes-session-id.js";

/**
 * RUAAAAA-5296 regression guard, ported onto the reconciled master
 * (RUAAAAA-5418): the hermes session-contention refusal.
 *
 * `persistSession` pins a dispatch to a session id and `hermes --resume <id>`
 * is refused while a person holds that session interactively:
 *
 *   hermes-refusal-reason: SESSION_NOT_OWNED
 *   This chat is open in another Hermes window/terminal. ...
 *   Details: session 20261021_120843_054c18 opened by cli 7m ago.
 *
 * The refusal carries no `session_id`, so the adapter returns no
 * `sessionParams` and the server falls back to `previousParams` — re-pinning
 * the id that was just refused. Six such runs in production on 2026-10-22 all
 * scored `adapter_failed`, which sent the hunt toward adapter config instead.
 */
const REFUSAL_STDERR = [
  "hermes-refusal-reason: SESSION_NOT_OWNED",
  "This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.",
  "Details: session 20261021_120843_054c18 opened by cli 7m ago.",
].join("\n");

const HELD_SESSION = "20261021_120843_054c18";

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

/**
 * The vendored hermes adapter (packages/adapters/hermes) reads its config from
 * `ctx.config` first and only falls back to `ctx.agent.adapterConfig`, so the
 * fake command has to be supplied through `ctx.config`.
 */
function ctx(commandPath: string, runtimeSessionId?: string) {
  return {
    runId: "run-5296",
    agent: {
      id: "agent-5296",
      name: "Godines OS Reliability & QA Lead",
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
      // Keep the child cheap and hermes-free.
      model: "test-model",
      extraArgs: [],
    },
    context: {},
    onLog: async () => {},
  };
}

describe("hermes SESSION_NOT_OWNED recovery (RUAAAAA-5296)", () => {
  it("recognises the refusal text", () => {
    expect(isHermesSessionNotOwned(REFUSAL_STDERR)).toBe(true);
    expect(isHermesSessionNotOwned(`prefix\n${REFUSAL_STDERR}\nsuffix`)).toBe(true);
  });

  it("does not fire on ordinary hermes output", () => {
    for (const other of [
      "",
      null,
      undefined,
      "session_id: 20261022_114854_26d1cd",
      "Error: something genuinely broke",
      "hermes-refusal-reason: RATE_LIMITED",
      "session 20261021_120843_054c18 opened by cli 7m ago.",
    ]) {
      expect(isHermesSessionNotOwned(other as string)).toBe(false);
    }
  });

  it("marks a refused result for session clearing and a distinct error code", () => {
    const fixed = applyHermesSessionContentionRecovery({ exitCode: 1 }, REFUSAL_STDERR);
    expect(fixed.clearSession).toBe(true);
    expect(fixed.errorCode).toBe(HERMES_SESSION_NOT_OWNED_ERROR_CODE);
    expect(HERMES_SESSION_NOT_OWNED_ERROR_CODE).not.toBe("adapter_failed");
  });

  it("leaves an unrelated failure untouched", () => {
    const original = { exitCode: 1 };
    expect(applyHermesSessionContentionRecovery(original, "Error: boom")).toBe(original);
  });

  it("reproduces the refusal through the real adapter and recovers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-5296-"));
    try {
      const commandPath = await writeFakeHermes(dir, refusingHermes());

      // The adapter on its own: it surfaces the refusal as a bare failure with
      // no sessionParams, which is exactly what made the server re-pin.
      const raw = await execute(ctx(commandPath, HELD_SESSION) as never);
      expect(raw.sessionParams).toBeUndefined();
      expect(raw.exitCode).not.toBe(0);

      // After recovery the server drops the pinned session.
      const recovered = applyHermesSessionContentionRecovery(raw, REFUSAL_STDERR);
      expect(recovered.clearSession).toBe(true);
      expect(recovered.errorCode).toBe(HERMES_SESSION_NOT_OWNED_ERROR_CODE);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("still resumes normally when no interactive holder is present", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-5296-ok-"));
    try {
      const commandPath = await writeFakeHermes(dir, succeedingHermes("20261022_114854_26d1cd"));

      const result = await execute(ctx(commandPath) as never);
      expect(result.sessionParams).toEqual({ sessionId: "20261022_114854_26d1cd" });

      // No refusal in stderr => untouched, so normal session reuse is kept.
      const unchanged = applyHermesSessionContentionRecovery(result, "");
      expect(unchanged).toBe(result);
      expect(unchanged.clearSession).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers the session when the guard wraps the vendored adapter", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-5296-guard-"));
    try {
      const commandPath = await writeFakeHermes(dir, refusingHermes());
      const guarded = createGuardedHermesLocalExecute(execute);

      const result = await guarded(ctx(commandPath, HELD_SESSION) as never);

      // The vendored adapter never surfaces the child's stderr on the result,
      // so the guard has to recover the refusal from the child's stderr stream.
      expect(result.clearSession).toBe(true);
      expect(result.errorCode).toBe(HERMES_SESSION_NOT_OWNED_ERROR_CODE);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a successful run untouched when the guard wraps the vendored adapter", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-5296-guard-ok-"));
    try {
      const commandPath = await writeFakeHermes(dir, succeedingHermes("20261022_114854_26d1cd"));
      const guarded = createGuardedHermesLocalExecute(execute);

      const result = await guarded(ctx(commandPath) as never);

      expect(result.clearSession).toBeUndefined();
      expect(result.errorCode).toBeUndefined();
      expect(result.sessionParams).toEqual({ sessionId: "20261022_114854_26d1cd" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
