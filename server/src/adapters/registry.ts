import type {
  AdapterModel,
  AdapterModelProfileDefinition,
  AdapterRuntimeCommandSpec,
  ServerAdapterModule,
} from "./types.js";
import {
  buildSandboxNpmInstallCommand,
  getAdapterSessionManagement,
} from "@paperclipai/adapter-utils";
import {
  applyHermesCompactionStallRecovery,
  applyHermesSessionContentionRecovery,
  createGuardedHermesSessionCodec,
  isHermesSessionId,
  sanitizeHermesExecutionResult,
} from "./hermes-session-id.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../middleware/logger.js";

/** Upper bound on stderr kept for post-run refusal detection (RUAAAAA-5296). */
const HERMES_STDERR_CAPTURE_LIMIT = 16 * 1024;

/**
 * RUAAAAA-5440: the absolute path of an agent's stored Paperclip API key file.
 *
 * The path is safe to hand to an agent; the token it holds is not. hermes_local
 * needs it because the adapter's env injection cannot reach the process that
 * runs the turn (see buildHermesAuthGuardPrompt).
 */
function resolveHermesClaimedApiKeyPath(agent: { id: string; adapterConfig?: unknown }): string | null {
  const adapterConfig =
    agent.adapterConfig && typeof agent.adapterConfig === "object"
      ? (agent.adapterConfig as Record<string, unknown>)
      : null;
  const rawPath = adapterConfig?.claimedApiKeyPath;
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return null;
  }
  const trimmed = rawPath.trim();
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(1).replace(/^[\\/]+/, ""));
  }
  return trimmed;
}

/**
 * RUAAAAA-5440: the Paperclip auth instructions handed to a hermes_local seat.
 *
 * Hermes runs the turn inside the long-lived `hermes gateway run` process,
 * whose environment was frozen when THAT process started. The adapter injects
 * PAPERCLIP_API_KEY / PAPERCLIP_RUN_ID into its own `hermes chat` child, so
 * both are absent from the shell the agent actually gets and every Paperclip
 * call answers 401 (the symptom RUAAAAA-5440 reports).
 *
 * The prompt therefore restores the documented contract inside the agent's own
 * shell: it names the credential FILE (never the secret) and the run id (a
 * literal, never an env var), and the agent exports both before it calls the
 * API. The file is the seat's own claimed-key file, which the gateway host can
 * read because it runs as the same user.
 */
function buildHermesAuthGuardPrompt(opts: { runId: string; claimedApiKeyPath: string | null }): string {
  const lines = ["Paperclip API safety rule:"];
  if (opts.claimedApiKeyPath) {
    lines.push(
      "Your turn runs inside the long-lived Hermes gateway process, whose environment was frozen when it started, so PAPERCLIP_API_KEY and PAPERCLIP_RUN_ID are usually NOT set in your shell. Set them yourself before the first Paperclip call:",
      `  export PAPERCLIP_API_KEY="$(python3 -c "import json;print(json.load(open('${opts.claimedApiKeyPath}'))['token'])")" && export PAPERCLIP_RUN_ID="${opts.runId}"`,
      "Run that once at the start of your turn, in the shell you use for curl. Hermes keeps a persistent shell; if a call starts a fresh shell, prefix that command with the same export.",
    );
  } else {
    lines.push(
      "Your turn runs inside the long-lived Hermes gateway process, whose environment was frozen when it started, so PAPERCLIP_API_KEY is usually NOT set in your shell. If it IS set, use it. If it is unset, do not make Paperclip API calls: say the credential is unavailable instead of retrying.",
    );
  }
  lines.push(
    "Use Authorization: Bearer $PAPERCLIP_API_KEY on every Paperclip API request.",
    "Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every Paperclip API request that writes or mutates data, including comments and issue updates.",
    "Never use a board, browser, or local-board session for Paperclip API writes.",
    "Do not print the API key or the bearer token.",
  );
  return lines.join("\n");
}

