import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isHermesCompactionStall } from "../adapters/hermes-session-id.js";

/**
 * RUAAAAA-5339 production replay.
 *
 * The fixture is a 48h sample of the result payloads of 997 real runs out of
 * the production database (2026-10-23). It is a SAMPLE, not a census: it
 * carries no run ids and its counts do not correspond to any single time
 * window. The authoritative figure is the census over the full
 * heartbeat_runs history, which is recorded on the issue: 501 of 936
 * hermes_local timeouts are compaction stalls, plus 5 more filed as
 * failed/adapter_failed with exit code 130, with 0 false positives across
 * 10,430 hermes successes and 80,232 openclaw_gateway runs.
 *
 * This fixture exists so the detector's precision is pinned by a test rather
 * than by a one-off measurement.
 */
type Payload = { label: string; status: string; result: string | null };

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "ruaaaaa-5339-run-payloads.jsonl",
);

const payloads: Payload[] = fs
  .readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Payload);

describe("RUAAAAA-5339 detector replayed against production payloads", () => {
  it("loaded the replay corpus", () => {
    expect(payloads.length).toBe(997);
  });

  it("fires on every run that stalled in compaction", () => {
    const stalled = payloads.filter((p) => p.label === "stall");
    const exit130 = payloads.filter((p) => p.label === "hermes_failed_exit130_stall");
    expect(stalled.length).toBe(61);
    expect(exit130.length).toBe(5);
    const missed = [...stalled, ...exit130].filter((p) => !isHermesCompactionStall(p.result));
    expect(missed.map((p) => p.result)).toEqual([]);
  });

  it("stays quiet on hermes timeouts that did not stall", () => {
    const others = payloads.filter((p) => p.label === "hermes_timeout_nostall");
    expect(others.length).toBe(18);
    const fired = others.filter((p) => isHermesCompactionStall(p.result));
    expect(fired.map((p) => p.result)).toEqual([]);
  });

  it("stays quiet on every successful hermes run", () => {
    const ok = payloads.filter((p) => p.label === "hermes_success");
    expect(ok.length).toBe(599);
    const fired = ok.filter((p) => isHermesCompactionStall(p.result));
    expect(fired.map((p) => p.result)).toEqual([]);
  });

  it("stays quiet on gateway timeouts", () => {
    const gw = payloads.filter((p) => p.label === "gateway_timeout");
    expect(gw.length).toBe(314);
    const fired = gw.filter((p) => isHermesCompactionStall(p.result));
    expect(fired.map((p) => p.result)).toEqual([]);
  });
});
