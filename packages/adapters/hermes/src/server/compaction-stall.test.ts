import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { execute } from "./execute.js";
import {
  HERMES_COMPACTION_STALL_ERROR_CODE,
  countHermesCompactionSpinnerLines,
  describeHermesCompactionStall,
  isHermesCompactionStall,
  isHermesNonSuccessExit,
} from "./compaction-stall.js";

/**
 * RUAAAAA-5339 regression guard: the Hermes context-compaction stall.
 *
 * Hermes own context compaction stalls on some sessions. It never returns: it
 * reprints its progress line until the child is killed (SIGINT, exit 130) or
 * the adapters timeoutSec kills it. The run spends its whole budget without
 * executing a single turn, and parseHermesOutput scrapes the progress line as
 * the response - so the run result payload is nothing but the spinner.
 *
 * The session is persisted anyway, so every later dispatch resumes the same
 * wedged session and fails identically. Measured on production 2026-10-23:
 * 501 of 936 hermes_local timeouts showed this signature across many agents,
 * plus 6 more filed as failed/adapter_failed with exit code 130. Zero of
 * 10,429 hermes_local successes and zero of 80,222 openclaw_gateway runs
 * matched.
 *
 * The run record hid all of it: the adapter returned timedOut with no
 * errorMessage, and the server fell back to the bare string "Timed out".
 */

const STALLED_SESSION = "20261022_133354_50b060";

/** The exact shape captured from the live runs on 2026-10-23. */
const OBSERVED_SPINNER_RESULT = [
  "⟳ compacting context…",
  "⟳ compacting context…",
  "⟳ compacting context…",
  "⟳ compacting context…",
].join("\n");

const FIXTURE_URL = new URL("./fixtures/ruaaaaa-5339-run-payloads.jsonl", import.meta.url);

type Payload = { label: string; status: string; result: string | null };

describe("hermes compaction-stall detection (RUAAAAA-5339)", () => {
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
      OBSERVED_SPINNER_RESULT + "\nHere is the reconciliation summary you asked for.",
      "⟳ compacting context…\nsession_id: 20261022_133354_50b060",
      "Done. Patched the invoice totals and posted the summary.",
    ]) {
      expect(isHermesCompactionStall(other as string)).toBe(false);
    }
  });

  it("arms on every non-success exit, not only on a wall-clock timeout", () => {
    // Wall-clock timeout.
    expect(isHermesNonSuccessExit({ timedOut: true, exitCode: null })).toBe(true);
    // The child died on SIGINT by itself: timedOut is false, exit code 130.
    // The server files this as failed/adapter_failed, not timed_out.
    expect(isHermesNonSuccessExit({ timedOut: false, exitCode: 130 })).toBe(true);
    expect(isHermesNonSuccessExit({ timedOut: false, exitCode: 1 })).toBe(true);
    // Killed by a signal: no exit code at all, but it never succeeded.
    expect(isHermesNonSuccessExit({ timedOut: false, exitCode: null, signal: "SIGINT" })).toBe(true);
    // A clean exit is not a stall.
    expect(isHermesNonSuccessExit({ timedOut: false, exitCode: 0 })).toBe(false);
    expect(isHermesNonSuccessExit({ timedOut: false, exitCode: null })).toBe(false);
  });

  it("counts the progress lines and names the cause", () => {
    expect(countHermesCompactionSpinnerLines(OBSERVED_SPINNER_RESULT)).toBe(4);
    expect(countHermesCompactionSpinnerLines("")).toBe(0);
    const message = describeHermesCompactionStall({
      spinnerLines: 4,
      signal: "SIGINT",
      timeoutSec: 600,
      exitCode: 130,
    });
    expect(message).toContain("compaction");
    expect(message).toContain("600s");
    expect(message).toContain("SIGINT");
    expect(message).toContain("130");
    expect(message).not.toBe("Timed out");
  });

  it("keeps a distinct error code", () => {
    expect(HERMES_COMPACTION_STALL_ERROR_CODE).toBe("compaction_stall");
    expect(HERMES_COMPACTION_STALL_ERROR_CODE).not.toBe("timeout");
    expect(HERMES_COMPACTION_STALL_ERROR_CODE).not.toBe("adapter_failed");
  });

  it("replays real production payloads: every stall caught, no false positives", async () => {
    const raw = await fs.readFile(FIXTURE_URL, "utf8");
    const payloads: Payload[] = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Payload);

    const byLabel = (label: string) => payloads.filter((p) => p.label === label);
    const stalls = byLabel("stall");
    const exit130 = byLabel("hermes_failed_exit130_stall");
    const nonStallTimeouts = byLabel("hermes_timeout_nostall");
    const successes = byLabel("hermes_success");
    const gatewayTimeouts = byLabel("gateway_timeout");

    expect(payloads.length).toBeGreaterThan(990);
    expect(stalls.length).toBe(61);
    // 5, not the 6 the reviewer measured: the sixth was still in flight when
    // they measured at 08:37Z and has since not completed as a stall. The
    // census in the issue comment states the current figure.
    expect(exit130.length).toBe(5);
    expect(nonStallTimeouts.length).toBe(18);
    expect(successes.length).toBe(599);
    expect(gatewayTimeouts.length).toBe(314);

    // Every run that stalled in compaction is detected.
    const missed = [...stalls, ...exit130].filter((p) => !isHermesCompactionStall(p.result));
    expect(missed.map((p) => p.result)).toEqual([]);

    // Nothing else is.
    const falsePositives = [...nonStallTimeouts, ...successes, ...gatewayTimeouts].filter((p) =>
      isHermesCompactionStall(p.result),
    );
    expect(falsePositives.map((p) => p.result)).toEqual([]);
  });
});

