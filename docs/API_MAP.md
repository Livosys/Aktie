# API Map

`server.js` exposes one unauthenticated health endpoint and mounts
`src/routes/api.js` under `/api` behind Basic Auth.

## Public Endpoint

### `GET /health`

Open endpoint. Returns process-level service status:

- `ok`
- `service`
- `time`
- `alpacaConfigured`
- `feed`
- `env`

It does not expose secrets.

## System Routes

### `GET /api/system/redis-status`

Authenticated. Returns Redis client status without exposing `REDIS_URL` or any
secret env values.

Fields:

- `redisConfigured`
- `redisAvailable`
- `mode`: `redis` or `fallback`
- `clientStatus`
- `memoryFallbackKeys`
- `lastConnectedAt`
- `lastPingAt`
- `lastError`

## Authenticated Scanner Routes

### `GET /api/scan`

Returns all latest stock/Nasdaq scanner results.

### `GET /api/scan/stocks`

Returns latest results filtered to the stock group.

### `GET /api/scan/nasdaq`

Returns latest results filtered to the Nasdaq reference group (`QQQ`).

### `GET /api/scan/crypto`

Returns latest crypto scanner results.

### `GET /api/wave`

Returns all stock and crypto results that have `waveContext`.

### `GET /api/wave/stocks`

Returns stock results that have `waveContext`.

### `GET /api/wave/crypto`

Returns crypto results that have `waveContext`.

### `GET /api/replay/latest`

Reads recent feature logs.

Query:

- `symbol` optional
- `limit` optional, max 500

### `GET /api/groups`

Returns configured scanner groups.

### `GET /api/symbols`

Returns stock/Nasdaq watchlist symbols.

### `GET /api/status`

Returns stock scanner status plus Alpaca configuration flags.

## Hybrid Agent Routes

### `GET /api/agent/latest-analysis`

Returns the latest cached local agent analysis plus Redis status. The analysis
is commentary only and cannot create orders.

### `POST /api/agent/analyze-signal`

Runs the local/mock TradingAgents-inspired layer for a current Decision Monitor
candidate. Body may include `symbol`; if omitted, the first current candidate is
used. Output includes:

- `technical_view`
- `bull_case`
- `bear_case`
- `risk_notes`
- `confidence_adjustment`
- `final_commentary`
- `should_block_trade`

The route only returns explanation, confidence adjustment, risk flag and
optional block flag. BUY/SELL creation remains in the fast engine and gate
system.

## Paper Trading Routes

### `GET /api/paper-trading/live-state`

Returns the live paper trading snapshot from Redis when available, otherwise the
same in-memory/disk state used by existing paper trading endpoints.

## Data Routes

### `POST /api/data/backfill`

Backfills historical data.

Body:

- `symbols`: required array
- `start`: required `YYYY-MM-DD`
- `end`: required `YYYY-MM-DD`

Stocks use Alpaca. USDT crypto pairs use Binance.

### `GET /api/data/status`

Returns stored data availability by symbol, including raw dates, 2-minute dates,
date range, total 2-minute candles, and Alpaca flags.

## Historical Signal Routes

### `POST /api/history/scan`

Runs historical scanner over stored 2-minute candles.

Body:

- `symbols`: required array
- `start`: required
- `end`: required

### `POST /api/history/hunt-signals`

Alias for historical scan with historical-edge cache invalidation.

Body:

- `symbols`: required array
- `start`: required `YYYY-MM-DD`
- `end`: required `YYYY-MM-DD`

### `POST /api/history/analyze`

Analyzes outcomes for saved historical signals, saves legacy learning summary,
and invalidates historical-edge cache.

Body:

- `symbols`: optional array
- `start`: required
- `end`: required

### `GET /api/history/signals`

Loads saved historical signal records.

Query:

- `symbol` optional
- `start` optional, defaults to last 7 days
- `end` optional, defaults to today
- `limit` optional, max 1000

### `GET /api/history/outcomes`

Loads saved outcome records.

Query:

- `symbol` optional
- `start` optional, defaults to last 7 days
- `end` optional, defaults to today
- `limit` optional, max 1000

### `GET /api/history/edge`

