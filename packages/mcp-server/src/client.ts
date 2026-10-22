import type { PaperclipMcpConfig } from "./config.js";
import { normalizeApiUrl } from "./config.js";

/**
 * Transport error codes that mean the request provably never reached a server:
 * the TCP connection was refused, the name did not resolve, or the connect
 * attempt timed out. A request that failed this way is always safe to replay
 * against the next candidate, including writes.
 */
const CONNECT_PHASE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

function collectErrorCodes(error: unknown, depth = 0): string[] {
  if (depth > 4 || !error || typeof error !== "object") return [];
  const codes: string[] = [];
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") codes.push(code);
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) codes.push(...collectErrorCodes(cause, depth + 1));
  return codes;
}

/** True when the fetch never established a connection, so a retry cannot duplicate a write. */
export function isConnectPhaseFailure(error: unknown): boolean {
  if (error instanceof PaperclipApiError) return false;
  return collectErrorCodes(error).some((code) => CONNECT_PHASE_ERROR_CODES.has(code));
}

/** True when `error` is any transport-level failure (fetch rejected, no HTTP response). */
export function isTransportFailure(error: unknown): boolean {
  if (error instanceof PaperclipApiError) return false;
  return error instanceof TypeError || collectErrorCodes(error).length > 0;
}

export function resolveApiUrlCandidates(config: PaperclipMcpConfig): string[] {
  const primary = normalizeApiUrl(config.apiUrl);
  const seen = new Set([primary]);
  const ordered = [primary];
  for (const candidate of config.apiUrlCandidates ?? []) {
    const trimmed = typeof candidate === "string" ? candidate.trim() : "";
    if (!trimmed) continue;
    const normalized = normalizeApiUrl(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

export class PaperclipApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(input: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    message: string;
  }) {
    super(input.message);
    this.name = "PaperclipApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.body = input.body;
  }
}

export interface JsonRequestOptions {
  body?: unknown;
  includeRunId?: boolean;
}

function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function buildErrorMessage(method: string, path: string, status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return `${method} ${path} failed with ${status}: ${body.error}`;
  }
  return `${method} ${path} failed with ${status}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class PaperclipApiClient {
  private readonly candidates: string[];
  private activeCandidateIndex = 0;

  constructor(private readonly config: PaperclipMcpConfig) {
    this.candidates = resolveApiUrlCandidates(config);
  }

  /** The base currently in use (the primary until a failover proves otherwise). */
  get activeApiUrl(): string {
    return this.candidates[this.activeCandidateIndex] ?? normalizeApiUrl(this.config.apiUrl);
  }

  get apiUrlCandidates(): readonly string[] {
    return this.candidates;
  }

  get defaults() {
    return {
      companyId: this.config.companyId,
      agentId: this.config.agentId,
      runId: this.config.runId,
    };
  }

  resolveCompanyId(companyId?: string | null): string {
    const resolved = companyId?.trim() || this.config.companyId;
    if (!resolved) {
      throw new Error("companyId is required because PAPERCLIP_COMPANY_ID is not set");
    }
    return resolved;
  }

  resolveAgentId(agentId?: string | null): string {
    const resolved = agentId?.trim() || this.config.agentId;
    if (!resolved) {
      throw new Error("agentId is required because PAPERCLIP_AGENT_ID is not set");
    }
    return resolved;
  }

  private buildRequest(
    method: string,
    path: string,
    options: JsonRequestOptions,
    apiUrl: string,
  ): { url: URL; init: RequestInit } {
    const url = new URL(path.slice(1), `${apiUrl}/`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if ((options.includeRunId ?? isWriteMethod(method)) && this.config.runId) {
      headers["X-Paperclip-Run-Id"] = this.config.runId;
    }
    return {
      url,
      init: {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      },
    };
  }

  async requestJson<T>(method: string, path: string, options: JsonRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error(`API path must start with "/": ${path}`);
    }

    const upperMethod = method.toUpperCase();
    const replaySafe = IDEMPOTENT_METHODS.has(upperMethod);
    let lastError: unknown = null;

    for (let attempt = 0; attempt < this.candidates.length; attempt += 1) {
      const index = (this.activeCandidateIndex + attempt) % this.candidates.length;
      const apiUrl = this.candidates[index] ?? normalizeApiUrl(this.config.apiUrl);
      const { url, init } = this.buildRequest(method, path, options, apiUrl);

      try {
        const response = await fetch(url, init);
        const parsedBody = await parseResponseBody(response);

        if (!response.ok) {
          // An HTTP status means the base is reachable; never fail over on it.
          throw new PaperclipApiError({
            status: response.status,
            method: upperMethod,
            path,
            body: parsedBody,
            message: buildErrorMessage(upperMethod, path, response.status, parsedBody),
          });
        }

        this.activeCandidateIndex = index;
        return parsedBody as T;
      } catch (error) {
        lastError = error;
        if (error instanceof PaperclipApiError) throw error;
        const canRetry =
          attempt < this.candidates.length - 1 &&
          (isConnectPhaseFailure(error) || (replaySafe && isTransportFailure(error)));
        if (!canRetry) throw error;
      }
    }

    throw lastError;
  }
}
