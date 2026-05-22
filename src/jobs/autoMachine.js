'use strict';
/**
 * Auto-Machine v1
 *
 * Runs the full history + learning pipeline in sequence:
 *   1. Backfill data (Alpaca/Binance)
 *   2. Hunt signals (historical scan)
 *   3. Replay
 *   4. Analyze outcomes
 *   5. Update learning
 *   6. Invalidate historicalEdge cache
 *   7. Save status
 *
 * Never runs two pipelines simultaneously.
 * If a symbol fails, the rest continue.
 */

const fs   = require('fs');
const path = require('path');

const { fetchAlpacaBars, isEnabled: alpacaEnabled, hasCredentials } = require('../data/alpacaDataService');
const { fetchBinanceKlines }  = require('../data/binanceDataService');
const { saveRawBars, saveCandles2m } = require('../data/marketDataStore');
const { aggregate1mTo2m, filterComplete } = require('../data/candleAggregator');
const { runHistoricalScan }   = require('../scanner/historicalScanner');
const { runReplay }           = require('../scanner/replayEngine');
const { analyzeOutcomes }     = require('../scanner/signalOutcomeAnalyzer');
const { saveLearning }        = require('../scanner/signalLearning');
const { runLearningEngine }   = require('../scanner/learningEngine');
const { buildRuleMemory }     = require('../scanner/ruleMemoryEngine');
const { buildSymbolProfiles } = require('../scanner/symbolPersonalityEngine');
const { buildRegimeProfiles } = require('../scanner/regimeProfileEngine');
const { invalidateCache }     = require('../scanner/historicalEdge');

const STATUS_PATH = path.resolve(__dirname, '../../data/system/auto-machine-status.json');

const CRYPTO_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT']);

const STOCK_SYMBOLS_DEFAULT  = ['NVDA', 'AMD', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'QQQ'];
const CRYPTO_SYMBOLS_DEFAULT = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

// ── State ─────────────────────────────────────────────────────────────────────

let _running = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function isCrypto(symbol) {
  return symbol.endsWith('USDT') || CRYPTO_SYMBOLS.has(symbol.toUpperCase());
}

function dateRange(lookbackDays) {
  const end   = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - lookbackDays);
  return {
    start: start.toISOString().slice(0, 10),
    end:   end.toISOString().slice(0, 10),
  };
}

function readStatus() {
  try {
    if (!fs.existsSync(STATUS_PATH)) return null;
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeStatus(status) {
  try {
    ensureDir(path.dirname(STATUS_PATH));
    fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2), 'utf8');
  } catch (err) {
    console.warn('[AutoMachine] writeStatus failed:', err.message);
  }
}

// ── Backfill ──────────────────────────────────────────────────────────────────