Returns historical edge.

Query:

- `symbol` optional. If present, returns symbol breakdown. Otherwise returns
  global fallback edge.

### `GET /api/history/edge-summary`

Returns full historical edge summary.

### `GET /api/history/learning-summary`

Returns the newer learning summary if present, otherwise legacy learning summary.

### `POST /api/history/update-learning`

Runs the learning update pipeline:

1. `runLearningEngine()`
2. `buildRuleMemory()`
3. `buildSymbolProfiles()`
4. `buildRegimeProfiles()`

Returns high-level learning and profile summaries.

## Learning Artifact Routes

### `GET /api/history/rule-memory`

Returns `data/signals/rule-memory.json`.

### `GET /api/history/symbol-profiles`

Returns `data/signals/symbol-profiles.json`.

Query:

- `symbol` optional. If present, returns one symbol profile.

### `GET /api/history/regime-profiles`

Returns `data/signals/regime-profiles.json`.

Query:

- `regime` optional. If present, returns one regime profile.

### `GET /api/history/score-calibration`

Returns `data/signals/score-calibration.json`.

### `GET /api/history/fakeout-dna`

Returns `data/signals/fakeout-dna.json`.

### `GET /api/history/rule-health`

Returns `data/signals/rule-health.json`.

### `GET /api/history/momentum-backtest`

Returns `data/signals/momentum-backtest.json`.

Query:

- `build=true` optional. Builds the report if missing.

### `GET /api/market/personality`

Returns live market personality artifacts.

Query:

- `group=stocks` returns stocks only.
- `group=crypto` returns crypto only.
- no group returns both.

### `GET /api/history/missed-breakouts`

Returns missed breakout review items.

Query:

- `limit` optional
- `days` optional
- `start` optional
- `end` optional
- `symbol` optional
- `onlyBlocked=true` optional

## Replay Routes

### `POST /api/replay/run`

Runs historical replay.

Body:

- `symbols`: required array
- `start`: required `YYYY-MM-DD`
- `end`: required `YYYY-MM-DD`
- `mode`: optional, one of `scan_only`, `with_outcomes`, `debug`

### `GET /api/replay/runs`

Lists replay runs newest first.

### `GET /api/replay/runs/:runId`

Returns one replay summary and insights.

### `GET /api/replay/runs/:runId/events`

Returns replay events.

Query:

- `symbol` optional
- `limit` optional, max 1000

### `GET /api/replay/compare`

Compares two replay summaries.

Query:

- `runA`: required
- `runB`: required

## System Routes

### `GET /api/system/auto-machine-status`

Returns Machine running flag, scheduler config from env, and saved Machine status.

### `GET /api/system/scheduler-status`

Returns Auto Machine scheduler status from `autoMachineScheduler.js`.

### `GET /api/system/health`

Returns full system health from `src/systemHealth.js`.

Also records system-health alerts through `src/alerts/alertEngine.js`.

## Alert Routes

### `GET /api/alerts`

Builds current system health, combines health-derived alerts and scanner-result
alerts, records new deduped alerts, and returns persisted alerts.

Query:

- `includeAcknowledged=true` optional
- `limit` optional, capped by alert engine at 500

### `POST /api/alerts/acknowledge`

Acknowledges one or more alerts.

Body:

- `id`: single alert id, or
- `ids`: array of alert ids

### `POST /api/system/run-auto-machine`

Starts Machine asynchronously and returns immediately.

Body:

- `lookbackDays`: optional; default from env or 7; valid range 1-90
- `groups`: optional array or comma-separated string; default from env or
  `stocks,crypto`

Returns `409` if Machine is already running.

## Review Routes

### `GET /api/review/chart-data`

Returns candle window and SMA values around a signal timestamp for review charts.

Query:

- `symbol`: required
- `timestamp`: required
- `windowBefore`: optional, max 300
- `windowAfter`: optional, max 300

## Alert Engine Notes

`src/alerts/alertEngine.js` persists alerts to `data/alerts/alerts.jsonl`, dedupes
unacknowledged alerts for 30 minutes, and supports acknowledgement. Alerts are
diagnostic/watch records only; no notification transport or order execution is
implemented in this module.
