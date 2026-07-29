import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

// Log rotation policy (RUAAAAA-3192):
// - Implemented via pino-roll transport (size-based + daily cap)
// - Filenames follow pino-roll's `filename.date.count.extension` convention, e.g.
//     server.2026-07-29.1.log  ← active file (today, count 1)
//     server.2026-07-29.2.log  ← rotated today (if a second rotation happens)
//     server.2026-07-28.1.log  ← yesterday's first
//   With limit.count=2 + removeOtherLogFiles=true, pino-roll v4 keeps exactly
//   `count` files on disk (1 active + 1 most-recent rotated), so the worst-case
//   footprint is ~200 MiB at the 100 MiB size cap.
// - The transport calls `destination.reopen(newFileName)` after flushing
//   buffered writes, so the new active file handle is in place before the next
//   log line — recovery from a rotated log is automatic with no process restart.
// - `limit.removeOtherLogFiles: true` is set so legacy files (e.g. a pre-rotation
//   `server.log` without date/count segments) are also reaped on the next
//   rotation cycle.
// - Override via env vars:
//     PAPERCLIP_LOG_ROTATE_SIZE   size string (default "100m")
//     PAPERCLIP_LOG_ROTATE_COUNT  number of files to keep (default 2)
// NOTE: pino-roll's parseSize() treats raw numbers as MB (multiplier 1024^2),
// so we deliberately pass the size as a string with an explicit "m" suffix to
// avoid double-multiplication. Use the env var only with a unit ("k", "m", "g").
const logRotateSize = process.env.PAPERCLIP_LOG_ROTATE_SIZE?.trim() || "100m";
const logRotateCount = Number.parseInt(process.env.PAPERCLIP_LOG_ROTATE_COUNT ?? "", 10) || 2;

export const logger = pino({
  level: "debug",
  redact: ["req.headers.authorization"],
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-roll",
      options: {
        file: logFile,
        size: logRotateSize,
        frequency: "daily",
        dateFormat: "yyyy-MM-dd",
        extension: "log",
        mkdir: true,
        limit: {
          count: logRotateCount,
          removeOtherLogFiles: true,
        },
      },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = body;
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = query;
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
