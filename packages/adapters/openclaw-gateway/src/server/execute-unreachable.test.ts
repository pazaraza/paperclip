import { describe, expect, it } from "vitest";
import { detectGatewayConnectionClosed, detectGatewayUnreachable } from "./execute.js";

describe("detectGatewayUnreachable (RUAAAAA-5520)", () => {
  it("classifies a refused gateway connection as the gateway being down", () => {
    expect(detectGatewayUnreachable("connect ECONNREFUSED 127.0.0.1:18789")).toBe("connect_refused");
    expect(detectGatewayUnreachable("connect ECONNREFUSED ::1:18789")).toBe("connect_refused");
  });

  it("classifies other transport-level failures", () => {
    expect(detectGatewayUnreachable("read ECONNRESET")).toBe("connection_reset");
    expect(detectGatewayUnreachable("write EPIPE")).toBe("pipe_closed");
    expect(detectGatewayUnreachable("connect EHOSTUNREACH 10.0.0.5:18789")).toBe("host_unreachable");
    expect(detectGatewayUnreachable("connect ENETUNREACH 10.0.0.5:18789")).toBe("network_unreachable");
    expect(detectGatewayUnreachable("socket hang up")).toBe("socket_hang_up");
  });

  it("does not classify provider, quota or agent faults as a gateway outage", () => {
    expect(
      detectGatewayUnreachable(
        'OpenClaw gateway run in cooldown: Provider "minimax-portal" reason=provider_cooldown',
      ),
    ).toBeNull();
    expect(
      detectGatewayUnreachable("Token Plan usage limit reached: Upgrade your Token Plan. (2056) | 429"),
    ).toBeNull();
    expect(detectGatewayUnreachable("OpenClaw gateway agent request failed")).toBeNull();
    expect(detectGatewayUnreachable("")).toBeNull();
  });
});

describe("detectGatewayConnectionClosed (RUAAAAA-5520)", () => {
  it("classifies an abnormal websocket close as the gateway going away mid-run", () => {
    expect(detectGatewayConnectionClosed("gateway closed (1006):")).toBe("connection_closed");
  });

  it("still classifies transport errors seen on the wait path", () => {
    expect(detectGatewayConnectionClosed("read ECONNRESET")).toBe("connection_reset");
  });

  it("does not classify an ordinary wait failure as a gateway outage", () => {
    expect(detectGatewayConnectionClosed("OpenClaw gateway run failed")).toBeNull();
    expect(detectGatewayConnectionClosed("")).toBeNull();
  });
});