/**
 * Best-effort lookup of a hermes_local agent's stored Paperclip API key.
 *
 * Preferred source: `agent.adapterConfig.claimedApiKeyPath` (the per-agent
 * `paperclip-claimed-api-key.json` file the agent writes when it claims its
 * key, generated 2026-06-27 by the per-agent keyfile migration). The
 * `agent_api_keys` table only stores SHA-256 hashes of keys and cannot
 * recover the plaintext, so it is not a viable source. The file path is the
 * canonical source of truth for raw tokens today (see RUAAAAA-2375).
 *
 * Behaviour:
 * - Reads + parses the JSON file at the configured path (resolving a leading
 *   `~` against `os.homedir()`).
 * - Returns `parsed.token` when the JSON parses and the token is a non-empty
 *   string. Tokens are expected to start with `pcp_`; tokens that do not are
 *   rejected so we never silently inject a malformed/JWT-shaped value.
 * - Returns `null` (with a warn log) when the path is unset, unreadable,
 *   malformed, or carries an invalid token. The caller is then responsible
 *   for falling back to the local JWT path or skipping injection.
 *
 * The lookup is run once per `execute()` call. Cache-busting is the caller's
 * responsibility (the run id is the natural cache key — every wake is one
 * execute()).
 */
async function resolveHermesPaperclipApiKey(
  agent: { id: string; adapterConfig?: unknown },
  runId: string,
): Promise<string | null> {
  const adapterConfig =
    agent.adapterConfig && typeof agent.adapterConfig === "object"
      ? (agent.adapterConfig as Record<string, unknown>)
      : null;
  const rawPath = adapterConfig?.claimedApiKeyPath;
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return null;
  }
  const trimmed = rawPath.trim();
  let resolved: string;
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    resolved = path.join(os.homedir(), trimmed.slice(1).replace(/^[\\/]+/, ""));
  } else {
    resolved = trimmed;
  }
  let raw: string;
  try {
    raw = await fs.promises.readFile(resolved, "utf-8");
  } catch (err) {
    logger.warn(
      { agentId: agent.id, runId, claimedApiKeyPath: resolved, err: err instanceof Error ? err.message : String(err) },
      "[hermes_local] PAPERCLIP_API_KEY source unreadable; falling back to JWT path",
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      { agentId: agent.id, runId, claimedApiKeyPath: resolved, err: err instanceof Error ? err.message : String(err) },
      "[hermes_local] claimedApiKeyPath file is not valid JSON; falling back to JWT path",
    );
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    logger.warn(
      { agentId: agent.id, runId, claimedApiKeyPath: resolved },
      "[hermes_local] claimedApiKeyPath JSON is not an object; falling back to JWT path",
    );
    return null;
  }
  const token = (parsed as { token?: unknown }).token;
  if (typeof token !== "string" || token.trim().length === 0) {
    logger.warn(
      { agentId: agent.id, runId, claimedApiKeyPath: resolved },
      "[hermes_local] claimedApiKeyPath JSON missing .token; falling back to JWT path",
    );
    return null;
  }
  const trimmedToken = token.trim();
  // Defense-in-depth: the agent_api_keys table only ever stores tokens
  // minted via server/src/services/agents.ts:createApiKey which produces
  // `pcp_<random>` strings. Reject anything that does not match so we never
  // silently inject a raw JWT or other unrelated value.
  if (!trimmedToken.startsWith("pcp_")) {
    logger.warn(
      { agentId: agent.id, runId, claimedApiKeyPath: resolved, tokenPrefix: trimmedToken.slice(0, 4) },
      "[hermes_local] claimedApiKeyPath token does not look like a Paperclip api key; falling back to JWT path",
    );
    return null;
  }
  return trimmedToken;
}
import {
  execute as acpxExecute,
  testEnvironment as acpxTestEnvironment,
  sessionCodec as acpxSessionCodec,
  getConfigSchema as getAcpxConfigSchema,
  listAcpxSkills,
  syncAcpxSkills,
} from "@paperclipai/adapter-acpx-local/server";
import {
  agentConfigurationDoc as acpxAgentConfigurationDoc,
  models as acpxModels,
} from "@paperclipai/adapter-acpx-local";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  listClaudeModels,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
} from "@paperclipai/adapter-claude-local/server";
import {
  agentConfigurationDoc as claudeAgentConfigurationDoc,
  models as claudeModels,
  modelProfiles as claudeModelProfiles,
} from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
} from "@paperclipai/adapter-codex-local/server";
import {
  agentConfigurationDoc as codexAgentConfigurationDoc,
  models as codexModels,
  modelProfiles as codexModelProfiles,
} from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import {
  agentConfigurationDoc as cursorAgentConfigurationDoc,
  models as cursorModels,
  modelProfiles as cursorModelProfiles,
} from "@paperclipai/adapter-cursor-local";
import {
  execute as cursorCloudExecute,
  getConfigSchema as getCursorCloudConfigSchema,
  sessionCodec as cursorCloudSessionCodec,
  testEnvironment as cursorCloudTestEnvironment,
} from "@paperclipai/adapter-cursor-cloud/server";
import { agentConfigurationDoc as cursorCloudAgentConfigurationDoc } from "@paperclipai/adapter-cursor-cloud";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
} from "@paperclipai/adapter-gemini-local/server";
import {
  agentConfigurationDoc as geminiAgentConfigurationDoc,
  models as geminiModels,
  modelProfiles as geminiModelProfiles,
} from "@paperclipai/adapter-gemini-local";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@paperclipai/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
  models as openCodeModels,
  modelProfiles as openCodeModelProfiles,
} from "@paperclipai/adapter-opencode-local";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@paperclipai/adapter-openclaw-gateway";
import { listCodexModels, listCodexModelProfiles, refreshCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
  modelProfiles as piModelProfiles,
} from "@paperclipai/adapter-pi-local";
import {
  execute as hermesExecute,
  testEnvironment as hermesTestEnvironment,
  sessionCodec as hermesSessionCodec,
  listSkills as hermesListSkills,
  syncSkills as hermesSyncSkills,
  detectModel as detectModelFromHermes,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { buildExternalAdapters } from "./plugin-loader.js";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";

function readConfiguredCommand(config: Record<string, unknown>, fallback: string): string {
  const value = typeof config.command === "string" ? config.command.trim() : "";
  return value.length > 0 ? value : fallback;
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildNpmRuntimeCommandSpec(
  config: Record<string, unknown>,
  fallbackCommand: string,
  packageName: string,
): AdapterRuntimeCommandSpec {
  const command = readConfiguredCommand(config, fallbackCommand);
  const canSelfInstall = !hasPathSeparator(command) && command === fallbackCommand;
  const installLine = buildSandboxNpmInstallCommand(packageName);
  return {
    command,
    detectCommand: command,
    installCommand: canSelfInstall
      ? `if ! command -v ${shellQuote(command)} >/dev/null 2>&1; then ${installLine}; fi`
      : null,
  };
}

function buildCursorRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = readConfiguredCommand(config, "agent");
  return {
    command,
    detectCommand: command,
    installCommand: null,
  };
}

function normalizeHermesConfig<T extends { config?: unknown; agent?: unknown }>(ctx: T): T {
  const config =
    ctx && typeof ctx === "object" && "config" in ctx && ctx.config && typeof ctx.config === "object"
      ? (ctx.config as Record<string, unknown>)
      : null;
  const agent =
    ctx && typeof ctx === "object" && "agent" in ctx && ctx.agent && typeof ctx.agent === "object"
      ? (ctx.agent as Record<string, unknown>)
      : null;
  const agentAdapterConfig =
    agent?.adapterConfig && typeof agent.adapterConfig === "object"
      ? (agent.adapterConfig as Record<string, unknown>)
      : null;

  const configCommand =
    typeof config?.command === "string" && config.command.length > 0 ? config.command : undefined;
  const agentCommand =
    typeof agentAdapterConfig?.command === "string" && agentAdapterConfig.command.length > 0
      ? agentAdapterConfig.command
      : undefined;

  if (config && !config.hermesCommand && configCommand) {
    config.hermesCommand = configCommand;
  }
  if (agentAdapterConfig && !agentAdapterConfig.hermesCommand && agentCommand) {
    agentAdapterConfig.hermesCommand = agentCommand;
  }

  return ctx;
}

function dedupeAdapterModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const result: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ ...model, id });
  }
  return result;
}

