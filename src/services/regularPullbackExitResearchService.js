'use strict';

// ---------------------------------------------------------------------------
// Regular Pullback Exit Research — READ-ONLY research/observability
// ---------------------------------------------------------------------------
// Focused read-only analysis of REGULAR_PULLBACK (trend_continuation) closed
// paper trades, built to track the "time-based early abort" hypothesis over
// time WITHOUT changing any trading behaviour.
//
// It answers: which normalized exit buckets create the bad short trades
// (stop_hit), and — for candle-matched trades — what a time-based early abort
// WOULD have done, versus how many target_hit winners it would have hurt.
//
// Safety: NEVER writes, NEVER touches the exit engine, entry gate, allowlist,
// cooldown, risk/runtime state, Redis, or the order/broker path. It does not
// import any trading module. Pure read of trades.jsonl + candle snapshots.
// Simulation is offline research only and is explicitly flagged NOT patch-ready.
// ---------------------------------------------------------------------------

const path = require('path');
const { readJsonlTail } = require('./readOnlyJsonlTailService');
const { normalizeExitReasonFields } = require('./exitReasonNormalizer');
const candleRead = require('./candleSnapshotReadService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  read_only: true,
});

const DEFAULT_TRADES_FILE = path.resolve(__dirname, '../../data/paper-trading/trades.jsonl');
const TRADES_TAIL_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 60_000;
const WINDOW_MS = Object.freeze({ '24h': 86400e3, '3d': 3 * 86400e3, '7d': 7 * 86400e3, all: Infinity });
const BUCKET_ORDER = Object.freeze([
  'stop_hit', 'target_hit', 'near_target_profit', 'tightened_stop', 'momentum_fade', 'timeout_intelligence', 'timeout',
]);
// Minimum candle coverage before the time-abort numbers stop being flagged as
// "insufficient_coverage". The replay work ran at ~32% — deliberately low.
const COVERAGE_OK_PCT = 60;

let _cache = null;
let _cacheKey = '';
let _cacheAt = 0;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function tsOf(v) { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; }
function round(v, d = 2) { const n = Number(v); if (!Number.isFinite(n)) return null; const f = 10 ** d; return Math.round(n * f) / f; }
function median(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function sum(arr) { return arr.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0); }

function dirNorm(t) {
  const d = String(t.direction || '').toUpperCase();
  if (d === 'UP' || d === 'LONG') return 'long';
  if (d === 'DOWN' || d === 'SHORT') return 'short';
  return 'unknown';
}
function assetClass(t) {
  return (t.marketType === 'crypto' || /USDT?$/.test(String(t.symbol || ''))) ? 'crypto' : 'stock/ETF';
}
function isRegularPullback(t) {
  return t.signalSubtype === 'REGULAR_PULLBACK' || t.signal_subtype === 'REGULAR_PULLBACK' || t.setup === 'REGULAR_PULLBACK';
}
function isClosed(t) { return t.exitTime != null || t.closed_at != null || t.exitPrice != null; }
function isWin(t) { const r = String(t.result || '').toUpperCase(); if (r === 'WIN') return true; if (r === 'LOSS') return false; return num(t.pnlPct) > 0; }

// PnL% of a price relative to entry, respecting direction.
function favPct(dir, entry, price) {
  if (!(entry > 0)) return null;
  return dir === 'short' ? (entry - price) / entry * 100 : (price - entry) / entry * 100;
}
// Per-candle favorable/adverse excursion in PnL% terms.
function candleFavAdv(dir, entry, c) {
  if (dir === 'short') return { fav: favPct(dir, entry, c.l), adv: favPct(dir, entry, c.h) };
  return { fav: favPct(dir, entry, c.h), adv: favPct(dir, entry, c.l) };
}

function readTrades(tradesFile) {
  const tail = readJsonlTail(tradesFile, { maxBytes: TRADES_TAIL_BYTES, maxLines: 80_000 });
  return { rows: tail.rows, partial: Boolean(tail.partial), warnings: tail.warnings || [], sourceRows: tail.rows.length, sourceBytes: tail.size || 0 };
}

