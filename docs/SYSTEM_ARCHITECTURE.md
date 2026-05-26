# System Architecture

## Redis Live State Layer

Redis är ett frivilligt live-state/cache-lager mellan scanner, backend, paper
trading, gate logic och dashboard.

Konfiguration:

```env
REDIS_URL=redis://127.0.0.1:6379
REDIS_ENABLED=true
```

Backend startar även om Redis saknas. `src/services/redisService.js` använder
en in-process memory fallback och returnerar fallback-status via
`GET /api/system/redis-status`.

Redis används best effort för:

- `prices:stocks:latest` och `prices:crypto:latest`
- `candles:<market>:<symbol>:<timeframe>`
- `scan:stocks:latest` och `scan:crypto:latest`
- `signal:cooldowns`
- `gate:status` och `gate:recent-decisions`
- `paper:live-state` och `paper:active-positions`
- `paper:recent-decisions` stream
- `market:personality:<group>:snapshot`
- `agent:latest-analysis`, `agent:analysis:<SYMBOL>` och
  `agent:analysis-stream`

PM2 kör fortfarande Node-processen på samma sätt. Redis bör köras som separat
systemservice, till exempel:

```bash
sudo systemctl enable --now redis-server
pm2 restart nasdaq-scanner
```

This repository is a Node/Express trading scanner with a React/Vite dashboard.
It runs live scanners for stocks/Nasdaq and crypto, stores historical market and
signal data as JSONL/JSON under `data/`, and uses a Machine pipeline to refresh
learning artifacts from historical scans, outcomes, replay, and backtests.

This system produces scanner intelligence and watch-mode signals. It does not
place orders.

## Runtime Entry Points

- `server.js` loads `.env`, starts Express on `PORT` or `3001`, exposes `/health`,
  protects `/api/*` and the built frontend with Basic Auth, and starts background
  schedulers.
- `src/scanner/scheduler.js` starts the stock/Nasdaq live scanner every 30 seconds.
- `src/scanner/cryptoScheduler.js` starts the crypto live scanner every 30 seconds.
- `src/jobs/autoMachineScheduler.js` optionally starts scheduled Machine runs when
  `AUTO_MACHINE_ENABLED=true`.
- `src/routes/api.js` contains the authenticated API surface.
- `client/src/*` is the dashboard. It consumes the `/api/*` routes and the static
  build is served from `client/dist`.

## External Data Providers

- Alpaca live stocks/Nasdaq: `src/scanner/alpacaClient.js`.
- Alpaca historical stock bars: `src/data/alpacaDataService.js`.
- Binance live crypto: `src/scanner/binanceClient.js`.
- Binance historical crypto bars: `src/data/binanceDataService.js`.

## Symbol Groups

Defined in `src/scanner/scheduler.js`:

- Stocks: `NVDA`, `AMD`, `TSLA`, `AAPL`, `MSFT`, `AMZN`, `META`
- Nasdaq reference group: `QQQ`
- Watchlist for stock scanner: stocks plus `QQQ`

Defined in `src/scanner/cryptoScheduler.js`:

- Crypto live scanner: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`

Defined in `src/jobs/autoMachine.js`:

- Machine stock defaults: stocks plus `QQQ`
- Machine crypto defaults: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`

## Live Scanner Flow

The live stock/Nasdaq scanner:

1. Fetches recent 1-minute Alpaca bars for each watchlist symbol.
2. Aggregates 1-minute bars to 2-minute, 5-minute, and 15-minute candles.
3. Calculates indicators on 2-minute candles.
4. Fetches latest trade price when possible, otherwise uses the latest 2-minute close.
5. Runs `classifyNarrowState()` to create the base v2 scan result.
6. Attaches private candle arrays (`_candles2m`, `_candles5m`, `_candles15m`) for
   downstream engines.
7. Uses `QQQ` as market reference.
8. Runs the live enrichment pipeline in the order documented in
   `docs/ENGINE_ORDER.md`.
9. Saves aggregate market personality for `stocks`.
10. Logs stock and Nasdaq feature rows when feature logging is enabled.

The crypto scanner follows the same shape but uses Binance bars and `BTCUSDT` as
the market reference for ETH/SOL. For `BTCUSDT`, BTC uses itself as reference.

## Engine Families

- Base signal classification: indicators, narrow state, triggers, TFS, elephant
  bars, color change, breakout-already-occurred checks.
- Market context: Engine v3 market regime, Market Regime V2, market personality.
- Score and confirmation: score breakdown, confidence engine, MTF confirmation,
  confidence decay.
- Learning and memory: historical edge, adaptive edge, setup DNA, rule memory,
  symbol profiles, regime profiles, score calibration, fakeout DNA, orchestrator.
- Momentum and risk: momentum continuation, fakeout probability, liquidity sweep,
  pre-move, market fatigue, market state graph, wave phase.
