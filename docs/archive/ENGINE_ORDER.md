# Engine Order

This file documents the live scanner pipeline order as implemented in
`src/scanner/scheduler.js` and `src/scanner/cryptoScheduler.js`.

## Live Stock/Nasdaq Pipeline

Before the engine chain, each symbol is built from live data:

1. `fetch1mBars(symbol, 410)` from Alpaca.
2. Aggregate to 2-minute candles with `aggregate1mTo2m()`.
3. Aggregate the same 1-minute bars to 5-minute and 15-minute candles.
4. Calculate indicators with `calcIndicators(candles2m)`.
5. Prefer `fetchLatestTrade(symbol)` as price; fall back to latest 2-minute close.
6. Build base result with `classifyNarrowState()`.
7. Attach `_candles2m`, `_candles5m`, `_candles15m`.
8. Use `QQQ` as the stock market reference.
9. Compute Market Regime V2 context once from `QQQ`.

Then the result array is mapped through this exact order:

1. `applyEngineV3(r, qqqResult)`
2. `applyMarketRegimeV2(r, mktCtxV2)`
3. `applyHistoricalEdge(r)`
4. `applyConfidenceEngine(r)`
5. `applyMtf(r)`
6. `applyMomentumContinuation(r)`
7. `applyFakeoutProbability(r)`
8. `applyLiquiditySweep(r)`
9. `applyAdaptiveEdge(r)`
10. `applyRuleMemory(r)`
11. `applySymbolPersonality(r)`
12. `applyRegimeProfile(r)`
13. `applyScoreCalibration(r)`
14. `applyFakeoutDna(r)`
15. `applyPreMove(r)`
16. `applyMarketFatigue(r)`
17. `applyStateGraph(r)`
18. `applySetupDNA(r)`
19. `orchestrateScores(r)`
20. `applyConfidenceDecay(r)`
21. `applyWavePhase(r)`
22. `stripPrivateFields(r)`

After the chain:

1. `computeAndSavePersonality(latestResults, 'stocks')`
2. `logResults(stocks, 'stocks')`
3. `logResults(nasdaq, 'nasdaq')`
4. Update scan status and expose latest results through API routes.

## Live Crypto Pipeline

Before the engine chain, each symbol is built from live Binance data:

1. `fetch1mBars(symbol, 410)` from Binance.
2. Aggregate to 2-minute, 5-minute, and 15-minute candles.
3. Calculate indicators with `calcIndicators(candles2m)`.
4. Use latest 2-minute close as price.
5. Build base result with `classifyNarrowState()`.
6. Attach `_candles2m`, `_candles5m`, `_candles15m`.
7. Run `applyEngineV3()` first with `BTCUSDT` as market reference; BTC uses itself.
8. Compute Market Regime V2 context from enriched BTC.

Then the crypto result array is mapped through this exact order:

1. `applyMarketRegimeV2(r, mktCtxV2)`
2. `applyHistoricalEdge(r)`
3. `applyConfidenceEngine(r)`
4. `applyMtf(r)`
5. `applyMomentumContinuation(r)`
6. `applyFakeoutProbability(r)`
7. `applyLiquiditySweep(r)`
8. `applyAdaptiveEdge(r)`
9. `applyRuleMemory(r)`
10. `applySymbolPersonality(r)`
11. `applyRegimeProfile(r)`
12. `applyScoreCalibration(r)`
13. `applyFakeoutDna(r)`
14. `applyPreMove(r)`
15. `applyMarketFatigue(r)`
16. `applyStateGraph(r)`
17. `applySetupDNA(r)`
18. `orchestrateScores(r)`
19. `applyConfidenceDecay(r)`
20. `applyWavePhase(r)`
21. `stripPrivateFields(r)`

`applyEngineV3()` is intentionally separated in crypto because BTC must be
enriched before its Market Regime V2 context is calculated.

After the chain:

1. `computeAndSavePersonality(cryptoResults, 'crypto')`
2. `logResults(cryptoResults, 'crypto')`
3. Update crypto scan status and expose latest results through API routes.

## Engine Responsibilities

- `indicators.js`: SMA, RSI, ATR, recent range, average range, Bollinger width,
  relative volume, ATR/BBW percentiles.
- `narrowState.js`: base scanner classifier. Calculates narrow metrics, Three
  Finger Spread, elephant bars, color changes, pullbacks, breakout-already-
  occurred, triggers, targets, invalidations, event type, action text, reasons,
  `tradeScore`, and `signal`.
