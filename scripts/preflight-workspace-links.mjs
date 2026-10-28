#!/usr/bin/env node
/**
 * Preflight dependency check for the deployed Paperclip tree (RUAAAAA-5497).
 *
 * Why this exists
 * ---------------
 * On 2026-10-27 00:23:26Z -> 00:33:23Z the control plane crash-looped for
 * ~10 minutes. systemd restarted `paperclip.service` 53 times because the
 * workspace link `packages/db/node_modules/@paperclipai/shared` was missing,
 * and every start died with
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@paperclipai/shared'
 * The unit's default start limit (5 starts / 10s) could never trip because
 * `RestartSec=10`, so the loop was unbounded and 5 in-flight agent runs died
 * with "Process lost -- server may have restarted".
 *
 * What this does
 * --------------
 * Verifies that every `workspace:` dependency of every workspace package
 * resolves through its node_modules symlink to the in-tree package directory,
 * and can repair the links it finds broken.
 *
 * It deliberately uses ZERO third-party dependencies (node builtins only), so
 * it still runs when node_modules is exactly what is broken. The existing
 * `scripts/ensure-workspace-package-links.ts` needs tsx from node_modules and
 * is only wired into build/typecheck/test - never into the service start path.
 *
 * Exit codes
 * ----------
 *   0   every workspace link resolves
 *   78  (EX_CONFIG) at least one link is missing/wrong and was not repaired.
 *       The service start path must NOT restart the unit on this code: this is
 *       a deterministic configuration failure, not a transient one.
 *   1   unexpected internal error
 *
 * Usage
 * -----
 *   node scripts/preflight-workspace-links.mjs [--repair] [--repo-root PATH] [--json]
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, rename, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXIT_OK = 0;
export const EXIT_BROKEN_LINKS = 78; // EX_CONFIG
export const EXIT_INTERNAL_ERROR = 1;

/** Workspace roots scanned for package.json files. */
export const WORKSPACE_ROOTS = ["packages", "server", "ui", "cli"];

/** Directory names never walked into while discovering workspace packages. */
const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".paperclip",
  ".turbo",
  ".vite",
  ".vite-temp",
  "coverage",
  "dist",
  "node_modules",
  "ui-dist",
]);

/** How deep below each workspace root a package.json may live. */
const MAX_DISCOVERY_DEPTH = 3;

export function parseArgs(argv) {
  const options = { repair: false, json: false, repoRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repair") {
      options.repair = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--repo-root") {
      options.repoRoot = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * Map every workspace package name to the directory that holds it.
 */
export function discoverWorkspacePackages(repoRoot, roots = WORKSPACE_ROOTS) {
  const packagePaths = new Map();

  const visit = (dirPath, depth) => {
    if (depth > MAX_DISCOVERY_DEPTH) return;
    const packageJsonPath = path.join(dirPath, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = readJsonFile(packageJsonPath);
        if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
          if (!packagePaths.has(packageJson.name)) {
            packagePaths.set(packageJson.name, dirPath);
          }
        }
      } catch {
        // An unreadable package.json is not a workspace-link problem.
      }
    }

    let entries = [];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name), depth + 1);
    }
  };

  for (const root of roots) {
    visit(path.join(repoRoot, root), 0);
  }
  return packagePaths;
}

function workspaceDirsFrom(packagePaths, repoRoot) {
  return Array.from(
    new Set(
      Array.from(packagePaths.values())
        .map((packagePath) => path.relative(repoRoot, packagePath))
        .filter((relativePath) => relativePath.length > 0),
    ),
  ).sort();
}

/**
 * Every workspace: dependency link that is missing or points at the wrong package.
 */
