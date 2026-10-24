import type { FeedbackDataSharingPreference } from "./feedback.js";

export const DAILY_RETENTION_PRESETS = [1, 3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;

/**
 * Run-log retention presets (in days).
 *
 * The default hourly cadence produces ~400 Paperclip runs/day ≈ ~25 MiB/day;
 * without an active retention guard the per-run ndjson tree accumulates
 * without bound (RUAAAAA-3200 audit measured 4.27 GiB / 64,961 files across
 * 14 active companies at the time the feature was proposed). The preset set
 * is intentionally narrow so operators trade off disk usage against
 * recovery-service evidence depth (recovery reads the per-run logs via
 * `server/src/services/recovery/service.ts:809` to auto-clear stranded runs).
 *
 * Allowed values: 7, 14, 30, 60, 90. The 30d default is a balanced middle
 * (≈1.4 GiB steady-state at our current run rate) — see RUAAAAA-3219.
 */
export const RUN_LOG_RETENTION_PRESETS = [7, 14, 30, 60, 90] as const;
export const DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24;
export const MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 1;
export const MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24 * 30;

export interface BackupRetentionPolicy {
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

/**
 * Default backup retention policy used when an instance has not explicitly
 * configured one. Tuned for the default hourly backup cadence so that
 * steady-state disk usage stays bounded at roughly ~77 files / ~26 GB at our
 * current DB size; the previous `dailyDays: 7` default yielded ~168 hourly
 * backups (~57 GB) and pushed the live instance into a 99% disk-fill
 * incident (RUAAAAA-3132). The schema restricts `dailyDays` to the preset
 * values `[1, 3, 7, 14]`. `1` is the smallest defensible floor for
 * operators on tight disks (RUAAAAA-3176 added it); we keep the default at
 * `3` because a fresh new instance with no operator awareness of its DB
 * growth trajectory still gets a 3-day daily tier as a safer baseline.
 * Bumping the default back up without an explicit override and an updated
 * CI guard in `packages/shared/src/types/instance.test.ts` will fail the
 * build — see RUAAAAA-3133.
 */
export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 3,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

/**
 * Instance-wide execution policy.
 *
 * - `"any"` (default / absent): unrestricted — any environment driver (local,
 *   ssh, sandbox) may run agents. Preserves single-tenant / local-trusted
 *   behavior.
 * - `"kubernetes"`: force ALL agent execution onto the Kubernetes
 *   sandbox-provider environment and REFUSE local/in-process execution. Used by
 *   shared cloud (cloud_tenant) instances so untrusted tenant agents can never
 *   run in the server process or on an unsandboxed local/ssh adapter.
 */
export type InstanceExecutionMode = "kubernetes" | "any";
export interface RunLogRetentionPolicy {
  retentionDays: (typeof RUN_LOG_RETENTION_PRESETS)[number];
}

/**
 * Default run-log retention policy used when an instance has not explicitly
 * configured one. Tuned for the default Paperclip run cadence so the per-run
 * ndjson tree stays bounded — see RUAAAAA-3219. The previous behavior was no
 * guard at all, which let the on-disk accumulator grow toward ~3 months
 * before hitting disk-pressure (RUAAAAA-3200 audit). The schema restricts
 * `retentionDays` to the preset values `[7, 14, 30, 60, 90]`; `30` is the
 * balanced middle (≈1.4 GiB steady-state at our current ~25 MiB/day rate).
 * Bumping the default back up without an explicit override and an updated
 * CI guard in `packages/shared/src/types/instance.test.ts` will fail the
 * build — see RUAAAAA-3219.
 */
export const DEFAULT_RUN_LOG_RETENTION: RunLogRetentionPolicy = {
  retentionDays: 30,
};
export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
  /**
   * Execution policy. Absent/`"any"` = unrestricted; `"kubernetes"` forces the
   * Kubernetes sandbox provider and denies local/ssh execution.
   */
  executionMode?: InstanceExecutionMode;
  runLogsRetention: RunLogRetentionPolicy;}

export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  /**
   * Exposes the experimental Paperclip Runner adapter for new selections.
   * Existing native runs ignore later flag changes so they remain recoverable.
   */
  enableNativeRunner: boolean;
  enableAiConnectionRouters: boolean;
  /**
   * Hide the local environment and run all agents in the platform-managed
   * sandbox environment. Run selection refuses local while this is on.
   */
  enableManagedSandboxOnly: boolean;
  enableIsolatedWorkspaces: boolean;
  /**
   * Move the execution workspace default for a project that carries no policy
   * of its own from the shared project checkout to an isolated per-task
   * worktree. Inert unless `enableIsolatedWorkspaces` is also on, and never
   * overrides a project that stores its own policy.
   */
  enableIsolatedWorkspacesByDefault: boolean;
  enableStreamlinedLeftNavigation: boolean;
  /**
   * Use the streamlined shell, navigation, and contextual-sidebar experience.
   * Missing legacy values default on; the retired left-navigation preference
   * remains separate so an old opt-out cannot disable the broader UI.
   */
  enableStreamlinedUi: boolean;
  /** @deprecated Compatibility key only. Apps is always enabled. */
  enableApps: boolean;
  /** Exposes chat connector setup and Board surfaces; existing delivery continues when hidden. */
  enableChatConnectors: boolean;
  /** Show GitHub review bot setup and management independently of chat connectors. */
  enableGitHubReviewBots: boolean;
  /** Allow person-authorized assistant tools and task event delivery. */
  enablePublicMcp: boolean;
  /** Enable the standalone Dot choice and dedicated agent MCP connection independently of the general Runner rollout. */
  enableOpenAiDot: boolean;
  /** Enable experimental Grok Bot agents; requires MCP and the managed/native Runner. */
  enableGrokBot: boolean;
  enableMuse: boolean;
  /** @deprecated Compatibility key only. MCP aggregators are always enabled. */
  enableMcpAggregators: boolean;
  /** Show experimental memory connection setup. Existing connections remain usable. */
  enableMemoryConnectors: boolean;
  enablePaperclipNotebook: boolean;
  enableCases: boolean;
  enableAgentChat: boolean;
  /** Reorganized left nav, Inbox-as-Tasks-views, and the chat agent rail + task cards. */
  enableCombinedInboxTasks: boolean;
  /** The artifact presentation from the artifact directions lab (MVP V1) on the Artifacts page, the panel's Artifacts tab and the task thread. */
  enableArtifactsV1: boolean;
  enableConferenceRoomChat: boolean;
  enableClassicTaskInterface: boolean;
  enableIssuePlanDecompositions: boolean;
  enableExperimentalFileViewer: boolean;
  enableExternalObjects: boolean;
  enableSmokeLab: boolean;
  enableBuiltInAgents: boolean;
  enableBetaSkills: boolean;
  enableSummaries: boolean;
  enableStatusCards: boolean;
  enableDecisions: boolean;
  /** Show company connection settings and allow contextual fast-response acknowledgements. */
  enableFastResponses: boolean;
  enableGoalsSidebarLink: boolean;
  enableServerInfoDebugView: boolean;
  /** Shows internal Paperclip maintainer tools and observability links. */
  enablePaperclipDeveloperMode: boolean;
  /**
   * Instructs agents to write user-interaction content (confirmations,
   * questions, suggested tasks, checkbox prompts) in ASD-STE100 Simplified
   * Technical English with brief decision context. Prompt-side only; no
   * behavior change outside interaction wording.
   */
  enableSimplifiedEnglishInteractions: boolean;
  /**
   * When the user's first onboarding request is a single task, the chief of
   * staff proposes with a short plan document and a checkbox card instead of a
   * one-card confirmation. Read once, when the onboarding first task is created;
   * flipping it later does not change an existing first task.
   */
  enableFirstTaskPlanProposal: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableWorkspaceBranchReconcileForward: boolean;
  enableWorkspaceDirtyQuarantineRepair: boolean;
  /**
   * On cloud-managed instances, grant the stack owner instance-admin access
   * to their own dedicated instance. Elevation is computed per request at the
   * trusted-header auth boundary (owner stack role + this flag); no
   * `instance_user_roles` row is ever written. Inert on self-hosted
   * instances, which have no trusted cloud tenant path.
   */
  enableOwnerInstanceAdmin: boolean;
  /**
   * Kill switch for the sandbox duplex command-stream bridge. Default off. The
   * host reads this per run before it selects the callback bridge transport.
   * Off forces the file bridge for every run with no manifest change and no
   * redeploy.
   */
  enableSandboxDuplexBridge: boolean;
  /**
   * @deprecated Compatibility-only. Provider WebSocket ingress now follows
   * enableNativeRunner and this value has no runtime effect.
   */
  enableRunnerPreviewIngress: boolean;
  /**
   * Worktree preview instances (`PAPERCLIP_IN_WORKTREE=true`) suppress the
   * heartbeat run engine by default so previews never self-execute tasks. When
   * this is enabled the worktree-instance scheduling suppression is lifted so
   * runs actually execute inside the preview. Ignored outside a worktree.
   */
  enableWorktreeRunExecution: boolean;
  /**
   * Server-managed cutoff recorded when worktree run execution is enabled in
   * this instance. Client PATCH payloads must not control this value.
   */
  worktreeRunExecutionActivatedAt: string | null;
  /**
   * Server-managed instance id captured with the cutoff so copied settings rows
   * from another instance fail closed.
   */
  worktreeRunExecutionActivationInstanceId: string | null;
}

