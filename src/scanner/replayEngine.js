'use strict';
/**
 * Replay Engine
 *
 * Replays historical 2m candles through the full signal pipeline,
 * producing a structured run with events, summary, and insights.
 *
 * Pipeline per candle: Narrow v2 → Engine v3 → Market Regime V2 → Historical Edge
 */

const fs   = require('fs');
const path = require('path');

const { loadCandles }         = require('../data/marketDataStore');
const { toScannerFormat }     = require('../data/candleAggregator');
const { calcIndicators }      = require('./indicators');
const { classifyNarrowState } = require('./narrowState');
const { applyEngineV3 }       = require('./engineV3');
const { calcMarketRegimeV2, applyMarketRegimeV2 } = require('./marketRegimeEngine');
const { applyHistoricalEdge } = require('./historicalEdge');
const { buildInsights }       = require('./replayInsights');

const REPLAY_DIR   = path.resolve(__dirname, '../../data/replay/runs');
const MIN_CANDLES  = 20;
const WARM_CANDLES = 210;
const MAX_WINDOW   = 500;

// Interesting states/events that warrant saving
const SAVE_EVENTS = new Set([
  'BULLISH_ELEPHANT_BREAKOUT', 'BEARISH_ELEPHANT_BREAKDOWN',
  'BULLISH_COLOR_CHANGE', 'BEARISH_COLOR_CHANGE',
  'NARROW_WAIT', 'REGULAR_PULLBACK', 'WIDE_REVERSAL_WATCH',
]);
const SAVE_STATES = new Set([
  'HIGH_QUALITY_NARROW', 'MEDIUM_NARROW',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function round(n, d) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function makeRunId() {
  const ts  = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 7);
  return `run_${ts}_${rnd}`;
}

function isInteresting(result, prev) {
  if (!result || result.state === 'NO_TRADE') return false;
  if (SAVE_STATES.has(result.state))  return true;
  if (SAVE_EVENTS.has(result.eventType)) return true;
  if (prev && result.signal !== prev.signal && result.signal !== 'NO_TRADE') return true;
  return false;
}

function toEventRecord(result, runId) {
  const { threeFingerSpread = {}, elephantBar = {}, colorChange = {}, pullback = {} } = result;
  return {
    runId,
    timestamp:    result.lastUpdate,
    symbol:       result.symbol,
    price:        result.price,
    state:        result.state,
    signal:       result.signal,
    eventType:    result.eventType   ?? null,
    narrowType:   result.narrowType  ?? null,
    narrowScore:  result.narrowScore ?? null,
    tradeScore:   result.tradeScore  ?? null,
    scores:       result.scores      ?? null,
    historicalEdge: result.historicalEdge ?? null,
    marketContext:  result.marketContext  ?? null,
    actionSv:       result.actionSv      ?? null,
    reasonSv:       result.reasonSv      ?? null,
    scoreExplanationSv: result.scoreExplanationSv ?? null,
    flags: {
      threeFingerSpread:       threeFingerSpread.active ?? false,
      breakoutAlreadyOccurred: result.breakoutAlreadyOccurred ?? false,
      elephantBar:             elephantBar.active ?? false,
      colorChange:             colorChange.active ?? false,
      pullback:                pullback.active    ?? false,
    },
  };
}

// ── Per-symbol replay ─────────────────────────────────────────────────────────

/**
 * Run the full pipeline on one symbol's candle history.
 *
 * @param {string}   symbol
 * @param {Array}    candles   sorted 2m candles in scanner format
 * @param {string}   runId
 * @param {string}   mode      'scan_only' | 'with_outcomes' | 'debug'
 * @param {object|null} refResult  market reference result (QQQ or BTC)
 *                                 when available from a separate pass
 * @returns {Array} event records
 */
function replaySymbol(symbol, candles, runId, mode, refResultFn) {
  const events = [];
  let prev = null;

  const startAt = candles.length >= WARM_CANDLES ? WARM_CANDLES : MIN_CANDLES;

  for (let i = startAt; i <= candles.length; i++) {
    const sliceStart = Math.max(0, i - MAX_WINDOW);
    const window     = candles.slice(sliceStart, i);
    if (window.length < MIN_CANDLES) continue;

    const indicators = calcIndicators(window);
    if (!indicators) continue;

    const lastCandle = window[window.length - 1];
    const price      = lastCandle.c;
    const candleTs   = lastCandle.t || lastCandle.ts;

    let result;
    try {
      result = classifyNarrowState({ symbol, price, candles2m: window, indicators, lastUpdate: candleTs });
    } catch (err) {
      console.warn(`[ReplayEngine] classifyNarrowState(${symbol}) error:`, err.message);
      continue;
    }

    // Engine v3 — use refResult if available, else null
    const refResult = refResultFn ? refResultFn(candleTs) : null;
    try { result = applyEngineV3(result, refResult); } catch (_) {}

    // Market Regime V2 — self-referential if no cross-ref, otherwise use refResult
    try {
      const mktInput = refResult || result;
      const mktCtx   = calcMarketRegimeV2(mktInput);
      result = applyMarketRegimeV2(result, mktCtx);
    } catch (_) {}

    // Historical Edge (uses global cache, may have no data — safe to fail)
    try { result = applyHistoricalEdge(result); } catch (_) {}

    if (isInteresting(result, prev)) {
      events.push(toEventRecord(result, runId));
    }

    prev = result;
  }

  return events;
}

// ── Main run ──────────────────────────────────────────────────────────────────

/**
 * Run a full replay over a date range and set of symbols.
 *
 * @param {object}   opts
 * @param {string[]} opts.symbols
 * @param {string}   opts.start   "YYYY-MM-DD"
 * @param {string}   opts.end     "YYYY-MM-DD"
 * @param {string}   [opts.mode]  'scan_only' | 'with_outcomes' | 'debug'
 * @returns {Promise<{ runId, summary }>}
 */
async function runReplay({ symbols, start, end, mode = 'scan_only' }) {
  const runId  = makeRunId();
  const runDir = path.join(REPLAY_DIR, runId);
  ensureDir(runDir);

  const eventsPath  = path.join(runDir, 'events.jsonl');
  const summaryPath = path.join(runDir, 'summary.json');

  const summary = {
    runId,
    start,
    end,
    symbols,
    mode,
    totalCandles:  0,
    totalEvents:   0,
    signalsByType: {},
    stateCounts:   {},
    avgTradeScore: null,
    bestSymbols:   [],
    worstSymbols:  [],
    createdAt:     new Date().toISOString(),
  };

  let allEvents   = [];
  let scoreSum    = 0;
  let scoreN      = 0;
  const symStats  = {};

  // Determine reference symbols for market context
  const refSymbol = symbols.includes('QQQ')     ? 'QQQ'     :
                    symbols.includes('BTCUSDT')  ? 'BTCUSDT' : null;

  for (const symbol of symbols) {
    console.log(`[ReplayEngine] ${symbol} — loading ${start} → ${end}`);
    let candles;
    try {
      const raw = loadCandles(symbol, start, end, '2m');
      candles   = toScannerFormat(raw).filter((c) => !c.incomplete);
    } catch (err) {
      console.warn(`[ReplayEngine] loadCandles(${symbol}) failed:`, err.message);
      continue;
    }

    if (candles.length < MIN_CANDLES) {
      console.warn(`[ReplayEngine] ${symbol}: ${candles.length} candles — skipping (need ${MIN_CANDLES}+)`);
      continue;
    }

    summary.totalCandles += candles.length;
    console.log(`[ReplayEngine] ${symbol}: ${candles.length} candles → replaying…`);

    // No cross-reference in this version (self-referential regime)
    const events = replaySymbol(symbol, candles, runId, mode, null);
    allEvents = allEvents.concat(events);

    const sym_evts = events.filter((e) => e.state !== 'NO_TRADE');
    symStats[symbol] = {
      events:   events.length,
      avgScore: sym_evts.length > 0
        ? Math.round(sym_evts.reduce((a, e) => a + (e.tradeScore ?? 0), 0) / sym_evts.length)
        : 0,
    };

    for (const e of events) {
      summary.totalEvents++;
      const sig = e.signal || 'unknown';
      const st  = e.state  || 'unknown';
      summary.signalsByType[sig] = (summary.signalsByType[sig] || 0) + 1;
      summary.stateCounts[st]   = (summary.stateCounts[st]   || 0) + 1;
      if (e.tradeScore != null) { scoreSum += e.tradeScore; scoreN++; }
    }
  }

  summary.avgTradeScore = scoreN > 0 ? round(scoreSum / scoreN, 1) : null;

  // Best/worst symbols
  const ranked = Object.entries(symStats).sort((a, b) => b[1].avgScore - a[1].avgScore);
  summary.bestSymbols  = ranked.slice(0, 3).map(([s, d]) => ({ symbol: s, avgScore: d.avgScore, events: d.events }));
  summary.worstSymbols = ranked.slice(-3).reverse().map(([s, d]) => ({ symbol: s, avgScore: d.avgScore, events: d.events }));

  // Write events JSONL
  try {
    const lines = allEvents.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(eventsPath, lines ? lines + '\n' : '', 'utf8');
  } catch (err) {
    console.warn('[ReplayEngine] Failed to write events:', err.message);
  }

  // Write summary
  try {
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  } catch (err) {
    console.warn('[ReplayEngine] Failed to write summary:', err.message);
  }

  // Build insights
  try {
    await buildInsights(runId, allEvents, summary);
  } catch (err) {
    console.warn('[ReplayEngine] Insights failed:', err.message);
  }

  console.log(`[ReplayEngine] Run ${runId} done — ${summary.totalEvents} events, ${summary.totalCandles} candles`);
  return { runId, summary };
}

// ── Run management ────────────────────────────────────────────────────────────

/**
 * List all replay runs (newest first).
 */
function listRuns() {
  try {
    if (!fs.existsSync(REPLAY_DIR)) return [];
    return fs.readdirSync(REPLAY_DIR)
      .filter((d) => /^run_/.test(d))
      .sort()
      .reverse()
      .map((runId) => {
        const p = path.join(REPLAY_DIR, runId, 'summary.json');
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch { return { runId, error: 'summary unreadable' }; }
      });
  } catch (err) {
    console.warn('[ReplayEngine] listRuns error:', err.message);
    return [];
  }
}

/**
 * Load summary for one run.
 */
function loadRunSummary(runId) {
  const p = path.join(REPLAY_DIR, runId, 'summary.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

/**
 * Load events for one run with optional filters.
 */
function loadRunEvents(runId, { symbol, limit } = {}) {
  const p = path.join(REPLAY_DIR, runId, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  try {
    const events = fs.readFileSync(p, 'utf8')
      .split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const filtered = symbol ? events.filter((e) => e.symbol === symbol) : events;
    return limit ? filtered.slice(-Number(limit)) : filtered;
  } catch (err) {
    console.warn('[ReplayEngine] loadRunEvents error:', err.message);
    return [];
  }
}

/**
 * Load insights for one run.
 */
function loadRunInsights(runId) {
  const p = path.join(REPLAY_DIR, runId, 'insights.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

module.exports = { runReplay, listRuns, loadRunSummary, loadRunEvents, loadRunInsights };
