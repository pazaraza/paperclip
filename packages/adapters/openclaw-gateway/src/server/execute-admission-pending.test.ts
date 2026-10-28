import { describe, expect, it } from "vitest";
import {
  buildGatewayAdmissionPendingError,
  detectGatewayAdmissionPending,
} from "./execute.js";

const REFUSAL =
  "Agent ruai-odoo-accounting-specialist has not completed startup inspection and preparation. " +
  "Inspection and writable admission continue after the Gateway listener binds.";

describe("detectGatewayAdmissionPending (RUAAAAA-5548)", () => {
  it("classifies the gateway startup-inspection refusal as an admission state", () => {
    expect(detectGatewayAdmissionPending(REFUSAL)).toBe("startup_inspection_pending");
  });

  it("classifies the refusal for any seat, including other companies", () => {
    expect(
      detectGatewayAdmissionPending(
        "Agent capital-partnerships has not completed startup inspection and preparation. " +
          "Inspection and writable admission continue after the Gateway listener binds.",
      ),
    ).toBe("startup_inspection_pending");
  });

  it("does not classify provider, quota, cooldown or agent faults as an admission state", () => {
    expect(
      detectGatewayAdmissionPending(
        'OpenClaw gateway run in cooldown: Provider "minimax-portal" reason=provider_cooldown',
      ),
    ).toBeNull();
    expect(
      detectGatewayAdmissionPending(
        "Token Plan usage limit reached: Upgrade your Token Plan. (2056) | 429",
      ),
    ).toBeNull();
    expect(detectGatewayAdmissionPending("OpenClaw gateway run failed")).toBeNull();
    expect(detectGatewayAdmissionPending("")).toBeNull();
  });

  it("does not swallow transport failures, which have their own classifier", () => {
    expect(detectGatewayAdmissionPending("connect ECONNREFUSED 127.0.0.1:18789")).toBeNull();
    expect(detectGatewayAdmissionPending("read ECONNRESET")).toBeNull();
  });
});

describe("buildGatewayAdmissionPendingError (RUAAAAA-5548)", () => {
  const endpoint = "ws://127.0.0.1:18789/";

  it("REGRESSION: the refusal must be retryable, not a terminal agent fault", () => {
    // Before RUAAAAA-5548 this refusal fell through to the catch block's terminal
    // `openclaw_gateway_request_failed`, which carries no errorFamily, so Paperclip never
    // rescheduled the run and the seat stayed broken until the next gateway restart.
    const contract = buildGatewayAdmissionPendingError({
      message: REFUSAL,
      endpoint,
      retryDelayMs: 30_000,
      now: new Date("2026-10-27T11:53:09.132Z"),
    });
    expect(contract).not.toBeNull();
    expect(contract?.errorCode).toBe("openclaw_gateway_admission_pending");
    expect(contract?.errorFamily).toBe("transient_upstream");
    expect(contract?.errorMeta).toEqual({
      reason: "startup_inspection_pending",
      endpoint,
    });
  });

  it("reports a retry floor that honours the per-seat delay", () => {
    const contract = buildGatewayAdmissionPendingError({
      message: REFUSAL,
      endpoint,
      retryDelayMs: 45_000,
      now: new Date("2026-10-27T11:53:09.132Z"),
    });
    expect(contract?.retryNotBefore).toBe("2026-10-27T11:53:54.132Z");
  });

  it("clamps a nonsense per-seat delay to the 1s floor", () => {
    const contract = buildGatewayAdmissionPendingError({
      message: REFUSAL,
      endpoint,
      retryDelayMs: -5,
      now: new Date("2026-10-27T11:53:09.132Z"),
    });
    expect(contract?.retryNotBefore).toBe("2026-10-27T11:53:10.132Z");
  });

  it("says the refusal is a gateway-side admission state, not an agent fault", () => {
    const contract = buildGatewayAdmissionPendingError({
      message: REFUSAL,
      endpoint,
      retryDelayMs: 30_000,
    });
    expect(contract?.errorMessage).toContain("admission still pending");
    expect(contract?.errorMessage).toContain("not a provider or agent fault");
  });

  it("returns null for every other failure so the terminal branch is untouched", () => {
    expect(
      buildGatewayAdmissionPendingError({
        message: "connect ECONNREFUSED 127.0.0.1:18789",
        endpoint,
        retryDelayMs: 30_000,
      }),
    ).toBeNull();
    expect(
      buildGatewayAdmissionPendingError({
        message: "OpenClaw gateway run failed",
        endpoint,
        retryDelayMs: 30_000,
      }),
    ).toBeNull();
  });
});
