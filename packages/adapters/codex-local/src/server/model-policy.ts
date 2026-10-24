import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  CHATGPT_ACCOUNT_DEFAULT_MODEL,
  CHATGPT_ACCOUNT_UNSERVABLE_MODELS,
} from "../index.js";
import { resolveSharedCodexHomeDir } from "./codex-home.js";

/**
 * Which credential class the Codex CLI will authenticate with.
 *
 * - `chatgpt`   — a ChatGPT subscription login (`auth_mode: "chatgpt"` in
 *                 `auth.json`). Served-model set is restricted by the
 *                 subscription entitlement.
 * - `api_key`   — an OpenAI API key. Served-model set is the API-key one.
 * - `unknown`   — no readable `auth.json`, or a shape we do not recognise.
 *                 Treated permissively: we never narrow the model list on a
 *                 guess, because hiding a servable model is a worse failure
 *                 than offering one the operator can override.
 */
export type CodexCredentialScope = "chatgpt" | "api_key" | "unknown";

const UNSERVABLE_BY_CHATGPT_ACCOUNT: ReadonlySet<string> = new Set<string>(
  CHATGPT_ACCOUNT_UNSERVABLE_MODELS,
);

/**
 * Classify a raw `auth.json` payload without touching the filesystem.
 *
 * Exported separately from the reader so the classification is unit-testable
 * without a credential on disk.
 */
export function classifyCodexAuthJson(raw: string | null | undefined): CodexCredentialScope {
  if (typeof raw !== "string" || raw.trim().length === 0) return "unknown";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unknown";
  const record = parsed as Record<string, unknown>;

  const authMode = typeof record.auth_mode === "string" ? record.auth_mode.trim() : "";
  if (authMode.toLowerCase() === "chatgpt") return "chatgpt";

  const apiKey =
    typeof record.OPENAI_API_KEY === "string" ? record.OPENAI_API_KEY.trim() : "";
  if (apiKey.length > 0) return "api_key";

  // A `tokens` block is a ChatGPT login even when `auth_mode` is absent — older
  // Codex CLI builds wrote the token block without the discriminator.
  const tokens = record.tokens;
  if (typeof tokens === "object" && tokens !== null && !Array.isArray(tokens)) {
    const tokenRecord = tokens as Record<string, unknown>;
    const hasIdentity = ["access_token", "refresh_token", "id_token"].some(
      (key) =>
        typeof tokenRecord[key] === "string" &&
        tokenRecord[key]!.toString().trim().length > 0,
    );
    if (hasIdentity) return "chatgpt";
  }

  return "unknown";
}

/**
 * Resolve the credential scope from the Codex home the adapter will actually
 * authenticate against: `$CODEX_HOME` when set, otherwise `~/.codex`.
 */
export async function resolveCodexCredentialScope(
  codexHome?: string,
): Promise<CodexCredentialScope> {
  const home = codexHome ?? resolveSharedCodexHomeDir();
  let raw: string;
  try {
    raw = await fs.readFile(path.join(home, "auth.json"), "utf8");
  } catch {
    return "unknown";
  }
  return classifyCodexAuthJson(raw);
}

/** True when `model` can be served by a credential of the given scope. */
export function isModelServableForScope(model: string, scope: CodexCredentialScope): boolean {
  const id = model.trim();
  if (id.length === 0) return false;
  if (scope !== "chatgpt") return true;
  return !UNSERVABLE_BY_CHATGPT_ACCOUNT.has(id);
}

/**
 * Drop models the active credential cannot serve, so the picker cannot hand an
 * operator a model that is guaranteed to 400 on the next run.
 */
export function filterModelsForScope(
  models: AdapterModel[],
  scope: CodexCredentialScope,
): AdapterModel[] {
  if (scope !== "chatgpt") return models;
  return models.filter((model) => isModelServableForScope(model.id, scope));
}

/**
 * Resolve the model a run should actually ask for.
 *
 * Returns `null` when no model is configured, which is the caller's signal to
 * leave `--model` off entirely and let the Codex CLI use its own configured
 * default. A non-null result is always servable: an unservable configured model
 * is replaced by `CHATGPT_ACCOUNT_DEFAULT_MODEL` rather than passed through to
 * fail at request time.
 */
export function resolveServableModel(
  model: string | null | undefined,
  scope: CodexCredentialScope,
): string | null {
  const id = typeof model === "string" ? model.trim() : "";
  if (id.length === 0) return null;
  if (isModelServableForScope(id, scope)) return id;
  return CHATGPT_ACCOUNT_DEFAULT_MODEL;
}