function bucketStats(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winrate: null, avgPnl: null, totPnl: 0, medDurationSec: null };
  const pnl = trades.map((t) => num(t.pnlPct)).filter((v) => v != null);
  const durs = trades.map((t) => num(t.duration_seconds)).filter((v) => v != null);
  const wins = trades.filter(isWin).length;
  return {
    n,
    winrate: pnl.length ? round(100 * wins / n, 1) : null,
    avgPnl: pnl.length ? round(sum(pnl) / pnl.length, 4) : null,
    totPnl: round(sum(pnl), 3),
    medDurationSec: median(durs),
  };
}

function overviewFor(pop) {
  const short = pop.filter((t) => { const d = num(t.duration_seconds); return d != null && d <= 300; });
  const stop = pop.filter((t) => t.normalizedExitReasonCode === 'stop_hit');
  const target = pop.filter((t) => t.normalizedExitReasonCode === 'target_hit');
  const st = bucketStats(pop);
  return {
    n: pop.length,
    winrate: st.winrate,
    totPnl: st.totPnl,
    shortLe5mPct: pop.length ? round(100 * short.length / pop.length, 1) : null,
    stopHit: { n: stop.length, totPnl: round(sum(stop.map((t) => num(t.pnlPct))), 3) },
    targetHit: { n: target.length, totPnl: round(sum(target.map((t) => num(t.pnlPct))), 3) },
  };
}

function bucketsFor(pop) {
  const byCode = new Map();
  for (const t of pop) {
    const code = t.normalizedExitReasonCode || 'unknown';
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(t);
  }
  return BUCKET_ORDER
    .filter((code) => byCode.has(code))
    .map((code) => ({ code, ...bucketStats(byCode.get(code)) }));
}

function stopHitDiagnostics(pop, matchedIds) {
  const stop = pop.filter((t) => t.normalizedExitReasonCode === 'stop_hit');
  const mfe = stop.map((t) => num(t.maxFavorablePct)).filter((v) => v != null);
  const mae = stop.map((t) => num(t.maxAdversePct)).filter((v) => v != null);
  const neverGreen = stop.filter((t) => { const m = num(t.maxFavorablePct); return m != null && m <= 0; }).length;
  const byDir = { long: [], short: [], unknown: [] };
  for (const t of stop) byDir[dirNorm(t)].push(t);
  const byAsset = { crypto: [], 'stock/ETF': [] };
  for (const t of stop) byAsset[assetClass(t)].push(t);
  const bySym = new Map();
  for (const t of stop) { const s = t.symbol || '?'; if (!bySym.has(s)) bySym.set(s, []); bySym.get(s).push(t); }
  const topSymbols = [...bySym.entries()]
    .map(([symbol, arr]) => ({ symbol, n: arr.length, totPnl: round(sum(arr.map((t) => num(t.pnlPct))), 3) }))
    .sort((a, b) => a.totPnl - b.totPnl)
    .slice(0, 5);
  const matched = matchedIds ? stop.filter((t) => matchedIds.has(t.tradeId)).length : 0;
  const dirOut = {};
  for (const k of ['long', 'short']) dirOut[k] = { n: byDir[k].length, totPnl: round(sum(byDir[k].map((t) => num(t.pnlPct))), 3) };
  const assetOut = {};
  for (const k of ['crypto', 'stock/ETF']) assetOut[k] = { n: byAsset[k].length, totPnl: round(sum(byAsset[k].map((t) => num(t.pnlPct))), 3) };
  return {
    n: stop.length,
    medMFE: round(median(mfe), 3),
    medMAE: round(median(mae), 3),
    pctNeverGreen: stop.length ? round(100 * neverGreen / stop.length, 1) : null,
    byDirection: dirOut,
    byAsset: assetOut,
    topSymbols,
    candleCoverage: { matched, total: stop.length, pct: stop.length ? round(100 * matched / stop.length, 1) : null },
  };
}

