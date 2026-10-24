import path from "node:path";
import fs from "node:fs";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import pino from "pino";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import { HTTP_LOG_REDACT_PATHS } from "./http-log-redaction.js";
import {
  isPrivateWebhookHttpRequest,
  isSecretSensitiveHttpRequest,
  isPrivateAgentCommentaryHttpRequest,
  isPrivateAgentObservabilityHttpRequest,
  isPrivateMuseHttpRequest,
  shouldSilenceHttpSuccessLog,
} from "./http-log-policy.js";
import {
  redactSensitive,
  stripSecretBearingUrlParts,
} from "./redact-sensitive.js";

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};


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


// Log rotation policy (RUAAAAA-3192, tuned per RUAAAAA-3201):
// - Implemented via pino-roll transport (size-based + daily cap)
// - Filenames follow pino-roll's `filename.date.count.extension` convention, e.g.
//     server.2026-07-29.1.log  ← active file (today, count 1)
//     server.2026-07-29.2.log  ← rotated today (if a second rotation happens)
//     server.2026-07-28.1.log  ← yesterday's first
//   With `frequency: "daily" + limit.count` pino-roll keeps one file per day
//   for the most recent `count` days, so `count=7` means "keep last 7 days"
//   (per the 3201 audit). Worst-case footprint is `count × size` — at the
//   defaults (count=7, size=100m) that's ~700 MiB. Realistic footprint at
//   current traffic (~1.5 MiB/day) is ~10 MiB.
// - The transport calls `destination.reopen(newFileName)` after flushing
//   buffered writes, so the new active file handle is in place before the next
//   log line — recovery from a rotated log is automatic with no process restart.
// - `limit.removeOtherLogFiles: true` is set so legacy files (e.g. a pre-rotation
//   `server.log` without date/count segments) are also reaped on the next
//   rotation cycle. Note: this only reaps files matching pino-roll's understood
//   naming pattern — files with non-standard suffixes (e.g. the 20260512
//   recovery-snapshots `.tail` files) are NOT automatically reaped and must be
//   cleaned up manually (see RUAAAAA-3201).
// - Override via env vars:
//     PAPERCLIP_LOG_ROTATE_SIZE   size string (default "100m")
//     PAPERCLIP_LOG_ROTATE_COUNT  number of days to keep (default 7)
// NOTE: pino-roll's parseSize() treats raw numbers as MB (multiplier 1024^2),
// so we deliberately pass the size as a string with an explicit "m" suffix to
// avoid double-multiplication. Use the env var only with a unit ("k", "m", "g").
const logRotateSize = process.env.PAPERCLIP_LOG_ROTATE_SIZE?.trim() || "100m";
const logRotateCount = Number.parseInt(process.env.PAPERCLIP_LOG_ROTATE_COUNT ?? "", 10) || 7;

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

function requestClassificationUrl(req: {
  originalUrl?: unknown;
  url?: unknown;
}): string | undefined {
  return typeof req.originalUrl === "string"
    ? req.originalUrl
    : typeof req.url === "string"
      ? req.url
      : undefined;
}

function isPrivateWebhook(req: {
  method?: string;
  originalUrl?: unknown;
  url?: unknown;
}) {
  return isPrivateWebhookHttpRequest(
    req.method,
    requestClassificationUrl(req),
  );
}

function privateWebhookLogUrl(url: unknown) {
  return typeof url === "string" && /\/routine-triggers\/public(?:\/|$)/i.test(url)
    ? "/api/routine-triggers/public/:publicId/fire"
    : "/api/chat-webhooks/:publicId/:provider";
}

function requestLogUrl(req: {
  method?: string;
  originalUrl?: unknown;
  url?: unknown;
}) {
  if(isPrivateMuseHttpRequest(requestClassificationUrl(req)))return "/api/muse/:protocol";
  if (isPrivateAgentObservabilityHttpRequest(requestClassificationUrl(req))) return "/api/companies/:companyId/observability";
  return isPrivateWebhook(req)
    ? privateWebhookLogUrl(requestClassificationUrl(req))
    : stripSecretBearingUrlParts(typeof req.url === "string" ? req.url : "");
}

