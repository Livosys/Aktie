'use strict';
const fs   = require('fs');
const path = require('path');
const { loadCandles, getDatesInRange } = require('../data/marketDataStore');
const { toScannerFormat }              = require('../data/candleAggregator');
const { loadSignals }                  = require('./historicalScanner');

const OUTCOMES_DIR = path.resolve(__dirname, '../../data/signals/outcomes');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function outcomeFilePath(date) {
  return path.join(OUTCOMES_DIR, `${date}.jsonl`);
}

function appendOutcome(date, row) {
  try {
    ensureDir(OUTCOMES_DIR);
    fs.appendFileSync(outcomeFilePath(date), JSON.stringify(row) + '\n', 'utf8');
  } catch (err) {
    console.warn('[OutcomeAnalyzer] appendOutcome failed:', err.message);
  }
}

// ── Candle lookup helpers ─────────────────────────────────────────────────────

/**
 * Load all 2m candles for a symbol around a date range (padded by ±5 days).
 * Returns a map: ts-string → index, plus the candles array.
 */
function loadCandlesWithIndex(symbol, signalDate, candleCache) {
  if (candleCache[symbol]) return candleCache[symbol];

  // Pad ±5 days to ensure we have candles before and after the signal date
  const d = new Date(signalDate + 'T00:00:00Z');
  const start = new Date(d); start.setUTCDate(start.getUTCDate() - 5);
  const end   = new Date(d); end.setUTCDate(end.getUTCDate()   + 5);

  let raw;
  try {
    raw = loadCandles(
      symbol,
      start.toISOString().slice(0, 10),
      end.toISOString().slice(0, 10),
      '2m'
    );
  } catch { raw = []; }

  const candles = toScannerFormat(raw).filter((c) => !c.incomplete);
  const tsIndex = new Map();
  candles.forEach((c, i) => {
    const key = c.t || c.ts;
    if (key && !tsIndex.has(key)) tsIndex.set(key, i);
  });

  candleCache[symbol] = { candles, tsIndex };
  return candleCache[symbol];
}

// ── Outcome calculation ───────────────────────────────────────────────────────

function calcOutcome(candles, startIdx, horizons) {
  const entry  = candles[startIdx];
  if (!entry) return {};
  const entryPrice = entry.c;
  const result = {};

  for (const n of horizons) {
    const slice  = candles.slice(startIdx + 1, startIdx + 1 + n);
    if (slice.length === 0) continue;

    const closes  = slice.map((c) => c.c);
    const highs   = slice.map((c) => c.h);
    const lows    = slice.map((c) => c.l);
    const lastClose = closes[closes.length - 1];

    const priceChangePct = ((lastClose - entryPrice) / entryPrice) * 100;
    const maxHigh        = Math.max(...highs);
    const minLow         = Math.min(...lows);
    const maxMoveUp      = ((maxHigh - entryPrice) / entryPrice) * 100;
    const maxMoveDown    = ((entryPrice - minLow)  / entryPrice) * 100;

    result[`outcome${n}`] = {
      priceChangePct: round(priceChangePct, 4),
      maxMoveUp:      round(maxMoveUp, 4),
      maxMoveDown:    round(maxMoveDown, 4),
      candlesAvail:   slice.length,
    };
  }

  return result;
}

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/**
 * Determine whether a signal was successful.
 * Long: price moved up ≥ 1 ATR within 5 candles.
 * Short: price moved down ≥ 1 ATR within 5 candles.
 */