// Simulate one time-abort variant on a candle-matched trade.
// Returns the counterfactual exit PnL%, or null if not candle-matched.
function simTimeAbort(trade, series, { candles, mfeThresh }) {
  const entry = num(trade.entryPrice);
  const dir = dirNorm(trade);
  const en = tsOf(trade.entryTime); const ex = tsOf(trade.exitTime);
  if (entry == null || en == null || ex == null) return null;
  const pathC = candleRead.sliceSeries(series, en, ex);
  if (!pathC.length) return null;
  let mfe = -Infinity;
  for (let i = 0; i < pathC.length; i += 1) {
    const c = pathC[i];
    const { fav } = candleFavAdv(dir, entry, c);
    if (fav != null) mfe = Math.max(mfe, fav);
    if (i + 1 >= candles) {
      if (mfe < mfeThresh) return favPct(dir, entry, c.c); // abort at this candle's close
      return num(trade.pnlPct); // hypothesis would let it run — keep recorded outcome
    }
  }
  // fewer candles than the abort horizon: not enough info -> keep recorded outcome
  return num(trade.pnlPct);
}

const VARIANTS = Object.freeze([
  { id: 'mfe_lt_0_03_by_1', label: 'MFE < +0.03% inom 1 candle', candles: 1, mfeThresh: 0.03 },
  { id: 'mfe_lt_0_05_by_2', label: 'MFE < +0.05% inom 2 candles', candles: 2, mfeThresh: 0.05 },
]);

function buildTimeAbort(pop, seriesBySymbol) {
  const stop = pop.filter((t) => t.normalizedExitReasonCode === 'stop_hit');
  const target = pop.filter((t) => t.normalizedExitReasonCode === 'target_hit');
  const matchedIds = new Set();
  const seriesFor = (t) => seriesBySymbol.get(t.symbol) || [];
  const isMatched = (t) => {
    const en = tsOf(t.entryTime); const ex = tsOf(t.exitTime);
    if (en == null || ex == null) return false;
    return candleRead.sliceSeries(seriesFor(t), en, ex).length > 0;
  };
  const stopMatched = stop.filter((t) => { const m = isMatched(t); if (m) matchedIds.add(t.tradeId); return m; });
  const targetMatched = target.filter(isMatched);

  const variants = VARIANTS.map((v) => {
    const baseStop = sum(stopMatched.map((t) => num(t.pnlPct)));
    const simStop = sum(stopMatched.map((t) => { const s = simTimeAbort(t, seriesFor(t), v); return s != null ? s : num(t.pnlPct); }));
    let winnersHurt = 0;
    for (const t of targetMatched) {
      const s = simTimeAbort(t, seriesFor(t), v);
      if (s != null && s < num(t.pnlPct) - 1e-9) winnersHurt += 1;
    }
    return {
      id: v.id,
      label: v.label,
      stopHitBaselineTotPnl: round(baseStop, 3),
      stopHitSimTotPnl: round(simStop, 3),
      stopHitImprovement: round(simStop - baseStop, 3),
      targetHitWinnersHurt: winnersHurt,
      targetHitMatched: targetMatched.length,
    };
  });

  const matchedTotal = stopMatched.length + targetMatched.length;
  const grandTotal = stop.length + target.length;
  const pct = grandTotal ? round(100 * matchedTotal / grandTotal, 1) : null;
  const status = (pct != null && pct >= COVERAGE_OK_PCT) ? 'preliminary' : 'insufficient_coverage';
  return {
    status,
    patchReady: false,
    note: 'Research only. Detta ändrar inte exit. Time-abort är EJ patch-redo.',
    coverage: {
      stopHitMatched: stopMatched.length,
      stopHitTotal: stop.length,
      targetHitMatched: targetMatched.length,
      targetHitTotal: target.length,
      pct,
    },
    variants,
    matchedIds,
  };
}

