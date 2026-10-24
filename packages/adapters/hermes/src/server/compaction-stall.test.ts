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
} from "./compaction-stall.js";

/**
 * RUAAAAA-5339 regression guard: the Hermes context-compaction stall.
 *
 * Hermes' own context compaction stalls on some sessions. It never returns:
 * it reprints its progress line until the adapter's `timeoutSec` kills the
 * child (SIGINT, exit 130). The run spends its whole budget without
 * executing a single turn, and `parseHermesOutput` scrapes the progress
 * line as the response — so the run's result payload is nothing but
 * `⟳ compacting context…`.
 *
 * The session is persisted anyway, so every later dispatch resumes the same
 * wedged session and fails identically. Measured on production 2026-10-23:
 * 61 of 79 `hermes_local` timeouts showed this signature across 15 agents,
 * and 0 of 314 `openclaw_gateway` timeouts did. Seven Ruah agents sat at
 * zero successful runs for 20-50h while still dispatching.
 *
 * The run record hid all of it: the adapter returned `timedOut` with no
 * `errorMessage`, and the server fell back to the bare string "Timed out".
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
      `${OBSERVED_SPINNER_RESULT}\nHere is the reconciliation summary you asked for.`,
      "⟳ compacting context…\nsession_id: 20261022_133354_50b060",
      "Done. Patched the invoice totals and posted the summary.",
    ]) {
      expect(isHermesCompactionStall(other as string)).toBe(false);
    }
  });

  it("counts the progress lines and names the cause", () => {
    expect(countHermesCompactionSpinnerLines(OBSERVED_SPINNER_RESULT)).toBe(4);
    expect(countHermesCompactionSpinnerLines("")).toBe(0);
    const message = describeHermesCompactionStall({
      spinnerLines: 4,
      signal: "SIGINT",
      timeoutSec: 600,
    });
    expect(message).toContain("compaction");
    expect(message).toContain("600s");
    expect(message).toContain("SIGINT");
    expect(message).not.toBe("Timed out");
  });

  it("keeps a distinct error code", () => {
    expect(HERMES_COMPACTION_STALL_ERROR_CODE).toBe("compaction_stall");
    expect(HERMES_COMPACTION_STALL_ERROR_CODE).not.toBe("timeout");
    expect(HERMES_COMPACTION_STALL_ERROR_CODE).not.toBe("adapter_failed");
  });

  it("replays real production payloads: 61/61 stalls caught, no false positives", async () => {
    const raw = await fs.readFile(FIXTURE_URL, "utf8");
    const payloads: Payload[] = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Payload);

    const byLabel = (label: string) => payloads.filter((p) => p.label === label);
    const stalls = byLabel("stall");
    const nonStallTimeouts = byLabel("hermes_timeout_nostall");
    const successes = byLabel("hermes_success");
    const gatewayTimeouts = byLabel("gateway_timeout");

    expect(payloads.length).toBe(992);
    expect(stalls.length).toBe(61);
    expect(nonStallTimeouts.length).toBe(18);
    expect(successes.length).toBe(599);
    expect(gatewayTimeouts.length).toBe(314);

    // Every run that stalled in compaction is detected.
    const missed = stalls.filter((p) => !isHermesCompactionStall(p.result));
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

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-stall-"));
    command = path.join(dir, "hermes.cjs");
    // A child that prints the compaction progress line forever and never
    // exits, so only the adapter's timeout can stop it — the production
    // signature. The progress lines come before `session_id:` because that
    // is the order the real child uses, and the parser only builds the
    // response from the text ahead of the `session_id:` line.
    await fs.writeFile(
      command,
      `#!${process.execPath}
const spin = setInterval(() => {
  process.stdout.write("⟳ compacting context…\\n");
}, 20);
process.on("SIGINT", () => {
  clearInterval(spin);
  process.stdout.write("session_id: ${STALLED_SESSION}\\n");
  process.exit(130);
});
`,
      "utf8",
    );
    await fs.chmod(command, 0o755);
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

  it("reports the cause and drops the wedged session", async () => {
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
});
