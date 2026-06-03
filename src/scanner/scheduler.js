'use strict';
const { fetch1mBars, fetchLatestTrade, aggregate1mTo2m } = require('./alpacaClient');
const { aggregate1mTo5m, aggregate1mTo15m }              = require('../data/candleAggregator');
const { calcIndicators } = require('./indicators');
const { classifyNarrowState } = require('./narrowState');
const { applyEngineV3 }                          = require('./engineV3');
const { calcMarketRegimeV2, applyMarketRegimeV2 } = require('./marketRegimeEngine');
const { applyHistoricalEdge }                     = require('./historicalEdge');
const { applyConfidenceEngine }                   = require('./confidenceEngine');
const { applyMtf }                                = require('./mtf');
const { applyMomentumContinuation }               = require('./momentumContinuationEngine');
const { applyFakeoutProbability }                 = require('./fakeoutProbabilityEngine');
const { applyLiquiditySweep }                     = require('./liquiditySweepEngine');
const { applyAdaptiveEdge }                       = require('./adaptiveEdgeEngine');
const { applySetupDNA }                           = require('./setupDnaEngine');
const { applyWavePhase }                          = require('./wavePhaseEngine');
const { applyRuleMemory }                         = require('./ruleMemoryEngine');
const { applySymbolPersonality }                  = require('./symbolPersonalityEngine');
const { applyRegimeProfile }                      = require('./regimeProfileEngine');
const { applyScoreCalibration }                   = require('./scoreCalibrationEngine');
const { applyFakeoutDna }                         = require('./fakeoutDnaEngine');
const { applyPreMove }                            = require('./preMoveEngine');
const { applyMarketFatigue }                      = require('./marketFatigueEngine');
const { computeAndSavePersonality }               = require('./marketPersonalityEngine');
const { applyStateGraph }                         = require('./marketStateGraphEngine');
const { orchestrateScores }                       = require('./learningOrchestrator');
const { applyConfidenceDecay }                    = require('./confidenceDecayEngine');
const { applyMicroMove }                          = require('./microMoveEngine');
const { enrichIndicatorsFromCandles }             = require('./indicatorEnrichment');
const { logResults }                              = require('./featureLogger');
const { buildFeedStatus, classifyProviderError }  = require('../providerStatus');
const { processScanResults }                      = require('../alerts/notificationService');
const notificationEngineV2                         = require('../alerts/notificationEngineV2');
const { getMarketGroup }                          = require('../markets/marketProfiles');
const { computeAndSaveCompass }                   = require('../markets/marketCompass');
const redisService                                = require('../services/redisService');
const marketUniverse                              = require('../services/marketUniverseService');
const eventLogService                             = require('../services/eventLogService');
const strategyRuntimeConnector                    = require('../services/strategyRuntimeConnectorService');

