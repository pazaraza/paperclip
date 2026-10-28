# Paperclip control plane: startup contract

RUAAAAA-5497. Written 2026-10-27 after the control plane crash-looped for
~10 minutes on a missing workspace package link.

## What happened

Between 00:23:26Z and 00:33:23Z systemd restarted `paperclip.service` 53 times.
Every failing start died with:

    Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@paperclipai/shared'
    imported from packages/db/src/runtime-config.ts

The cause was a missing workspace link:
`packages/db/node_modules/@paperclipai/shared -> packages/shared`. The link was
recreated at 00:32:36Z and the next start succeeded. Five in-flight agent runs
died with "Process lost -- server may have restarted".

Two independent defects turned one missing symlink into a ten-minute outage:

1. **Nothing checked the dependency before the start.** The server failed with
   a raw node resolution error on every attempt, and the message named the
   importer, not the missing link or the repair.
2. **The restart policy could not stop a deterministic failure.** systemd's
   default start limit is 5 starts per 10s; with `RestartSec=10` the limit can
   never trip, so the loop was unbounded (measured: 4 restarts in 35s with the
   old policy, versus 53 in 10 minutes during the incident).

## The contract

**Start path.** `scripts/dev-runner.mjs` runs
`scripts/preflight-workspace-links.mjs` before it spawns the server.

- The preflight uses node builtins only, so it still runs when node_modules is
  exactly what is broken.
- It resolves every `workspace:` dependency of every workspace package through
  its node_modules symlink.
- On a broken link it prints ONE actionable message naming the link, the
  expected target and the repair command, then exits **78** (EX_CONFIG).
- The check can never be the reason the plane stays down: an unexpected error
  in the preflight is logged and startup continues.

**Systemd policy** (drop-in `paperclip.service.d/20-startup-preflight.conf`):

| Setting | Value | Why |
|---|---|---|
| `RestartPreventExitStatus` | 78 | a deterministic configuration failure is surfaced once, not retried |
| `StartLimitIntervalSec` | 300 | the default 10s window can never trip while `RestartSec=10` |
| `StartLimitBurst` | 3 | at most 3 restarts per 5 minutes for transient main-process failures |

**Why the check is inside dev-runner.mjs and not an `ExecStartPre=`.**
`RestartPreventExitStatus` matches the MAIN process exit status only. Measured
on systemd 255: an `ExecStartPre=` that exits 78 is still restarted (the unit
restarts until the start limit trips), and `RestartMode=direct` does not change
that either - it only changes how the unit transitions, not whether it
restarts. Running the check inside the main process makes exit 78 the service
exit status, which is what `RestartPreventExitStatus=78` matches.

**Repair path.** `paperclip-workspace-links.timer` runs every 5 minutes (at
:04, :09, :14, ... so it never co-fires with the :00/:30 fleet-health routine,
the :05/:20/:35/:50 heartbeat sweep or the :02/5 auth detector):

1. `scripts/preflight-workspace-links.mjs --repair` restores any missing or
   wrong workspace link (a real directory in the way is moved aside, never
   deleted).
2. `ExecStartPost=` starts `paperclip.service` again. `ExecStartPost=` only
   runs when the repair succeeded, so the plane is never started against broken
   links.

## Operating notes

- `pnpm run preflight:workspace-links` (the older
  `scripts/ensure-workspace-package-links.ts`) still runs before build,
  typecheck and test. It needs tsx from node_modules, so it cannot be the
  service start path - that is why the dependency-free `.mjs` preflight
  exists.
- Nothing in the deployed tree may run `pnpm install`/`pnpm prune` while the
  service is live: pnpm rewrites the workspace links, and the server can be
  restarted into the window where a link is missing. The repair timer covers
  the gap, but the install is the actual trigger and should be avoided.
- Verify the start path after a change:
  `journalctl --user -u paperclip.service | grep paperclip-preflight`.

## Tests

`node --test scripts/preflight-workspace-links.test.mjs`
