/**
 * RUAAAAA-5339: detection for the Hermes context-compaction stall.
 *
 * Hermes' own context compaction stalls on some sessions. It never returns:
 * it reprints its progress line until the child is killed (SIGINT, exit 130)
 * or the adapter's timeoutSec kills it (SIGTERM then SIGKILL). The run
 * spends its entire budget without executing a single turn, and
 * parseHermesOutput scrapes the progress line as the response - so the run's
 * resultJson.result is nothing but the compaction spinner.
 *
 * The session is persisted anyway, so every later dispatch resumes the same
 * wedged session and fails identically. That is how an agent ends up with
 * zero successful runs for 20-50h while still dispatching every few hours.
 *
 * Measured on production against the full heartbeat_runs history: 501 of 936
 * hermes_local timeouts showed this signature, plus 6 more filed as
 * failed/adapter_failed with exit code 130; 0 of 10,429 hermes_local
 * successes and 0 of 80,222 openclaw_gateway runs matched.
 */

/**
 * The progress line Hermes prints while compacting. The decoration and
 * punctuation vary between Hermes versions, so match on the stable words and
 * allow any non-alphanumeric decoration around them. Requiring the line to
 * carry no alphanumeric characters after "context" keeps real prose from
 * matching.
 */
const COMPACTION_SPINNER_LINE = /^[^A-Za-z0-9]*compacting\s+context[^A-Za-z0-9]*$/i;

/** Distinct run error code so a compaction stall is not scored as a plain timeout. */
export const HERMES_COMPACTION_STALL_ERROR_CODE = "compaction_stall";

/**
 * True when the text contains nothing but Hermes' compaction progress line.
 *
 * A run that produced a real answer alongside the spinner is a normal slow
 * run and must not be classified as a stall, so every non-blank line has to
 * match. This strictness is what makes the detector safe to arm on every
 * non-success exit rather than only on wall-clock timeouts.
 */
export function isHermesCompactionStall(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => COMPACTION_SPINNER_LINE.test(line));
}

/**
 * Count the progress lines in a stalled run's output, for the error message.
 */
export function countHermesCompactionSpinnerLines(text: string | null | undefined): number {
  if (typeof text !== "string") return 0;
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

/**
 * True when the run did not produce a usable result.
 *
 * A compaction stall is only a stall if the run also failed. Paperclip sets
 * timedOut only when its own wall-clock timer fires, so a child that dies on
 * its own is not covered by that flag. Two shapes were observed on
 * production: the Hermes CLI catches SIGINT and exits 130 (exit code 130, no
 * signal), and a child killed outright by a signal reports no exit code at
 * all (exit code null, signal set). The server files both as
 * failed/adapter_failed rather than timed_out, and the server's own
 * "succeeded" test requires both a zero exit code and no signal, so this
 * mirrors that rule exactly.
 */
export function isHermesNonSuccessExit(input: {
  timedOut?: boolean;
  exitCode?: number | null;
  signal?: string | null;
}): boolean {
  if (input.timedOut) return true;
  if (typeof input.exitCode === "number") return input.exitCode !== 0;
  // Killed by a signal: it never produced an exit code, so it never
  // succeeded either.
  return typeof input.signal === "string" && input.signal.length > 0;
}

export type HermesCompactionStallDescription = {
  /** Number of compaction progress lines the run printed. */
  spinnerLines: number;
  /** The signal that killed the child, when the runtime reported one. */
  signal?: string | null;
  /** The configured run budget in seconds. */
  timeoutSec?: number | null;
  /** The child's exit code, when it exited on its own. */
  exitCode?: number | null;
  /** Any genuine error the adapter parsed out of stderr, preserved. */
  detail?: string | null;
};

/**
 * Build the error message for a stalled run.
 *
 * The bare "Timed out" the server falls back to names neither the cause nor
 * the budget. This names both, records how the child ended, and says what
 * happens next (the wedged session is dropped so the next dispatch starts
 * clean).
 */
export function describeHermesCompactionStall(input: HermesCompactionStallDescription): string {
  const parts: string[] = [];
  if (typeof input.timeoutSec === "number" && input.timeoutSec > 0) {
    parts.push("run budget " + input.timeoutSec + "s");
  }
  if (typeof input.exitCode === "number") {
    parts.push("exit " + input.exitCode);
  }
  if (input.signal) {
    parts.push("signal " + input.signal);
  }
  const how = parts.length > 0 ? " (" + parts.join(", ") + ")" : "";
  const detail =
    typeof input.detail === "string" && input.detail.trim().length > 0
      ? " Adapter also reported: " + input.detail.trim().slice(0, 400)
      : "";
  return (
    "Hermes stalled in context compaction for the whole run" +
    how +
    " - " +
    input.spinnerLines +
    " progress lines, no assistant output. " +
    "The wedged session was dropped so the next dispatch starts fresh. " +
    "See RUAAAAA-5339." +
    detail
  );
}
