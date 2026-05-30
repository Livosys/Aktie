'use strict';
const { fetch1mBars, aggregate1mTo2m } = require('./binanceClient');
const { aggregate1mTo5m, aggregate1mTo15m } = require('../data/candleAggregator');
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
const redisService                                = require('../services/redisService');
const marketUniverse                              = require('../services/marketUniverseService');

const CRYPTO_MAJOR     = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const CRYPTO_SECONDARY = ['BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT'];
const CRYPTO_SYMBOLS   = [...CRYPTO_MAJOR, ...CRYPTO_SECONDARY];
const SCAN_INTERVAL_MS = 30_000;

let cryptoResults = [];
const liveCandleCache = new Map();
let cryptoStatus = {
  lastScan: null,
  scanning: false,
  error: null,
};
let cryptoTimer = null;

async function scanCryptoSymbol(symbol) {
  const now = new Date().toISOString();
  try {
    const bars1m = await fetch1mBars(symbol, 410);
    if (!bars1m || bars1m.length < 40) {
      updateLiveCandleCache(symbol, '1m', bars1m || [], 'binance_live_1m');
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
        note: 'Not enough 1m bars from Binance',
      };
    }

    const candles2m  = aggregate1mTo2m(bars1m);
    const candles5m  = aggregate1mTo5m(bars1m);
    const candles15m = aggregate1mTo15m(bars1m);
    updateLiveCandleCache(symbol, '1m', bars1m, 'binance_live_1m');
    updateLiveCandleCache(symbol, '2m', candles2m, 'binance_live_2m');
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

    const price  = candles2m[candles2m.length - 1].c;
    const result = classifyNarrowState({ symbol, price, candles2m, indicators, lastUpdate: now });
    result._candles2m  = candles2m;
    result._candles5m  = candles5m;
    result._candles15m = candles15m;
    return result;
  } catch (err) {
    const providerError = classifyProviderError(err, 'binance');
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
      provider: 'binance',
      providerErrorType: providerError.type,
      note: `Error: ${providerError.type}`,
    };
  }
}

async function runCryptoScan() {
  if (cryptoStatus.scanning) return;
  cryptoStatus.scanning = true;
  cryptoStatus.error = null;

  const results = [];
  const activeSymbols = CRYPTO_SYMBOLS.filter((symbol) => marketUniverse.symbolEnabledFor(symbol, 'scanner', getMarketGroup(symbol) || 'crypto'));

  for (const symbol of activeSymbols) {
    const result = await scanCryptoSymbol(symbol);
    results.push(result);
    await delay(300);
  }

  // Engine v3: BTCUSDT as market reference for ETH/SOL; BTC uses itself
  const btcResult = results.find((r) => r.symbol === 'BTCUSDT') || null;
  const v3Results = results.map((r) => {
    const ref = r.symbol === 'BTCUSDT' ? r : btcResult;
    return applyEngineV3(r, ref);
  });

  // Market Regime V2: compute from enriched BTC result
  const v3BtcResult = v3Results.find((r) => r.symbol === 'BTCUSDT') || null;
  let mktCtxV2 = null;
  try { mktCtxV2 = calcMarketRegimeV2(v3BtcResult); } catch (_) {}

  cryptoResults = v3Results
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
    .map((r) => enrichLiveIndicators(r))
    .map((r) => stripPrivateFields(r))
    .map((r) => ({ ...r, marketGroup: getMarketGroup(r.symbol) || 'CRYPTO_MAJOR' }));

  // Market personality (computed from aggregate of major crypto only)
  try { computeAndSavePersonality(cryptoResults.filter(r => CRYPTO_MAJOR.includes(r.symbol)), 'crypto'); } catch (_) {}
  cacheScanState('crypto', cryptoResults, cryptoStatus);

  // Feature logging (respects FEATURE_LOGGING_ENABLED env flag)
  logResults(cryptoResults.filter(r => CRYPTO_MAJOR.includes(r.symbol)), 'crypto');
  logResults(cryptoResults.filter(r => CRYPTO_SECONDARY.includes(r.symbol)), 'crypto_secondary');

  cryptoStatus.lastScan = new Date().toISOString();
  cryptoStatus.scanning = false;

  processScanResults(cryptoResults, {
    group: 'crypto',
    feedStatus: getCryptoFeedStatus(),
  }).catch((err) => console.warn('[Notifier] crypto processing failed:', err.message));
  notificationEngineV2.processStrongSignals(cryptoResults, {
    group: 'crypto',
    feedStatus: getCryptoFeedStatus(),
  }).catch((err) => console.warn('[notification-v2] crypto processing failed:', err.message));

  console.log(`[CryptoScanner] Scan complete at ${cryptoStatus.lastScan} – ${results.length} symbols (Engine v3)`);
}

function startCryptoScheduler() {
  console.log('[CryptoScanner] Starting 24/7 crypto scheduler, interval:', SCAN_INTERVAL_MS / 1000, 's');
  runCryptoScan();
  cryptoTimer = setInterval(runCryptoScan, SCAN_INTERVAL_MS);
}

function stopCryptoScheduler() {
  if (cryptoTimer) clearInterval(cryptoTimer);
}

function getCryptoResults() {
  return cryptoResults;
}

function getCryptoFeedStatus() {
  return buildFeedStatus({
    group: 'crypto',
    provider: 'binance',
    scannerStatus: cryptoStatus,
    results: cryptoResults,
    staleMinutes: 5,
  });
}

function getCryptoStatus() {
  return { ...cryptoStatus, feedStatus: getCryptoFeedStatus() };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    marketType: 'crypto',
    timeframe,
    sourceName,
    updatedAt: new Date().toISOString(),
    candles: normalized,
  };
  liveCandleCache.set(`${String(symbol || '').toUpperCase()}:${timeframe}`, snapshot);
  void redisService.setJson(`candles:crypto:${snapshot.symbol}:${timeframe}`, snapshot, 180);
}

function getLiveCandlesDebug(symbol, timeframe = '2m') {
  return liveCandleCache.get(`${String(symbol || '').toUpperCase()}:${timeframe}`) || null;
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

module.exports = { startCryptoScheduler, stopCryptoScheduler, getCryptoResults, getCryptoStatus, getCryptoFeedStatus, getLiveCandlesDebug };