function buildRegularPullbackExitResearch(options = {}) {
  const tradesFile = options.tradesFile || DEFAULT_TRADES_FILE;
  const candleStorageRoot = options.candleStorageRoot;
  const cacheable = !options.now && options.cache !== false;
  const cacheKey = `${tradesFile}|${candleStorageRoot || ''}`;
  const cacheNow = Date.now();
  if (cacheable && _cache && _cacheKey === cacheKey && (cacheNow - _cacheAt) < CACHE_TTL_MS) return _cache;

  const now = options.now ? new Date(options.now).getTime() : Date.now();
  const read = readTrades(tradesFile);

  // normalizeExitReasonFields returns an enriched COPY that keeps every original
  // field (entryPrice/direction/maxFavorablePct/…) and adds normalized* fields.
  const pop = read.rows
    .filter((t) => isRegularPullback(t) && isClosed(t) && t.paperOnly !== false && num(t.pnlPct) != null)
    .map((t) => normalizeExitReasonFields(t));

  // Windows (cheap, trades-only): overview + buckets for trend-over-time.
  const windows = {};
  for (const [wk, ms] of Object.entries(WINDOW_MS)) {
    const w = ms === Infinity ? pop : pop.filter((t) => { const ts = tsOf(t.exitTime || t.closed_at || t.entryTime); return ts != null && ts >= now - ms; });
    windows[wk] = { overview: overviewFor(w), buckets: bucketsFor(w) };
  }

  // Candle-backed sections use the full population (low coverage is expected
  // and surfaced explicitly).
  const symbols = [...new Set(pop.map((t) => t.symbol).filter(Boolean))];
  let seriesBySymbol = new Map();
  let candleWarnings = [];
  let candlePartial = false;
  if (symbols.length) {
    const entryTimes = pop.map((t) => tsOf(t.entryTime)).filter((v) => v != null);
    const exitTimes = pop.map((t) => tsOf(t.exitTime)).filter((v) => v != null);
    const sinceMs = entryTimes.length ? Math.min(...entryTimes) : null;
    const untilMs = exitTimes.length ? Math.max(...exitTimes) : null;
    const loaded = candleRead.loadSeries({ storageRoot: candleStorageRoot, timeframe: '1m', symbols, sinceMs, untilMs });
    seriesBySymbol = loaded.bySymbol;
    candleWarnings = loaded.warnings || [];
    candlePartial = Boolean(loaded.partial);
  }

  const timeAbort = buildTimeAbort(pop, seriesBySymbol);
  const diagnostics = stopHitDiagnostics(pop, timeAbort.matchedIds);
  delete timeAbort.matchedIds;

  const span = candleRead.coverageSpan(seriesBySymbol);
  const result = {
    ok: true,
    mode: 'paper_only',
    partial: read.partial || candlePartial,
    warnings: [...(read.warnings || []), ...candleWarnings],
    generatedAt: new Date(now).toISOString(),
    safety: { ...SAFETY },
    note: 'Research only. Detta ändrar inte exit, entry, risk eller order. Endast läsning.',
    dataSource: { trades: 'data/paper-trading/trades.jsonl', candles: 'data/candle-snapshots/*/candles-1m.jsonl' },
    regularPullback: {
      overview: windows.all.overview,
      buckets: windows.all.buckets,
      stopHitDiagnostics: diagnostics,
      timeAbort,
    },
    windows,
    candleCoverageSpan: {
      firstCandle: span.firstMs != null ? new Date(span.firstMs).toISOString() : null,
      lastCandle: span.lastMs != null ? new Date(span.lastMs).toISOString() : null,
      symbols: span.symbols.length,
    },
    readLimits: {
      cacheTtlMs: CACHE_TTL_MS,
      tradesTailBytes: TRADES_TAIL_BYTES,
      tradesRowsRead: read.sourceRows,
      tradesSourceBytes: read.sourceBytes,
    },
  };

  if (cacheable) { _cache = result; _cacheKey = cacheKey; _cacheAt = cacheNow; }
  return result;
}

module.exports = {
  SAFETY,
  WINDOW_MS,
  COVERAGE_OK_PCT,
  buildRegularPullbackExitResearch,
};
