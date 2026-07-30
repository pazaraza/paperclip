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
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
  runLogsRetention: RunLogRetentionPolicy;
}

export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableIssueGraphLivenessAutoRecovery: boolean;
  issueGraphLivenessAutoRecoveryLookbackHours: number;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueGraphLivenessAutoRecoveryPreviewItem {
  issueId: string;
  identifier: string | null;
  title: string;
  state: string;
  severity: string;
  reason: string;
  recoveryIssueId: string;
  recoveryIdentifier: string | null;
  recoveryTitle: string | null;
  recommendedOwnerAgentId: string | null;
  incidentKey: string;
  latestDependencyUpdatedAt: string;
  dependencyPath: Array<{
    issueId: string;
    identifier: string | null;
    title: string;
    status: string;
  }>;
}

export interface IssueGraphLivenessAutoRecoveryPreview {
  lookbackHours: number;
  cutoff: string;
  generatedAt: string;
  findings: number;
  recoverableFindings: number;
  skippedOutsideLookback: number;
  items: IssueGraphLivenessAutoRecoveryPreviewItem[];
}
