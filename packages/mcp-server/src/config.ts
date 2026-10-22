export interface PaperclipMcpConfig {
  apiUrl: string;
  /**
   * Ordered fallback bases, most-preferred first. The Paperclip server exports
   * these as PAPERCLIP_RUNTIME_API_CANDIDATES_JSON at boot (see
   * server/src/runtime-api.ts buildRuntimeApiCandidateUrls). The first entry is
   * normally the primary base; later entries are other interfaces the same
   * instance answers on.
   */
  apiUrlCandidates?: readonly string[];
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function parseCandidatesJson(raw: string | undefined): string[] {
  const trimmed = nonEmpty(raw);
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Malformed export must never take the server down; the primary base still works.
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Build the ordered base list: `primary` first, then the server-exported
 * candidates in order, normalized and de-duplicated.
 */
export function buildApiUrlCandidates(
  primary: string | null,
  rawCandidatesJson: string | undefined,
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined, requireHttp: boolean): void => {
    const candidate = nonEmpty(value);
    if (!candidate) return;
    let normalized: string;
    try {
      const parsed = new URL(candidate);
      // A non-http(s) base is never a usable fetch target, so refuse it rather
      // than hand it to the client as a candidate.
      if (requireHttp && parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      normalized = normalizeApiUrl(parsed.origin);
    } catch {
      normalized = normalizeApiUrl(candidate);
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    ordered.push(normalized);
  };

  push(primary, false);
  for (const candidate of parseCandidatesJson(rawCandidatesJson)) push(candidate, true);
  return ordered;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  const configuredApiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  const apiUrlCandidates = buildApiUrlCandidates(
    configuredApiUrl,
    env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON,
  );
  // A missing PAPERCLIP_API_URL is survivable when the server exported reachable
  // candidates; fall back to the first one instead of hard-failing.
  const apiUrl = configuredApiUrl ?? apiUrlCandidates[0] ?? null;
  if (!apiUrl) {
    throw new Error("Missing PAPERCLIP_API_URL");
  }
  const apiKey = nonEmpty(env.PAPERCLIP_API_KEY);
  if (!apiKey) {
    throw new Error("Missing PAPERCLIP_API_KEY");
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiUrlCandidates,
    apiKey,
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: nonEmpty(env.PAPERCLIP_RUN_ID),
  };
}
