import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "hermes-paperclip-adapter/server";
import {
  HERMES_COMPACTION_STALL_ERROR_CODE,
  applyHermesCompactionStallRecovery,
  isHermesCompactionStall,
  isHermesNonSuccessExit,
} from "../adapters/hermes-session-id.js";

/**
 * RUAAAAA-5339 regression guard: the hermes compaction-stall livelock.
 *
 * Hermes' own context compaction stalls on some sessions. It never returns —
 * it just reprints its progress line until the adapter's `timeoutSec` kills
 * the child (SIGINT, exit 130), so the run spends its entire budget without
 * executing a single turn. `parseHermesOutput` scrapes the spinner as the
 * response, so `resultJson.result` is nothing but progress lines.
 *
 * The session is persisted anyway, so every later dispatch resumes the same
 * wedged session and fails identically. Measured 2026-10-23: 61 of 79
 * `hermes_local` timeouts showed this signature across 15 agents, and 7 Ruah
 * agents sat at zero successful runs for 20-50h while still dispatching.
 * 0 of 314 `openclaw_gateway` timeouts showed it, so it is hermes-specific.
 *
 * The run record hid all of it: the adapter returns `timedOut: true` with no
 * `errorMessage`, and heartbeat.ts falls back to the bare string "Timed out"
 * (heartbeat.ts:7583). The `process` adapter does set
 * `Timed out after ${timeoutSec}s` (adapters/process/execute.ts:60).
 */

const STALLED_SESSION = "20261022_133354_50b060";

/** The exact shape captured from the live runs on 2026-10-23. */
const OBSERVED_SPINNER_RESULT = [
  "⟳ compacting context…",
  "⟳ compacting context…",
  "⟳ compacting context…",
  "⟳ compacting context…",
].join("\n");

