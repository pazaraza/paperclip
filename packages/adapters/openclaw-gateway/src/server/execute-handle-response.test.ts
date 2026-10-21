import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket as WebSocketConnection } from "ws";
import { GatewayWsClient } from "./execute.js";

/**
 * RUAAAAA-5209 — `handleMessage` must promote the postgres
 * (SQLSTATE, constraint) pair out of a gateway JSON-RPC error frame's
 * `details` onto the thrown `GatewayResponseError` as `postgresCode` +
 * `postgresConstraint`. Without that, `isRoutineExecutionOpenConflict`
 * (server/src/services/issue-assignment-wakeup.ts) cannot see the constraint
 * through the OpenClaw gateway and the wake falls back to 'generic wake
 * error', pinning the agent to status='error' for the wrong reason.
 *
 * These tests drive the real parse path: a stub `ws` server performs the
 * connect.challenge handshake, then answers a follow-up request with an
 * error frame built from a fixture. Pattern mirrors
 * server/src/__tests__/heartbeat-comment-wake-batching.test.ts.
 */

type ReqFrame = { type: "req"; id: string; method: string; params?: unknown };

type StubGateway = {
  url: string;
  close: () => Promise<void>;
};

/**
 * Starts a stub gateway that completes the challenge handshake and then
 * replies to every non-`connect` request with the frame produced by
 * `replyFor`.
 */
async function startStubGateway(
  replyFor: (frame: ReqFrame) => unknown,
): Promise<StubGateway> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  wss.on("connection", (socket: WebSocketConnection) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "stub-nonce" },
      }),
    );

    socket.on("message", (data) => {
      let frame: ReqFrame;
      try {
        frame = JSON.parse(String(data)) as ReqFrame;
      } catch {
        return;
      }
      if (frame?.type !== "req" || typeof frame.id !== "string") return;

      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }),
        );
        return;
      }

      socket.send(JSON.stringify(replyFor(frame)));
    });
  });

  const address = wss.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

const openStubs: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (openStubs.length > 0) {
    const close = openStubs.pop();
    await close?.();
  }
});

function newClient(url: string): GatewayWsClient {
  return new GatewayWsClient({
    url,
    headers: {},
    onEvent: () => {},
    onLog: async () => {},
  });
}

/** Runs one round-trip and returns the rejection as a typed record. */
async function rejectFromStub(
  errorFrame: { code?: unknown; message?: unknown; details?: unknown },
): Promise<Record<string, unknown> & Error> {
  const stub = await startStubGateway((frame) => ({
    type: "res",
    id: frame.id,
    ok: false,
    error: errorFrame,
  }));
  openStubs.push(stub.close);

  const client = newClient(stub.url);
  await client.connect(() => ({ nonce: "stub-nonce" }), 5_000);

  let caught: unknown = null;
  try {
    await client.request("issues.update", {}, { timeoutMs: 5_000 });
  } catch (err) {
    caught = err;
  }
  if (!caught) throw new Error("expected the gateway request to reject");
  return caught as Record<string, unknown> & Error;
}

describe("GatewayWsClient.handleMessage postgres surfacing (RUAAAAA-5209)", () => {
  it("promotes 23505 + constraint out of details onto the thrown error", async () => {
    const err = await rejectFromStub({
      code: "unique_violation",
      message: "duplicate key value violates unique constraint",
      details: {
        code: "23505",
        constraint: "issues_open_routine_execution_uq",
      },
    });

    expect(err.postgresCode).toBe("23505");
    expect(err.postgresConstraint).toBe("issues_open_routine_execution_uq");
    // Pre-existing surface must be preserved.
    expect(err.gatewayCode).toBe("unique_violation");
    expect(err.gatewayDetails).toEqual({
      code: "23505",
      constraint: "issues_open_routine_execution_uq",
    });
  });

  it("promotes the pair when the postgres error is nested one level deep", async () => {
    const err = await rejectFromStub({
      message: "assignment wake failed",
      details: {
        pgError: {
          code: "23505",
          constraint: "issues_open_routine_execution_uq",
          detail: "Key (company_id, origin_kind, origin_id)=(...) already exists.",
        },
      },
    });

    expect(err.postgresCode).toBe("23505");
    expect(err.postgresConstraint).toBe("issues_open_routine_execution_uq");
  });

  it("surfaces any 23505+constraint pair and leaves bare SQLSTATE unset", async () => {
    const noDetails = await rejectFromStub({
      code: "internal_error",
      message: "boom",
    });
    expect(noDetails.postgresCode).toBeUndefined();
    expect(noDetails.postgresConstraint).toBeUndefined();

    // Any 23505 + constraint pair is promoted, not just the routine-execution
    // one: the adapter has no business knowing which constraint the server
    // treats as contention. Narrowing is
    // isRoutineExecutionOpenConflict's job (RUAAAAA-5209 step 2), which
    // matches on the constraint NAME — so an unrelated unique violation is
    // surfaced faithfully and still not mistaken for contention.
    const otherConstraint = await rejectFromStub({
      message: "duplicate",
      details: { code: "23505", constraint: "agents_company_id_name_key" },
    });
    expect(otherConstraint.postgresCode).toBe("23505");
    expect(otherConstraint.postgresConstraint).toBe("agents_company_id_name_key");

    // A SQLSTATE with no constraint name is not actionable — nothing is set,
    // so the server predicate cannot fire on a half-populated pair.
    const codeWithoutConstraint = await rejectFromStub({
      message: "duplicate",
      details: { code: "23505" },
    });
    expect(codeWithoutConstraint.postgresCode).toBeUndefined();
    expect(codeWithoutConstraint.postgresConstraint).toBeUndefined();
  });
});