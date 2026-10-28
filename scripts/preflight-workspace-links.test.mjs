import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXIT_BROKEN_LINKS,
  EXIT_OK,
  findBrokenWorkspaceLinks,
  parseArgs,
  repairWorkspaceLink,
  runPreflight,
} from "./preflight-workspace-links.mjs";

function writePackage(dir, name, dependencies = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name, version: "0.0.0", dependencies }, null, 2)}\n`,
  );
}

/**
 * A miniature workspace tree:
 *   packages/shared   -> @paperclipai/shared
 *   packages/db       -> @paperclipai/db, depends on @paperclipai/shared (workspace:*)
 */
function makeTree({ linkShared = true, linkTarget = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "paperclip-preflight-"));
  writePackage(path.join(root, "packages", "shared"), "@paperclipai/shared");
  writePackage(path.join(root, "packages", "db"), "@paperclipai/db", {
    "@paperclipai/shared": "workspace:*",
  });

  const linkPath = path.join(root, "packages", "db", "node_modules", "@paperclipai", "shared");
  mkdirSync(path.dirname(linkPath), { recursive: true });
  if (linkShared) {
    const target = linkTarget ?? path.join(root, "packages", "shared");
    symlinkSync(target, linkPath);
  }
  return { root, linkPath, sharedDir: path.join(root, "packages", "shared") };
}

test("parseArgs recognizes the documented flags", () => {
  assert.deepEqual(parseArgs([]), { repair: false, json: false, repoRoot: null });
  assert.deepEqual(parseArgs(["--repair", "--json"]), { repair: true, json: true, repoRoot: null });
  assert.deepEqual(parseArgs(["--repo-root", "/tmp/x"]), {
    repair: false,
    json: false,
    repoRoot: "/tmp/x",
  });
  assert.deepEqual(parseArgs(["--repo-root=/tmp/y"]), {
    repair: false,
    json: false,
    repoRoot: "/tmp/y",
  });
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});

test("a healthy workspace tree reports no broken links", () => {
  const { root } = makeTree();
  assert.deepEqual(findBrokenWorkspaceLinks(root), []);
});

test("a missing workspace link is detected and names the broken path", () => {
  const { root } = makeTree({ linkShared: false });
  const broken = findBrokenWorkspaceLinks(root);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].packageName, "@paperclipai/shared");
  assert.equal(broken[0].workspaceDir, path.join("packages", "db"));
  assert.equal(broken[0].actualPath, null);
  assert.match(broken[0].linkPath, /packages\/db\/node_modules\/@paperclipai\/shared$/);
});

test("a workspace link pointing at the wrong package is detected", () => {
  const { root } = makeTree();
  const wrongTarget = path.join(root, "packages", "db");
  const linkPath = path.join(root, "packages", "db", "node_modules", "@paperclipai", "shared");
  rmSync(linkPath, { force: true });
  symlinkSync(wrongTarget, linkPath);

  const broken = findBrokenWorkspaceLinks(root);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].actualPath, realpathSync(wrongTarget));
});

test("a dangling workspace link reads as missing", () => {
  const { root } = makeTree({ linkTarget: "/tmp/paperclip-does-not-exist-12345" });
  const broken = findBrokenWorkspaceLinks(root);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].actualPath, null);
});

test("repair restores a missing link and the tree becomes healthy", async () => {
  const { root, linkPath, sharedDir } = makeTree({ linkShared: false });
  const broken = findBrokenWorkspaceLinks(root);
  await repairWorkspaceLink(root, broken[0]);
  assert.equal(realpathSync(linkPath), realpathSync(sharedDir));
  assert.deepEqual(findBrokenWorkspaceLinks(root), []);
});

test("repair moves a real directory aside instead of deleting it", async () => {
  const { root, linkPath, sharedDir } = makeTree({ linkShared: false });
  const decoy = path.join(root, "packages", "db", "node_modules", "@paperclipai", "shared");
  mkdirSync(decoy, { recursive: true });
  writeFileSync(path.join(decoy, "keep.txt"), "important");

  const broken = findBrokenWorkspaceLinks(root);
  await repairWorkspaceLink(root, broken[0]);

  assert.equal(realpathSync(linkPath), realpathSync(sharedDir));
  assert.ok(broken[0].movedAside, "expected the decoy to be recorded as moved aside");
  assert.ok(existsSync(path.join(root, broken[0].movedAside, "keep.txt")));
});

test("runPreflight returns EXIT_OK on a healthy tree", async () => {
  const { root } = makeTree();
  assert.equal(await runPreflight(["--repo-root", root, "--json"]), EXIT_OK);
});

test("runPreflight returns EX_CONFIG on a broken tree and repairs it on demand", async () => {
  const { root } = makeTree({ linkShared: false });
  assert.equal(await runPreflight(["--repo-root", root, "--json"]), EXIT_BROKEN_LINKS);
  assert.equal(await runPreflight(["--repo-root", root, "--repair", "--json"]), EXIT_OK);
  assert.deepEqual(findBrokenWorkspaceLinks(root), []);
});

test("the failure message is one actionable block naming the link and the repair", async () => {
  const { root } = makeTree({ linkShared: false });
  const written = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrorWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    await runPreflight(["--repo-root", root]);
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
  }
  const output = written.join("");
  assert.match(output, /FAILED: 1 workspace package link is missing/);
  assert.match(output, /packages\/db\/node_modules\/@paperclipai\/shared/);
  assert.match(output, /preflight-workspace-links\.mjs --repair/);
  assert.match(output, /Exit code 78/);
});
