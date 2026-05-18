'use strict';
const express = require('express');
const router  = express.Router();
const { getLatestResults, getScanStatus, getWatchlist, getGroups } = require('../scanner/scheduler');
const { getCryptoResults, getCryptoStatus } = require('../scanner/cryptoScheduler');
const { readLatest }          = require('../scanner/featureLogger');
const { fetchAlpacaBars, isEnabled: alpacaEnabled, hasCredentials } = require('../data/alpacaDataService');
const { fetchBinanceKlines } = require('../data/binanceDataService');
const { saveRawBars, saveCandles2m, listSymbols, listAvailableDates, countCandles, getDatesInRange } = require('../data/marketDataStore');
const { aggregate1mTo2m, filterComplete } = require('../data/candleAggregator');
const { runHistoricalScan, loadSignals }  = require('../scanner/historicalScanner');
const { analyzeOutcomes, loadOutcomes }         = require('../scanner/signalOutcomeAnalyzer');
const { saveLearning, loadLearning }            = require('../scanner/signalLearning');
const { getEdge, getEdgeForSymbol, getEdgeSummary, invalidateCache } = require('../scanner/historicalEdge');
const { runReplay, listRuns, loadRunSummary, loadRunEvents, loadRunInsights } = require('../scanner/replayEngine');
const { runLearningEngine, loadLearningSummary } = require('../scanner/learningEngine');

function buildScanResponse(results, status, group) {
  return {
    ok: true,
    group: group || 'all',
    lastScan: status.lastScan,
    scanning: status.scanning,
    marketWarning: status.marketWarning,
    count: results.length,
    results,
  };
}

router.get('/scan', (req, res) => {
  res.json(buildScanResponse(getLatestResults(), getScanStatus()));
});

router.get('/scan/stocks', (req, res) => {
  const { stocks } = getGroups();
  const filtered = getLatestResults().filter((r) => stocks.includes(r.symbol));
  res.json(buildScanResponse(filtered, getScanStatus(), 'stocks'));
});

router.get('/scan/nasdaq', (req, res) => {
  const { nasdaq } = getGroups();
  const filtered = getLatestResults().filter((r) => nasdaq.includes(r.symbol));
  res.json(buildScanResponse(filtered, getScanStatus(), 'nasdaq'));
});

router.get('/scan/crypto', (req, res) => {
  const status = getCryptoStatus();
  const results = getCryptoResults();
  res.json({
    ok: true,
    enabled: true,
    group: 'crypto',
    lastScan: status.lastScan,
    scanning: status.scanning,
    marketWarning: false,
    count: results.length,
    results,
  });
});

router.get('/replay/latest', (req, res) => {
  const symbol = req.query.symbol || null;
  const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const entries = readLatest(symbol, limit);
  res.json({ ok: true, count: entries.length, symbol: symbol || 'all', entries });
});

router.get('/groups', (req, res) => {
  res.json({ ok: true, groups: getGroups() });
});

router.get('/symbols', (req, res) => {
  res.json({ ok: true, symbols: getWatchlist() });
});

router.get('/status', (req, res) => {
  const status = getScanStatus();
  const alpacaConfigured =
    !!process.env.ALPACA_API_KEY_ID && !!process.env.ALPACA_API_SECRET_KEY;
  res.json({
    ok: true,
    alpacaConfigured,
    feed: process.env.ALPACA_DATA_FEED || 'iex',
    ...status,
  });
});

// ── Backfill helpers ──────────────────────────────────────────────────────────

const CRYPTO_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT']);

function isCrypto(symbol) {
  return symbol.endsWith('USDT') || CRYPTO_SYMBOLS.has(symbol.toUpperCase());
}

async function backfillAlpaca(symbol, start, end) {
  const bars = await fetchAlpacaBars({ symbol, timeframe: '1Min', start, end, limit: 10000 });
  if (bars.length === 0) {
    return { rawBars: 0, candles2m: 0, source: 'alpaca', warning: 'no data returned from Alpaca' };
  }

  const byDate = {};
  for (const bar of bars) {
    const date = (bar.ts || '').slice(0, 10);
    if (!date) continue;
    (byDate[date] = byDate[date] || []).push(bar);
  }

  let totalRaw = 0;
  let total2m  = 0;
  for (const [date, dateBars] of Object.entries(byDate)) {
    const saved = saveRawBars(symbol, date, dateBars, 'alpaca');
    if (saved > 0) totalRaw += saved;
    const candles = filterComplete(aggregate1mTo2m(dateBars));
    const saved2m = saveCandles2m(symbol, date, candles);
    if (saved2m > 0) total2m += saved2m;
  }

  return { rawBars: totalRaw, candles2m: total2m, source: 'alpaca' };
}

