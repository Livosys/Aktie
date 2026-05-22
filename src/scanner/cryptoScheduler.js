'use strict';
const { fetch1mBars, aggregate1mTo2m } = require('./binanceClient');
const { calcIndicators } = require('./indicators');
const { classifyNarrowState } = require('./narrowState');
const { applyEngineV3 }                          = require('./engineV3');
const { calcMarketRegimeV2, applyMarketRegimeV2 } = require('./marketRegimeEngine');
const { applyHistoricalEdge }                     = require('./historicalEdge');
const { applyConfidenceEngine }                   = require('./confidenceEngine');
const { applyAdaptiveEdge }                       = require('./adaptiveEdgeEngine');
const { applySetupDNA }                           = require('./setupDnaEngine');
const { applyWavePhase }                          = require('./wavePhaseEngine');
const { applyRuleMemory }                         = require('./ruleMemoryEngine');
const { applySymbolPersonality }                  = require('./symbolPersonalityEngine');
const { applyRegimeProfile }                      = require('./regimeProfileEngine');
const { logResults }                              = require('./featureLogger');

const CRYPTO_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const SCAN_INTERVAL_MS = 30_000;

let cryptoResults = [];
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

    const candles2m = aggregate1mTo2m(bars1m);
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

    const price = candles2m[candles2m.length - 1].c;
    return classifyNarrowState({ symbol, price, candles2m, indicators, lastUpdate: now });
  } catch (err) {
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
      note: `Error: ${err.message || 'Unknown error'}`,
    };
  }
}

async function runCryptoScan() {
  if (cryptoStatus.scanning) return;
  cryptoStatus.scanning = true;
  cryptoStatus.error = null;

  const results = [];
  for (const symbol of CRYPTO_SYMBOLS) {
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
    .map((r) => applyAdaptiveEdge(r))
    .map((r) => applyRuleMemory(r))
    .map((r) => applySymbolPersonality(r))
    .map((r) => applyRegimeProfile(r))
    .map((r) => applySetupDNA(r))
    .map((r) => applyWavePhase(r));

  // Feature logging (respects FEATURE_LOGGING_ENABLED env flag)
  logResults(cryptoResults, 'crypto');

  cryptoStatus.lastScan = new Date().toISOString();
  cryptoStatus.scanning = false;
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

function getCryptoStatus() {
  return cryptoStatus;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { startCryptoScheduler, stopCryptoScheduler, getCryptoResults, getCryptoStatus };
