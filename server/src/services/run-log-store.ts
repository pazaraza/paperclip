import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { addAbortSignal } from "node:stream";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import type { StorageProvider } from "../storage/types.js";

export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
  attemptId?: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
  signal?: AbortSignal;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  // Null means a stalled write prevented a verified final snapshot. Callers
  // can still settle the run without recording a false byte count or hash.
  bytes: number | null;
  sha256?: string | null;
  compressed: boolean;
}

export interface RunLogBeginInput {
  companyId: string;
  agentId: string;
  runId: string;
  // Set only when persisted run lifecycle state proves no earlier attempt
  // began this log, so no durable prefix can exist to restore. Omitted means
  // the run may be a retry or recovery and the durable mirror is checked.
  newRun?: boolean;
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
   * Override the wall-clock used for the cutoff. Defaults to `Date.now`.
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
  begin(input: RunLogBeginInput): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string; seq?: number },
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
  // Optional so existing fakes/fixtures keep compiling: uploads every dirty
  // in-flight mirror immediately (graceful-shutdown path). No-op when the
  // in-flight mirror is not enabled.
  flushInflightMirrors?(): Promise<void>;
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

function normalizeKeyPrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export interface DurableRunLogStoreOptions {
  basePath: string;
  // When provided, completed logs are mirrored to object storage on finalize and
  // served from there on read whenever the local file is missing (e.g. the pod
  // rolled and wiped the emptyDir). When omitted, the store is local-only (the
  // historical behaviour: a restart loses the log).
  s3?: {
    provider: StorageProvider;
    keyPrefix?: string;
    // When > 0, ALSO mirror the still-running log to the same object key at
    // most once per this interval (plus a flush hook for graceful shutdown),
    // so a crash mid-run loses at most one interval's tail instead of the
    // whole log. Off (undefined/0) preserves the historical finalize-only
    // mirroring: no extra PUT traffic unless explicitly opted in.
    inflightMirrorMs?: number;
  };
}

// Run-log store with TRANSPARENT durability. The store id stays "local_file" so
// nothing downstream (feedback.ts, the heartbeat read cast, fixtures) changes;
// the S3 mirror is keyed by the same logRef and is purely an implementation
// detail. Live append/tail stays on the pod-local file (fast, no per-chunk PUT);
// on finalize the complete .ndjson is uploaded to object storage; on read we try
// local first and fall back to S3 when the local file is gone. This is the fix
// for "Run log not found" after a deploy/restart (the /paperclip data dir is an
// emptyDir in cloud_tenant mode -- persistence is disabled to avoid the
// operator's privileged selinux-relabel init container in our hardened ns).
//
// Optionally (inflightMirrorMs > 0) the still-running log is ALSO mirrored to
// the same key at a throttled cadence and flushed on graceful shutdown, so a
// restart mid-run preserves the tail up to the last mirror instead of losing
// the whole in-flight log. Finalize retires the in-flight bookkeeping (waiting
// out any upload already on the wire) before writing the complete file, so a
// stale partial can never overwrite a finalized log.

/**
 * Sweep the on-disk store and delete per-run ndjson files older than
 * `limits.retentionMs`. Never touches:
 *   - top-level dirs that aren't in `limits.allowedCompanyIds` (when provided)
 *   - files where mtime is fresher than the cutoff
 *   - non-`.ndjson` files (only the active store shape deletes)
 *
 * Returns aggregate counts; idempotent and safe to re-run. See RUAAAAA-3219.
 *
 * Only the LOCAL mirror is swept. The S3 mirror is the durable copy of a
 * finalized log; pruning it is a separate lifecycle decision and is not
 * implied by the local retention setting.
 */
async function pruneRunLogStore(
  basePath: string,
  limits: RunLogRetentionLimits,
): Promise<RunLogRetentionResult> {
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
}