function prefixAdapterModelLabels(models: AdapterModel[], provider: "Claude" | "Codex"): AdapterModel[] {
  const prefix = `${provider}: `;
  return models.map((model) => ({
    ...model,
    label: model.label.startsWith(prefix) ? model.label : `${prefix}${model.label}`,
  }));
}

async function listAcpxModels(): Promise<AdapterModel[]> {
  const [claude, codex] = await Promise.all([
    listClaudeModels().catch(() => claudeModels),
    listCodexModels().catch(() => codexModels),
  ]);
  return dedupeAdapterModels([
    ...acpxModels,
    ...prefixAdapterModelLabels(claude, "Claude"),
    ...prefixAdapterModelLabels(codex, "Codex"),
  ]);
}

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  modelProfiles: claudeModelProfiles,
  listModels: listClaudeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "claude", "@anthropic-ai/claude-code"),
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getQuotaWindows: claudeGetQuotaWindows,
};

const acpxLocalAdapter: ServerAdapterModule = {
  type: "acpx_local",
  execute: acpxExecute,
  testEnvironment: acpxTestEnvironment,
  listSkills: listAcpxSkills,
  syncSkills: syncAcpxSkills,
  sessionCodec: acpxSessionCodec,
  sessionManagement: getAdapterSessionManagement("acpx_local") ?? undefined,
  models: dedupeAdapterModels([
    ...prefixAdapterModelLabels(claudeModels, "Claude"),
    ...prefixAdapterModelLabels(codexModels, "Codex"),
  ]),
  listModels: listAcpxModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: acpxAgentConfigurationDoc,
  getConfigSchema: getAcpxConfigSchema,
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  modelProfiles: codexModelProfiles,
  listModelProfiles: listCodexModelProfiles,
  listModels: listCodexModels,
  refreshModels: refreshCodexModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) => buildNpmRuntimeCommandSpec(config, "codex", "@openai/codex"),
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getQuotaWindows: codexGetQuotaWindows,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  modelProfiles: cursorModelProfiles,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: buildCursorRuntimeCommandSpec,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const cursorCloudAdapter: ServerAdapterModule = {
  type: "cursor_cloud",
  execute: cursorCloudExecute,
  testEnvironment: cursorCloudTestEnvironment,
  sessionCodec: cursorCloudSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor_cloud") ?? undefined,
  models: [],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: cursorCloudAgentConfigurationDoc,
  getConfigSchema: getCursorCloudConfigSchema,
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  modelProfiles: geminiModelProfiles,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "gemini", "@google/gemini-cli"),
  agentConfigurationDoc: geminiAgentConfigurationDoc,
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  modelProfiles: openCodeModelProfiles,
  sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) => buildNpmRuntimeCommandSpec(config, "opencode", "opencode-ai"),
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  modelProfiles: piModelProfiles,
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "pi", "@mariozechner/pi-coding-agent"),
  agentConfigurationDoc: piAgentConfigurationDoc,
};

