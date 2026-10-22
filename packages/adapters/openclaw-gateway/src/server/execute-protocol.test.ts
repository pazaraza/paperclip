import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  GatewayWsClient,
  describeProtocolMismatch,
  detectProtocolMismatch,
  gatewayProtocolRange,
} from "./execute.js";

/**
 * Fake gateway that admits a connect frame with the gateway's real rule:
 *
 *   supportsCurrentProtocol = maxProtocol >= CURRENT && minProtocol <= CURRENT
 *
 * That overlap rule is the whole point. `min === max` is the only shape that
 * cannot survive a bump of CURRENT, which is exactly what stranded the fleet on
 * 2026-10-17. These tests speak a real connect frame over a real socket so a
 * protocol bump on the gateway side fails CI instead of failing every agent at
 * runtime.
 */
type FakeGateway = {
  url: string;
  protocol: number;
  admitted: Array<{ minProtocol: unknown; maxProtocol: unknown }>;
  close: () => Promise<void>;
};

const servers: FakeGateway[] = [];

async function startFakeGateway(currentProtocol: number): Promise<FakeGateway> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const admitted: Array<{ minProtocol: unknown; maxProtocol: unknown }> = [];
  const protocol = currentProtocol;

  wss.on("connection", (socket: WebSocket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: randomUUID() },
      }),
    );

    socket.on("message", (raw: Buffer) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.method !== "connect") return;
      const params = (frame.params ?? {}) as Record<string, unknown>;
      const min = params.minProtocol;
      const max = params.maxProtocol;

      if (typeof min !== "number" || typeof max !== "number" || max < protocol || min > protocol) {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              message: "protocol mismatch",
              details: {
                code: "protocol_mismatch",
                clientMinProtocol: min ?? null,
                clientMaxProtocol: max ?? null,
                expectedProtocol: protocol,
                minimumProbeProtocol: 3,
              },
            },
          }),
        );
        socket.close(1002, "protocol mismatch");
        return;
      }

      admitted.push({ minProtocol: min, maxProtocol: max });
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { type: "hello-ok", protocol, server: { version: "fake" } },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (typeof address === "string" || address === null) throw new Error("fake gateway has no port");

  const gateway: FakeGateway = {
    url: `ws://127.0.0.1:${address.port}`,
    protocol,
    admitted,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => resolve());
      }),
  };
  servers.push(gateway);
  return gateway;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

function connectFrame(overrides: { minProtocol: number; maxProtocol: number }) {
  return () => ({
    ...overrides,
    client: {
      id: "gateway-client",
      version: "paperclip-test",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.admin"],
  });
}

async function handshake(gateway: FakeGateway, range: { minProtocol: number; maxProtocol: number }) {
  const client = new GatewayWsClient({
    url: gateway.url,
    headers: {},
    onEvent: () => {},
    onLog: async () => {},
  });
  try {
    return await client.connect(connectFrame(range), 5000);
  } finally {
    client.close();
  }
}

describe("gateway protocol range (RUAAAAA-5246)", () => {
  it("declares a range rather than an equality", () => {
    const range = gatewayProtocolRange();
    expect(range.minProtocol).toBeLessThan(range.maxProtocol);
  });

  // The regression this issue exists for: pinned min===max===4 vs a gateway that
  // moved to protocol 5.
  it("is admitted by a gateway one protocol ahead (the 2026-10-17 recurrence)", async () => {
    const gateway = await startFakeGateway(5);
    const hello = await handshake(gateway, gatewayProtocolRange());
    expect((hello as Record<string, unknown>).protocol).toBe(5);
    expect(gateway.admitted).toHaveLength(1);
  });

  it("is admitted by a gateway several protocols ahead", async () => {
    const gateway = await startFakeGateway(8);
    const hello = await handshake(gateway, gatewayProtocolRange());
    expect((hello as Record<string, unknown>).protocol).toBe(8);
  });

  it("is admitted by a gateway on the oldest protocol the adapter speaks", async () => {
    const gateway = await startFakeGateway(3);
    const hello = await handshake(gateway, gatewayProtocolRange());
    expect((hello as Record<string, unknown>).protocol).toBe(3);
  });

  it("still rejects a gateway past the declared maximum", async () => {
    const gateway = await startFakeGateway(9);
    await expect(handshake(gateway, gatewayProtocolRange())).rejects.toThrow(/protocol mismatch/i);
    expect(gateway.admitted).toHaveLength(0);
  });

  it("pins would have been rejected by the same gateway", async () => {
    // Documents the failure the range prevents, so reverting to a pin fails
    // this file rather than production.
    const gateway = await startFakeGateway(4);
    await expect(handshake(gateway, { minProtocol: 3, maxProtocol: 3 })).rejects.toThrow(
      /protocol mismatch/i,
    );
    expect(gateway.admitted).toHaveLength(0);
  });
});

describe("detectProtocolMismatch (RUAAAAA-5246)", () => {
  it("recognises the gateway INVALID_REQUEST details payload", () => {
    expect(
      detectProtocolMismatch({
        message: "protocol mismatch",
        details: {
          code: "protocol_mismatch",
          clientMinProtocol: 3,
          clientMaxProtocol: 3,
          expectedProtocol: 4,
          minimumProbeProtocol: 3,
        },
      }),
    ).toEqual({ expectedProtocol: 4, clientMinProtocol: 3, clientMaxProtocol: 3 });
  });

  it("recognises the bare 1002 close text when the response never arrived", () => {
    expect(detectProtocolMismatch({ message: "gateway closed (1002): protocol mismatch" })).toEqual({
      expectedProtocol: null,
      clientMinProtocol: null,
      clientMaxProtocol: null,
    });
  });

  it("returns null for an unrelated failure", () => {
    expect(
      detectProtocolMismatch({
        message: "gateway request timeout (agent)",
        details: { code: "TIMEOUT" },
      }),
    ).toBeNull();
    expect(detectProtocolMismatch({ message: null })).toBeNull();
    expect(detectProtocolMismatch({})).toBeNull();
  });

  it("reports nulls rather than NaN when the gateway sends no details", () => {
    const signal = detectProtocolMismatch({ message: "protocol mismatch", details: { code: 7 } });
    expect(signal?.expectedProtocol).toBeNull();
    expect(signal?.clientMinProtocol).toBeNull();
  });
});

describe("describeProtocolMismatch (RUAAAAA-5246)", () => {
  it("names both sides and rules out the timeout fix", () => {
    const text = describeProtocolMismatch({
      expectedProtocol: 5,
      clientMinProtocol: 3,
      clientMaxProtocol: 3,
    });
    expect(text).toContain("protocol 5");
    expect(text).toContain("3-3");
    expect(text).toContain("waitTimeoutMs");
  });

  it("degrades to 'unknown'/'?' rather than printing NaN", () => {
    const text = describeProtocolMismatch({
      expectedProtocol: null,
      clientMinProtocol: null,
      clientMaxProtocol: null,
    });
    expect(text).toContain("unknown");
    expect(text).not.toContain("NaN");
    expect(describeProtocolMismatch(null)).toBe("");
  });
});
