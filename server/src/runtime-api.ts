import os from "node:os";

function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::";
}

function isLinkLocalHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  if (normalized.startsWith("169.254.")) return true;
  // IPv6 link-local block is fe80::/10 (fe80:: through febf::)
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  return false;
}

/**
 * A bind host the server can actually be reached on, without operator extras.
 *
 * `bindHost` is the address the OS successfully bound the listener to, so it is
 * the only input to this module that is evidence of reachability. A wildcard
 * (0.0.0.0 / ::) says nothing about which interface answers, and an IPv6
 * link-local address cannot be dialed without a scope id, so both are excluded.
 */
function isConcreteBindHost(host: string | null | undefined): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  if (isWildcardHost(normalized)) return false;
  if (isLinkLocalHost(normalized)) return false;
  return true;
}

function formatOrigin(protocol: string, host: string, port: number): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") && !host.endsWith("]")
    ? `[${host}]`
    : host;
  return `${protocol}//${normalizedHost}:${port}`;
}

function pushCandidate(
  candidates: string[],
  seen: Set<string>,
  rawUrl: string | null | undefined,
): void {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return;
  try {
    const normalized = new URL(trimmed).origin;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  } catch {
    // Ignore malformed candidates.
  }
}

export function choosePrimaryRuntimeApiUrl(input: {
  authPublicBaseUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
}): string {
  const explicitPublicBaseUrl = input.authPublicBaseUrl?.trim();
  if (explicitPublicBaseUrl) {
    try {
      return new URL(explicitPublicBaseUrl).origin;
    } catch {
      // Fall through to derived candidates if config parsing drifted.
    }
  }

  // The bind host outranks allowedHostnames: it is the address the listener is
  // actually bound to. allowedHostnames is an unauthenticated config string
  // whose ordering carries no reachability guarantee, so a stale first entry
  // must never be able to advertise a base children cannot connect to
  // (RUAAAAA-5236). Operators who need an externally reachable origin still
  // declare it explicitly via authPublicBaseUrl above.
  if (isConcreteBindHost(input.bindHost)) {
    return formatOrigin("http:", normalizeHost(input.bindHost), input.port);
  }

  const allowedHostname = input.allowedHostnames
    .map((value) => value.trim())
    .find(Boolean);
  if (allowedHostname) {
    return formatOrigin("http:", allowedHostname, input.port);
  }

  return formatOrigin("http:", "localhost", input.port);
}

export function collectReachableInterfaceHosts(input: {
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
} = {}): string[] {
  const interfaces = input.networkInterfacesMap ?? os.networkInterfaces();
  const rankedHosts: Array<{ host: string; rank: number; index: number }> = [];
  const seen = new Set<string>();
  let index = 0;

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const host = normalizeHost(entry.address);
      if (!host || isLoopbackHost(host) || isWildcardHost(host) || isLinkLocalHost(host)) continue;
      if (seen.has(host)) continue;
      seen.add(host);
      rankedHosts.push({
        host,
        rank: entry.family === "IPv4" ? 0 : 1,
        index: index++,
      });
    }
  }

  return rankedHosts
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.host);
}

export function buildRuntimeApiCandidateUrls(input: {
  preferredApiUrl?: string | null;
  authPublicBaseUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const explicitPublicBaseUrl = input.authPublicBaseUrl?.trim() ?? "";
  const explicitOrigin = (() => {
    if (!explicitPublicBaseUrl) return null;
    try {
      return new URL(explicitPublicBaseUrl).origin;
    } catch {
      return null;
    }
  })();
  const protocol = explicitOrigin ? new URL(explicitOrigin).protocol : "http:";

  pushCandidate(candidates, seen, input.preferredApiUrl);
  pushCandidate(candidates, seen, explicitOrigin);

  // Same precedence as choosePrimaryRuntimeApiUrl: a concrete bind host is
  // reachable by construction, so it outranks the allowedHostnames entries.
  if (isConcreteBindHost(input.bindHost)) {
    pushCandidate(candidates, seen, formatOrigin(protocol, normalizeHost(input.bindHost), input.port));
  }

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHost(rawHost);
    if (!host) continue;
    pushCandidate(candidates, seen, formatOrigin(protocol, host, input.port));
  }

  if (explicitOrigin) {
    const hostname = new URL(explicitOrigin).hostname;
    if (isLoopbackHost(hostname)) {
      pushCandidate(candidates, seen, formatOrigin(protocol, "host.docker.internal", input.port));
    }
  }

  for (const host of collectReachableInterfaceHosts({ networkInterfacesMap: input.networkInterfacesMap })) {
    pushCandidate(candidates, seen, formatOrigin(protocol, host, input.port));
  }

  if (candidates.length === 0) {
    pushCandidate(
      candidates,
      seen,
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: input.authPublicBaseUrl,
        allowedHostnames: input.allowedHostnames,
        bindHost: input.bindHost,
        port: input.port,
      }),
    );
  }

  return candidates;
}