// hermes-paperclip-adapter v0.2.0 predates the authToken field; cast is
// intentional until hermes ships a matching AdapterExecutionContext type.
const executeHermesLocal = hermesExecute as unknown as ServerAdapterModule["execute"];

const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: async (ctx) => {
    const normalizedCtx = normalizeHermesConfig(ctx);
    if (!normalizedCtx.authToken && !normalizedCtx.agent?.id) return executeHermesLocal(normalizedCtx);

    const existingConfig = (normalizedCtx.agent.adapterConfig ?? {}) as Record<string, unknown>;
    const existingEnv =
      typeof existingConfig.env === "object" && existingConfig.env !== null && !Array.isArray(existingConfig.env)
        ? (existingConfig.env as Record<string, string>)
        : {};
    const explicitApiKey =
      typeof existingEnv.PAPERCLIP_API_KEY === "string" && existingEnv.PAPERCLIP_API_KEY.trim().length > 0;
    const promptTemplate =
      typeof existingConfig.promptTemplate === "string" && existingConfig.promptTemplate.trim().length > 0
        ? existingConfig.promptTemplate
        : "";

    // RUAAAAA-2375: prefer the agent's stored Paperclip API key (read from the
    // per-agent `paperclip-claimed-api-key.json` written when the agent claimed
    // its key) over the local-agent JWT issued by `createLocalAgentJwt`. The
    // JWT path silently fails in production — the signature verifies but the
    // agent lookup in actorMiddleware returns null, so every route returns
    // 401. The stored token works for both reads and writes today.
    //
    // Cache the lookup at run start so we only hit the filesystem once per
    // wake even if Hermes shells out multiple Paperclip API calls.
    //
    // Fallback order:
    //   1. explicit existingConfig.env.PAPERCLIP_API_KEY (operator override — never overwritten)
    //   2. stored api_key from adapterConfig.claimedApiKeyPath  ← preferred
    //   3. normalizedCtx.authToken (the local JWT)             ← legacy / unmigrated agents
    //
    // We deliberately do NOT set `supportsLocalAgentJwt: false` on the
    // hermes_local adapter so the heartbeat path can still issue the JWT
    // upstream; this branch only decides what we inject into the child env.
    const runId = normalizedCtx.runId;
    const agentId = normalizedCtx.agent?.id ?? "unknown";
    let resolvedStoredKey: string | null = null;
    if (!explicitApiKey) {
      try {
        resolvedStoredKey = await resolveHermesPaperclipApiKey(normalizedCtx.agent, runId);
      } catch (err) {
        // resolveHermesPaperclipApiKey already logs; swallow so we still take the JWT path.
        resolvedStoredKey = null;
      }
    }

    let injectedApiKey: string | null = null;
    let injectedSource: "explicit" | "claimedApiKeyPath" | "authToken" | null = null;
    if (explicitApiKey) {
      // Operator-supplied takes priority; leave it alone.
      injectedApiKey = existingEnv.PAPERCLIP_API_KEY;
      injectedSource = "explicit";
    } else if (resolvedStoredKey) {
      injectedApiKey = resolvedStoredKey;
      injectedSource = "claimedApiKeyPath";
    } else if (normalizedCtx.authToken) {
      injectedApiKey = normalizedCtx.authToken;
      injectedSource = "authToken";
      logger.warn(
        { agentId, runId },
        "[hermes_local] no stored api_key; falling back to local-agent JWT (broken for hermes_local — RUAAAAA-2375)",
      );
    } else {
      logger.warn(
        { agentId, runId },
        "[hermes_local] no PAPERCLIP_API_KEY source available; child will run without one (writes will 401)",
      );
    }

    // RUAAAAA-5440: the credential has to reach the agent through the prompt.
    // The adapter's env injection lands in the `hermes chat` child, but Hermes
    // runs the turn in the long-lived gateway host, so the agent's shell never
    // sees PAPERCLIP_API_KEY / PAPERCLIP_RUN_ID and every call answers 401.
    const authGuardPrompt = buildHermesAuthGuardPrompt({
      runId: normalizedCtx.runId,
      claimedApiKeyPath:
        injectedSource === "claimedApiKeyPath"
          ? resolveHermesClaimedApiKeyPath(normalizedCtx.agent)
          : null,
    });

    const patchedConfig: Record<string, unknown> = {
      ...existingConfig,
      env: {
        ...existingEnv,
        ...(injectedApiKey ? { PAPERCLIP_API_KEY: injectedApiKey } : {}),
        PAPERCLIP_RUN_ID: normalizedCtx.runId,
      },
    };

    // Only inject the auth guard into promptTemplate when a custom template already exists.
    // When no custom template is set, Hermes uses its built-in default heartbeat/task prompt —
    // overwriting it with only the auth guard text would strip the assigned issue/workflow instructions.
    if (promptTemplate) {
      patchedConfig.promptTemplate = `${authGuardPrompt}\n\n${promptTemplate}`;
    }

    if (injectedSource && injectedSource !== "explicit") {
      logger.info(
        { agentId, runId, source: injectedSource },
        "[hermes_local] injecting PAPERCLIP_API_KEY for child process",
      );
    }

    // RUAAAAA-5296: keep a bounded copy of the child's stderr. The adapter's
    // own parser only keeps lines matching /error|exception|traceback|failed/i,
    // and the Hermes session-contention refusal matches none of those, so the
    // text is invisible to the server by the time the result is returned.
    let capturedStderr = "";
    const patchedCtx = {
      ...normalizedCtx,
      agent: {
        ...normalizedCtx.agent,
        adapterConfig: patchedConfig,
      },
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stderr" && capturedStderr.length < HERMES_STDERR_CAPTURE_LIMIT) {
          capturedStderr += chunk;
        }
        return normalizedCtx.onLog(stream, chunk);
      },
    };

    // RUAAAAA-5244: hermes' legacy stdout parser captures the next prose word
    // after "session saved" / "session id", so ordinary output like "Session
    // saved from the previous run" yields sessionId "from". heartbeat.ts reads
    // adapterResult.sessionId directly (it bypasses the session codec) and
    // writes it to agent_runtime_state.session_id, so guard it here too.
    const hermesResult = await executeHermesLocal(patchedCtx);
    if (typeof hermesResult?.sessionId === "string" && !isHermesSessionId(hermesResult.sessionId)) {
      logger.warn(
        { agentId, runId, rejectedSessionId: hermesResult.sessionId },
        "[hermes_local] adapter reported a session id that is not a hermes session id; dropping it (RUAAAAA-5244)",
      );
    }
    // RUAAAAA-5339: a run that burns its whole budget in hermes' own context
    // compaction produces no turns and keeps the same wedged session, so the
    // next dispatch resumes it and fails identically. Drop the session and
    // name the cause instead of recording a bare "Timed out".
    const recovered = applyHermesSessionContentionRecovery(
      sanitizeHermesExecutionResult(hermesResult),
      capturedStderr,
    );
    // The adapter resolves its budget from `agent.adapterConfig.timeoutSec`
    // and falls back to its own default, which its shipped config doc states
    // as "timeoutSec | number | 300" (the constant is not exported by the
    // package). Name the same budget in the stall diagnosis: the
    // operator-raised 1800s and the adapter's own 300s default mean very
    // different things.
    const HERMES_DEFAULT_TIMEOUT_SEC = 300;
    const configuredTimeoutSec = existingConfig.timeoutSec;
    const timeoutSec =
      typeof configuredTimeoutSec === "number" &&
      Number.isFinite(configuredTimeoutSec) &&
      configuredTimeoutSec > 0
        ? configuredTimeoutSec
        : HERMES_DEFAULT_TIMEOUT_SEC;
    return applyHermesCompactionStallRecovery(recovered, { timeoutSec });
  },
  testEnvironment: (ctx) => hermesTestEnvironment(normalizeHermesConfig(ctx) as never),
  sessionCodec: createGuardedHermesSessionCodec(hermesSessionCodec, (rejections) => {
    for (const rejection of rejections) {
      logger.warn(
        { rejectedField: rejection.field, rejectedSessionId: rejection.value },
        "[hermes_local] refusing to persist a malformed hermes session id (RUAAAAA-5244)",
      );
    }
  }),
  listSkills: hermesListSkills,
  syncSkills: hermesSyncSkills,
  models: hermesModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
  detectModel: () => detectModelFromHermes(),
};

