import { describe, expect, it } from "vitest";
import { buildApiUrlCandidates, normalizeApiUrl, readConfigFromEnv } from "./config.js";

describe("buildApiUrlCandidates", () => {
  it("puts the primary base first and de-duplicates against the export", () => {
    const candidates = buildApiUrlCandidates(
      "http://100.67.204.21:3100",
      JSON.stringify(["http://100.67.204.21:3100", "http://192.168.1.10:3100"]),
    );

    expect(candidates).toEqual(["http://100.67.204.21:3100/api", "http://192.168.1.10:3100/api"]);
  });

  it("normalizes every entry to an /api base", () => {
    const candidates = buildApiUrlCandidates(
      "http://host-a:3100/api/",
      JSON.stringify(["http://host-b:3100/api", "http://host-c:3100"]),
    );

    expect(candidates).toEqual([
      "http://host-a:3100/api",
      "http://host-b:3100/api",
      "http://host-c:3100/api",
    ]);
  });

  it("keeps only http(s) origins and drops malformed, non-string and empty entries", () => {
    const candidates = buildApiUrlCandidates(
      "http://host-a:3100",
      JSON.stringify(["not a url", "", 42, null, "http://host-b:3100", "ftp://host-c:3100"]),
    );

    expect(candidates[0]).toBe("http://host-a:3100/api");
    expect(candidates).toContain("http://host-b:3100/api");
    expect(candidates.some((entry) => entry.includes("host-c"))).toBe(false);
  });

  it("returns the primary alone when the export is malformed, empty or not an array", () => {
    for (const raw of ["{oops", "[]", '"a string"', "", "   ", undefined]) {
      expect(buildApiUrlCandidates("http://host-a:3100", raw)).toEqual(["http://host-a:3100/api"]);
    }
  });

  it("still yields candidates when the primary is missing entirely", () => {
    expect(buildApiUrlCandidates(null, JSON.stringify(["http://host-b:3100"]))).toEqual([
      "http://host-b:3100/api",
    ]);
  });
});

describe("readConfigFromEnv", () => {
  const baseEnv = {
    PAPERCLIP_API_KEY: "token-123",
    PAPERCLIP_COMPANY_ID: "11111111-1111-1111-1111-111111111111",
    PAPERCLIP_AGENT_ID: "22222222-2222-2222-2222-222222222222",
    PAPERCLIP_RUN_ID: "33333333-3333-3333-3333-333333333333",
  } as NodeJS.ProcessEnv;

  it("wires the server-exported candidates behind the primary", () => {
    const config = readConfigFromEnv({
      ...baseEnv,
      PAPERCLIP_API_URL: "http://100.67.204.21:3100",
      PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: JSON.stringify([
        "http://100.67.204.21:3100",
        "http://10.0.0.5:3100",
      ]),
    });

    expect(config.apiUrl).toBe("http://100.67.204.21:3100/api");
    expect(config.apiUrlCandidates).toEqual([
      "http://100.67.204.21:3100/api",
      "http://10.0.0.5:3100/api",
    ]);
  });

  it("survives a missing PAPERCLIP_API_URL by adopting the first candidate", () => {
    const config = readConfigFromEnv({
      ...baseEnv,
      PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: JSON.stringify(["http://10.0.0.5:3100"]),
    });

    expect(config.apiUrl).toBe("http://10.0.0.5:3100/api");
    expect(config.apiUrlCandidates).toEqual(["http://10.0.0.5:3100/api"]);
  });

  it("throws when neither the primary nor any candidate is usable", () => {
    expect(() => readConfigFromEnv({ ...baseEnv })).toThrow("Missing PAPERCLIP_API_URL");
    expect(() =>
      readConfigFromEnv({ ...baseEnv, PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: "{broken" }),
    ).toThrow("Missing PAPERCLIP_API_URL");
  });

  it("keeps the existing missing-key and api-key validation", () => {
    expect(() =>
      readConfigFromEnv({ ...baseEnv, PAPERCLIP_API_URL: "http://host-a:3100", PAPERCLIP_API_KEY: "" }),
    ).toThrow("Missing PAPERCLIP_API_KEY");
  });
});

describe("normalizeApiUrl", () => {
  it("appends /api exactly once and strips trailing slashes", () => {
    expect(normalizeApiUrl("http://host-a:3100")).toBe("http://host-a:3100/api");
    expect(normalizeApiUrl("http://host-a:3100/api")).toBe("http://host-a:3100/api");
    expect(normalizeApiUrl("http://host-a:3100/api///")).toBe("http://host-a:3100/api");
  });
});