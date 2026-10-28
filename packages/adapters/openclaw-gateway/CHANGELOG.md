# @paperclipai/adapter-openclaw-gateway

## Unreleased

### Patch Changes

- RUAAAAA-5520: a gateway restart is no longer surfaced as a raw socket
  refusal. When the `openclaw-gateway` listener is not accepting connections
  (`connect ECONNREFUSED 127.0.0.1:18789`, `ECONNRESET`, `EPIPE`,
  `EHOSTUNREACH`, `ENETUNREACH`, `socket hang up`) or the gateway process
  goes away mid-run (websocket close `1006`), the adapter now returns
  `errorCode: openclaw_gateway_unreachable` with
  `errorFamily: transient_upstream` and a `retryNotBefore` floor
  (`unreachableRetryDelayMs`, default 15000). Paperclip therefore retries the
  run in bounded fashion once the listener is back, instead of failing it as
  `openclaw_gateway_request_failed` / `openclaw_gateway_wait_error` and
  letting the raw socket error be misread as a provider or agent fault.
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