const adaptersByType = new Map<string, ServerAdapterModule>();

// For builtin types that are overridden by an external adapter, we keep the
// original builtin so it can be restored when the override is deactivated.
const builtinFallbacks = new Map<string, ServerAdapterModule>();

// Tracks which override types are currently deactivated (paused).  When
// paused, `getServerAdapter()` returns the builtin fallback instead of the
// external.  Persisted across reloads via the same disabled-adapters store.
const pausedOverrides = new Set<string>();

function registerBuiltInAdapters() {
  for (const adapter of [
    acpxLocalAdapter,
    claudeLocalAdapter,
    codexLocalAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorCloudAdapter,
    cursorLocalAdapter,
    geminiLocalAdapter,
    openclawGatewayAdapter,
    hermesLocalAdapter,
    processAdapter,
    httpAdapter,
  ]) {
    adaptersByType.set(adapter.type, adapter);
  }
}

registerBuiltInAdapters();

// ---------------------------------------------------------------------------
// Load external adapter plugins (e.g. droid_local)
//
// External adapter packages export createServerAdapter() which returns a
// ServerAdapterModule. When the module provides its own sessionManagement
// it is preserved; otherwise the host falls back to the built-in registry
// lookup (so externals that override a built-in type inherit the builtin's
// policy). This brings init-time registration to at-least-as-good behavior
// as the hot-install path (routes/adapters.ts:179 -> registerServerAdapter):
// both preserve module-provided sessionManagement, and init-time additionally
// applies the registry fallback for externals overriding a built-in type.
// ---------------------------------------------------------------------------

