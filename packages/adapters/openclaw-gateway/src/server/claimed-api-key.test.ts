import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildClaimedApiKeyFileContents,
  describeClaimedApiKeyFailure,
  expandClaimedApiKeyPath,
  readClaimedApiKeyFile,
  validateClaimedApiKeyToken,
  writeClaimedApiKeyFile,
} from "./claimedApiKey.js";

const VALID_TOKEN = "pcp_0123456789abcdef0123456789abcdef0123456789abcdef";

describe("validateClaimedApiKeyToken (RUAAAAA-5770)", () => {
  it("accepts a minted pcp_ token", () => {
    const result = validateClaimedApiKeyToken(VALID_TOKEN);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toBe(VALID_TOKEN);
  });

  it("rejects the doc placeholder that was written into the live key file", () => {
    // The value the Head of Engineering claimed key file held from
    // 2026-11-01T03:03:45Z until 2026-11-02T18:45:11Z.
    const result = validateClaimedApiKeyToken("pc_api_key_value_here");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("placeholder_token");
  });

  it("rejects the scrubbed value the OpenClaw exec scrubber leaves behind", () => {
    // The Governance Records Steward key file was written with exactly this
    // value on 2026-06-30T18:54:53Z by a rotation routine that put the token
    // literal into an exec command string.
    const result = validateClaimedApiKeyToken("***");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("placeholder_token");
  });

  it("rejects a jwt-shaped token", () => {
    const result = validateClaimedApiKeyToken("eyJhbGciOiJIUzI1NiJ9.payload.signature");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_prefix");
  });

  it("rejects an empty token", () => {
    const result = validateClaimedApiKeyToken("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_token");
  });

  it("rejects a non-string token", () => {
    const result = validateClaimedApiKeyToken({ token: VALID_TOKEN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_a_string");
  });

  it("rejects a pcp_ token that is too short to be a minted key", () => {
    const result = validateClaimedApiKeyToken("pcp_x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_token");
  });

  it("trims surrounding whitespace before deciding", () => {
    const result = validateClaimedApiKeyToken("  " + VALID_TOKEN + "  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toBe(VALID_TOKEN);
  });
});

describe("readClaimedApiKeyFile (RUAAAAA-5770)", () => {
  it("reports missing when the file does not exist", () => {
    const result = readClaimedApiKeyFile(path.join(os.tmpdir(), "paperclip-5770-absent.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  it("reports invalid_json for a file that is not JSON", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-5770-")), "key.json");
    fs.writeFileSync(file, "not-json{");
    const result = readClaimedApiKeyFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_json");
  });

  it("reports not_object when the JSON root is an array", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-5770-")), "key.json");
    fs.writeFileSync(file, JSON.stringify(["nope"]));
    const result = readClaimedApiKeyFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_object");
  });

  it("reports missing_token when the JSON has no .token field", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-5770-")), "key.json");
    fs.writeFileSync(file, JSON.stringify({ agentId: "agent-1" }));
    const result = readClaimedApiKeyFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_token");
  });

  it("reports invalid_token for the placeholder that broke the live seat", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-5770-")), "key.json");
    fs.writeFileSync(file, JSON.stringify({ token: "pc_api_key_value_here" }));
    const result = readClaimedApiKeyFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_token");
      expect(describeClaimedApiKeyFailure(result)).toContain("unusable token");
    }
  });

  it("returns the token for a valid file", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-5770-")), "key.json");
    fs.writeFileSync(file, JSON.stringify({ token: VALID_TOKEN, agentId: "agent-1" }));
    const result = readClaimedApiKeyFile(file);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toBe(VALID_TOKEN);
  });
});

describe("writeClaimedApiKeyFile (RUAAAAA-5770)", () => {
  it("refuses to write a placeholder token and leaves no file behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-5770-"));
    const file = path.join(dir, "paperclip-claimed-api-key.json");
    const result = writeClaimedApiKeyFile(file, { token: "pc_api_key_value_here" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_token");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses to write a scrubbed token", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-5770-"));
    const file = path.join(dir, "paperclip-claimed-api-key.json");
    const result = writeClaimedApiKeyFile(file, { token: "***" });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("writes a valid token with mode 0600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-5770-"));
    const file = path.join(dir, "paperclip-claimed-api-key.json");
    const result = writeClaimedApiKeyFile(file, {
      token: VALID_TOKEN,
      agentId: "agent-1",
      agentName: "Test Agent",
    });
    expect(result.ok).toBe(true);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("round-trips through readClaimedApiKeyFile", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-5770-"));
    const file = path.join(dir, "paperclip-claimed-api-key.json");
    writeClaimedApiKeyFile(file, { token: VALID_TOKEN, agentId: "agent-1" });
    const read = readClaimedApiKeyFile(file);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.token).toBe(VALID_TOKEN);
  });

  it("puts the token first in the file body", () => {
    const contents = buildClaimedApiKeyFileContents({ token: VALID_TOKEN, agentId: "agent-1" });
    expect(contents.indexOf('"token"')).toBeLessThan(contents.indexOf('"agentId"'));
    expect(JSON.parse(contents).token).toBe(VALID_TOKEN);
  });
});

describe("expandClaimedApiKeyPath (RUAAAAA-5770)", () => {
  it("expands the adapter default OPENCLAW_AGENT_DIR template", () => {
    const expanded = expandClaimedApiKeyPath("$OPENCLAW_AGENT_DIR/../paperclip-claimed-api-key.json", {
      OPENCLAW_AGENT_DIR: "/home/raul/.openclaw/agents/agent-1",
    });
    expect(expanded).toBe("/home/raul/.openclaw/agents/agent-1/../paperclip-claimed-api-key.json");
  });

  it("expands the braced form too", () => {
    const braced = "$" + "{CLAIMED_DIR}/key.json";
    const expanded = expandClaimedApiKeyPath(braced, { CLAIMED_DIR: "/tmp/x" });
    expect(expanded).toBe("/tmp/x/key.json");
  });

  it("leaves an unknown variable untouched", () => {
    const expanded = expandClaimedApiKeyPath("$NOT_SET_ANYWHERE/key.json", {});
    expect(expanded).toBe("$NOT_SET_ANYWHERE/key.json");
  });

  it("expands a leading ~ against the home directory", () => {
    const expanded = expandClaimedApiKeyPath("~/.openclaw/workspace/key.json", {});
    expect(expanded).toBe(path.join(os.homedir(), ".openclaw/workspace/key.json"));
  });
});