async function backfillBinance(symbol, start, end) {
  const bars = await fetchBinanceKlines({ symbol, interval: '1m', start, end, limit: 1000 });
  if (bars.length === 0) {
    return { rawBars: 0, candles2m: 0, source: 'binance', warning: 'no data returned from Binance' };
  }

  const byDate = {};
  for (const bar of bars) {
    const date = (bar.ts || '').slice(0, 10);
    if (!date) continue;
    (byDate[date] = byDate[date] || []).push(bar);
  }

  let totalRaw = 0;
  let total2m  = 0;
  for (const [date, dateBars] of Object.entries(byDate)) {
    const saved = saveRawBars(symbol, date, dateBars, 'binance');
    if (saved > 0) totalRaw += saved;
    const candles = filterComplete(aggregate1mTo2m(dateBars));
    const saved2m = saveCandles2m(symbol, date, candles);
    if (saved2m > 0) total2m += saved2m;
  }

  return { rawBars: totalRaw, candles2m: total2m, source: 'binance' };
}

// ── POST /api/data/backfill ───────────────────────────────────────────────────
// Stocks → Alpaca, crypto (USDT pairs) → Binance.
router.post('/data/backfill', async (req, res) => {
  const { symbols, start, end } = req.body || {};

  if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ ok: false, error: 'symbols array required' });
  }
  if (!start || !end) {
    return res.status(400).json({ ok: false, error: 'start and end dates required (YYYY-MM-DD)' });
  }

  const stockSyms  = symbols.filter((s) => !isCrypto(s));
  const cryptoSyms = symbols.filter((s) =>  isCrypto(s));

  // Alpaca credentials required only if stock symbols are requested
  if (stockSyms.length > 0 && (!alpacaEnabled() || !hasCredentials())) {
    return res.status(503).json({
      ok: false,
      error: alpacaEnabled()
        ? 'Alpaca credentials not configured (set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY)'
        : 'ALPACA_ENABLED=false — backfill disabled',
    });
  }

  const result = {};

  for (const symbol of stockSyms) {
    try {
      result[symbol] = await backfillAlpaca(symbol, start, end);
    } catch (err) {
      result[symbol] = { error: err.message, source: 'alpaca' };
    }
  }

  for (const symbol of cryptoSyms) {
    try {
      result[symbol] = await backfillBinance(symbol, start, end);
    } catch (err) {
      result[symbol] = { error: err.message, source: 'binance' };
    }
  }

  res.json({ ok: true, start, end, result });
});

