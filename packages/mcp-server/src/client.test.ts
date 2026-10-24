import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient, PaperclipApiError } from "./client.js";
import type { PaperclipMcpConfig } from "./config.js";

const DEAD = "http://dead-host:3100";
const LIVE = "http://100.67.204.21:3100";

function makeClient(candidates?: string[]): PaperclipApiClient {
  const config: PaperclipMcpConfig = {
    apiUrl: DEAD,
    ...(candidates ? { apiUrlCandidates: candidates } : {}),
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  };
  return new PaperclipApiClient(config);
}

/** Undici rejects with a TypeError whose `cause` carries the socket error code. */
function transportError(code: string): TypeError {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(new Error(`connect ${code}`), { code });
  return error;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PaperclipApiClient candidate failover", () => {
  it("fails a GET over to the next candidate when the primary refuses the connection", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(transportError("ECONNREFUSED"))
      .mockResolvedValueOnce(jsonResponse({ id: "agent-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient([DEAD, LIVE]);

    await expect(client.requestJson("GET", "/agents/me")).resolves.toEqual({ id: "agent-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${DEAD}/api/agents/me`);
    expect(String(fetchMock.mock.calls[1][0])).toBe(`${LIVE}/api/agents/me`);
    expect(client.activeApiUrl).toBe(`${LIVE}/api`);
  });

  it("sticks to the candidate that answered", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(transportError("ECONNREFUSED"))
      .mockImplementation(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient([DEAD, LIVE]);
    await client.requestJson("GET", "/agents/me");
    fetchMock.mockClear();

    await client.requestJson("GET", "/companies/1/issues");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${LIVE}/api/companies/1/issues`);
  });

  it("fails a POST over too, because a refused connection never delivered it", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(transportError("ECONNREFUSED"))
      .mockImplementation(async () => jsonResponse({ id: "issue-9" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient([DEAD, LIVE]);

    await expect(
      client.requestJson("POST", "/issues", { body: { title: "t" } }),
    ).resolves.toEqual({ id: "issue-9" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT replay a POST after an ambiguous mid-flight failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(transportError("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient([DEAD, LIVE]);

    await expect(client.requestJson("POST", "/issues", { body: { title: "t" } })).rejects.toThrow(
      "fetch failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does replay an idempotent request after an ambiguous mid-flight failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(transportError("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient([DEAD, LIVE]);

    await expect(client.requestJson("GET", "/agents/me")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never fails over on an HTTP status — the base answered", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient([DEAD, LIVE]);

    await expect(client.requestJson("GET", "/agents/me")).rejects.toBeInstanceOf(PaperclipApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.activeApiUrl).toBe(`${DEAD}/api`);
  });

  it("propagates the 401 body untouched instead of masking it as a transport fault", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "Agent authentication required" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient([DEAD, LIVE]);

    await expect(client.requestJson("GET", "/agents/me")).rejects.toMatchObject({
      status: 401,
      body: { error: "Agent authentication required" },
    });
  });

  it("exhausts every candidate and then surfaces the last transport error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(transportError("ENOTFOUND"));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient([DEAD, LIVE, "http://third-host:3100"]);

    await expect(client.requestJson("GET", "/agents/me")).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps working with a single candidate when the export is absent", async () => {
    const fetchMock = vi.fn().mockRejectedValue(transportError("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient();

    await expect(client.requestJson("GET", "/agents/me")).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.apiUrlCandidates).toEqual([`${DEAD}/api`]);
  });

  it("de-duplicates a candidate list that repeats the primary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient([DEAD, `${DEAD}/api`, LIVE]);

    expect(client.apiUrlCandidates).toEqual([`${DEAD}/api`, `${LIVE}/api`]);
  });

  it("carries auth and run-id headers on the failover attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(transportError("ECONNREFUSED"))
      .mockImplementation(async () => jsonResponse({ id: "issue-9" }));
    vi.stubGlobal("fetch", fetchMock);

    await makeClient([DEAD, LIVE]).requestJson("POST", "/issues", { body: { title: "t" } });

    const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-123");
    expect(headers["X-Paperclip-Run-Id"]).toBe("33333333-3333-3333-3333-333333333333");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});