export function createHttpLogger(baseLogger: Logger) {
  return pinoHttp({
    logger: baseLogger,
    serializers: {
      req(req: Record<string, unknown> & { url?: unknown }) {
        if (isPrivateAgentObservabilityHttpRequest(typeof req.url === "string" ? req.url : undefined)) {
          return { id: req.id, method: req.method, url: "/api/companies/:companyId/observability" };
        }
        if(isPrivateMuseHttpRequest(typeof req.url === "string" ? req.url : undefined))return {id:req.id,method:req.method,url:"/api/muse/:protocol"};
        if (isPrivateAgentCommentaryHttpRequest(typeof req.url === "string" ? req.url : undefined)) {
          return { id: req.id, method: req.method, url: stripSecretBearingUrlParts(req.url as string) };
        }
        if (
          isPrivateWebhook({
            method: typeof req.method === "string" ? req.method : undefined,
            url: req.url,
          })
        ) {
          // pino's standard request serializer has already selected originalUrl.
          // A closed projection also excludes params, arbitrary headers and any
          // parser/SDK-added body copies, including Buffer numeric byte keys.
          return {
            id: req.id,
            method: req.method,
            url: privateWebhookLogUrl(req.url),
          };
        }
        return {
          ...req,
          url:
            typeof req.url === "string"
              ? stripSecretBearingUrlParts(req.url)
              : req.url,
          // The URL policy intentionally drops all query parameters. The default
          // serializer also exposes the parsed query separately, so omit that
          // duplicate path instead of letting credentials bypass the URL scrub.
          query: undefined,
        };
      },
      res(
        res: Record<string, unknown> & {
          raw?: {
            req?: { method?: string; originalUrl?: unknown; url?: unknown };
          };
        },
      ) {
        // A provider error may also be reflected in response headers. Keep the
        // same content-free contract on both sides of a webhook request.
        return res.raw?.req && (isPrivateWebhook(res.raw.req) || isPrivateMuseHttpRequest(requestClassificationUrl(res.raw.req)) || isPrivateAgentCommentaryHttpRequest(requestClassificationUrl(res.raw.req)) || isPrivateAgentObservabilityHttpRequest(requestClassificationUrl(res.raw.req)))
          ? { statusCode: res.statusCode }
          : res;
      },
    },
    customLogLevel(_req, res, err) {
      if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
        return "silent";
      }
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage(req, res) {
      return `${req.method} ${requestLogUrl(req)} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      if (
        isSecretSensitiveHttpRequest(req.method, requestClassificationUrl(req))
      ) {
        return `${req.method} ${requestLogUrl(req)} ${res.statusCode} — request failed`;
      }
      const ctx = (res as any).__errorContext;
      const errMsg =
        ctx?.error?.message ||
        err?.message ||
        (res as any).err?.message ||
        "unknown error";
      return `${req.method} ${stripSecretBearingUrlParts(req.url ?? "")} ${res.statusCode} — ${errMsg}`;
    },
    customErrorObject(req, _res, _err, value) {
      if (isPrivateAgentObservabilityHttpRequest(requestClassificationUrl(req))) {
        return { ...value, err: { type: "Error", message: "Agent observability request failed" } };
      }
      if (isPrivateMuseHttpRequest(requestClassificationUrl(req)))return {...value,err:{type:"Error",message:"External agent request failed"}};
      if (isPrivateAgentCommentaryHttpRequest(requestClassificationUrl(req))) {
        return { ...value, err: { type: "Error", message: "Feedback request failed" } };
      }
      // pino-http serializes res.err independently of customProps/errorContext.
      // Do not rely on a particular error handler having sanitized an SDK Error.
      return isPrivateWebhook(req)
        ? {
            ...value,
            err: { type: "Error", message: "Chat webhook request failed" },
          }
        : value;
    },
    customProps(req, res) {
      if (res.statusCode >= 400) {
        const ctx = (res as any).__errorContext;
        if (/^\/mcp\/(?:oauth|paperclip)(?:\/|$)/.test(requestClassificationUrl(req) ?? "")) {
          return { reqBody: "[REDACTED]", ...(ctx ? { errorContext: { name: "Error" } } : {}) };
        }
        if (isPrivateWebhook(req) || isPrivateMuseHttpRequest(requestClassificationUrl(req)) || isPrivateAgentCommentaryHttpRequest(requestClassificationUrl(req)) || isPrivateAgentObservabilityHttpRequest(requestClassificationUrl(req))) {
          // Omit, rather than recursively redact, the entire provider payload.
          // This applies equally before/after parsing and with/without context.
          return {
            reqBody: "[REDACTED]",
            ...(ctx || (res as any).err
              ? { errorContext: { name: "Error" } }
              : {}),
          };
        }
        if (ctx) {
          const secretSensitiveRoute = isSecretSensitiveHttpRequest(
            req.method,
            requestClassificationUrl(req),
          );
          return {
            // Provider SDK and validation errors sometimes echo the supplied
            // credential in their prose. Keep only a non-sensitive type marker
            // for setup routes; the status, route, and redacted body remain.
            errorContext: secretSensitiveRoute
              ? { name: "Error" }
              : redactSensitive(ctx.error),
            reqBody: redactSensitive(ctx.reqBody),
            reqParams: redactSensitive(ctx.reqParams),
          };
        }
        const props: Record<string, unknown> = {};
        const { body, params } = req as any;
        if (body && typeof body === "object" && Object.keys(body).length > 0) {
          props.reqBody = redactSensitive(body);
        }
        if (
          params &&
          typeof params === "object" &&
          Object.keys(params).length > 0
        ) {
          props.reqParams = redactSensitive(params);
        }
        if ((req as any).route?.path) {
          props.routePath = (req as any).route.path;
        }
        return props;
      }
      return {};
    },
  });
}

export const httpLogger = createHttpLogger(logger);
