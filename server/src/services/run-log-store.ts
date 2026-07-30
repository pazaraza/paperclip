import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export interface RunLogRetentionLimits {
  /**
   * Maximum age, in milliseconds, for any retained per-run ndjson file. Files
   * strictly older than `now - retentionMs` (by mtime) are deleted.
   *
   * Required.
   */
  retentionMs: number;
  /**
   * Maximum number of files to delete in a single sweep. When the limit is
   * hit the sweep returns early with `hitLimit: true` so the caller can
   * re-schedule; this keeps a single stale run from blowing a sweep budget
   * on a multi-million-file backlog. Pass `Infinity` (or omit) for no cap.
   */
  maxDeleteCount?: number;
  /**
   * Optional whitelist of company directories the sweep is allowed to
   * prune. Top-level dirs in `basePath` that are NOT in this set are
   * skipped entirely — they may be orphan external-run-id dirs from a
   * pre-migration adapter (RUAAAAA-3200 audit) and must not be touched
   * by an automated sweep.
   *
   * When omitted, the sweep prunes all well-formed `<companyId>/<agentId>/*.ndjson`
   * files regardless of company.
   */
  allowedCompanyIds?: ReadonlySet<string>;
  /**
   * Override the wall-clock used for the cutoff. Defaults to `Date.now()`.
   * Tests inject a fixed clock here so they don't need to backdate mtimes.
   */
  now?: () => number;
}

export interface RunLogRetentionResult {
  prunedCount: number;
  bytesReclaimed: number;
  /** True when `maxDeleteCount` was hit and the sweep returned early. */
  hitLimit: boolean;
  /**
   * Companies whose top-level dirs were skipped (not in `allowedCompanyIds`,
   * or no longer present in the DB at sweep time). Useful for operator
   * diagnostics; not strictly required by callers.
   */
  skippedCompanyDirs: string[];
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<number>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
  /**
   * Sweep the on-disk store and delete per-run ndjson files older than
   * `limits.retentionMs`. Never touches:
   *   - top-level dirs that aren't in `limits.allowedCompanyIds` (when provided)
   *   - files where mtime is fresher than the cutoff
   *   - non-`.ndjson` files (only the active store shape deletes)
   *
   * Returns aggregate counts; idempotent and safe to re-run. See
   * RUAAAAA-3219.
   */
  pruneOlderThan(limits: RunLogRetentionLimits): Promise<RunLogRetentionResult>;
}

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

function _createLocalFileRunLogStoreForTests(basePath: string): RunLogStore {
  return createLocalFileRunLogStore(basePath);
}

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return 0;
      const absPath = resolveWithin(basePath, handle.logRef);
      const line = JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: event.chunk,
      });
      const persisted = `${line}\n`;
      await fs.appendFile(absPath, persisted, "utf8");
      return Buffer.byteLength(persisted, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");

      const hash = await sha256File(absPath);
      return {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
      };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      return readFileRange(absPath, offset, limitBytes);
    },

    async pruneOlderThan(limits) {
      const retentionMs = limits.retentionMs;
      if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
        throw new Error("retentionMs must be a positive finite number");
      }
      const now = limits.now ?? Date.now;
      const cutoff = now() - retentionMs;
      const maxDeleteCount = limits.maxDeleteCount ?? Number.POSITIVE_INFINITY;
      const allowedCompanyIds = limits.allowedCompanyIds ?? null;

      let prunedCount = 0;
      let bytesReclaimed = 0;
      let hitLimit = false;
      const skippedCompanyDirs: string[] = [];

      let topLevelEntries: import("node:fs").Dirent[];
      try {
        topLevelEntries = await fs.readdir(basePath, { withFileTypes: true });
      } catch (err: any) {
        if (err && err.code === "ENOENT") {
          // Store directory doesn't exist yet (fresh instance): no-op.
          return { prunedCount: 0, bytesReclaimed: 0, hitLimit: false, skippedCompanyDirs };
        }
        throw err;
      }

      outer: for (const topLevel of topLevelEntries) {
        if (!topLevel.isDirectory()) continue;
        const companyDirName = topLevel.name;
        const companyDirAbs = resolveWithin(basePath, companyDirName);

        // Per-company scope guard — when an allowlist is provided we prune
        // only those top-level dirs that look like real Paperclip companies.
        // Without an allowlist we still walk every dir, but we never touch
        // files that aren't shaped like `<dir>/<dir>/<file>.ndjson`.
        if (allowedCompanyIds && !allowedCompanyIds.has(companyDirName)) {
          skippedCompanyDirs.push(companyDirName);
          continue;
        }

        let agentEntries: import("node:fs").Dirent[];
        try {
          agentEntries = await fs.readdir(companyDirAbs, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const agentEntry of agentEntries) {
          if (!agentEntry.isDirectory()) continue;
          const agentDirAbs = resolveWithin(companyDirAbs, agentEntry.name);

          let runEntries: import("node:fs").Dirent[];
          try {
            runEntries = await fs.readdir(agentDirAbs, { withFileTypes: true });
          } catch {
            continue;
          }

          for (const runEntry of runEntries) {
            if (runEntry.isDirectory()) continue;
            if (!runEntry.name.endsWith(".ndjson")) continue;

            const runFileAbs = resolveWithin(agentDirAbs, runEntry.name);
            let stat;
            try {
              stat = await fs.stat(runFileAbs);
            } catch {
              continue;
            }
            if (!stat.isFile()) continue;

            // mtimeMs is fractional; a tiny in-band delta (files just inside
            // the boundary) must not be deleted. Use strict `< cutoff`.
            if (stat.mtimeMs >= cutoff) continue;

            if (prunedCount >= maxDeleteCount) {
              hitLimit = true;
              break outer;
            }

            try {
              await fs.unlink(runFileAbs);
              prunedCount += 1;
              bytesReclaimed += stat.size;
            } catch (err: any) {
              if (err && (err.code === "ENOENT" || err.code === "EACCES")) {
                // Already gone (concurrent sweep) or no permission to remove:
                // skip silently. A persistent permission issue will surface
                // on the next sweep tick when mtime is still in the past.
                continue;
              }
              throw err;
            }
          }
        }
      }

      return { prunedCount, bytesReclaimed, hitLimit, skippedCompanyDirs };
    },
  };
}

let cachedStore: RunLogStore | null = null;

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  cachedStore = createLocalFileRunLogStore(basePath);
  return cachedStore;
}

/**
 * Test-only factory: builds a fresh `RunLogStore` rooted at `basePath` without
 * touching the module-level cache that `getRunLogStore()` returns. Used by
 * `server/src/__tests__/run-log-store.test.ts` to spin isolated per-test
 * fixtures under `os.tmpdir()` and assert prune behavior deterministically.
 */
export function createRunLogStoreForTests(basePath: string): RunLogStore {
  return _createLocalFileRunLogStoreForTests(basePath);
}
