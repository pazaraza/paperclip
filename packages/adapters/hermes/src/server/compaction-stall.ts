/**
 * RUAAAAA-5339: detection for the Hermes context-compaction stall.
 *
 * Hermes' own context compaction stalls on some sessions. It never returns:
 * it reprints its progress line until the adapter's `timeoutSec` kills the
 * child (SIGINT, exit 130). The run spends its entire budget without
 * executing a single turn, and `parseHermesOutput` scrapes the progress
 * line as the response — so the run's `resultJson.result` is nothing but
 * `⟳ compacting context…`.
 *
 * The session is persisted anyway, so every later dispatch resumes the same
 * wedged session and fails identically. That is how an agent ends up with
 * zero successful runs for 20-50h while still dispatching every few hours.
 *
 * Measured on production on 2026-10-23: 61 of 79 `hermes_local` timeouts
 * showed this signature across 15 agents; 0 of 314 `openclaw_gateway`
 * timeouts did, so it is specific to the Hermes adapter.
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
 * True when `text` contains nothing but Hermes' compaction progress line.
 *
 * A run that produced a real answer alongside the spinner is a normal slow
 * run and must not be classified as a stall, so every non-blank line has to
 * match.
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
 * Build the error message for a stalled run.
 *
 * The bare `"Timed out"` the server falls back to names neither the cause
 * nor the budget. This names both, and says what happens next (the wedged
 * session is dropped so the next dispatch starts clean).
 */
export function describeHermesCompactionStall(input: {
  spinnerLines: number;
  signal?: string | null;
  timeoutSec?: number | null;
}): string {
  const signal = input.signal ? `, signal ${input.signal}` : "";
  const budget = input.timeoutSec ? ` (budget ${input.timeoutSec}s)` : "";
  return (
    `Hermes stalled in context compaction for the whole run budget${budget}` +
    ` — ${input.spinnerLines} progress lines, no assistant output${signal}. ` +
    `The wedged session was dropped so the next dispatch starts fresh. ` +
    `See RUAAAAA-5339.`
  );
}
