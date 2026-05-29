'use strict';

// Setup Performance Engine v1 — Read-only analysis layer.
// Reads paper/replay trades, builds setup IDs, computes per-setup statistics.
// actions_allowed=false, can_place_orders=false, live_trading_enabled=false

const fs   = require('fs');
const path = require('path');
const redisService = require('./redisService');

const SAFETY = Object.freeze({
  actions_allowed:       false,
  can_place_orders:      false,
  live_trading_enabled:  false,
  can_create_trades:     false,
  can_modify_risk:       false,
  source:                'setup_performance_v1',
});

const TRADES_FILE = path.join(__dirname, '../../data/paper-trading/trades.jsonl');

const KEYS = Object.freeze({
  performance: 'setups:performance',
  status:      'setups:status',
  prefix:      'setups:setup:',
});

const TTL = Object.freeze({ performance: 120, status: 60, setup: 300 });

// Minimum decisive (WIN+LOSS) trades for each category
const MIN_FOR_TOP  = 8;   // need 8+ decisive to declare a setup "top"
const MIN_FOR_POOR = 3;   // need 3+ decisive to declare a setup "poor/pause"
const MIN_EXPLORE  = 3;   // need 3+ total trades to say anything at all

// Win-rate thresholds (as fractions)
const PAUSE_WR = 0.25;
const POOR_WR  = 0.40;
const GOOD_WR  = 0.58;

// ── In-memory fallback ────────────────────────────────────────────────────────

const memCache = new Map();

async function rGet(key) {
  try { const v = await redisService.getJson(key, null); if (v) return v; } catch (_) {}
  const e = memCache.get(key);
  return (e && e.exp > Date.now()) ? e.v : null;
}

async function rSet(key, value, ttl) {
  try { await redisService.setJson(key, value, ttl); } catch (_) {}
  memCache.set(key, { v: value, exp: Date.now() + ttl * 1000 });
}

// ── Setup ID / label ──────────────────────────────────────────────────────────

const SUBTYPE_NORM = {
  VWAP_RECLAIM_UP:     'vwap_reclaim_up',
  VWAP_REJECTION_DOWN: 'vwap_rejection_down',
  EMA_PULLBACK_UP:     'ema_pullback_up',
  EMA_PULLBACK_DOWN:   'ema_pullback_down',
  NARROW_BREAKOUT:     'narrow_breakout',
  NARROW_REJECTION:    'narrow_rejection',
  COMPRESSION_BREAK:   'compression_break',
};

const SUBTYPE_SV = {
  vwap_reclaim_up:     'VWAP återtaget uppåt',
  vwap_rejection_down: 'VWAP avvisning nedåt',
  ema_pullback_up:     'EMA-rekyl uppåt',
  ema_pullback_down:   'EMA-rekyl nedåt',
  narrow_breakout:     'Smal kompression utbrott',
  narrow_rejection:    'Smal kompression avvisning',
  compression_break:   'Kompressionsutbrott',
};

const VOLUME_SV = {
  strong:   'stark volym',
  normal:   'normal volym',
  weak:     'svag volym',
  low:      'låg volym',
  very_low: 'mycket låg volym',
};

const STATUS_SV = {
  ready:   'redo',
  watch:   'bevakningsläge',
  caution: 'varsam',
  ok:      'ok',
};

function buildSetupId(trade) {
  const mkt = (trade.marketType   || 'unknown').toLowerCase();
  const sub = SUBTYPE_NORM[trade.signalSubtype] || (trade.signalSubtype || 'unknown').toLowerCase();
  const vol = (trade.volumeState  || 'unknown').toLowerCase();
  const sta = (trade.statusAtEntry || 'unknown').toLowerCase();
  return `${mkt}_${sub}_${vol}_${sta}`;
}

function buildSetupLabel(id) {
  const [mkt, ...rest] = id.split('_');
  const mktL = mkt === 'crypto' ? 'Krypto' : mkt === 'stocks' ? 'Aktier' : mkt;

  // Match known subtypes (longest first to avoid prefix collision)
  const sortedSubs = Object.entries(SUBTYPE_SV).sort((a, b) => b[0].length - a[0].length);
  for (const [sub, subL] of sortedSubs) {
    const suffix = id.slice(mkt.length + 1);
    if (suffix.startsWith(sub + '_')) {
      const after = suffix.slice(sub.length + 1).split('_');
      const vol   = after[0] || '';
      const sta   = after.slice(1).join('_') || '';
      const volL  = VOLUME_SV[vol]  || vol;
      const staL  = STATUS_SV[sta]  || sta;
      return `${mktL} · ${subL} · ${volL} · ${staL}`;
    }
  }
  return rest.join(' ').replace(/_/g, ' ');
}

