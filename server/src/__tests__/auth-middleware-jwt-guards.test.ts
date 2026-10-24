import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

/**
 * Helper: builds a fake db. actorMiddleware issues 3 db.select() calls in order:
 *   1. boardAuth.findBoardApiKeyByToken(token) → boardApiKeys table (pass empty)
 *   2. db.select(...).from(agentApiKeys)        → API-key table
 *   3. db.select(...).from(agents)              → agents table (only if API-key lookup returned null and JWT verification failed)
 *
 * Pass apiKeyRows = what the API-key lookup should return (use [] for "no agent_api_key row").
 * Pass agentRows  = what the agents table should return.
 */
function createDbWithRows(apiKeyRows: unknown[], agentRows: unknown[]) {
  const select = vi.fn();
  // 1st call: boardApiKeys lookup → always empty (board keys are out of scope here)
  select.mockImplementationOnce(() => ({
    from() {
      return {
        where() {
          return Promise.resolve([]);
        },
      };
    },
  }));
  // 2nd call: agentApiKeys lookup
  select.mockImplementationOnce(() => ({
    from() {
      return {
        where() {
          return Promise.resolve(apiKeyRows);
        },
      };
    },
  }));
  // 3rd call: agents lookup
  select.mockImplementationOnce(() => ({
    from() {
      return {
        where() {
          return Promise.resolve(agentRows);
        },
      };
    },
  }));
  return { select } as any;
}

function buildApp(db: any) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

const AGENT_ID = "00000000-0000-0000-0000-000000000abc";
const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";

describe("actorMiddleware JWT-path structured 401 responses (RUAAAAA-2378)", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const originalSecret = process.env[secretEnv];

  beforeEach(() => {
    process.env[secretEnv] = "test-secret-2378";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalSecret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalSecret;
  });

  it("returns 401 with guard=signature when the JWT has a bad signature", async () => {
    const db = createDbWithRows([], []); // no API key row, no agent row
    const app = buildApp(db);
    // Real token from createLocalAgentJwt (signed correctly), then mangle the signature segment.
    const goodToken = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", RUN_ID)!;
    const parts = goodToken.split(".");
    const tampered = `${parts[0]}.${parts[1]}.AAAAAAAAAAAA`;

    const res = await request(app)
      .get("/actor")
      .set("Authorization", `Bearer ${tampered}`);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: "Unauthorized",
      guard: "signature",
    });
    // Signature failure: claims never decoded, so no runId should leak out.
    expect(res.body.runId).toBeUndefined();
  });

  it("returns 401 with guard=signature when the token is not even JWT-shaped", async () => {
    const db = createDbWithRows([], []);
    const app = buildApp(db);
    const res = await request(app)
      .get("/actor")
      .set("Authorization", "Bearer not.a.real.jwt");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Unauthorized", guard: "signature" });
  });

  it("returns 401 with guard=agent_lookup when the JWT points at a non-existent agent", async () => {
    const db = createDbWithRows([], []); // no API key row, no agent row
    const app = buildApp(db);
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", RUN_ID)!;

    const res = await request(app)
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: "Unauthorized",
      guard: "agent_lookup",
      runId: RUN_ID,
    });
  });

  it("returns 401 with guard=company_mismatch when the JWT's company_id does not match the agent", async () => {
    const agentRow = {
      id: AGENT_ID,
      companyId: "different-company-id",
      status: "idle",
    };
    const db = createDbWithRows([], [agentRow]);
    const app = buildApp(db);
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", RUN_ID)!;

    const res = await request(app)
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: "Unauthorized",
      guard: "company_mismatch",
      runId: RUN_ID,
    });
  });

  it("returns 401 with guard=status_inactive when the agent is terminated", async () => {
    const agentRow = {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      status: "terminated",
    };
    const db = createDbWithRows([], [agentRow]);
    const app = buildApp(db);
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", RUN_ID)!;

    const res = await request(app)
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: "Unauthorized",
      guard: "status_inactive",
      runId: RUN_ID,
    });
  });

  it("returns 401 with guard=status_inactive when the agent is pending_approval", async () => {
    const agentRow = {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      status: "pending_approval",
    };
    const db = createDbWithRows([], [agentRow]);
    const app = buildApp(db);
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", RUN_ID)!;

    const res = await request(app)
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: "Unauthorized",
      guard: "status_inactive",
      runId: RUN_ID,
    });
  });

  it("does NOT short-circuit on a valid JWT (happy path: agent_jwt actor set, 200)", async () => {
    const agentRow = {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      status: "idle",
    };
    const db = createDbWithRows([], [agentRow]);
    const app = buildApp(db);
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "claude_local", RUN_ID)!;

    const res = await request(app)
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      source: "agent_jwt",
      runId: RUN_ID,
    });
  });

  it("API-key auth path is unchanged: 200 with actor set when the key row + active agent match", async () => {
    // We only need the first select() (agentApiKeys) to resolve to a key row, and the second
    // (agents) to resolve to an active agent. The auth middleware does not validate the token
    // contents — it just hashes and looks up by hash.
    const apiKeyRow = {
      id: "key-1",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      revokedAt: null,
    };
    const agentRow = {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      status: "idle",
    };
    const db = createDbWithRows([apiKeyRow], [agentRow]);
    const dbWithUpdate = {
      ...db,
      update: vi.fn(() => ({
        set() {
          return {
            where() {
              return Promise.resolve();
            },
          };
        },
      })),
    };
    const app = buildApp(dbWithUpdate);
    const res = await request(app)
      .get("/actor")
      .set("Authorization", "Bearer pcp_some_agent_api_key");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      source: "agent_key",
    });
  });

  it("API-key auth path is unchanged: agent_api_key path falls through when agent record is terminated (actor stays none, NOT a JWT-guard 401)", async () => {
    const apiKeyRow = {
      id: "key-1",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      revokedAt: null,
    };
    const agentRow = {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      status: "terminated",
    };
    const db = createDbWithRows([apiKeyRow], [agentRow]);
    // The test db has no .update() chain. The middleware hits it for `lastUsedAt`.
    // Add a stub so the call resolves cleanly.
    (db as any).update = vi.fn(() => ({
      set() {
        return {
          where() {
            return Promise.resolve();
          },
        };
      },
    }));
    const app = buildApp(db);
    // Custom error handler to surface any unexpected error in this regression test
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({ error: err?.message ?? "Internal", stack: err?.stack });
    });
    const res = await request(app)
      .get("/actor")
      .set("Authorization", "Bearer pcp_some_agent_api_key");

    // The API-key branch must remain silently fall-through; the structured 401 is JWT-only.
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("none");
    expect(res.body.guard).toBeUndefined();
  });
});