async function writeFakeHermes(dir: string, script: string): Promise<string> {
  const commandPath = path.join(dir, "hermes");
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

/**
 * A child that prints the compaction progress line forever and never exits,
 * so only the adapter's timeout can stop it — the production signature.
 *
 * The progress lines come before `session_id:` because that is the order the
 * real child uses, and `parseHermesOutput` only builds `result.response` from
 * the text ahead of the `session_id:` line.
 */
function stallingHermes(sessionId: string): string {
  return `#!/usr/bin/env node
const spin = setInterval(() => {
  process.stdout.write("⟳ compacting context…\\n");
}, 20);
process.on("SIGINT", () => { clearInterval(spin); process.stdout.write("session_id: ${sessionId}\\n"); process.exit(130); });
`;
}

function ctx(commandPath: string, runtimeSessionId?: string) {
  return {
    runId: "run-5339",
    agent: {
      id: "agent-5339",
      name: "Compliance Specialist",
      companyId: "company-1",
      workspaceDir: os.tmpdir(),
      adapterConfig: {
        hermesCommand: commandPath,
        persistSession: true,
        model: "test-model",
        extraArgs: [],
        timeoutSec: 1,
        graceSec: 1,
      },
    },
    runtime: {
      sessionParams: runtimeSessionId ? { sessionId: runtimeSessionId } : {},
      sessionDisplayId: runtimeSessionId ?? "",
      cwd: os.tmpdir(),
    },
    config: {},
    context: {},
    onLog: async () => {},
  };
}

describe("hermes compaction-stall recovery (RUAAAAA-5339)", () => {
  it("recognises a spinner-only result", () => {
    expect(isHermesCompactionStall(OBSERVED_SPINNER_RESULT)).toBe(true);
    expect(isHermesCompactionStall("⟳ compacting context…")).toBe(true);
    expect(isHermesCompactionStall("  ⟳ compacting context...  \n⟳ compacting context…\n")).toBe(true);
  });

  it("does not fire when the agent produced real output", () => {
    for (const other of [
      "",
      null,
      undefined,
      // A spinner line plus the actual answer is a normal slow run.
      `${OBSERVED_SPINNER_RESULT}\nHere is the reconciliation summary you asked for.`,
      "⟳ compacting context…\nsession_id: 20261022_133354_50b060",
      "Done. Patched the invoice totals and posted the summary.",
    ]) {
      expect(isHermesCompactionStall(other as string)).toBe(false);
    }
  });

  it("drops the wedged session and names the cause", () => {
    const fixed = applyHermesCompactionStallRecovery({
      exitCode: null,
      signal: "SIGINT",
      timedOut: true,
      resultJson: { result: OBSERVED_SPINNER_RESULT },
    });
    expect(fixed.clearSession).toBe(true);
    expect(fixed.errorCode).toBe(HERMES_COMPACTION_STALL_ERROR_CODE);
    // Never scored as the bare "Timed out" the reports were showing.
    expect(fixed.errorMessage).toContain("compaction");
    expect(fixed.errorMessage).toContain("SIGINT");
    expect(fixed.errorMessage).not.toBe("Timed out");
    expect(HERMES_COMPACTION_STALL_ERROR_CODE).not.toBe("timeout");
    expect(HERMES_COMPACTION_STALL_ERROR_CODE).not.toBe("adapter_failed");
  });

  it("names the run budget and keeps the adapter's own error text", () => {
    const fixed = applyHermesCompactionStallRecovery(
      {
        exitCode: 130,
        timedOut: false,
        errorMessage: "hermes: provider refused the request (401)",
        resultJson: { result: OBSERVED_SPINNER_RESULT },
      },
      { timeoutSec: 1800 },
    );
    // The budget is what tells an operator-raised 1800s apart from the
    // adapter's own 300s default - a stall that ate 1800s is a different
    // incident from one that ate 300s.
    expect(fixed.errorMessage).toContain("1800s");
    // The adapter already narrowed stderr down to the lines that look like
    // real errors, so the stall diagnosis must not throw them away: they are
    // the only evidence of WHY hermes stalled.
    expect(fixed.errorMessage).toContain("provider refused the request");
    expect(fixed.clearSession).toBe(true);
    expect(fixed.errorCode).toBe(HERMES_COMPACTION_STALL_ERROR_CODE);
  });

  it("omits the budget when the run budget is unknown", () => {
    const fixed = applyHermesCompactionStallRecovery({
      exitCode: 130,
      timedOut: false,
      resultJson: { result: OBSERVED_SPINNER_RESULT },
    });
    expect(fixed.errorMessage).toContain("compaction");
    expect(fixed.errorMessage).not.toContain("run budget");
  });

  it("leaves a run that did not time out untouched", () => {
    const original = { exitCode: 0, timedOut: false, resultJson: { result: OBSERVED_SPINNER_RESULT } };
    expect(applyHermesCompactionStallRecovery(original)).toBe(original);
  });

  it("leaves an ordinary timeout untouched", () => {
    // Real timeouts with no compaction are the 18-run minority; they must
    // keep their existing classification rather than be re-labelled.
    const original = {
      exitCode: null,
      signal: "SIGINT",
      timedOut: true,
      errorMessage: "Timed out after 600s",
      resultJson: { result: "" },
    };
    expect(applyHermesCompactionStallRecovery(original)).toBe(original);
  });

  it("reproduces the stall through the real adapter and recovers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-5339-"));
    try {
      const commandPath = await writeFakeHermes(dir, stallingHermes(STALLED_SESSION));

      // The raw adapter result: timed out, no errorMessage, and a
      // result payload that is only the progress line.
      const raw = await execute(ctx(commandPath, STALLED_SESSION) as never);
      expect(raw.timedOut).toBe(true);
      expect(raw.errorMessage).toBeUndefined();
      expect(String(raw.resultJson?.result ?? "").length).toBeGreaterThan(0);
      expect(raw.resultJson?.result).toMatch(/compacting context/);

      // Recovery turns that into an actionable, self-describing failure and
      // releases the wedged session.
      const recovered = applyHermesCompactionStallRecovery(raw as never);
      expect(recovered.clearSession).toBe(true);
      expect(recovered.errorCode).toBe(HERMES_COMPACTION_STALL_ERROR_CODE);
      expect(recovered.errorMessage).toContain("compaction");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
describe("hermes compaction-stall arming on a non-success exit (RUAAAAA-5339)", () => {
  it("arms on every non-success exit, not only on a wall-clock timeout", () => {
    // Wall-clock timeout.
    expect(isHermesNonSuccessExit({ timedOut: true, exitCode: null })).toBe(true);
    // The child caught SIGINT and exited 130: timedOut is false because
    // Paperclip's own timer never fired. The server files this as
    // failed/adapter_failed rather than timed_out.
    expect(isHermesNonSuccessExit({ timedOut: false, exitCode: 130 })).toBe(true);
    expect(isHermesNonSuccessExit({ timedOut: false, exitCode: 1 })).toBe(true);
    // Killed outright by a signal: no exit code at all, but it never
    // succeeded either.
    expect(isHermesNonSuccessExit({ timedOut: false, exitCode: null, signal: "SIGINT" })).toBe(true);
    // A clean exit is not a stall.
    expect(isHermesNonSuccessExit({ timedOut: false, exitCode: 0 })).toBe(false);
    expect(isHermesNonSuccessExit({ timedOut: false, exitCode: null })).toBe(false);
  });

  it("recovers a run that exited 130 without Paperclip's timer firing", () => {
    const fixed = applyHermesCompactionStallRecovery({
      exitCode: 130,
      signal: null,
      timedOut: false,
      resultJson: { result: OBSERVED_SPINNER_RESULT },
    });
    expect(fixed.clearSession).toBe(true);
    expect(fixed.errorCode).toBe(HERMES_COMPACTION_STALL_ERROR_CODE);
    expect(fixed.errorMessage).toContain("compaction");
    expect(fixed.errorMessage).toContain("130");
  });

  it("recovers a run that was killed outright by a signal", () => {
    const fixed = applyHermesCompactionStallRecovery({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
      resultJson: { result: OBSERVED_SPINNER_RESULT },
    });
    expect(fixed.clearSession).toBe(true);
    expect(fixed.errorCode).toBe(HERMES_COMPACTION_STALL_ERROR_CODE);
    expect(fixed.errorMessage).toContain("SIGKILL");
  });
});