// ── Trade reader ──────────────────────────────────────────────────────────────

function readTrades() {
  if (!fs.existsSync(TRADES_FILE)) return [];
  try {
    return fs.readFileSync(TRADES_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

// ── Statistics ────────────────────────────────────────────────────────────────

function r2(n) { return Math.round(n * 100) / 100; }

function computeStats(setupId, trades) {
  const wins   = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const ties   = trades.filter(t => t.result !== 'WIN' && t.result !== 'LOSS');
  const decisive = wins.length + losses.length;
  const win_rate = decisive > 0 ? r2(wins.length / decisive * 100) : null;

  const pnls     = trades.map(t => t.pnlPct || 0);
  const avg_pnl  = pnls.length ? r2(pnls.reduce((a, b) => a + b, 0) / pnls.length) : 0;
  const total_pnl = r2(pnls.reduce((a, b) => a + b, 0));
  const max_drawdown = r2(pnls.length ? Math.min(...pnls) : 0);
  const best_pnl     = r2(pnls.length ? Math.max(...pnls) : 0);

  // Per-symbol averages (min 2 trades)
  const bySym = {};
  for (const t of trades) {
    const s = t.symbol || '?';
    if (!bySym[s]) bySym[s] = [];
    bySym[s].push(t.pnlPct || 0);
  }
  const symArr = Object.entries(bySym)
    .filter(([, a]) => a.length >= 2)
    .map(([sym, a]) => ({ sym, avg: a.reduce((x, y) => x + y, 0) / a.length }))
    .sort((a, b) => b.avg - a.avg);
  const best_symbol  = symArr[0]?.sym || null;
  const worst_symbol = symArr[symArr.length - 1]?.sym || null;

  // Most common exit reason for losses
  const lossReasons = {};
  for (const t of losses) {
    const r = t.exitReason || t.exitReasonCode || 'unknown';
    lossReasons[r] = (lossReasons[r] || 0) + 1;
  }
  const common_loss_reason = Object.entries(lossReasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const timestamps = trades.map(t => t.exitTime || t.entryTime || '').filter(Boolean).sort();
  const last_trade_at = timestamps[timestamps.length - 1] || null;
  const symbols = [...new Set(trades.map(t => t.symbol).filter(Boolean))].sort();

  // Sample subtypes / market types for context
  const marketType   = trades[0]?.marketType || null;
  const signalSubtype = trades[0]?.signalSubtype || null;

  return {
    setup_id:          setupId,
    label:             buildSetupLabel(setupId),
    market_type:       marketType,
    signal_subtype:    signalSubtype,
    total_trades:      trades.length,
    wins:              wins.length,
    losses:            losses.length,
    ties:              ties.length,
    decisive,
    win_rate,
    avg_pnl_pct:       avg_pnl,
    total_pnl_pct:     total_pnl,
    max_drawdown_pct:  max_drawdown,
    best_pnl_pct:      best_pnl,
    best_symbol,
    worst_symbol,
    symbols,
    common_loss_reason,
    last_trade_at,
  };
}

function categorize(stats) {
  const wr = stats.win_rate !== null ? stats.win_rate / 100 : null;
  const d  = stats.decisive;
  const t  = stats.total_trades;

  if (t < MIN_EXPLORE)  return { category: 'insufficient', label_sv: 'För lite data ännu',        color: 'gray',   priority: 3 };
  if (d < MIN_EXPLORE)  return { category: 'explore',      label_sv: 'Testa mer innan beslut',     color: 'yellow', priority: 2 };

  // Strong negative signal — usable with fewer samples
  if (wr !== null && d >= MIN_FOR_POOR && wr <= PAUSE_WR) return { category: 'pause',  label_sv: 'Bör pausas',                 color: 'red',    priority: 5 };
  if (wr !== null && d >= MIN_FOR_POOR && wr <= POOR_WR)  return { category: 'poor',   label_sv: 'Det här mönstret förlorar', color: 'orange', priority: 4 };

  // Positive signal needs more data
  if (wr !== null && d >= MIN_FOR_TOP  && wr >= GOOD_WR)  return { category: 'top',    label_sv: 'Det här mönstret fungerar', color: 'green',  priority: 1 };

  return { category: 'explore', label_sv: 'Testa mer innan beslut', color: 'yellow', priority: 2 };
}

// ── Builder ───────────────────────────────────────────────────────────────────

function buildPerformance() {
  const trades = readTrades();

  const groups = {};
  for (const t of trades) {
    const id = buildSetupId(t);
    if (!groups[id]) groups[id] = [];
    groups[id].push(t);
  }

  const setups = Object.entries(groups)
    .map(([id, ts]) => {
      const stats = computeStats(id, ts);
      const cat   = categorize(stats);
      return { ...stats, ...cat, ok: true, ...SAFETY };
    })
    .sort((a, b) => {
      if (b.decisive !== a.decisive) return b.decisive - a.decisive;
      return (b.win_rate || 0) - (a.win_rate || 0);
    });

  const totalW = trades.filter(t => t.result === 'WIN').length;
  const totalD = trades.filter(t => t.result === 'WIN' || t.result === 'LOSS').length;
  const overall_win_rate = totalD > 0 ? r2(totalW / totalD * 100) : null;

  const summary = {
    top_count:          setups.filter(s => s.category === 'top').length,
    poor_count:         setups.filter(s => s.category === 'poor').length,
    pause_count:        setups.filter(s => s.category === 'pause').length,
    explore_count:      setups.filter(s => s.category === 'explore' || s.category === 'neutral').length,
    insufficient_count: setups.filter(s => s.category === 'insufficient').length,
  };

  return {
    ok: true,
    built_at: new Date().toISOString(),
    total_trades: trades.length,
    total_setups: setups.length,
    overall_win_rate,
    setups,
    summary,
    ...SAFETY,
  };
}

// ── Public ────────────────────────────────────────────────────────────────────

async function getPerformance(force = false) {
  if (!force) {
    const cached = await rGet(KEYS.performance);
    if (cached) return cached;
  }
  const result = buildPerformance();
  await rSet(KEYS.performance, result, TTL.performance);
  return result;
}

async function getSetupById(setupId) {
  const key    = KEYS.prefix + setupId;
  const cached = await rGet(key);
  if (cached) return cached;

  const trades = readTrades().filter(t => buildSetupId(t) === setupId);
  if (!trades.length) return null;

  const stats  = computeStats(setupId, trades);
  const cat    = categorize(stats);
  const result = { ...stats, ...cat, ok: true, ...SAFETY };
  await rSet(key, result, TTL.setup);
  return result;
}

async function getTopSetups(n = 5) {
  const perf = await getPerformance();
  const top  = perf.setups
    .filter(s => s.category === 'top' && s.decisive >= MIN_FOR_TOP)
    .sort((a, b) => (b.win_rate || 0) - (a.win_rate || 0))
    .slice(0, n);
  return { ok: true, setups: top, count: top.length, ...SAFETY };
}

async function getWorstSetups(n = 5) {
  const perf  = await getPerformance();
  const worst = perf.setups
    .filter(s => (s.category === 'poor' || s.category === 'pause') && s.decisive >= MIN_FOR_POOR)
    .sort((a, b) => (a.win_rate || 100) - (b.win_rate || 100))
    .slice(0, n);
  return { ok: true, setups: worst, count: worst.length, ...SAFETY };
}

async function getStatus() {
  const cached = await rGet(KEYS.status);
  if (cached) return cached;

  const exists = fs.existsSync(TRADES_FILE);
  let trade_count = 0;
  if (exists) {
    try {
      trade_count = fs.readFileSync(TRADES_FILE, 'utf8').split('\n').filter(Boolean).length;
    } catch (_) {}
  }

  const status = {
    ok:                  true,
    trades_file_exists:  exists,
    trade_count,
    cache_keys:          memCache.size,
    built_at:            new Date().toISOString(),
    ...SAFETY,
  };
  await rSet(KEYS.status, status, TTL.status);
  return status;
}

module.exports = {
  getPerformance,
  getSetupById,
  getTopSetups,
  getWorstSetups,
  getStatus,
  buildSetupId,
  SAFETY,
};
