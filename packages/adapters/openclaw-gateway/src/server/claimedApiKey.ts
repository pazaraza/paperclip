/**
 * RUAAAAA-5770: validation and safe writes for a claimed Paperclip API key file.
 *
 * The claimed key file (`paperclip-claimed-api-key.json`) is the only place the
 * plaintext of an agent's Paperclip bearer token exists on disk: the
 * `agent_api_keys` table stores a sha256 of the token, so the file IS the
 * credential of record. Two production failures destroyed it:
 *
 *  1. A hand-authored placeholder was written into it (`pc_api_key_value_here`).
 *  2. A token literal embedded in an exec command string was rewritten to `***`
 *     by the OpenClaw credential scrubber before the shell ran it, so the file
 *     was written with the scrubbed value.
 *
 * Both produce a file that parses as JSON but carries a token that matches no
 * live key row, so every Paperclip call answers
 * `401 {"error":"Unauthorized","guard":"signature"}`. Nothing noticed: the
 * reader judged the token "not a pcp_ token", logged a warning, and the run
 * continued on a path that could only 401 - for ~30 hours, with no escalation.
 *
 * This module is the single place that decides whether a claimed key file is
 * usable, plus a writer that refuses to store an unusable value.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every token minted by `server/src/services/agents.ts:createApiKey` starts with this. */
export const CLAIMED_API_KEY_TOKEN_PREFIX = "pcp_";

/** The shape of a minted key: `pcp_` + url-safe random characters. */
export const CLAIMED_API_KEY_TOKEN_PATTERN = /^pcp_[A-Za-z0-9_-]{8,}$/;

/**
 * Values that have actually been written into claimed key files in the wild.
 * `***` is what the OpenClaw exec credential scrubber leaves behind when a
 * token literal appears in a command string; the rest are doc placeholders an
 * agent copied instead of the real claim response.
 */
export const CLAIMED_API_KEY_REJECTED_TOKENS = new Set([
  "***",
  "pc_api_key_value_here",
  "your_api_key_here",
  "pc_api_key_value",
  "changeme",
  "<token>",
  "redacted",
]);

export type ClaimedApiKeyTokenRejection =
  | "not_a_string"
  | "empty_token"
  | "placeholder_token"
  | "wrong_prefix"
  | "malformed_token";

export type ClaimedApiKeyTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: ClaimedApiKeyTokenRejection; detail: string };

/**
 * Decide whether a value is usable as a Paperclip bearer token.
 *
 * This is the write-side guard the issue asks for: a non-`pcp_` value (and
 * every known placeholder) is rejected before it can reach a key file.
 */
export function validateClaimedApiKeyToken(raw: unknown): ClaimedApiKeyTokenResult {
  if (typeof raw !== "string") {
    return {
      ok: false,
      reason: "not_a_string",
      detail: `expected a string token, got ${raw === null ? "null" : typeof raw}`,
    };
  }

  const token = raw.trim();
  if (token.length === 0) {
    return { ok: false, reason: "empty_token", detail: "the token is empty" };
  }

  const lowered = token.toLowerCase();
  if (CLAIMED_API_KEY_REJECTED_TOKENS.has(token) || CLAIMED_API_KEY_REJECTED_TOKENS.has(lowered)) {
    return {
      ok: false,
      reason: "placeholder_token",
      detail: `the token is the placeholder ${JSON.stringify(token)}`,
    };
  }

  if (!token.startsWith(CLAIMED_API_KEY_TOKEN_PREFIX)) {
    return {
      ok: false,
      reason: "wrong_prefix",
      detail: `the token does not start with ${JSON.stringify(CLAIMED_API_KEY_TOKEN_PREFIX)}`,
    };
  }

  if (!CLAIMED_API_KEY_TOKEN_PATTERN.test(token)) {
    return {
      ok: false,
      reason: "malformed_token",
      detail: "the token does not match the minted pcp_ token shape",
    };
  }

  return { ok: true, token };
}

export type ClaimedApiKeyFileFailureReason =
  | "missing"
  | "unreadable"
  | "invalid_json"
  | "not_object"
  | "missing_token"
  | "invalid_token";

export type ClaimedApiKeyFileResult =
  | { ok: true; token: string; path: string }
  | {
      ok: false;
      reason: ClaimedApiKeyFileFailureReason;
      detail: string;
      path: string;
    };

