'use strict';
const fs   = require('fs');
const path = require('path');
const { loadCandles }         = require('../data/marketDataStore');
const { toScannerFormat }     = require('../data/candleAggregator');
const { calcIndicators }      = require('./indicators');
const { classifyNarrowState } = require('./narrowState');
const { calcMarketRegimeV2 }  = require('./marketRegimeEngine');

const SIGNALS_DIR = path.resolve(__dirname, '../../data/signals/history');
const MIN_CANDLES = 20;   // Minimum window to run scanner
const WARM_CANDLES = 210; // Preferred window for SMA200
const MAX_WINDOW = 500;   // Rolling window ceiling

// Actionable eventTypes worth saving
const SAVE_EVENTS = new Set([
  'BULLISH_ELEPHANT_BREAKOUT',
  'BEARISH_ELEPHANT_BREAKDOWN',
  'BULLISH_COLOR_CHANGE',
  'BEARISH_COLOR_CHANGE',
  'NARROW_WAIT',
  'REGULAR_PULLBACK',
  'WIDE_REVERSAL_WATCH',
]);

const SAVE_STATES = new Set([
  'HIGH_QUALITY_NARROW',
  'MEDIUM_NARROW',
]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function signalFilePath(date) {
  return path.join(SIGNALS_DIR, `${date}.jsonl`);
}

function appendSignal(date, row) {
  try {
    ensureDir(SIGNALS_DIR);
    fs.appendFileSync(signalFilePath(date), JSON.stringify(row) + '\n', 'utf8');
  } catch (err) {
    console.warn('[HistoricalScanner] appendSignal failed:', err.message);
  }
}

function makeSignalId(symbol, ts) {
  return `${symbol}_${ts}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Decide whether a scanner result is worth saving to signal history.
 */
function isInteresting(result, prev) {
  if (!result || result.state === 'NO_TRADE') return false;

  // Always save when state is HIGH_QUALITY or MEDIUM narrow
  if (SAVE_STATES.has(result.state)) return true;

  // Save specific eventTypes
  if (SAVE_EVENTS.has(result.eventType)) return true;

  // Save when signal changes from previous
  if (prev && result.signal !== prev.signal && result.signal !== 'NO_TRADE') return true;

  return false;
}

/**
 * Build a signal record from a scanner result.
 * result._marketContext is set by scanSymbolHistory before calling this.
 */
function toSignalRecord(result, candleTs) {
  const ts  = result.lastUpdate || candleTs;
  const ctx = result._marketContext;
  return {
    signalId:               makeSignalId(result.symbol, ts),
    timestamp:              ts,
    candleTs,
    symbol:                 result.symbol,
    price:                  result.price,
    atr14:                  result.atr14,
    state:                  result.state,
    signal:                 result.signal,
    eventType:              result.eventType,
    narrowType:             result.narrowType,
    narrowScore:            result.narrowScore,
    tradeScore:             result.tradeScore,
    scores:                 result.scores            ?? null,
    scoreExplanationSv:     result.scoreExplanationSv ?? null,
    actionSv:               result.actionSv,
    reasonSv:               result.reasonSv,
    marketRegime:           ctx?.regime              ?? null,
    marketDirection:        ctx?.direction           ?? null,
    marketScore:            ctx?.score               ?? null,
    smaGapAtr:              result.smaGapAtr         ?? null,
    priceToZoneAtr:         result.priceToZoneAtr    ?? null,
    rangeCompression:       result.rangeCompression  ?? null,
    relVol20:               result.relVol20          ?? null,
    threeFingerSpreadActive: result.threeFingerSpread?.active ?? false,
    breakoutAlreadyOccurred: result.breakoutAlreadyOccurred,
    source:                 'historical',
  };
}

/**
 * Run the scanner on historical candles for one symbol.
 *
 * @param {string} symbol
 * @param {Array}  candles  - sorted 2m candles in scanner format
 * @returns {Array} signal records saved
 */
function scanSymbolHistory(symbol, candles) {
  if (!candles || candles.length < MIN_CANDLES) return [];

  const saved = [];
  let prev    = null;

  // Start at WARM_CANDLES for SMA200 quality, fall back to MIN_CANDLES if not enough data
  const startAt = candles.length >= WARM_CANDLES ? WARM_CANDLES : MIN_CANDLES;

  for (let i = startAt; i <= candles.length; i++) {
    // Rolling window: keep at most MAX_WINDOW candles
    const start  = Math.max(0, i - MAX_WINDOW);
    const window = candles.slice(start, i);

    if (window.length < MIN_CANDLES) continue;

    const indicators = calcIndicators(window);
    if (!indicators) continue;

    const lastCandle = window[window.length - 1];
    const price      = lastCandle.c;
    const candleTs   = lastCandle.t || lastCandle.ts;

    const result = classifyNarrowState({
      symbol,
      price,
      candles2m:  window,
      indicators,
      lastUpdate: candleTs,
    });

    // Compute market regime from this symbol's own indicators.
    // For stocks, QQQ would be the ideal reference; using self-reference
    // is a reasonable proxy when the reference isn't in the dataset.
    result._marketContext = calcMarketRegimeV2(result);

    if (isInteresting(result, prev)) {
      const record = toSignalRecord(result, candleTs);
      // Save to the date that matches the candle timestamp
      const date = (candleTs || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
      appendSignal(date, record);
      saved.push(record);
    }

    prev = result;
  }

  return saved;
}

/**
 * Run historical scan for multiple symbols over a date range.
 *
 * @param {object} opts
 * @param {string[]} opts.symbols
 * @param {string}   opts.start    - "YYYY-MM-DD"
 * @param {string}   opts.end      - "YYYY-MM-DD"
 * @param {string}   [opts.timeframe] - "2m" (only 2m supported)
 * @returns {Promise<object>} summary { symbol: { candlesLoaded, signalsSaved } }
 */
async function runHistoricalScan({ symbols, start, end, timeframe = '2m' }) {
  const summary = {};

  for (const symbol of symbols) {
    console.log(`[HistoricalScanner] ${symbol} — loading ${start} → ${end}`);
    let candles;
    try {
      const raw = loadCandles(symbol, start, end, timeframe);
      candles   = toScannerFormat(raw).filter((c) => !c.incomplete);
    } catch (err) {
      console.warn(`[HistoricalScanner] loadCandles(${symbol}) failed:`, err.message);
      summary[symbol] = { error: err.message };
      continue;
    }

    if (candles.length < MIN_CANDLES) {
      console.warn(`[HistoricalScanner] ${symbol}: only ${candles.length} candles — skipping (need ${MIN_CANDLES}+)`);
      summary[symbol] = { candlesLoaded: candles.length, signalsSaved: 0, warning: 'not enough candles' };
      continue;
    }

    console.log(`[HistoricalScanner] ${symbol}: ${candles.length} candles — running replay…`);
    const saved = scanSymbolHistory(symbol, candles);

    summary[symbol] = {
      candlesLoaded: candles.length,
      signalsSaved:  saved.length,
    };
    console.log(`[HistoricalScanner] ${symbol}: saved ${saved.length} signals`);
  }

  return summary;
}

/**
 * Load saved signal records for a date range.
 */
function loadSignals(start, end, symbolFilter) {
  const { getDatesInRange } = require('../data/marketDataStore');
  const dates   = getDatesInRange(start, end);
  const signals = [];

  for (const date of dates) {
    const fp = signalFilePath(date);
    if (!fs.existsSync(fp)) continue;
    try {
      const lines = fs.readFileSync(fp, 'utf8')
        .split('\n')
        .filter((l) => l.trim());
      for (const line of lines) {
        try {
          const s = JSON.parse(line);
          if (!symbolFilter || s.symbol === symbolFilter) signals.push(s);
        } catch { /* skip malformed */ }
      }
    } catch (err) {
      console.warn(`[HistoricalScanner] loadSignals read error (${fp}):`, err.message);
    }
  }

  return signals;
}

module.exports = { runHistoricalScan, loadSignals, scanSymbolHistory };