- `engineV3.js`: orchestrates original Engine v3 enrichment. Adds market regime,
  MTF metadata, score breakdown, `tradeScore`, `signalScore`, and score label.
- `marketRegime.js`: original Engine v3 market regime from reference symbol.
- `scoreBreakdown.js`: six-component score model plus market adjustment.
- `marketRegimeEngine.js`: richer Market Regime V2 context and max +/-5 score
  adjustment.
- `historicalEdge.js`: reads signal/outcome history, finds similar historical
  setups, and applies edge-based score adjustment.
- `confidenceEngine.js`: applies historical boosters/blockers, creates
  `confidence`, `autoFilter`, and hard caps.
- `mtf.js`: calculates 5-minute/15-minute alignment metadata in Engine v3 and
  applies MTF score adjustment after `autoFilter` exists.
- `momentumContinuationEngine.js`: estimates continuation quality/probability and
  watch mode; adjusts score conservatively.
- `fakeoutProbabilityEngine.js`: estimates fakeout risk and applies the built-in
  momentum backtest adjustment.
- `liquiditySweepEngine.js`: detects sweep/trap structures and watch mode; adjusts
  score conservatively.
- `adaptiveEdgeEngine.js`: uses learning summary dimensions to apply adaptive
  score adjustments.
- `ruleMemoryEngine.js`: learns rules that blocked later-continuing setups and
  adds watch-mode metadata/limited boosts when safe.
- `symbolPersonalityEngine.js`: builds and applies per-symbol behavioral profiles.
- `regimeProfileEngine.js`: builds and applies per-regime behavioral profiles.
- `scoreCalibrationEngine.js`: calibrates score ranges against historical outcome
  buckets.
- `fakeoutDnaEngine.js`: learns fakeout-prone feature values and applies
  conservative score changes.
- `preMoveEngine.js`: enrichment-only compression/pre-breakout pressure detector.
- `marketFatigueEngine.js`: enrichment-only exhaustion and continuation-decay
  detector.
- `marketStateGraphEngine.js`: enrichment-only state-cycle tracker persisted per
  symbol.
- `setupDnaEngine.js`: compares live setups with historical setup DNA and applies
  a cached similarity adjustment.
- `learningOrchestrator.js`: combines learning engine adjustment proposals,
  resolves conflicts, clamps total effect, and reapplies hard-block caps.
- `confidenceDecayEngine.js`: penalizes unchanged/stale setups across scan ticks
  and reapplies hard caps.
- `wavePhaseEngine.js`: classifies wave/cycle phase for UI and wave routes.
- `marketPersonalityEngine.js`: computes aggregate group personality after scans.
- `featureLogger.js`: appends scanner feature rows and reads recent logs.

## Offline And Support Engines

- `historicalScanner.js`: replays stored 2-minute candles through the scanner and
  saves historical signal records.
- `signalOutcomeAnalyzer.js`: calculates post-signal outcomes and success labels.
- `signalLearning.js`: legacy learning summary builder.
- `learningEngine.js`: newer learning summary builder with broader dimensions.
- `replayEngine.js`: runs historical replay and saves events/summary.
- `replayInsights.js`: builds replay insights.
- `selfHealingRuleEngine.js`: builds rule-health report only; no live pipeline
  step and no automatic rule mutation.
- `momentumBacktestAnalyzer.js`: builds momentum/fakeout/liquidity backtest.
- `missedBreakoutFinder.js`: identifies missed breakout opportunities for review.
- `signalMemory.js`: in-memory signal transition helper. It is present but not
  wired into the current live scheduler pipeline.
- `alertEngine.js`: alert persistence/deduplication helper. It is wired into
  health and alert API routes, but not into the live scan order itself.

## Order-Sensitive Contracts

- `applyMtf()` must run after `applyConfidenceEngine()` because it needs
  `autoFilter.blocked` for hard-block safety.
- Learning/profile/calibration engines must run before `orchestrateScores()` so
  the orchestrator can see their adjustment fields.
- `orchestrateScores()` must run before `applyConfidenceDecay()` and
  `applyWavePhase()` in the current design.
- `stripPrivateFields()` must remain last so `_candles2m`, `_candles5m`, and
  `_candles15m` do not leak to API clients.
