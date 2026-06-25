'use strict';

// ---------------------------------------------------------------------------
// Short Exit Truth — READ-ONLY observability
// ---------------------------------------------------------------------------
// Explains WHY closed paper trades exited quickly: duration buckets, exit-reason
// top list (target_hit / tightened_stop / momentum_fade / default / timeout …),
// broken down per strategy and per setup. Pure read of trades.jsonl.
//
// Safety: NEVER writes, NEVER changes exit behaviour, NEVER touches the exit
// engine defaults or the 0.10% trailing default. Display only.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { readJsonlTail } = require('./readOnlyJsonlTailService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  read_only: true,
});

const DATA_DIR = path.resolve(__dirname, '../../data');
const TRADES_FILE = path.join(DATA_DIR, 'paper-trading/trades.jsonl');

const WINDOW_MS = Object.freeze({ '24h': 86400e3, '3d': 3 * 86400e3, '7d': 7 * 86400e3 });
const CACHE_TTL_MS = 20_000;
const TRADES_TAIL_BYTES = 8 * 1024 * 1024;

let _cache = null;
let _cacheAt = 0;

function tsOf(v) { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function lower(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function round(v, d = 2) { const n = Number(v); if (!Number.isFinite(n)) return 0; const f = 10 ** d; return Math.round(n * f) / f; }
function median(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function readTrades() {
  if (!fs.existsSync(TRADES_FILE)) return { rows: [], partial: false, warnings: [], sourceBytes: 0, sourceRows: 0 };
  const tail = readJsonlTail(TRADES_FILE, { maxBytes: TRADES_TAIL_BYTES, maxLines: 80_000 });
  const rows = tail.rows
    .filter((t) => t.pnlPct != null)
    .map((t) => ({
      ts: tsOf(t.exitTime || t.closed_at || t.entryTime || t.opened_at),
      durationSec: num(t.duration_seconds),
      pnlPct: num(t.pnlPct),
      result: String(t.result || '').toUpperCase(),
      exitReasonCode: t.exitReasonCode || null,
      exitSource: t.exitSource || null,
      exitEngineDecision: t.exitEngineLastDecision?.decision || t.exitEngineDecision || null,
      strategyId: t.strategyId || t.resolvedStrategyId || t.strategy_id || 'unknown',
      signalSubtype: t.signalSubtype || t.signal_subtype || 'unknown',
      statusAtEntry: lower(t.statusAtEntry),
      firstTargetTouchAt: t.firstTargetTouchAt || null,
      firstStopTouchAt: t.firstStopTouchAt || null,
    }));
  return { rows, partial: tail.partial, warnings: tail.warnings, sourceBytes: tail.size, sourceRows: tail.rows.length };
}

// "default" exit = closed with no explicit reason code (the fallback close).
function isDefaultExit(code) { return code == null || code === '' || code === 'none'; }
function isTargetHit(t) {
  return Boolean(t.firstTargetTouchAt) || /target/.test(lower(t.exitReasonCode));
}

function summarize(trades) {
  const n = trades.length;
  if (!n) return { count: 0 };
  const durs = trades.map((t) => t.durationSec).filter((x) => x != null);
  const wins = trades.filter((t) => (t.result === 'WIN') || (t.result !== 'LOSS' && t.pnlPct > 0)).length;
  const u2 = durs.filter((d) => d < 120).length;
  const u5 = durs.filter((d) => d < 300).length;
  const u10 = durs.filter((d) => d < 600).length;

  const codeCounts = {};
  for (const t of trades) {
    const code = isDefaultExit(t.exitReasonCode) ? 'default' : t.exitReasonCode;
    codeCounts[code] = (codeCounts[code] || 0) + 1;
  }
  const exitReasonTop = Object.entries(codeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({ code, count, pct: round(100 * count / n, 1) }));

  const sourceCounts = {};
  for (const t of trades) { const s = t.exitSource || 'unknown'; sourceCounts[s] = (sourceCounts[s] || 0) + 1; }

  return {
    count: n,
    winrate: round(100 * wins / n, 1),
    avgPnlPct: round(trades.reduce((s, t) => s + (t.pnlPct || 0), 0) / n, 4),
    medianDurationSec: median(durs),
    pctUnder2min: round(100 * u2 / n, 1),
    pctUnder5min: round(100 * u5 / n, 1),
    pctUnder10min: round(100 * u10 / n, 1),
    exitReasonTop,
    exitSource: sourceCounts,
    targetHits: trades.filter(isTargetHit).length,
    tightenedStop: codeCounts.tightened_stop || 0,
    momentumFade: codeCounts.momentum_fade || 0,
    defaultExits: codeCounts.default || 0,
    timeoutExits: (codeCounts.timeout_intelligence || 0) + (codeCounts.timeout || 0),
    breakEven: codeCounts.break_even || 0,
  };
}

function buildShortExitTruth(options = {}) {
  const cacheable = !options.now && options.cache !== false;
  const cacheNow = Date.now();
  if (cacheable && _cache && (cacheNow - _cacheAt) < CACHE_TTL_MS) return _cache;

  const now = options.now ? new Date(options.now).getTime() : Date.now();
  const read = readTrades();
  const all = read.rows;

  const windows = {};
  for (const [wk, ms] of Object.entries(WINDOW_MS)) {
    const since = now - ms;
    const w = all.filter((t) => t.ts != null && t.ts >= since);
    const byStrategy = {};
    for (const sid of ['trend_continuation', 'narrow_breakout', 'narrow_state_expansion_long']) {
      byStrategy[sid] = summarize(w.filter((t) => t.strategyId === sid));
    }
    const bySetup = {};
    for (const sub of ['REGULAR_PULLBACK', 'NARROW_WAIT', 'NARROW_BULL_ENTRY', 'NARROW_BEAR_ENTRY']) {
      bySetup[sub] = summarize(w.filter((t) => t.signalSubtype === sub));
    }
    const byStatus = {};
    for (const st of ['caution', 'watch']) {
      byStatus[st] = summarize(w.filter((t) => t.statusAtEntry === st));
    }
    windows[wk] = { overall: summarize(w), byStrategy, bySetup, byStatus };
  }

  const result = {
    ok: true,
    mode: 'paper_only',
    partial: Boolean(read.partial),
    warnings: read.warnings || [],
    generatedAt: new Date(now).toISOString(),
    safety: { ...SAFETY },
    note: 'Detta ändrar inte exit. Det visar bara varför trades stängdes.',
    dataSource: 'data/paper-trading/trades.jsonl',
    readLimits: {
      cacheTtlMs: CACHE_TTL_MS,
      tradesTailBytes: TRADES_TAIL_BYTES,
      tradesRowsRead: read.sourceRows,
      tradesSourceBytes: read.sourceBytes,
    },
    windows,
  };
  if (cacheable) {
    _cache = result;
    _cacheAt = cacheNow;
  }
  return result;
}

module.exports = {
  SAFETY,
  WINDOW_MS,
  buildShortExitTruth,
};