- Offline analysis: historical scanner, outcome analyzer, replay engine, replay
  insights, missed breakout finder, momentum backtest, self-healing rule health.
- Alert Engine: `src/alerts/alertEngine.js` persists alerts, dedupes them, can
  derive alerts from system health and scanner results, and is wired into
  `/api/system/health`, `/api/alerts`, and `/api/alerts/acknowledge`.

## Data Files

All persistent app data lives under `data/`.

- `data/market-data/candles-2m/<SYMBOL>/<YYYY-MM-DD>.jsonl`: shared 2-minute
  candle store used by stocks and crypto.
- `data/market-data/alpaca/raw/<SYMBOL>/<YYYY-MM-DD>.jsonl`: raw Alpaca 1-minute
  backfill data.
- `data/market-data/alpaca/candles-2m/<SYMBOL>/<YYYY-MM-DD>.jsonl`: legacy Alpaca
  2-minute path read as fallback.
- `data/market-data/binance/raw/<SYMBOL>/<YYYY-MM-DD>.jsonl`: raw Binance
  historical backfill data.
- `data/signals/history/<YYYY-MM-DD>.jsonl`: historical signal records.
- `data/signals/outcomes/<YYYY-MM-DD>.jsonl`: analyzed signal outcomes.
- `data/signals/learning-summary.json`: current learning summary. Both legacy
  `signalLearning` and newer `learningEngine` write to this path.
- `data/signals/rule-memory.json`: learned rule memory/watch-mode report.
- `data/signals/symbol-profiles.json`: per-symbol profiles.
- `data/signals/regime-profiles.json`: per-regime profiles.
- `data/signals/score-calibration.json`: score bucket calibration.
- `data/signals/fakeout-dna.json`: learned fakeout pattern stats.
- `data/signals/rule-health.json`: self-healing rule health report.
- `data/signals/momentum-backtest.json`: momentum/fakeout/liquidity backtest.
- `data/signals/market-personality-stocks.json`: aggregate live stock personality.
- `data/signals/market-personality-crypto.json`: aggregate live crypto personality.
- `data/signals/state-graph/<SYMBOL>.json`: per-symbol market state transitions.
- `data/signals/decay-state/<SYMBOL>.json`: per-symbol confidence decay state.
- `data/feature-logs/<YYYY-MM-DD>.jsonl`: recent live feature logs.
- `data/replay/runs/<RUN_ID>/summary.json`: replay summary.
- `data/replay/runs/<RUN_ID>/events.jsonl`: replay events.
- `data/replay/runs/<RUN_ID>/insights.json`: replay insights.
- `data/system/auto-machine-status.json`: latest Machine status/result.
- `data/alerts/alerts.jsonl`: persisted alert-engine storage used by health and
  alert API routes.

## Health System

`src/systemHealth.js` builds `/api/system/health`. It inspects:

- Runtime process status, memory, uptime, PM2 metadata when present.
- Stock scanner and crypto scanner freshness and result counts.
- Key API data availability.
- Required learning and signal files.
- Latest history/outcome/state/decay file freshness.
- Latest Auto Machine run and selected Machine step statuses.
- Live learning engine fields visible in current scanner results.

The health output includes `overallStatus`, Swedish summary text, component rows,
and alert-like records derived from broken or critical components. The
`/api/system/health` route also records system-health alerts through
`src/alerts/alertEngine.js`.

## Machine Pipeline

The Machine is implemented in `src/jobs/autoMachine.js` and documented in
`docs/LEARNING_PIPELINE.md`. It backfills data, replays, hunts historical signals,
analyzes outcomes, refreshes learning artifacts, builds rule/profile/calibration
reports, invalidates caches, and writes `data/system/auto-machine-status.json`.

It has a single-run guard (`_running`) and rejects duplicate runs.

## What Should Never Be Changed Blindly

- The live engine order in `scheduler.js` and `cryptoScheduler.js`.
- Hard-block caps: Three Finger Spread capped at 10, Breakout Already Occurred
  capped at 20, `autoFilter.blocked` capped at 20.
- The rule that learning engines must not turn hard-blocked signals into
  buy/sell automation.
- JSONL data paths and record shapes under `data/`; many loaders assume these
  paths and date filenames.
- `learning-summary.json` compatibility; both legacy and newer learning readers
  depend on this path.
- The Basic Auth behavior in `server.js`; missing dashboard credentials must block
  access, not leave the dashboard open.
- The `QQQ` and `BTCUSDT` market-reference behavior unless the full pipeline is
  updated and reverified.
- Cache invalidation after history/outcome/learning updates.
- The Machine non-overlap guard and Auto Machine scheduler interval floor.
- Private `_candles*` fields: they are needed by downstream engines during the
  pipeline and stripped before API responses.
