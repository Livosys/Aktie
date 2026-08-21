# Learning Pipeline

The learning system has two main modes:

- Manual API/script workflows for backfill, historical scan, outcome analysis,
  replay, and learning updates.
- The Machine pipeline in `src/jobs/autoMachine.js`, which runs the full sequence
  and refreshes derived artifacts.

## Source Data

Historical learning starts from market data:

1. Raw 1-minute bars are fetched from Alpaca for stocks or Binance for crypto.
2. Raw bars are saved to provider-specific raw paths.
3. Bars are aggregated to complete 2-minute candles.
4. Shared 2-minute candles are saved to
   `data/market-data/candles-2m/<SYMBOL>/<YYYY-MM-DD>.jsonl`.
5. Historical scan and replay load those 2-minute candles through
   `src/data/marketDataStore.js`.

## Manual Learning Flow

The manual flow exposed through API routes is:

1. `POST /api/data/backfill`
   - Fetches Alpaca/Binance 1-minute bars.
   - Saves raw bars.
   - Aggregates and saves 2-minute candles.
2. `POST /api/history/scan` or `POST /api/history/hunt-signals`
   - Runs `runHistoricalScan()`.
   - Scans stored 2-minute candles.
   - Saves signal rows to `data/signals/history/<YYYY-MM-DD>.jsonl`.
   - `hunt-signals` also invalidates the historical edge cache.
3. `POST /api/history/analyze`
   - Runs `analyzeOutcomes()`.
   - Saves outcome rows to `data/signals/outcomes/<YYYY-MM-DD>.jsonl`.
   - Runs legacy `saveLearning()`.
   - Invalidates the historical edge cache.
4. `POST /api/history/update-learning`
   - Runs new `runLearningEngine()`.
   - Builds rule memory.
   - Builds symbol profiles.
   - Builds regime profiles.
   - Returns summary fields for the dashboard.

Additional manual analysis:

- `POST /api/replay/run` creates replay runs under `data/replay/runs/<RUN_ID>/`.
- `GET /api/history/momentum-backtest?build=true` can build
  `data/signals/momentum-backtest.json` if missing.

## Machine Pipeline

`runAutoMachine({ lookbackDays, groups })` is the full automated learning run.
It writes status to `data/system/auto-machine-status.json`.

The exact implemented order is:

1. Resolve date range from `lookbackDays`.
2. Resolve symbols from groups:
   - `stocks`: `NVDA`, `AMD`, `TSLA`, `AAPL`, `MSFT`, `AMZN`, `META`, `QQQ`
   - `crypto`: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`
3. Backfill:
   - Stocks use Alpaca if `ALPACA_ENABLED` and credentials are present.
   - Crypto uses Binance.
   - Symbol failures are recorded but the rest continue.
4. Replay:
   - Runs `runReplay({ symbols, start, end, mode: 'scan_only' })`.
   - Saves replay summary/events/insights.
5. Hunt signals:
   - Runs `runHistoricalScan({ symbols, start, end })`.
   - Saves historical signal rows.
6. Analyze outcomes:
   - Runs `analyzeOutcomes({ symbols, start, end })`.
   - Saves outcome rows.
7. Update learning:
   - Runs legacy `saveLearning({ start, end, symbols })`.
   - Runs new `runLearningEngine()`.
8. Analyze Momentum Intelligence:
   - Runs `buildMomentumBacktest()`.
   - Saves `data/signals/momentum-backtest.json`.
9. Build rule memory:
   - Runs `buildRuleMemory()`.
   - Saves `data/signals/rule-memory.json`.
10. Build symbol profiles:
   - Runs `buildSymbolProfiles()`.
   - Saves `data/signals/symbol-profiles.json`.
11. Build regime profiles:
   - Runs `buildRegimeProfiles()`.
   - Saves `data/signals/regime-profiles.json`.
12. Build score calibration:
   - Runs `buildScoreCalibration()`.
   - Saves `data/signals/score-calibration.json`.
13. Build fakeout DNA:
   - Runs `buildFakeoutDna()`.
   - Saves `data/signals/fakeout-dna.json`.
14. Build rule health:
   - Runs `buildRuleHealth()`.
   - Saves `data/signals/rule-health.json`.
15. Invalidate caches:
   - Runs `invalidateCache()` from `historicalEdge.js`.
16. Finish status:
   - Marks `_running=false`.
   - Writes final status/result to `data/system/auto-machine-status.json`.

## Machine Safety

- Only one Machine run may execute at a time. `_running` rejects duplicates.
- `POST /api/system/run-auto-machine` returns `409` if a run is already active.
- Manual API launch validates `lookbackDays` as `1-90`.
- Auto scheduler defaults to disabled. It starts only when
  `AUTO_MACHINE_ENABLED=true`.
- Auto scheduler has a minimum interval floor of 5 minutes.
- The scheduler skips ticks while Machine is already running.
- Stock backfill is skipped when Alpaca is disabled or credentials are missing;
  crypto backfill can still continue.
- Non-fatal build steps record errors in Machine status instead of aborting the
  entire run.

## Learning Artifacts And Consumers

- `learning-summary.json`
  - Written by `signalLearning.js` and `learningEngine.js`.
  - Read by `confidenceEngine.js`, `adaptiveEdgeEngine.js`, and API summary routes.
- `rule-memory.json`
  - Written by `ruleMemoryEngine.js`.
  - Read by live `applyRuleMemory()` and health/API routes.
- `symbol-profiles.json`
  - Written by `symbolPersonalityEngine.js`.
  - Read by live `applySymbolPersonality()` and health/API routes.
- `regime-profiles.json`
  - Written by `regimeProfileEngine.js`.
  - Read by live `applyRegimeProfile()` and health/API routes.
- `score-calibration.json`
  - Written by `scoreCalibrationEngine.js`.
  - Read by live `applyScoreCalibration()` and health/API routes.
- `fakeout-dna.json`
  - Written by `fakeoutDnaEngine.js`.
  - Read by live `applyFakeoutDna()` and API routes.
- `rule-health.json`
  - Written by `selfHealingRuleEngine.js`.
  - Read by Machine page/API/health. It does not alter live rules.
- `momentum-backtest.json`
  - Written by `momentumBacktestAnalyzer.js`.
  - Read by API/health/Machine page. Current live fakeout probability logic also
    contains built-in backtest adjustment logic.

## Cache Behavior

Several engines cache JSON artifacts for about 5 minutes. After writing new
history/outcome data, call the relevant invalidation where available. The current
explicit cache invalidation is `historicalEdge.invalidateCache()`, called after
`/api/history/analyze`, `/api/history/hunt-signals`, and Machine cache invalidation.

## What Not To Change Blindly

- Do not change the shape of signal or outcome JSONL rows without updating all
  loaders and learning builders.
- Do not rename `learning-summary.json`; multiple old and new modules share it.
- Do not remove legacy Alpaca 2-minute fallback reads unless old data is migrated.
- Do not reorder Machine steps without checking which files downstream steps read.
- Do not make self-healing rule health mutate live rules. It is currently report
  only.
- Do not allow overlapping Machine runs.