/** Cached sync wrapper — the store is a simple JSON file read, safe to call frequently. */
function getDisabledAdapterTypesFromStore(): string[] {
  return getDisabledAdapterTypes();
}

/**
 * Merge an external adapter module with host-provided session management.
 *
 * Module-provided `sessionManagement` takes precedence. When absent, fall
 * back to the hardcoded registry keyed by adapter type (so externals that
 * override a built-in — same `type` — inherit the builtin's policy). If
 * neither is available, `sessionManagement` remains `undefined`.
 *
 * Used by both the init-time IIFE below (external-adapter load pass on
 * server start) and the hot-install path in `routes/adapters.ts`
 * (`registerWithSessionManagement`), so the two load paths resolve
 * `sessionManagement` identically.
 */
export function resolveExternalAdapterRegistration(
  externalAdapter: ServerAdapterModule,
): ServerAdapterModule {
  return {
    ...externalAdapter,
    sessionManagement:
      externalAdapter.sessionManagement
        ?? getAdapterSessionManagement(externalAdapter.type)
        ?? undefined,
  };
}

/**
 * Load external adapters from the plugin store and hardcoded sources.
 * Called once at module initialization. The promise is exported so that
 * callers (e.g. assertKnownAdapterType, app startup) can await completion
 * and avoid racing against the loading window.
 */