export function findBrokenWorkspaceLinks(repoRoot) {
  const packagePaths = discoverWorkspacePackages(repoRoot);
  const broken = [];

  for (const workspaceDir of workspaceDirsFrom(packagePaths, repoRoot)) {
    const nodeModulesDir = path.join(repoRoot, workspaceDir, "node_modules");
    if (!existsSync(nodeModulesDir)) continue;

    let packageJson;
    try {
      packageJson = readJsonFile(path.join(repoRoot, workspaceDir, "package.json"));
    } catch {
      continue;
    }

    const dependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };

    for (const [packageName, version] of Object.entries(dependencies)) {
      if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

      const expectedDir = packagePaths.get(packageName);
      if (!expectedDir) continue;

      const linkPath = path.join(nodeModulesDir, ...packageName.split("/"));
      let actualPath = null;
      try {
        actualPath = realpathSync(linkPath);
      } catch {
        actualPath = null;
      }

      if (actualPath === path.resolve(expectedDir)) continue;

      broken.push({
        workspaceDir,
        packageName,
        linkPath: path.relative(repoRoot, linkPath),
        expectedPath: path.resolve(expectedDir),
        actualPath,
      });
    }
  }

  return broken;
}

/**
 * Restore one broken link. Symlinks are unlinked; a real directory in the way
 * is moved aside (never deleted) so nothing is lost.
 */
export async function repairWorkspaceLink(repoRoot, entry) {
  const linkPath = path.join(
    repoRoot,
    entry.workspaceDir,
    "node_modules",
    ...entry.packageName.split("/"),
  );
  await mkdir(path.dirname(linkPath), { recursive: true });

  let stats = null;
  try {
    stats = lstatSync(linkPath);
  } catch {
    stats = null;
  }

  if (stats?.isSymbolicLink()) {
    await unlink(linkPath);
  } else if (stats) {
    const movedAside = `${linkPath}.pre-repair-${Date.now()}`;
    await rename(linkPath, movedAside);
    entry.movedAside = path.relative(repoRoot, movedAside);
  }

  await symlink(entry.expectedPath, linkPath);
}

function formatBrokenEntry(entry) {
  const found = entry.actualPath ?? "missing";
  return `  - ${entry.linkPath} -> expected ${entry.expectedPath} (found: ${found})`;
}

function formatFailureMessage(broken, repoRoot) {
  const lines = [];
  lines.push(
    `[paperclip-preflight] FAILED: ${broken.length} workspace package ${broken.length === 1 ? "link is" : "links are"} missing or pointing at the wrong package.`,
  );
  for (const entry of broken) {
    lines.push(formatBrokenEntry(entry));
  }
  lines.push("");
  lines.push(`Repair: cd ${repoRoot} && node scripts/preflight-workspace-links.mjs --repair`);
  lines.push("  (or re-run \`pnpm install\` in that tree)");
  lines.push("");
  lines.push(
    "This check runs as ExecStartPre= of paperclip.service. Exit code 78 means the unit must NOT be restarted:",
  );
  lines.push(
    "the failure is deterministic, so restarting it would only repeat it. paperclip-workspace-links.timer restores the links and starts the control plane once they are healthy again.",
  );
  return lines.join("\n");
}

export async function runPreflight(argv) {
  const options = parseArgs(argv);
  const repoRoot = path.resolve(
    options.repoRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );

  let broken = findBrokenWorkspaceLinks(repoRoot);
  const repaired = [];

  if (broken.length > 0 && options.repair) {
    for (const entry of broken) {
      try {
        await repairWorkspaceLink(repoRoot, entry);
        repaired.push(entry.linkPath);
      } catch (error) {
        entry.repairError = error instanceof Error ? error.message : String(error);
      }
    }
    broken = findBrokenWorkspaceLinks(repoRoot);
  }

  if (broken.length === 0) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, repoRoot, broken: [], repaired }, null, 2)}\n`);
    } else {
      const repairedNote =
        repaired.length > 0 ? ` (repaired ${repaired.length} link${repaired.length === 1 ? "" : "s"})` : "";
      process.stdout.write(`[paperclip-preflight] OK: every workspace package link resolves${repairedNote}.\n`);
    }
    return EXIT_OK;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: false, repoRoot, broken, repaired }, null, 2)}\n`);
  } else {
    process.stderr.write(`${formatFailureMessage(broken, repoRoot)}\n`);
  }
  return EXIT_BROKEN_LINKS;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    process.exitCode = await runPreflight(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `[paperclip-preflight] internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = EXIT_INTERNAL_ERROR;
  }
}