// ── GET /api/data/status ──────────────────────────────────────────────────────
router.get('/data/status', (req, res) => {
  try {
    const symbols = listSymbols();
    const status  = {};

    for (const symbol of symbols) {
      const dates   = listAvailableDates(symbol);
      const raw2m   = dates['2m'] || [];
      let totalCandles = 0;
      for (const date of raw2m) {
        totalCandles += countCandles(symbol, date, '2m');
      }
      status[symbol] = {
        datesRaw:    (dates.raw    || []).length,
        dates2m:     raw2m.length,
        dateRange:   raw2m.length > 0 ? { from: raw2m[0], to: raw2m[raw2m.length - 1] } : null,
        totalCandles2m: totalCandles,
      };
    }

    res.json({
      ok:      true,
      symbols: symbols.length,
      alpacaEnabled:  alpacaEnabled(),
      alpacaConfigured: hasCredentials(),
      data: status,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/history/scan ────────────────────────────────────────────────────
router.post('/history/scan', async (req, res) => {
  const { symbols, start, end } = req.body || {};

  if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ ok: false, error: 'symbols array required' });
  }
  if (!start || !end) {
    return res.status(400).json({ ok: false, error: 'start and end dates required' });
  }

  try {
    const summary = await runHistoricalScan({ symbols, start, end, timeframe: '2m' });
    res.json({ ok: true, start, end, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/history/analyze ─────────────────────────────────────────────────
router.post('/history/analyze', async (req, res) => {
  const { symbols, start, end } = req.body || {};

  if (!start || !end) {
    return res.status(400).json({ ok: false, error: 'start and end dates required' });
  }

  try {
    const outcomeSummary  = await analyzeOutcomes({ symbols: symbols || [], start, end });
    const learningSummary = saveLearning({ start, end, symbols: symbols || [] });
    invalidateCache(); // rebuild edge cache after new outcomes
    res.json({ ok: true, start, end, outcomeSummary, learningSummary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/signals ──────────────────────────────────────────────────
router.get('/history/signals', (req, res) => {
  const symbol = req.query.symbol || null;
  const start  = req.query.start  || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const end    = req.query.end    || new Date().toISOString().slice(0, 10);
  const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

  try {
    const signals = loadSignals(start, end, symbol);
    const sliced  = signals.slice(-limit);
    res.json({ ok: true, count: sliced.length, symbol, start, end, signals: sliced });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/outcomes ─────────────────────────────────────────────────
router.get('/history/outcomes', (req, res) => {
  const symbol = req.query.symbol || null;
  const start  = req.query.start  || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const end    = req.query.end    || new Date().toISOString().slice(0, 10);
  const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

  try {
    const outcomes = loadOutcomes(start, end, symbol);
    const sliced   = outcomes.slice(-limit);
    res.json({ ok: true, count: sliced.length, symbol, start, end, outcomes: sliced });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/history/hunt-signals ────────────────────────────────────────────
// Alias for /api/history/scan with cache invalidation after run.
router.post('/history/hunt-signals', async (req, res) => {
  const { symbols, start, end } = req.body || {};

  if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ ok: false, error: 'symbols array required' });
  }
  if (!start || !end) {
    return res.status(400).json({ ok: false, error: 'start and end dates required (YYYY-MM-DD)' });
  }

  try {
    const summary = await runHistoricalScan({ symbols, start, end, timeframe: '2m' });
    invalidateCache(); // edge cache must be rebuilt after new signals
    res.json({ ok: true, start, end, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/edge ─────────────────────────────────────────────────────
router.get('/history/edge', (req, res) => {
  const symbol = req.query.symbol || null;
  try {
    if (symbol) {
      res.json({ ok: true, ...getEdgeForSymbol(symbol) });
    } else {
      res.json({ ok: true, edge: getEdge({}) }); // global fallback
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/edge-summary ────────────────────────────────────────────
router.get('/history/edge-summary', (req, res) => {
  try {
    res.json(getEdgeSummary());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/learning-summary ────────────────────────────────────────
router.get('/history/learning-summary', (req, res) => {
  try {
    // Prefer Learning Engine v1 summary (new format with full dimensions)
    let summary = loadLearningSummary();
    // Fall back to legacy signalLearning summary if v1 hasn't run yet
    if (!summary) summary = loadLearning();
    if (!summary) {
      return res.json({ ok: true, summary: null, message: 'Ingen learning-summary ännu — kör POST /api/history/update-learning' });
    }
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/history/update-learning ────────────────────────────────────────
router.post('/history/update-learning', async (req, res) => {
  try {
    const summary = runLearningEngine();
    res.json({
      ok:             true,
      updatedAt:      summary.updatedAt,
      totalSignals:   summary.totalSignals,
      totalOutcomes:  summary.totalOutcomes,
      overallWinRate: summary.overallWinRate,
      bestSymbols:    summary.bestSymbols,
      bestEventTypes: summary.bestEventTypes,
      bestHours:      summary.bestHours,
      bestScoreRanges:summary.bestScoreRanges,
      insightsSv:     summary.insightsSv,
    });
  } catch (err) {
    console.error('[API] update-learning error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// REPLAY ENGINE ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /api/replay/run ──────────────────────────────────────────────────────
router.post('/replay/run', async (req, res) => {
  const { symbols, start, end, mode = 'scan_only' } = req.body || {};

  if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ ok: false, error: 'symbols array required' });
  }
  if (!start || !end) {
    return res.status(400).json({ ok: false, error: 'start and end dates required (YYYY-MM-DD)' });
  }
  if (!['scan_only', 'with_outcomes', 'debug'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'mode must be scan_only | with_outcomes | debug' });
  }

  try {
    const { runId, summary } = await runReplay({ symbols, start, end, mode });
    res.json({ ok: true, runId, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/replay/runs ──────────────────────────────────────────────────────
router.get('/replay/runs', (req, res) => {
  try {
    res.json({ ok: true, runs: listRuns() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/replay/runs/:runId ───────────────────────────────────────────────
router.get('/replay/runs/:runId', (req, res) => {
  const { runId } = req.params;
  try {
    const summary  = loadRunSummary(runId);
    const insights = loadRunInsights(runId);
    if (!summary) return res.status(404).json({ ok: false, error: 'Run not found' });
    res.json({ ok: true, summary, insights });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/replay/runs/:runId/events ───────────────────────────────────────
router.get('/replay/runs/:runId/events', (req, res) => {
  const { runId } = req.params;
  const symbol    = req.query.symbol || null;
  const limit     = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  try {
    const events = loadRunEvents(runId, { symbol, limit });
    res.json({ ok: true, runId, symbol, count: events.length, events });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/replay/compare ───────────────────────────────────────────────────
router.get('/replay/compare', (req, res) => {
  const { runA, runB } = req.query;
  if (!runA || !runB) {
    return res.status(400).json({ ok: false, error: 'runA and runB query params required' });
  }
  try {
    const a = loadRunSummary(runA);
    const b = loadRunSummary(runB);
    if (!a) return res.status(404).json({ ok: false, error: `Run ${runA} not found` });
    if (!b) return res.status(404).json({ ok: false, error: `Run ${runB} not found` });
    res.json({
      ok: true,
      comparison: {
        runA: { runId: runA, summary: a },
        runB: { runId: runB, summary: b },
        diff: {
          avgTradeScore: round2(a.avgTradeScore, b.avgTradeScore),
          totalEvents:   { a: a.totalEvents, b: b.totalEvents },
          symbols:       { a: a.symbols, b: b.symbols },
        },
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function round2(a, b) {
  if (a == null || b == null) return null;
  return { a, b, delta: Math.round((b - a) * 10) / 10 };
}

module.exports = router;
