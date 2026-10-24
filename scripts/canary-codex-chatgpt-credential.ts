/**
 * RUAAAAA-5276 end-to-end canary.
 *
 * Drives the real codex_local adapter `execute()` against the live Codex
 * credential, with an agent config shaped exactly like a codex_local agent
 * that inherited the old shipped defaults (base model from the create-time
 * seed, `cheap` profile from the adapter default) and a wake payload
 * replicating the failing shape (`issue_assigned` + `modelProfile: cheap`).
 *
 * Verifies each run reaches a real completion on the lane it was dispatched
 * on, served by a model the credential actually accepts.
 *
 * Run: node_modules/.bin/tsx scripts/canary-codex-chatgpt-credential.ts
 */
import fs from "node:fs/promises";
import { execute } from "../packages/adapters/codex-local/src/server/index.js";
import { DEFAULT_CODEX_LOCAL_MODEL, modelProfiles } from "../packages/adapters/codex-local/src/index.js";

const WORKSPACE = "/tmp/ru5276-canary";
await fs.mkdir(WORKSPACE, { recursive: true });

const cheapProfile = modelProfiles.find((p) => p.key === "cheap");
if (!cheapProfile) throw new Error("codex_local ships no `cheap` profile");

const REJECTION = "not supported when using Codex with a ChatGPT account";

function wakePayload(modelProfile: string | null) {
  return {
    reason: "issue_assigned",
    issue: {
      id: "438dc3fa-d484-4620-8037-0f36dad65b70",
      identifier: "RUAAAAA-5276",
      title: "codex_local cheap adapter profile default is rejected by the ChatGPT Codex credential",
      status: "in_progress",
    },
    requestedCount: 0,
    includedCount: 0,
    missingCount: 0,
    fallbackFetchNeeded: false,
    ...(modelProfile ? { modelProfile } : {}),
  };
}

const cases = [
  {
    name: "cheap lane, agent inherited the adapter's shipped profile default",
    config: { ...cheapProfile.adapterConfig },
    profile: "cheap",
    expectModel: "gpt-6-astra",
  },
  {
    name: "base lane, agent inherited the old create-time seed (gpt-5.3-codex)",
    config: { model: DEFAULT_CODEX_LOCAL_MODEL },
    profile: null,
    expectModel: "gpt-6-astra",
  },
];

let failures = 0;

for (const testCase of cases) {
  const logLines: string[] = [];
  const result = await execute({
    runId: `canary-${testCase.profile ?? "base"}-${Date.now()}`,
    agent: {
      id: "canary-agent",
      companyId: "17962940-d69e-4909-bb45-c7bb534505e5",
      name: "RUAAAAA-5276 canary",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      ...testCase.config,
      cwd: WORKSPACE,
      dangerouslyBypassApprovalsAndSandbox: true,
      // Keep the canary cheap and bounded.
      timeoutSec: 300,
    },
    context: {
      paperclipWake: wakePayload(testCase.profile),
      paperclipIssue: { identifier: "RUAAAAA-5276" },
    },
    authToken: null,
    onLog: async (stream: string, chunk: string) => {
      logLines.push(`[${stream}] ${chunk}`);
    },
    onMeta: async () => {},
    onSpawn: async () => {},
  } as never);

  const served = String((result as { model?: string }).model ?? "");
  const stdout = String((result as { resultJson?: { stdout?: string } }).resultJson?.stdout ?? "");
  const stderr = String((result as { resultJson?: { stderr?: string } }).resultJson?.stderr ?? "");
  const clamp = logLines.find((l) => l.includes("ChatGPT credential cannot serve model"));

  const ok =
    (result as { exitCode?: number | null }).exitCode === 0 &&
    !result.errorCode &&
    served === testCase.expectModel &&
    !stdout.includes(REJECTION) &&
    !stderr.includes(REJECTION);

  if (!ok) failures += 1;
  console.log(`\n${ok ? "PASS" : "FAIL"}  ${testCase.name}`);
  console.log(`      lane=${testCase.profile ?? "base"}  exitCode=${(result as { exitCode?: number | null }).exitCode}  errorCode=${(result as { errorCode?: string | null }).errorCode ?? "none"}  model=${served || "(none)"} (expected ${testCase.expectModel})  biller=${(result as { biller?: string | null }).biller ?? "?"}`);
  console.log(`      400 entitlement rejection present: ${stdout.includes(REJECTION) || stderr.includes(REJECTION)}`);
  if (clamp) console.log(`      clamp: ${clamp.trim()}`);
  if (!ok) {
    console.log(`      stdout tail: ${stdout.slice(-700)}`);
    console.log(`      stderr tail: ${stderr.slice(-700)}`);
  }
}

console.log(`\n${failures === 0 ? "ALL CASES PASSED" : `${failures} CASE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);