export function createDurableRunLogStore(options: DurableRunLogStoreOptions): RunLogStore {
  const { basePath } = options;
  const s3 = options.s3;
  const s3Prefix = normalizeKeyPrefix(s3?.keyPrefix);
  const inflightMirrorMs = s3?.inflightMirrorMs && s3.inflightMirrorMs > 0 ? s3.inflightMirrorMs : 0;
  // A run owns the write handle returned by begin(). Diagnostics can be
  // dispatched without awaiting the rest of onLog (DB progress/live events),
  // but finalize must include every file append already accepted on that handle.
  // Weak collections let completed handles disappear with their owning runs.
  const pendingAppends = new WeakMap<RunLogHandle, Set<Promise<void>>>();
  const closingHandles = new WeakSet<RunLogHandle>();
  const abandonedHandles = new WeakSet<RunLogHandle>();

  function s3Key(logRef: string): string {
    return s3Prefix ? `${s3Prefix}/${logRef}` : logRef;
  }

  // In-flight mirror bookkeeping, keyed by logRef. The mirror uploads the
  // CURRENT (partial) file to the SAME key finalize uses: readers already
  // range-read that key, so a partial object is served exactly like a live
  // tail, and finalize simply overwrites it with the complete file. One
  // entry exists only between the first post-interval-eligible append and
  // finalize.
  interface InflightMirrorEntry {
    dirty: boolean;
    lastMirrorAt: number;
    timer: NodeJS.Timeout | null;
    upload: Promise<boolean> | null;
  }
  const inflightMirrors = new Map<string, InflightMirrorEntry>();

  function mirrorInflightNow(logRef: string, entry: InflightMirrorEntry): Promise<boolean> {
    entry.dirty = false;
    const upload = (async () => {
      const absPath = resolveWithin(basePath, logRef);
      const stat = await fs.stat(absPath);
      if (stat.size === 0) return true;
      await s3!.provider.putObject({
        objectKey: s3Key(logRef),
        // Bound the stream to the stat'ed size: the run is still appending,
        // and an unbounded stream that grows past stat.size would violate
        // the declared contentLength and fail (or truncate) the upload.
        // Bytes appended after the stat stay dirty and ride the next mirror.
        body: createReadStream(absPath, { start: 0, end: stat.size - 1 }),
        contentType: "application/x-ndjson",
        contentLength: stat.size,
      });
      return true;
    })().catch((err) => {
      // Best-effort like the finalize mirror: a failing upload must never
      // break the run, but a persistently broken mirror should be visible.
      console.warn(
        `[run-log-store] Failed to mirror in-flight run log to object storage (key: ${s3Key(logRef)}):`,
        err,
      );
      // Re-dirty so the tail retries next interval even without new appends;
      // the lastMirrorAt stamp below bounds retries to one per interval.
      entry.dirty = true;
      return false;
    }).finally(() => {
      // Stamp AFTER the attempt so a slow or failing endpoint self-throttles
      // to one attempt per interval instead of hot-looping.
      entry.lastMirrorAt = Date.now();
      entry.upload = null;
      if (entry.dirty) scheduleInflightMirror(logRef, entry);
    });
    entry.upload = upload;
    return upload;
  }

  function scheduleInflightMirror(logRef: string, entry: InflightMirrorEntry): void {
    if (inflightMirrors.get(logRef) !== entry) return;
    if (entry.timer || entry.upload) return;
    const delay = Math.max(0, inflightMirrorMs - (Date.now() - entry.lastMirrorAt));
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void mirrorInflightNow(logRef, entry);
    }, delay);
    // Never keep the process alive just to mirror a tail.
    entry.timer.unref?.();
  }

  function noteInflightAppend(logRef: string): void {
    if (!s3 || inflightMirrorMs <= 0) return;
    let entry = inflightMirrors.get(logRef);
    if (!entry) {
      // First mirror lands one full interval after the first append: a run
      // that finalizes sooner is covered by the finalize upload, and this
      // keeps the steady-state cost at one PUT per interval per active run.
      entry = { dirty: false, lastMirrorAt: Date.now(), timer: null, upload: null };
      inflightMirrors.set(logRef, entry);
    }
    entry.dirty = true;
    scheduleInflightMirror(logRef, entry);
  }

  async function retireInflightMirror(logRef: string): Promise<void> {
    const entry = inflightMirrors.get(logRef);
    if (!entry) return;
    inflightMirrors.delete(logRef);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    // An upload still in flight could otherwise finish AFTER finalize's
    // complete-file upload and overwrite it with a stale partial.
    if (entry.upload) await entry.upload;
  }

  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readLocalRange(
    filePath: string,
    offset: number,
    limitBytes: number,
    signal?: AbortSignal,
  ): Promise<RunLogReadResult | null> {
    signal?.throwIfAborted();
    const start = Math.max(0, offset);
    // Read one extra byte to discover whether another page exists. A single
    // abortable stream avoids an uncancellable stat before opening the file.
    const chunks: Buffer[] = [];
    try {
      const stream = createReadStream(filePath, { start, end: start + limitBytes, signal });
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch (err) {
      signal?.throwIfAborted();
      // A missing file, including deletion before open, falls back to S3.
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
      throw err;
    }
    signal?.throwIfAborted();
    const bytes = Buffer.concat(chunks);
    const content = bytes.subarray(0, limitBytes).toString("utf8");
    const nextOffset = bytes.length > limitBytes ? start + limitBytes : undefined;
    return { content, nextOffset };
  }

  async function readS3Range(
    logRef: string,
    offset: number,
    limitBytes: number,
    signal?: AbortSignal,
  ): Promise<RunLogReadResult> {
    signal?.throwIfAborted();
    if (!s3) throw notFound("Run log not found");
    const key = s3Key(logRef);
    const head = await s3.provider.headObject({ objectKey: key, signal });
    signal?.throwIfAborted();
    if (!head.exists) throw notFound("Run log not found");
    const total = head.contentLength ?? 0;
    const start = Math.max(0, Math.min(offset, total));
    // Unlike local file streams, S3 rejects a range that starts at or past
    // EOF with 416 InvalidRange, so a caught-up reader (offset === total)
    // must short-circuit to an empty read instead of clamping end up to
    // start and requesting `bytes=total-total`.
    const end = Math.min(start + limitBytes - 1, total - 1);
    if (total === 0 || start > end) return { content: "", nextOffset: start < total ? start : undefined };

    const result = await s3.provider.getObject({ objectKey: key, range: { start, end }, signal });
    // Destroy a body that stalls after headers arrive, including a body
    // returned just after the caller cancelled the request.
    if (signal) addAbortSignal(signal, result.stream);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    signal?.throwIfAborted();
    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < total ? end + 1 : undefined;
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
      await retireInflightMirror(relPath);
      // Retries share a run ID. Never truncate their earlier evidence. On a
      // new pod, restore the durable prefix before opening another attempt.
      // A proven-new run has no prefix, so skip the remote round trip.
      const exists = await fs.stat(absPath).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (!exists && s3 && input.newRun !== true) {
        const key = s3Key(relPath);
        const head = await s3.provider.headObject({ objectKey: key });
        if (head.exists) {
          const temporary = `${absPath}.${randomUUID()}.restore`;
          try {
            const object = await s3.provider.getObject({ objectKey: key });
            await pipeline(object.stream, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
            if (typeof head.contentLength === "number" && (await fs.stat(temporary)).size !== head.contentLength) {
              throw new Error("Durable run log restore returned an incomplete prefix");
            }
            // Publish the complete prefix without replacing a file another
            // attempt has already restored and started appending to.
            await fs.link(temporary, absPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
            });
          } finally {
            await fs.rm(temporary, { force: true });
          }
        }
      }
      const file = await fs.open(absPath, "a", 0o600);
      await file.close();
      return { store: "local_file", logRef: relPath, attemptId: randomUUID() };
    },

    async append(handle, event) {
      if (handle.store !== "local_file" || closingHandles.has(handle)) return 0;
      const absPath = resolveWithin(basePath, handle.logRef);
      const line = JSON.stringify({
        ts: event.ts,
        ...(handle.attemptId ? { attemptId: handle.attemptId } : {}),
        stream: event.stream,
        chunk: event.chunk,
        // Monotonic per-run sequence so readers can dedupe and order records
        // even when several identical chunks share the same millisecond ts
        // (common for ACP-style token deltas).
        ...(typeof event.seq === "number" && Number.isFinite(event.seq) ? { seq: event.seq } : {}),
      });
      const persisted = `${line}\n`;
      let pending = pendingAppends.get(handle);
      if (!pending) {
        pending = new Set();
        pendingAppends.set(handle, pending);
      }
      const write = fs.appendFile(absPath, persisted, "utf8").then(() => {
        if (!closingHandles.has(handle)) noteInflightAppend(handle.logRef);
      });
      pending.add(write);
      try {
        await write;
      } finally {
        pending.delete(write);
      }
      return Buffer.byteLength(persisted, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") return { bytes: 0, compressed: false };
      if (abandonedHandles.has(handle)) return { bytes: null, sha256: null, compressed: false };
      // Close admission before the first await. Drain file writes only, not
      // heartbeat's later DB/live-event persistence, then freeze one consistent
      // byte count, hash, and durable copy. Late diagnostics cannot mutate it.
      closingHandles.add(handle);
      let drainTimer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        Promise.allSettled(pendingAppends.get(handle) ?? []).then(() => true),
        new Promise<boolean>((resolve) => {
          drainTimer = setTimeout(() => resolve(false), 3_000);
          drainTimer.unref?.();
        }),
      ]).finally(() => clearTimeout(drainTimer));
      if (!drained) {
        // An in-flight fs append cannot be cancelled safely. Do not hash or
        // mirror a file it may still change, and never re-arm mirroring when
        // that write eventually finishes. Terminal run status can still settle.
        abandonedHandles.add(handle);
        void retireInflightMirror(handle.logRef).catch(() => undefined);
        console.warn("[run-log-store] Pending log writes did not settle within 3000ms; final log size and hash are unknown.");
        return { bytes: null, sha256: null, compressed: false };
      }
      await retireInflightMirror(handle.logRef);
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");
      const hash = await sha256File(absPath);

      // Mirror the completed log to object storage so it survives a pod roll.
      // Best-effort upload failures must NOT fail run finalization (which also
      // records cost/usage); the local copy still serves reads until the pod
      // rolls, and a failed mirror only loses durability for that one run.
      if (s3) {
        try {
          // Stream from disk instead of buffering the whole .ndjson in the
          // heap; long agent sessions can produce large logs. The file is
          // complete at this point, so stat.size is the exact content length.
          await s3.provider.putObject({
            objectKey: s3Key(handle.logRef),
            body: createReadStream(absPath),
            contentType: "application/x-ndjson",
            contentLength: stat.size,
          });
        } catch (err) {
          // Best-effort: finalization must not break, but a persistently
          // failing mirror (bad creds/bucket/endpoint) should be visible to
          // operators before a pod roll makes the logs unreadable.
          console.warn(
            `[run-log-store] Failed to mirror run log to object storage (key: ${s3Key(handle.logRef)}):`,
            err,
          );
        }
      }

      return { bytes: stat.size, sha256: hash, compressed: false };
    },

    async read(handle, opts) {
      opts?.signal?.throwIfAborted();
      if (handle.store !== "local_file") throw notFound("Run log not found");
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      const local = await readLocalRange(absPath, offset, limitBytes, opts?.signal);
      if (local) return local;
      // Local file gone (pod rolled) -> serve from the S3 mirror if configured.
      return readS3Range(handle.logRef, offset, limitBytes, opts?.signal);
    },

    async pruneOlderThan(limits) {
      return pruneRunLogStore(basePath, limits);
    },

    async flushInflightMirrors() {
      if (!s3 || inflightMirrorMs <= 0) return;
      const flushEntry = async (logRef: string, entry: InflightMirrorEntry) => {
        // Loop until the entry is clean: an append that lands while an
        // upload is on the wire re-dirties the entry, and its follow-up
        // mirror sits on an unref'ed timer that would never fire once the
        // process exits — so re-check after every await instead of trusting
        // a single pass. A FAILED attempt ends the loop instead of retrying:
        // hot-looping a down endpoint at shutdown would spin forever, and
        // the flush is best-effort by design.
        for (;;) {
          if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
          }
          if (entry.upload) {
            await entry.upload;
            continue;
          }
          if (!entry.dirty) return;
          const uploaded = await mirrorInflightNow(logRef, entry);
          if (!uploaded) {
            if (entry.timer) {
              clearTimeout(entry.timer);
              entry.timer = null;
            }
            return;
          }
        }
      };
      await Promise.all([...inflightMirrors].map(([logRef, entry]) => flushEntry(logRef, entry)));
    },
  };
}