/**
 * Read and validate a claimed key file.
 *
 * `missing` means the agent never claimed a key (legitimate). `unreadable`
 * means the file exists but could not be read - the reader may be on a
 * different host than the file, so callers decide whether that is fatal.
 */
export function readClaimedApiKeyFile(filePath: string): ClaimedApiKeyFileResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "missing", detail: "the file does not exist", path: filePath };
    }
    return {
      ok: false,
      reason: "unreadable",
      detail: err instanceof Error ? err.message : String(err),
      path: filePath,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "invalid_json",
      detail: err instanceof Error ? err.message : String(err),
      path: filePath,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "not_object",
      detail: "the JSON root is not an object",
      path: filePath,
    };
  }

  const token = (parsed as { token?: unknown }).token;
  if (token === undefined || token === null) {
    return {
      ok: false,
      reason: "missing_token",
      detail: "the JSON has no .token field",
      path: filePath,
    };
  }

  const validated = validateClaimedApiKeyToken(token);
  if (!validated.ok) {
    return {
      ok: false,
      reason: "invalid_token",
      detail: validated.detail,
      path: filePath,
    };
  }

  return { ok: true, token: validated.token, path: filePath };
}

/**
 * A one-line, operator-readable description of why a claimed key file cannot be
 * used. Used in logs, in the run failure message, and in the wake text.
 */
export function describeClaimedApiKeyFailure(result: {
  reason: ClaimedApiKeyFileFailureReason;
  detail: string;
}): string {
  switch (result.reason) {
    case "missing":
      return "the claimed API key file does not exist (the agent never claimed a key)";
    case "unreadable":
      return `the claimed API key file could not be read: ${result.detail}`;
    case "invalid_json":
      return `the claimed API key file is not valid JSON: ${result.detail}`;
    case "not_object":
      return "the claimed API key file does not contain a JSON object";
    case "missing_token":
      return "the claimed API key file has no .token field";
    case "invalid_token":
      return `the claimed API key file holds an unusable token: ${result.detail}`;
  }
}

export interface ClaimedApiKeyFilePayload {
  token: string;
  agentId?: string;
  agentName?: string;
  companyId?: string;
  apiUrl?: string;
  note?: string;
  createdFor?: string;
  [key: string]: unknown;
}

/**
 * Render the key file body. The token comes first so a human reading the file
 * sees the credential immediately; the rest is metadata.
 */
export function buildClaimedApiKeyFileContents(payload: ClaimedApiKeyFilePayload): string {
  const { token, ...meta } = payload;
  return `${JSON.stringify({ token, ...meta }, null, 2)}\n`;
}

export type ClaimedApiKeyWriteResult =
  | { ok: true; path: string }
  | { ok: false; reason: "invalid_token" | "write_failed"; detail: string; path: string };

/**
 * Write a claimed key file, refusing to store an unusable token.
 *
 * The write is atomic (temp file + rename) and lands with mode 0600, so a
 * crash mid-write cannot leave a half-written credential behind.
 */
export function writeClaimedApiKeyFile(
  filePath: string,
  payload: ClaimedApiKeyFilePayload,
): ClaimedApiKeyWriteResult {
  const validated = validateClaimedApiKeyToken(payload.token);
  if (!validated.ok) {
    return {
      ok: false,
      reason: "invalid_token",
      detail: validated.detail,
      path: filePath,
    };
  }

  const contents = buildClaimedApiKeyFileContents({ ...payload, token: validated.token });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, contents, { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    return {
      ok: false,
      reason: "write_failed",
      detail: err instanceof Error ? err.message : String(err),
      path: filePath,
    };
  }
  return { ok: true, path: filePath };
}

/**
 * Expand a claimed key path: `$VAR` / `${VAR}` against the environment and a
 * leading `~` against the home directory. The default path shipped by the
 * adapter is `$OPENCLAW_AGENT_DIR/../paperclip-claimed-api-key.json`, so the
 * reader has to expand it before it can look at the file.
 */
export function expandClaimedApiKeyPath(
  rawPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const expanded = rawPath.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) => {
      const name = (braced ?? bare) as string;
      const value = env[name];
      return value === undefined ? match : value;
    },
  );

  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    return path.join(os.homedir(), expanded.slice(1).replace(/^[\\/]+/, ""));
  }
  return expanded;
}
