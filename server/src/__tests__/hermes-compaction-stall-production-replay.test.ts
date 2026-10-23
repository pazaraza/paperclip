import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { isHermesCompactionStall } from "../adapters/hermes-session-id.js";

/**
 * RUAAAAA-5339 production replay.
 *
 * The synthetic tests prove the shape. This replays the actual
 * `result_json.result` payloads of 992 real runs out of the production
 * database (2026-10-23) and asserts the detector fires on exactly the runs
 * that stalled in compaction and on nothing else.
 */
type Payload = { label: string; status: string; result: string | null };

const payloads: Payload[] = fs
  .readFileSync("/tmp/ru5339/payloads.jsonl", "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Payload);

describe("RUAAAAA-5339 detector replayed against production payloads", () => {
  it("loaded the replay corpus", () => {
    expect(payloads.length).toBeGreaterThan(900);
  });

  it("fires on every run that stalled in compaction", () => {
    const stalled = payloads.filter((p) => p.label === "stall");
    expect(stalled.length).toBeGreaterThan(50);
    const missed = stalled.filter((p) => !isHermesCompactionStall(p.result));
    expect(missed.map((p) => p.result)).toEqual([]);
  });

  it("stays quiet on hermes timeouts that did not stall", () => {
    const others = payloads.filter((p) => p.label === "hermes_timeout_nostall");
    expect(others.length).toBeGreaterThan(10);
    const fired = others.filter((p) => isHermesCompactionStall(p.result));
    expect(fired.map((p) => p.result)).toEqual([]);
  });

  it("stays quiet on every successful hermes run", () => {
    const ok = payloads.filter((p) => p.label === "hermes_success");
    expect(ok.length).toBeGreaterThan(500);
    const fired = ok.filter((p) => isHermesCompactionStall(p.result));
    expect(fired.map((p) => p.result)).toEqual([]);
  });

  it("stays quiet on gateway timeouts", () => {
    const gw = payloads.filter((p) => p.label === "gateway_timeout");
    expect(gw.length).toBeGreaterThan(300);
    const fired = gw.filter((p) => isHermesCompactionStall(p.result));
    expect(fired.map((p) => p.result)).toEqual([]);
  });

  it("reports the detection rate", () => {
    const counts = {
      stall: payloads.filter((p) => p.label === "stall" && isHermesCompactionStall(p.result)).length,
      nostall: payloads.filter((p) => p.label === "hermes_timeout_nostall" && isHermesCompactionStall(p.result)).length,
      success: payloads.filter((p) => p.label === "hermes_success" && isHermesCompactionStall(p.result)).length,
      gateway: payloads.filter((p) => p.label === "gateway_timeout" && isHermesCompactionStall(p.result)).length,
    };
    console.log("RUAAAAA-5339 replay detection:", JSON.stringify(counts));
    expect(counts.stall).toBe(61);
    expect(counts.nostall + counts.success + counts.gateway).toBe(0);
  });
});