// Build the run-log S3 mirror from dedicated RUN_LOG_S3_* env. Deliberately
// separate from PAPERCLIP_STORAGE_PROVIDER so enabling durable run logs does
// NOT redirect the product's workspace/file storage (smaller blast radius).
// Unset RUN_LOG_S3_BUCKET -> no mirror -> local-only (safe degrade). Creds come
// from the standard AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY chain.
function resolveRunLogS3(): DurableRunLogStoreOptions["s3"] {
  const bucket = process.env.RUN_LOG_S3_BUCKET?.trim();
  if (!bucket) return undefined;
  const provider = createS3StorageProvider({
    bucket,
    region: process.env.RUN_LOG_S3_REGION?.trim() || "us-east-1",
    endpoint: process.env.RUN_LOG_S3_ENDPOINT?.trim() || undefined,
    prefix: undefined, // prefixing is handled by keyPrefix below (kept off the provider)
    forcePathStyle: process.env.RUN_LOG_S3_FORCE_PATH_STYLE
      ? process.env.RUN_LOG_S3_FORCE_PATH_STYLE === "true"
      : true, // Cubbit (and most S3-compatible endpoints) need path-style
  });
  // Opt-in in-flight tail mirroring: at most one partial upload per interval
  // per active run, so a crash loses at most one interval's tail. Unset/0
  // keeps the historical finalize-only mirroring.
  const inflightSeconds = Number.parseFloat(process.env.RUN_LOG_S3_INFLIGHT_MIRROR_SECONDS ?? "");
  return {
    provider,
    keyPrefix: process.env.RUN_LOG_S3_PREFIX?.trim() || "run-logs",
    inflightMirrorMs:
      Number.isFinite(inflightSeconds) && inflightSeconds > 0 ? Math.round(inflightSeconds * 1000) : undefined,
  };
}

let cachedStore: RunLogStore | null = null;

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  cachedStore = createDurableRunLogStore({ basePath, s3: resolveRunLogS3() });
  return cachedStore;
}

// Graceful-shutdown hook: upload every dirty in-flight run-log tail before
// the process exits, so an orderly restart (deploy, SIGTERM) loses nothing
// even for runs that never reach finalize. No-op when the store was never
// created or in-flight mirroring is off.
/**
 * Test-only factory: builds a fresh `RunLogStore` rooted at `basePath` without
 * touching the module-level cache that `getRunLogStore()` returns. Used by
 * `server/src/__tests__/run-log-store.test.ts` to spin isolated per-test
 * fixtures under `os.tmpdir()` and assert prune behavior deterministically.
 */
export function createRunLogStoreForTests(basePath: string): RunLogStore {
  return createDurableRunLogStore({ basePath });
}

export async function flushInFlightRunLogMirrors(): Promise<void> {
  await cachedStore?.flushInflightMirrors?.();
}