describe("hermes compaction-stall recovery through the real adapter (RUAAAAA-5339)", () => {
  let dir: string;
  let command: string;

  /**
   * A child that prints the compaction progress line forever and never exits,
   * so only the adapters timeout can stop it - the production signature. The
   * progress lines come before the session_id line because that is the order
   * the real child uses, and the parser only builds the response from the
   * text ahead of the session_id line.
   */
  function stallingHermes(): string {
    return [
      "#!" + process.execPath,
      "const spin = setInterval(() => {",
      '  process.stdout.write("⟳ compacting context…\\n");',
      "}, 20);",
      'process.on("SIGINT", () => {',
      "  clearInterval(spin);",
      '  process.stdout.write("session_id: ' + STALLED_SESSION + '\\n");',
      "  process.exit(130);",
      "});",
      "",
    ].join("\n");
  }

  /**
   * A child that prints the compaction progress line and then dies on SIGINT
   * by itself, without Paperclips wall-clock timer firing. The server files
   * this as failed/adapter_failed rather than timed_out, so the detector has
   * to arm on a non-success exit as well.
   */
  function selfInterruptedHermes(): string {
    // The production shape: the Hermes CLI catches SIGINT and exits 130, so
    // the run reports exit code 130 with no signal.
    return [
      "#!" + process.execPath,
      'process.stdout.write("⟳ compacting context…\\n");',
      'process.stdout.write("⟳ compacting context…\\n");',
      'process.on("SIGINT", () => { process.exit(130); });',
      'process.kill(process.pid, "SIGINT");',
      "setTimeout(() => process.exit(130), 500);",
      "",
    ].join("\n");
  }

  /**
   * A child killed outright by a signal reports no exit code at all, only
   * the signal. That is a third shape the detector has to arm on.
   */
  function signalKilledHermes(): string {
    return [
      "#!" + process.execPath,
      'process.stdout.write("⟳ compacting context…\\n");',
      'process.kill(process.pid, "SIGKILL");',
      "setTimeout(() => process.exit(137), 500);",
      "",
    ].join("\n");
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-stall-"));
    command = path.join(dir, "hermes.cjs");
  });

  function context(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    const config = {
      hermesCommand: command,
      provider: "openrouter",
      model: "fixture-model",
      cwd: dir,
      timeoutSec: 1,
      graceSec: 1,
    };
    return {
      runId: "run-5339",
      agent: {
        id: "agent-5339",
        companyId: "company-5339",
        name: "Compliance Specialist",
        adapterType: "hermes_local",
        adapterConfig: config,
      },
      runtime: {
        sessionId: STALLED_SESSION,
        sessionParams: { sessionId: STALLED_SESSION },
        sessionDisplayId: STALLED_SESSION,
        taskKey: "task-5339",
      },
      config,
      context: { issueId: "task-5339" },
      onLog: async () => {},
      ...overrides,
    } as unknown as AdapterExecutionContext;
  }

  it("reports the cause and drops the wedged session on a wall-clock timeout", async () => {
    await fs.writeFile(command, stallingHermes(), "utf8");
    await fs.chmod(command, 0o755);

    const result = await execute(context());

    expect(result.timedOut).toBe(true);
    // The adapter now names the cause instead of leaving it undefined.
    expect(result.errorMessage).toBeTruthy();
    expect(result.errorMessage).toContain("compaction");
    expect(result.errorMessage).not.toBe("Timed out");
    expect(result.errorCode).toBe(HERMES_COMPACTION_STALL_ERROR_CODE);
    // The server drops the session, so the next dispatch starts fresh.
    expect(result.clearSession).toBe(true);
  }, 30_000);

  it("reports the cause and drops the wedged session when the child self-interrupts", async () => {
    await fs.writeFile(command, selfInterruptedHermes(), "utf8");
    await fs.chmod(command, 0o755);

    const result = await execute(context());

    // Paperclips own wall-clock timer never fired: this is the path the
    // server files as failed/adapter_failed, not timed_out.
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(130);
    expect(result.errorMessage).toContain("compaction");
    expect(result.errorCode).toBe(HERMES_COMPACTION_STALL_ERROR_CODE);
    expect(result.clearSession).toBe(true);
  }, 30_000);

  it("reports the cause and drops the wedged session when the child is killed by a signal", async () => {
    await fs.writeFile(command, signalKilledHermes(), "utf8");
    await fs.chmod(command, 0o755);

    const result = await execute(context());

    // Killed by a signal: no exit code at all, only the signal.
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeTruthy();
    expect(result.errorMessage).toContain("compaction");
    expect(result.errorCode).toBe(HERMES_COMPACTION_STALL_ERROR_CODE);
    expect(result.clearSession).toBe(true);
  }, 30_000);
});
