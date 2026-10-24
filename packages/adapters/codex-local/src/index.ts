import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "codex_local";
export const label = "Codex (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @openai/codex";

export const DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.3-codex";
export const DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX = true;
export const CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS = ["gpt-5.4"] as const;

/**
 * Models the Codex backend only serves to API-key credentials.
 *
 * A ChatGPT subscription credential gets `400 invalid_request_error` —
 * "The '<model>' model is not supported when using Codex with a ChatGPT
 * account." — for every one of these, so they must never be seeded into an
 * agent, offered by the picker, or reached through a model profile while a
 * ChatGPT credential is active.
 *
 * Verified by live probe against a ChatGPT Pro credential on 2026-10-22.
 */
export const CHATGPT_ACCOUNT_UNSERVABLE_MODELS = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
] as const;

/**
 * Model the adapter falls back to when a ChatGPT credential is active and the
 * requested model is one of `CHATGPT_ACCOUNT_UNSERVABLE_MODELS`.
 */
export const CHATGPT_ACCOUNT_DEFAULT_MODEL = "gpt-6-astra";

function normalizeModelId(model: string | null | undefined): string {
  return typeof model === "string" ? model.trim() : "";
}

export function isCodexLocalKnownModel(model: string | null | undefined): boolean {
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel) return false;
  return models.some((entry) => entry.id === normalizedModel);
}

export function isCodexLocalManualModel(model: string | null | undefined): boolean {
  const normalizedModel = normalizeModelId(model);
  return Boolean(normalizedModel) && !isCodexLocalKnownModel(normalizedModel);
}

export function isCodexLocalFastModeSupported(model: string | null | undefined): boolean {
  if (isCodexLocalManualModel(model)) return true;
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  return CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.includes(
    normalizedModel as (typeof CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS)[number],
  );
}

export const models = [
  { id: "gpt-5.4", label: "gpt-5.4" },
  { id: DEFAULT_CODEX_LOCAL_MODEL, label: DEFAULT_CODEX_LOCAL_MODEL },
  { id: CHATGPT_ACCOUNT_DEFAULT_MODEL, label: CHATGPT_ACCOUNT_DEFAULT_MODEL },
  { id: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
  { id: "gpt-5", label: "gpt-5" },
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "gpt-5-mini", label: "gpt-5-mini" },
  { id: "gpt-5-nano", label: "gpt-5-nano" },
  { id: "o3-mini", label: "o3-mini" },
  { id: "codex-mini-latest", label: "Codex Mini" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use the lowest-cost Codex local model lane the active credential can actually serve, without changing the primary model.",
    adapterConfig: {
      model: CHATGPT_ACCOUNT_DEFAULT_MODEL,
      modelReasoningEffort: "low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# codex_local agent configuration

Adapter: codex_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to stdin prompt at runtime
- model (string, optional): Codex model id
- modelReasoningEffort (string, optional): reasoning effort override (minimal|low|medium|high|xhigh) passed via -c model_reasoning_effort=...
- promptTemplate (string, optional): run prompt template. {{paperclipApiUrl}} resolves to the Paperclip API root (origin + /api), so a template can say {{paperclipApiUrl}}/agents/me/inbox-lite instead of hard-coding a literal base
- search (boolean, optional): run codex with --search
- fastMode (boolean, optional): enable Codex Fast mode; supported on GPT-5.4 and passed through for manual model IDs
- dangerouslyBypassApprovalsAndSandbox (boolean, optional): run with bypass flag
- command (string, optional): defaults to "codex"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Prompts are piped via stdin (Codex receives "-" prompt argument).
- If instructionsFilePath is configured, Paperclip prepends that file's contents to the stdin prompt on every run.
- Codex exec automatically applies repo-scoped AGENTS.md instructions from the active workspace. Paperclip cannot suppress that discovery in exec mode, so repo AGENTS.md files may still apply even when you only configured an explicit instructionsFilePath.
- Paperclip injects desired local skills into the effective CODEX_HOME/skills/ directory at execution time so Codex can discover "$paperclip" and related skills without polluting the project working directory. In managed-home mode (the default) this is ~/.paperclip/instances/<id>/companies/<companyId>/codex-home/skills/; when CODEX_HOME is explicitly overridden in adapter config, that override is used instead.
- Unless explicitly overridden in adapter config, Paperclip runs Codex with a per-company managed CODEX_HOME under the active Paperclip instance and seeds auth/config from the shared Codex home (the CODEX_HOME env var, when set, or ~/.codex).
- Some model/tool combinations reject certain effort levels (for example minimal with web search enabled).
- Fast mode is supported on GPT-5.4 and manual model IDs. When enabled for those models, Paperclip applies \`service_tier="fast"\` and \`features.fast_mode=true\`.
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;