const GROUPS = {
  stocks:        ['NVDA', 'AMD', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'NFLX', 'GOOGL'],
  // TODO: Replace QQQ with real NASDAQ-100 index (NDX/NAS100) when a provider
  // supporting index bar data is added. Alpaca IEX returns 0 bars for NDX.
  nasdaq:        ['QQQ'],
  indexEtfs:     ['SPY', 'IWM', 'DIA'],
  leveragedEtfs: ['TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'TNA', 'TZA'],
  crypto:        ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
};
// Nasdaq-focused watchlist: the 9 large-cap stocks + QQQ + SPY.
// QQQ and SPY are kept ONLY as market-compass references (observe-only) — they
// drive the RISK_ON/RISK_OFF gate logic in marketCompass.js. IWM/DIA and the
// leveraged ETFs are disconnected. Crypto runs in its own (now disabled) scheduler.
const WATCHLIST = [
  ...GROUPS.stocks,
  ...GROUPS.nasdaq, // QQQ — Nasdaq-100 proxy + compass
  'SPY',            // S&P 500 — compass reference only
];
const SCAN_INTERVAL_MS = 30_000;

let latestResults = [];
const liveCandleCache = new Map();
let scanStatus = {
  lastScan: null,
  scanning: false,
  error: null,
  marketWarning: false,
};
let scanTimer = null;

async function scanSymbol(symbol) {
  const now = new Date().toISOString();
  try {
    const bars1m = await fetch1mBars(symbol, 410);
    if (!bars1m || bars1m.length < 40) {
      updateLiveCandleCache(symbol, '1m', bars1m || [], 'alpaca_live_1m');
      return {
        symbol,
        price: null,
        state: 'NO_TRADE',
        position: null,
        signal: 'NO_TRADE',
        confidence: 0,
        sma20: null,
        sma200: null,
        smaGap: null,
        smaGapPct: null,
        rsi14: null,
        atr14: null,
        recentHigh: null,
        recentLow: null,
        recentRange: null,
        compressionRatio: null,
        longTrigger: null,
        shortTrigger: null,
        invalidationLong: null,
        invalidationShort: null,
        target1Long: null,
        target2Long: null,
        target1Short: null,
        target2Short: null,
        candleCount: bars1m ? bars1m.length : 0,
        lastUpdate: now,
        note: 'Not enough 1m bars from Alpaca',
      };
    }

    const candles2m  = aggregate1mTo2m(bars1m);
    const candles5m  = aggregate1mTo5m(bars1m);
    const candles15m = aggregate1mTo15m(bars1m);
    updateLiveCandleCache(symbol, '1m', bars1m, 'alpaca_live_1m');
    updateLiveCandleCache(symbol, '2m', candles2m, 'alpaca_live_2m');
    const indicators = calcIndicators(candles2m);

    if (!indicators) {
      return {
        symbol,
        price: null,
        state: 'NO_TRADE',
        position: null,
        signal: 'NO_TRADE',
        confidence: 0,
        sma20: null,
        sma200: null,
        smaGap: null,
        smaGapPct: null,
        rsi14: null,
        atr14: null,
        recentHigh: null,
        recentLow: null,
        recentRange: null,
        compressionRatio: null,
        longTrigger: null,
        shortTrigger: null,
        invalidationLong: null,
        invalidationShort: null,
        target1Long: null,
        target2Long: null,
        target1Short: null,
        target2Short: null,
        candleCount: candles2m.length,
        lastUpdate: now,
        note: 'Not enough 2m candles for indicators',
      };
    }

    let price = candles2m[candles2m.length - 1].c;
    try {
      const trade = await fetchLatestTrade(symbol);
      if (trade && trade.price > 0) price = trade.price;
    } catch (_) {
      // fallback to last close
    }

    const result = classifyNarrowState({ symbol, price, candles2m, indicators, lastUpdate: now });
    result._candles2m  = candles2m;
    // Attach MTF candles as private fields; applyEngineV3 will read and strip them
    result._candles5m  = candles5m;
    result._candles15m = candles15m;
    return result;
  } catch (err) {
    const providerError = classifyProviderError(err, 'alpaca');
    const isMarketClosed =
      err?.response?.status === 422 ||
      (err?.message && err.message.toLowerCase().includes('market'));
    return {
      symbol,
      price: null,
      state: 'NO_TRADE',
      position: null,
      signal: 'NO_TRADE',
      confidence: 0,
      sma20: null,
      sma200: null,
      smaGap: null,
      smaGapPct: null,
      rsi14: null,
      atr14: null,
      recentHigh: null,
      recentLow: null,
      recentRange: null,
      compressionRatio: null,
      longTrigger: null,
      shortTrigger: null,
      invalidationLong: null,
      invalidationShort: null,
      target1Long: null,
      target2Long: null,
      target1Short: null,
      target2Short: null,
      candleCount: 0,
      lastUpdate: now,
      provider: 'alpaca',
      providerErrorType: providerError.type,
      note: isMarketClosed
        ? 'Market may be closed – no recent data'
        : `Error: ${providerError.type}`,
    };
  }
}

async function runScan() {
  if (scanStatus.scanning) return;
  scanStatus.scanning = true;
  scanStatus.error = null;

  const results = [];
  let anyMarketWarning = false;

  const activeWatchlist = WATCHLIST.filter((symbol) => marketUniverse.symbolEnabledFor(symbol, 'scanner', getMarketGroup(symbol)));

  for (const symbol of activeWatchlist) {
    const result = await scanSymbol(symbol);
    results.push(result);
    if (result.note && result.note.includes('Market may be closed')) {
      anyMarketWarning = true;
    }
    // Small delay between requests to avoid rate limits
    await delay(200);
  }

  // Engine v3: use QQQ as market reference for all symbols
  const qqqResult = results.find((r) => r.symbol === 'QQQ') || null;

  // Market Regime V2: compute once from QQQ, apply to all
  let mktCtxV2 = null;
  try { mktCtxV2 = calcMarketRegimeV2(qqqResult); } catch (_) {}

  latestResults = results
    .map((r) => applyEngineV3(r, qqqResult))
    .map((r) => applyMarketRegimeV2(r, mktCtxV2))
    .map((r) => applyHistoricalEdge(r))
    .map((r) => applyConfidenceEngine(r))
    .map((r) => applyMtf(r))
    .map((r) => applyMomentumContinuation(r))
    .map((r) => applyFakeoutProbability(r))
    .map((r) => applyLiquiditySweep(r))
    .map((r) => applyAdaptiveEdge(r))
    .map((r) => applyRuleMemory(r))
    .map((r) => applySymbolPersonality(r))
    .map((r) => applyRegimeProfile(r))
    .map((r) => applyScoreCalibration(r))
    .map((r) => applyFakeoutDna(r))
    .map((r) => applyPreMove(r))
    .map((r) => applyMarketFatigue(r))
    .map((r) => applyStateGraph(r))
    .map((r) => applySetupDNA(r))
    .map((r) => orchestrateScores(r))
    .map((r) => applyConfidenceDecay(r))
    .map((r) => applyWavePhase(r))
    .map((r) => applyMicroMove(r))
    .map((r) => strategyRuntimeConnector.enrichSignalWithStrategy(r))
    .map((r) => ({ ...r, narrow_state_data: r.narrow_state_data || r.stateGraph || null }))
    .map((r) => enrichLiveIndicators(r))
    .map((r) => stripPrivateFields(r))
    .map((r) => ({ ...r, marketGroup: getMarketGroup(r.symbol) || 'UNKNOWN' }));

  // Market personality (computed from aggregate of all results)
  try { computeAndSavePersonality(latestResults, 'stocks'); } catch (_) {}
  cacheScanState('stocks', latestResults, scanStatus);

  // Market compass: derive risk-on/off from QQQ + SPY
  try { computeAndSaveCompass(latestResults); } catch (_) {}

  // Feature logging (respects FEATURE_LOGGING_ENABLED env flag)
  logResults(latestResults.filter((r) => GROUPS.stocks.includes(r.symbol)), 'stocks');
  logResults(latestResults.filter((r) => GROUPS.nasdaq.includes(r.symbol)), 'nasdaq');

  scanStatus.lastScan = new Date().toISOString();
  scanStatus.scanning = false;
  scanStatus.marketWarning = anyMarketWarning;
  emitScannerEvents(latestResults, scanStatus);

  processScanResults(latestResults.filter((r) => GROUPS.stocks.includes(r.symbol)), {
    group: 'stocks',
    feedStatus: getStockFeedStatus(),
  }).catch((err) => console.warn('[Notifier] scan processing failed:', err.message));
  notificationEngineV2.processStrongSignals(latestResults.filter((r) => GROUPS.stocks.includes(r.symbol)), {
    group: 'stocks',
    feedStatus: getStockFeedStatus(),
  }).catch((err) => console.warn('[notification-v2] scan processing failed:', err.message));

  console.log(`[Scanner] Scan complete at ${scanStatus.lastScan} – ${results.length} symbols (Engine v3, market-controls)`);
}

function startScheduler() {
  console.log('[Scanner] Starting scheduler, interval:', SCAN_INTERVAL_MS / 1000, 's');
  runScan();
  scanTimer = setInterval(runScan, SCAN_INTERVAL_MS);
}

function stopScheduler() {
  if (scanTimer) clearInterval(scanTimer);
}

function getLatestResults() {
  return latestResults;
}

function getStockFeedStatus() {
  return buildFeedStatus({
    group: 'stocks',
    provider: 'alpaca',
    scannerStatus: scanStatus,
    results: latestResults.filter((r) =>
      GROUPS.stocks.includes(r.symbol) ||
      GROUPS.nasdaq.includes(r.symbol) ||
      GROUPS.indexEtfs.includes(r.symbol) ||
      GROUPS.leveragedEtfs.includes(r.symbol),
    ),
    staleMinutes: 15,
    marketAware: true,
  });
}

function getScanStatus() {
  return { ...scanStatus, feedStatus: getStockFeedStatus() };
}

function getWatchlist() {
  return WATCHLIST;
}

function getGroups() {
  return GROUPS;
}

function normalizeDebugCandle(c) {
  const timestamp = c?.timestamp || c?.ts || c?.t || null;
  return {
    timestamp,
    open: c?.open ?? c?.o ?? null,
    high: c?.high ?? c?.h ?? null,
    low: c?.low ?? c?.l ?? null,
    close: c?.close ?? c?.c ?? null,
    volume: c?.volume ?? c?.v ?? null,
  };
}

function updateLiveCandleCache(symbol, timeframe, candles, sourceName) {
  const normalized = (candles || [])
    .map(normalizeDebugCandle)
    .filter((c) => c.timestamp)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const snapshot = {
    symbol: String(symbol || '').toUpperCase(),
    marketType: 'stock',
    timeframe,
    sourceName,
    updatedAt: new Date().toISOString(),
    candles: normalized,
  };
  liveCandleCache.set(`${String(symbol || '').toUpperCase()}:${timeframe}`, snapshot);
  void redisService.setJson(`candles:stock:${snapshot.symbol}:${timeframe}`, snapshot, 180);
}

function getLiveCandlesDebug(symbol, timeframe = '2m') {
  return liveCandleCache.get(`${String(symbol || '').toUpperCase()}:${timeframe}`) || null;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripPrivateFields(result) {
  const { _candles2m, _candles5m, _candles15m, ...rest } = result || {};
  const last2m = Array.isArray(_candles2m) && _candles2m.length
    ? _candles2m[_candles2m.length - 1]
    : null;
  return {
    ...rest,
    latest2mTimestamp: last2m?.t || last2m?.ts || rest.latest2mTimestamp || null,
  };
}

function enrichLiveIndicators(result) {
  const candles = result?._candles2m || [];
  if (!candles.length) {
    return {
      ...result,
      ema9: result?.ema9 ?? null,
      ema21: result?.ema21 ?? null,
      ema50: result?.ema50 ?? null,
      sma50: result?.sma50 ?? null,
      vwap: result?.vwap ?? null,
      vwapDistancePct: result?.vwapDistancePct ?? null,
      rvol: result?.rvol ?? result?.relVol20 ?? null,
      volumeState: result?.volumeState || 'unknown',
      candleScore2m: result?.candleScore2m ?? null,
    };
  }
  const enriched = enrichIndicatorsFromCandles(result, candles);
  return {
    ...result,
    ...enriched,
    rvol: enriched.rvol,
  };
}

function cacheScanState(group, results, status) {
  const updatedAt = new Date().toISOString();
  const prices = {};
  for (const r of results || []) {
    if (r.symbol && r.price != null) prices[r.symbol] = Number(r.price);
  }
  void redisService.setJson(`scan:${group}:latest`, {
    ok: true,
    group,
    updatedAt,
    status: { ...status, lastScan: updatedAt },
    count: (results || []).length,
    results,
  }, 180);
  void redisService.setJson(`prices:${group}:latest`, {
    ok: true,
    group,
    updatedAt,
    prices,
  }, 60);
  void redisService.setJson(`market:personality:${group}:snapshot`, {
    ok: true,
    group,
    updatedAt,
    symbols: (results || []).map((r) => ({
      symbol: r.symbol,
      marketGroup: r.marketGroup || null,
      state: r.state || null,
      signal: r.signal || null,
      confidence: r.confidence ?? r.confidenceScore ?? null,
      price: r.price ?? null,
    })),
  }, 300);
}

function emitScannerEvents(results, status) {
  try {
    const timestamp = status?.lastScan || new Date().toISOString();
    for (const row of results || []) {
      if (!row?.symbol) continue;
      const signal = String(row.signal || '').toUpperCase();
      if (!signal || signal === 'NO_TRADE') continue;

      const direction = row.daytradeDirection === 'up'
        ? 'UP'
        : row.daytradeDirection === 'down'
          ? 'DOWN'
          : 'NONE';
      const baseEvent = {
        source: 'scanner',
        timestamp,
        symbol: row.symbol,
        market: row.marketGroup || row.marketType || 'unknown',
        timeframe: row.timeframe || '2m',
        raw_signal: row.signalSubtype || row.signalFamily || signal,
        direction,
        strategy: row.strategy_id || row.strategy_name || null,
        strategyId: row.strategyId || row.strategy_id || row.setupId || row.sourceStrategyId || null,
        strategyName: row.strategyName || row.strategy_name || null,
        strategy_name: row.strategy_name || row.strategyName || null,
        sourceStrategyId: row.sourceStrategyId || null,
        resolvedStrategyId: row.resolvedStrategyId || row.strategyId || row.strategy_id || row.setupId || null,
        sourceStrategyName: row.sourceStrategyName || null,
        resolvedStrategyName: row.resolvedStrategyName || row.strategyName || row.strategy_name || null,
        mappingSource: row.mappingSource || (row.sourceStrategyId || row.strategyId || row.strategy_id || row.setupId ? 'explicit' : 'unknown'),
        score: row.tradeScore ?? row.daytradeScore ?? row.confidenceScore ?? null,
        decision: 'observe_only',
        reason: row.daytradeStatus || row.signal || null,
        threshold: row.confidenceThreshold ?? row.scoreThreshold ?? null,
        paper: true,
        metadata: {
          signal: row.signal || null,
          signal_family: row.signalFamily || null,
          signal_subtype: row.signalSubtype || null,
          strategyId: row.strategyId || row.strategy_id || row.setupId || row.sourceStrategyId || null,
          source_strategy_id: row.sourceStrategyId || null,
          resolved_strategy_id: row.resolvedStrategyId || row.strategyId || row.strategy_id || row.setupId || null,
          mapping_source: row.mappingSource || (row.sourceStrategyId || row.strategyId || row.strategy_id || row.setupId ? 'explicit' : 'unknown'),
          strategy_id: row.strategy_id || null,
          strategy_name: row.strategy_name || null,
          daytrade_score: row.daytradeScore ?? null,
          daytrade_status: row.daytradeStatus || null,
          daytrade_direction: row.daytradeDirection || null,
          market_group: row.marketGroup || null,
          market_type: row.marketType || null,
          market_regime: row.marketRegime || null,
          market_regime_v2: row.marketRegimeV2 || null,
          score_label: row.scoreLabel || null,
        },
      };

      eventLogService.appendEvent({
        ...baseEvent,
        event_type: 'signal.detected',
      });

      if (row.strategy_id || row.strategy_name) {
        eventLogService.appendEvent({
          ...baseEvent,
          event_type: 'strategy.matched',
          metadata: {
            ...baseEvent.metadata,
            matched: true,
          },
        });
      }
    }
  } catch (err) {
    console.warn('[event-log] scanner mirror failed:', err.message);
  }
}

module.exports = { startScheduler, stopScheduler, getLatestResults, getScanStatus, getWatchlist, getGroups, getStockFeedStatus, getLiveCandlesDebug };