async function backfillSymbol(symbol, start, end) {
  if (isCrypto(symbol)) {
    const bars = await fetchBinanceKlines({ symbol, interval: '1m', start, end, limit: 1000 });
    if (!bars || bars.length === 0) {
      return { rawBars: 0, candles2m: 0, source: 'binance', warning: 'no data' };
    }
    const byDate = {};
    for (const bar of bars) {
      const date = (bar.ts || '').slice(0, 10);
      if (date) (byDate[date] = byDate[date] || []).push(bar);
    }
    let totalRaw = 0; let total2m = 0;
    for (const [date, dateBars] of Object.entries(byDate)) {
      totalRaw += saveRawBars(symbol, date, dateBars, 'binance');
      total2m  += saveCandles2m(symbol, date, filterComplete(aggregate1mTo2m(dateBars)));
    }
    return { rawBars: totalRaw, candles2m: total2m, source: 'binance' };
  } else {
    const bars = await fetchAlpacaBars({ symbol, timeframe: '1Min', start, end, limit: 10000 });
    if (!bars || bars.length === 0) {
      return { rawBars: 0, candles2m: 0, source: 'alpaca', warning: 'no data' };
    }
    const byDate = {};
    for (const bar of bars) {
      const date = (bar.ts || '').slice(0, 10);
      if (date) (byDate[date] = byDate[date] || []).push(bar);
    }
    let totalRaw = 0; let total2m = 0;
    for (const [date, dateBars] of Object.entries(byDate)) {
      totalRaw += saveRawBars(symbol, date, dateBars, 'alpaca');
      total2m  += saveCandles2m(symbol, date, filterComplete(aggregate1mTo2m(dateBars)));
    }
    return { rawBars: totalRaw, candles2m: total2m, source: 'alpaca' };
  }
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

/**
 * Run the full auto-machine pipeline.
 *
 * @param {object} opts
 * @param {number}   opts.lookbackDays  - how many days back to process
 * @param {string[]} opts.groups        - ['stocks','crypto'] or subset
 * @returns {Promise<object>} run result
 */
async function runAutoMachine({ lookbackDays, groups }) {
  if (_running) {
    return { ok: false, error: 'Already running — duplicate run rejected' };
  }

  _running = true;
  const startedAt = new Date().toISOString();
  console.log(`[AutoMachine] Pipeline start — lookback=${lookbackDays}d groups=${groups.join(',')}`);

  const status = {
    running:    true,
    startedAt,
    finishedAt: null,
    lastResult: null,
    error:      null,
  };
  writeStatus(status);

  const result = {
    ok:         true,
    startedAt,
    finishedAt: null,
    lookbackDays,
    groups,
    steps:      {},
  };

  try {
    const { start, end } = dateRange(lookbackDays);
    result.start = start;
    result.end   = end;

    // ── Resolve symbols ───────────────────────────────────────────────────────
    const symbols = [];
    if (groups.includes('stocks'))  symbols.push(...STOCK_SYMBOLS_DEFAULT);
    if (groups.includes('crypto'))  symbols.push(...CRYPTO_SYMBOLS_DEFAULT);

    const stockSyms  = symbols.filter((s) => !isCrypto(s));
    const cryptoSyms = symbols.filter((s) =>  isCrypto(s));

    // ── Step 1: Backfill ──────────────────────────────────────────────────────
    console.log('[AutoMachine] Step 1: Backfill');
    const backfillResult = {};
    let backfillErrors = 0;

    if (stockSyms.length > 0 && (!alpacaEnabled() || !hasCredentials())) {
      const reason = alpacaEnabled() ? 'Alpaca credentials missing' : 'ALPACA_ENABLED=false';
      console.warn(`[AutoMachine] Backfill skipped for stocks: ${reason}`);
      for (const s of stockSyms) backfillResult[s] = { skipped: true, reason };
    } else {
      for (const symbol of stockSyms) {
        try {
          backfillResult[symbol] = await backfillSymbol(symbol, start, end);
        } catch (err) {
          backfillErrors++;
          backfillResult[symbol] = { error: err.message, source: 'alpaca' };
          console.warn(`[AutoMachine] Backfill ${symbol} failed:`, err.message);
        }
      }
    }

    for (const symbol of cryptoSyms) {
      try {
        backfillResult[symbol] = await backfillSymbol(symbol, start, end);
      } catch (err) {
        backfillErrors++;
        backfillResult[symbol] = { error: err.message, source: 'binance' };
        console.warn(`[AutoMachine] Backfill ${symbol} failed:`, err.message);
      }
    }

    result.steps.backfill = { ok: backfillErrors === 0, errors: backfillErrors, bySymbol: backfillResult };

    // ── Step 2: Replay ────────────────────────────────────────────────────────
    console.log('[AutoMachine] Step 2: Replay');
    let replayResult = null;
    try {
      replayResult = await runReplay({ symbols, start, end, mode: 'scan_only' });
      result.steps.replay = { ok: true, runId: replayResult?.runId, totalEvents: replayResult?.summary?.totalEvents };
    } catch (err) {
      console.warn('[AutoMachine] Replay failed:', err.message);
      result.steps.replay = { ok: false, error: err.message };
    }

    // ── Step 3: Hunt signals ──────────────────────────────────────────────────
    console.log('[AutoMachine] Step 3: Hunt signals');
    try {
      const huntResult = await runHistoricalScan({ symbols, start, end });
      const totalSignals = Object.values(huntResult).reduce((acc, v) => acc + (v.signalsSaved || 0), 0);
      result.steps.huntSignals = { ok: true, totalSignals, bySymbol: huntResult };
    } catch (err) {
      console.warn('[AutoMachine] Hunt-signals failed:', err.message);
      result.steps.huntSignals = { ok: false, error: err.message };
    }

    // ── Step 4: Analyze outcomes ──────────────────────────────────────────────
    console.log('[AutoMachine] Step 4: Analyze outcomes');
    try {
      const outcomeResult = await analyzeOutcomes({ symbols, start, end });
      result.steps.analyzeOutcomes = {
        ok:        true,
        processed: outcomeResult?.processed ?? null,
        skipped:   outcomeResult?.skipped   ?? null,
      };
    } catch (err) {
      console.warn('[AutoMachine] Analyze outcomes failed:', err.message);
      result.steps.analyzeOutcomes = { ok: false, error: err.message };
    }

    // ── Step 5: Update learning ───────────────────────────────────────────────
    console.log('[AutoMachine] Step 5: Update learning');
    try {
      saveLearning({ start, end, symbols });
      runLearningEngine();
      result.steps.updateLearning = { ok: true };
    } catch (err) {
      console.warn('[AutoMachine] Update learning failed:', err.message);
      result.steps.updateLearning = { ok: false, error: err.message };
    }

    // ── Step 5b: Build rule memory ────────────────────────────────────────────
    console.log('[AutoMachine] Step 5b: Build rule memory');
    try {
      const rm = buildRuleMemory();
      result.steps.buildRuleMemory = { ok: true, totalRules: rm.totalRules, watchModeRules: rm.watchModeRules };
    } catch (err) {
      console.warn('[AutoMachine] buildRuleMemory failed (non-fatal):', err.message);
      result.steps.buildRuleMemory = { ok: false, error: err.message };
    }

    // ── Step 5c: Build symbol profiles ───────────────────────────────────────
    console.log('[AutoMachine] Step 5c: Build symbol profiles');
    try {
      const sp = buildSymbolProfiles();
      result.steps.buildSymbolProfiles = {
        ok:               true,
        totalSymbols:     sp.totalSymbols,
        highConfSymbols:  sp.highConfSymbols,
        watchSymbols:     sp.watchSymbols,
        strongSymbols:    sp.strongSymbols,
      };
    } catch (err) {
      console.warn('[AutoMachine] buildSymbolProfiles failed (non-fatal):', err.message);
      result.steps.buildSymbolProfiles = { ok: false, error: err.message };
    }

    // ── Step 5d: Build regime profiles ───────────────────────────────────────
    console.log('[AutoMachine] Step 5d: Build regime profiles');
    try {
      const rp = buildRegimeProfiles();
      result.steps.buildRegimeProfiles = {
        ok:              true,
        totalRegimes:    rp.totalRegimes,
        highConfRegimes: rp.highConfRegimes,
        bestRegime:      rp.bestRegime,
        worstRegime:     rp.worstRegime,
      };
    } catch (err) {
      console.warn('[AutoMachine] buildRegimeProfiles failed (non-fatal):', err.message);
      result.steps.buildRegimeProfiles = { ok: false, error: err.message };
    }

    // ── Step 6: Invalidate caches ─────────────────────────────────────────────
    console.log('[AutoMachine] Step 6: Invalidate caches');
    try {
      invalidateCache();
      result.steps.invalidateCaches = { ok: true };
    } catch (err) {
      console.warn('[AutoMachine] Cache invalidation failed:', err.message);
      result.steps.invalidateCaches = { ok: false, error: err.message };
    }

    result.finishedAt = new Date().toISOString();
    console.log(`[AutoMachine] Pipeline done in ${Date.now() - new Date(startedAt).getTime()}ms`);

  } catch (err) {
    result.ok    = false;
    result.error = err.message;
    console.error('[AutoMachine] Unexpected error:', err.message);
  } finally {
    _running = false;
    result.finishedAt = result.finishedAt || new Date().toISOString();

    const finalStatus = {
      running:    false,
      startedAt,
      finishedAt: result.finishedAt,
      lastResult: result,
      error:      result.error || null,
    };
    writeStatus(finalStatus);
  }

  return result;
}

function isRunning()  { return _running; }
function getStatus()  { return readStatus(); }

module.exports = { runAutoMachine, isRunning, getStatus };