function calcSuccess(signal, entryPrice, atr14, outcome5) {
  if (!outcome5 || !atr14 || atr14 <= 0) {
    return { success: null, failureReason: 'insufficient_data' };
  }

  const isLong  = signal && (signal.includes('LONG')  || signal === 'WIDE_REVERSAL_WATCH');
  const isShort = signal && signal.includes('SHORT');

  if (!isLong && !isShort) {
    return { success: null, failureReason: 'non_directional_signal' };
  }

  const atrPct = (atr14 / entryPrice) * 100;

  if (isLong) {
    if (outcome5.maxMoveUp >= atrPct) return { success: true,  failureReason: null };
    if (outcome5.maxMoveDown >= atrPct * 0.5)
      return { success: false, failureReason: 'stopped_out' };
    return { success: false, failureReason: 'no_follow_through' };
  }

  // isShort
  if (outcome5.maxMoveDown >= atrPct) return { success: true,  failureReason: null };
  if (outcome5.maxMoveUp >= atrPct * 0.5)
    return { success: false, failureReason: 'stopped_out' };
  return { success: false, failureReason: 'no_follow_through' };
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Analyze outcomes for signals in a date range.
 *
 * @param {object} opts
 * @param {string[]} opts.symbols
 * @param {string}   opts.start   - "YYYY-MM-DD"
 * @param {string}   opts.end     - "YYYY-MM-DD"
 * @returns {Promise<object>} summary
 */
async function analyzeOutcomes({ symbols, start, end }) {
  const HORIZONS = [3, 5, 10, 20, 30];
  const summary  = { processed: 0, skipped: 0, bySymbol: {} };

  // Load all signals for the date range
  const signals = loadSignals(start, end, null);
  const filtered = symbols && symbols.length > 0
    ? signals.filter((s) => symbols.includes(s.symbol))
    : signals;

  console.log(`[OutcomeAnalyzer] ${filtered.length} signals to analyze (${start} → ${end})`);

  const candleCache = {};

  for (const sig of filtered) {
    const { symbol, candleTs, timestamp, signalId, signal, eventType, price, atr14,
      tradeScore, narrowScore } = sig;

    const date       = (candleTs || timestamp || '').slice(0, 10);
    if (!date || !symbol) { summary.skipped++; continue; }

    const { candles, tsIndex } = loadCandlesWithIndex(symbol, date, candleCache);

    const searchTs = candleTs || timestamp;
    let startIdx   = tsIndex.get(searchTs);

    // Try to find nearest candle if exact match missing
    if (startIdx === undefined && searchTs) {
      const target = new Date(searchTs).getTime();
      let closest = Infinity;
      candles.forEach((c, i) => {
        const diff = Math.abs(new Date(c.t || c.ts).getTime() - target);
        if (diff < closest) { closest = diff; startIdx = i; }
      });
      if (closest > 5 * 60 * 1000) startIdx = undefined; // >5 min gap — skip
    }

    if (startIdx === undefined) { summary.skipped++; continue; }

    const entryPrice = price || candles[startIdx]?.c;
    if (!entryPrice) { summary.skipped++; continue; }

    const outcomes  = calcOutcome(candles, startIdx, HORIZONS);
    const { success, failureReason } = calcSuccess(signal, entryPrice, atr14, outcomes.outcome5);

    const record = {
      signalId,
      timestamp:   searchTs,
      symbol,
      signal,
      eventType,
      state:            sig.state           ?? null,
      narrowType:       sig.narrowType      ?? null,
      marketRegime:     sig.marketRegime    ?? null,
      marketDirection:  sig.marketDirection ?? null,
      relVol20:         sig.relVol20        ?? null,
      entryPrice,
      tradeScore,
      narrowScore,
      ...outcomes,
      success,
      failureReason,
    };

    appendOutcome(date, record);
    summary.processed++;
    summary.bySymbol[symbol] = (summary.bySymbol[symbol] || 0) + 1;
  }

  console.log(`[OutcomeAnalyzer] Done — processed: ${summary.processed}, skipped: ${summary.skipped}`);
  return summary;
}

/**
 * Load saved outcome records for a date range.
 */
function loadOutcomes(start, end, symbolFilter) {
  const dates    = getDatesInRange(start, end);
  const outcomes = [];

  for (const date of dates) {
    const fp = outcomeFilePath(date);
    if (!fs.existsSync(fp)) continue;
    try {
      fs.readFileSync(fp, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .forEach((l) => {
          try {
            const o = JSON.parse(l);
            if (!symbolFilter || o.symbol === symbolFilter) outcomes.push(o);
          } catch { /* skip */ }
        });
    } catch (err) {
      console.warn(`[OutcomeAnalyzer] loadOutcomes read error (${fp}):`, err.message);
    }
  }

  return outcomes;
}

module.exports = { analyzeOutcomes, loadOutcomes };