const externalAdaptersReady: Promise<void> = (async () => {
  try {
    const externalAdapters = await buildExternalAdapters();
    for (const externalAdapter of externalAdapters) {
      const overriding = BUILTIN_ADAPTER_TYPES.has(externalAdapter.type);
      if (overriding) {
        console.log(
          `[paperclip] External adapter "${externalAdapter.type}" overrides built-in adapter`,
        );
        // Save the original builtin for later restoration.
        const existing = adaptersByType.get(externalAdapter.type);
        if (existing && !builtinFallbacks.has(externalAdapter.type)) {
          builtinFallbacks.set(externalAdapter.type, existing);
        }
      }
      adaptersByType.set(
        externalAdapter.type,
        resolveExternalAdapterRegistration(externalAdapter),
      );
    }
  } catch (err) {
    console.error("[paperclip] Failed to load external adapters:", err);
  }
})();

/**
 * Await this before validating adapter types to avoid race conditions
 * during server startup. External adapters are loaded asynchronously;
 * calling assertKnownAdapterType before this resolves will reject
 * valid external adapter types.
 */
export function waitForExternalAdapters(): Promise<void> {
  return externalAdaptersReady;
}

export function registerServerAdapter(adapter: ServerAdapterModule): void {
  if (BUILTIN_ADAPTER_TYPES.has(adapter.type) && !builtinFallbacks.has(adapter.type)) {
    const existing = adaptersByType.get(adapter.type);
    if (existing) {
      builtinFallbacks.set(adapter.type, existing);
    }
  }
  adaptersByType.set(adapter.type, adapter);
}

