#!/usr/bin/env node
/**
 * RUAAAAA-5770: write a claimed Paperclip API key file without destroying it.
 *
 * WHY THIS EXISTS
 *
 * The claimed key file is the only copy of an agent's Paperclip bearer token
 * on disk (the server stores a sha256 of it). Two production failures wrote a
 * useless value into it:
 *
 *   - a hand-authored placeholder (`pc_api_key_value_here`), and
 *   - a token literal pasted into a shell command, which the OpenClaw exec
 *     credential scrubber rewrote to `***` before the shell ran it.
 *
 * Either way every Paperclip call then answered
 * 401 {"error":"Unauthorized","guard":"signature"} while the seat looked
 * authenticated. This helper refuses to store such a value and writes the
 * file atomically with mode 0600.
 *
 * USAGE
 *
 *   # the token comes from STDIN, never from argv: a token literal in a
 *   # command string gets scrubbed to *** by the OpenClaw exec tool.
 *   pbp_claim_response.json | node scripts/paperclip/write-claimed-key.mjs \
 *     --path ~/.openclaw/agents/<agent>/paperclip-claimed-api-key.json \
 *     --agent-id <agentId> --agent-name "<name>"
 *
 * The token may also be piped as a bare line (the first line of stdin).
 */

import process from "node:process";

const TOKEN_PATTERN = /^pcp_[A-Za-z0-9_-]{8,}$/;
const REJECTED = new Set([
  "***",
  "pc_api_key_value_here",
  "your_api_key_here",
  "pc_api_key_value",
  "changeme",
  "<token>",
  "redacted",
]);

function parseArgs(argv) {
  const out = { path: null, meta: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--path") {
      out.path = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--path=")) {
      out.path = arg.slice("--path=".length);
    } else if (arg === "--agent-id") {
      out.meta.agentId = argv[i + 1];
      i += 1;
    } else if (arg === "--agent-name") {
      out.meta.agentName = argv[i + 1];
      i += 1;
    } else if (arg === "--company-id") {
      out.meta.companyId = argv[i + 1];
      i += 1;
    } else if (arg === "--api-url") {
      out.meta.apiUrl = argv[i + 1];
      i += 1;
    } else if (arg === "--note") {
      out.meta.note = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function validateToken(raw) {
  if (typeof raw !== "string") return "the token is not a string";
  const token = raw.trim();
  if (!token) return "the token is empty";
  if (REJECTED.has(token) || REJECTED.has(token.toLowerCase())) {
    return `the token is the placeholder ${JSON.stringify(token)} - never write a placeholder into the key file`;
  }
  if (!token.startsWith("pcp_")) {
    return "the token does not start with pcp_ - a claimed Paperclip key is always pcp_<random>";
  }
  if (!TOKEN_PATTERN.test(token)) {
    return "the token does not match the minted pcp_ token shape";
  }
  return null;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function extractToken(stdinText) {
  const trimmed = stdinText.trim();
  if (!trimmed) return "";
  // A claim response body: take the .token field.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && typeof parsed.token === "string") {
        return parsed.token.trim();
      }
    } catch {
      // fall through: treat stdin as a bare token
    }
  }
  const firstLine = trimmed.split("\n")[0];
  return firstLine.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "usage: node scripts/paperclip/write-claimed-key.mjs --path <file> [--agent-id <id>] " +
        "[--agent-name <name>] [--company-id <id>] [--api-url <url>] [--note <text>]\n" +
        "the token is read from STDIN (a claim response JSON or a bare token line)\n",
    );
    return 0;
  }
  if (!args.path) {
    process.stderr.write("--path is required\n");
    return 2;
  }

  const token = extractToken(await readStdin());
  const problem = validateToken(token);
  if (problem) {
    process.stderr.write(`refusing to write ${args.path}: ${problem}\n`);
    return 3;
  }

  const { writeClaimedApiKeyFile } = await import(
    "../../packages/adapters/openclaw-gateway/src/server/claimedApiKey.ts",
  );
  const result = writeClaimedApiKeyFile(args.path, { token, ...args.meta });
  if (!result.ok) {
    process.stderr.write(`refusing to write ${args.path}: ${result.detail}\n`);
    return 3;
  }
  process.stdout.write(`wrote ${result.path} (mode 0600, token not printed)\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
