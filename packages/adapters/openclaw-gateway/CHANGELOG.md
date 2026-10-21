# @paperclipai/adapter-openclaw-gateway

## Unreleased

### Patch Changes

- RUAAAAA-5062: cooldown-aware retry/backoff. The adapter now polls `agent.wait`
  in configurable slices (`waitPollIntervalMs`, default 30s) instead of holding
  the connection for the full `waitTimeoutMs`. When a provider cooldown signal
  is detected (`Provider <name> is in cooldown`, optional `(billing)` qualifier,
  or `Auth profile 'X' is temporarily unavailable`), the adapter waits a
  configured exponential backoff (`cooldownBackoffMs`, default `30000,60000,120000`)
  inside the original budget and tries again. Returns one of three new
  `errorCode`s on cooldown: `openclaw_gateway_wait_cooldown`,
  `openclaw_gateway_wait_timeout_in_cooldown`,
  `openclaw_gateway_wait_cooldown_signal` (lifecycle-only). Cooldown state is
  surfaced under `resultJson.cooldown` with `provider`, `reason`, `untilIso`,
  `untilMs`, `attempts`, and the active `backoffSequenceMs`.

## 0.3.1


### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies
  - @paperclipai/adapter-utils@0.3.0