/**
 * Boolean feature-flag keys of the experimental settings — the only keys a
 * cloud managed-config overlay may target. Server-managed bookkeeping fields
 * (activation cutoffs, lookback hours) are excluded by construction.
 */
export type ManagedExperimentalFeatureKey = {
  [K in keyof InstanceExperimentalSettings]-?: InstanceExperimentalSettings[K] extends boolean
    ? K
    : never;
}[keyof InstanceExperimentalSettings];

export const PAPERCLIP_CLOUD_MANAGED_BY = "paperclip-cloud" as const;

/** Per-key metadata attached to settings responses for cloud-overlaid keys. */
export interface ManagedSettingMetadata {
  managed: true;
  managedBy: typeof PAPERCLIP_CLOUD_MANAGED_BY;
}

/**
 * Experimental settings as returned by the settings API. On cloud-managed
 * instances (`PAPERCLIP_MANAGED_CONFIG` present) `managedKeys` lists every key
 * whose value is overlaid by the harness; self-hosted responses omit it.
 */
export interface InstanceExperimentalSettingsWithManaged extends InstanceExperimentalSettings {
  managedKeys?: Partial<Record<ManagedExperimentalFeatureKey, ManagedSettingMetadata>>;
}

export interface InstanceSettings {
  id: string;
  defaultEnvironmentId: string | null;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettingsWithManaged;
  createdAt: Date;
  updatedAt: Date;
}