export function unregisterServerAdapter(type: string): void {
  if (type === processAdapter.type || type === httpAdapter.type) return;
  if (builtinFallbacks.has(type)) {
    pausedOverrides.delete(type);
    const fallback = builtinFallbacks.get(type);
    if (fallback) {
      adaptersByType.set(type, fallback);
    }
    return;
  }
  if (BUILTIN_ADAPTER_TYPES.has(type)) {
    return;
  }
  adaptersByType.delete(type);
}

export function requireServerAdapter(type: string): ServerAdapterModule {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return adapter;
}

export function getServerAdapter(type: string): ServerAdapterModule {
  return findActiveServerAdapter(type) ?? processAdapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function refreshAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.refreshModels) {
    const refreshed = await adapter.refreshModels();
    if (refreshed.length > 0) return refreshed;
  }
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function listAdapterModelProfiles(type: string): Promise<AdapterModelProfileDefinition[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModelProfiles) {
    const discovered = await adapter.listModelProfiles();
    if (discovered.length > 0) return discovered;
  }
  return adapter.modelProfiles ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

/**
 * List adapters excluding those that are disabled in settings.
 * Used for menus and agent creation flows — disabled adapters remain
 * functional for existing agents but hidden from selection.
 */
export function listEnabledServerAdapters(): ServerAdapterModule[] {
  const disabled = getDisabledAdapterTypesFromStore();
  const disabledSet = disabled.length > 0 ? new Set(disabled) : null;
  return disabledSet
    ? Array.from(adaptersByType.values()).filter((a) => !disabledSet.has(a.type))
    : Array.from(adaptersByType.values());
}

export async function detectAdapterModel(
  type: string,
): Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter?.detectModel) return null;
  const detected = await adapter.detectModel();
  if (!detected) return null;
  return {
    model: detected.model,
    provider: detected.provider,
    source: detected.source,
    ...(detected.candidates?.length ? { candidates: detected.candidates } : {}),
  };
}

// ---------------------------------------------------------------------------
// Override pause / resume
// ---------------------------------------------------------------------------

/**
 * Pause or resume an external override for a builtin adapter type.
 *
 * - `paused = true`  → subsequent calls to `getServerAdapter(type)` return
 *   the builtin fallback instead of the external adapter.  Already-running
 *   agent sessions are unaffected (they hold a reference to the module they
 *   started with).
 *
 * - `paused = false` → the external adapter is active again.
 *
 * Returns `true` if the state actually changed, `false` if the type is not
 * an override or was already in the requested state.
 */
export function setOverridePaused(type: string, paused: boolean): boolean {
  if (!builtinFallbacks.has(type)) return false;
  const wasPaused = pausedOverrides.has(type);
  if (paused && !wasPaused) {
    pausedOverrides.add(type);
    console.log(`[paperclip] Override paused for "${type}" — builtin adapter restored`);
    return true;
  }
  if (!paused && wasPaused) {
    pausedOverrides.delete(type);
    console.log(`[paperclip] Override resumed for "${type}" — external adapter active`);
    return true;
  }
  return false;
}

/** Check whether the external override for a builtin type is currently paused. */
export function isOverridePaused(type: string): boolean {
  return pausedOverrides.has(type);
}

/** Get the set of types whose overrides are currently paused. */
export function getPausedOverrides(): Set<string> {
  return pausedOverrides;
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export function findActiveServerAdapter(type: string): ServerAdapterModule | null {
  if (pausedOverrides.has(type)) {
    const fallback = builtinFallbacks.get(type);
    if (fallback) return fallback;
  }
  return adaptersByType.get(type) ?? null;
}
