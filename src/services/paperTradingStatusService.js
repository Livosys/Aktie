'use strict';

/**
 * Read-only paper trading status service.
 *
 * Inspects the simulated ("paper") trade results written by the paper trading
 * agent (data/paper-trading/trades.jsonl) and turns them into a compact,
 * render-safe status for the supervisor "Låtsashandel" view. It NEVER starts a
 * paper trade, never schedules one, never places orders and never enables a
 * broker. Pure read of existing files.
 *
 * Paper trading in this system is a simulation over live/2m signals: each row is
 * a finished låtsastest with an entry reason, an exit reason and a WIN/LOSS/
 * TIMEOUT outcome. No real money and no real orders are involved.
 *
 * Aggregate numbers (win rate, avg pnl, best strategy) are delegated to
 * tradeStatsService so this endpoint can never disagree with the supervisor
 * overview headline numbers — they read the same file through the same math.
 */

const fs = require('fs');
const path = require('path');

const tradeStats = require('./tradeStatsService');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_TRADES_FILE = path.join(ROOT, 'data/paper-trading/trades.jsonl');

// The paper engine evaluates 2m signals; trade rows carry no timeframe field.
const PAPER_TIMEFRAME = '2m';
// Cap how many recent trades we normalize so the endpoint stays cheap even when
// the trades file grows large over time.
const MAX_RECENT = 25;

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function nowIso() { return new Date().toISOString(); }

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeError(err) {
  const msg = String(err?.message || err || 'unknown_error');
  if (/key|token|secret|password|credential|authorization/i.test(msg)) return 'Källa kunde inte läsas utan att visa hemligheter.';
  return msg.slice(0, 180);
}

// Read raw paper-trade rows (read-only). Reuses tradeStatsService's reader when
// the default file is requested so both stay in sync; otherwise reads the
// provided test file directly.
function readTrades(file) {
  try {
    if (file === DEFAULT_TRADES_FILE && typeof tradeStats.loadPaperTrades === 'function') {
      return tradeStats.loadPaperTrades();
    }
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function rowTimestamp(row) {
  return (row && (row.exitTime || row.closed_at || row.entryTime || row.opened_at || row.timestamp)) || null;
}

function displayTime(iso) {
  if (!iso) return 'Okänd tid';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  // Stockholm-facing supervisor; keep it short and locale-stable.
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function strategyLabel(row) {
  return (row && (row.strategyName || row.strategy_name || row.familyLabelSv || row.subtypeLabelSv)) || null;
}

// Map a raw paper-trade row to the supervisor "Låtsashandel" status vocabulary.
// completed = finished simulated trade with an outcome; simulated = still open;
// blocked/failed/info kept for forward-compat with non-trade rows.
function resolveStatus(row) {
  const hasExit = !!(row && (row.exitTime || row.closed_at || row.exitReason || row.exitPrice != null));
  const result = String(row && (row.result ?? row.outcome) || '').trim().toUpperCase();
  if (!hasExit && (row && (row.entryTime || row.opened_at))) return 'simulated';
  if (result === 'BLOCKED' || result === 'SKIPPED') return 'blocked';
  if (result === 'ERROR' || result === 'FAILED') return 'failed';
  if (hasExit) return 'completed';
  return 'info';
}

// Build a short, factual Swedish "what did we learn" line from the outcome.
// Read-only narration only — no buy/sell/order/execute vocabulary.
function deriveLesson(row, cls) {
  const exit = String(row && (row.exitReason || row.exit_reason) || '').trim().toUpperCase();
  if (cls === 'win') {
    if (exit.includes('TARGET')) return 'Signalen nådde sitt mål i simuleringen.';
    return 'Simuleringen gav ett positivt resultat.';
  }
  if (cls === 'loss') {
    if (exit.includes('STOP')) return 'Signalen träffade stoppnivån i simuleringen.';
    return 'Simuleringen gav ett negativt resultat.';
  }
  if (cls === 'timeout') return 'Tidsgränsen nåddes utan att signalen avgjordes.';
  if (cls === 'breakeven') return 'Simuleringen slutade nära noll.';
  return 'Testhändelsen gav ingen tydlig lärdom ännu.';
}

function normalizeTrade(row) {
  if (!row || typeof row !== 'object') return null;
  const cls = typeof tradeStats.classifyResult === 'function'
    ? tradeStats.classifyResult(row, { deriveFromPnl: true })
    : 'unknown';
  const ts = rowTimestamp(row);
  const strategy = typeof tradeStats.resolveGroupKey === 'function'
    ? tradeStats.resolveGroupKey(row)
    : (row.strategy_id || row.strategyId || row.signalFamily || 'unknown');
  return {
    id: (row.tradeId || row.id || row.signalId) || null,
    timestamp: ts,
    displayTime: displayTime(ts),
    strategy: strategy || null,
    strategyLabel: strategyLabel(row),
    symbol: (row.symbol || null),
    timeframe: PAPER_TIMEFRAME,
    status: resolveStatus(row),
    entryReason: (row.entryReasonSv || row.entry_reason || row.entryReason) || null,
    exitReason: (row.exitReason || row.exit_reason) || null,
    result: (row.result ?? row.outcome) || null,
    pnl: num(row.pnlPct ?? row.pnl_pct ?? row.pnl),
    winRate: null,
    lesson: deriveLesson(row, cls),
    paperOnly: true,
    ...SAFETY,
  };
}

// Sort newest-first by best-available timestamp; rows without a timestamp sink.
function sortNewestFirst(rows) {
  return rows.slice().sort((a, b) => {
    const ta = Date.parse(rowTimestamp(a) || '') || 0;
    const tb = Date.parse(rowTimestamp(b) || '') || 0;
    return tb - ta;
  });
}

function buildSummary(rows) {
  let stats = null;
  try {
    stats = typeof tradeStats.computeStats === 'function'
      ? tradeStats.computeStats(rows, { deriveFromPnl: true })
      : null;
  } catch (_) {
    stats = null;
  }
  let bestStrategy = null;
  try {
    if (typeof tradeStats.computeStatsByGroup === 'function') {
      const groups = tradeStats.computeStatsByGroup(rows, undefined, { deriveFromPnl: true })
        .filter((g) => (g.decisive || 0) >= 1);
      const top = groups[0];
      if (top) bestStrategy = { strategy: top.key, winRate: top.winRate, decisive: top.decisive, totalTrades: top.totalTrades };
    }
  } catch (_) {
    bestStrategy = null;
  }
  return {
    totalTrades: stats ? stats.totalTrades : rows.length,
    win: stats ? stats.win : null,
    loss: stats ? stats.loss : null,
    timeout: stats ? stats.timeout : null,
    breakeven: stats ? stats.breakeven : null,
    winRate: stats ? stats.winRate : null,
    decisiveWinRate: stats ? stats.decisiveWinRate : null,
    avgPnl: stats ? stats.avgPnl : null,
    totalPnl: stats ? stats.totalPnl : null,
    bestPnl: stats ? stats.bestPnl : null,
    worstPnl: stats ? stats.worstPnl : null,
    bestStrategy,
    ...SAFETY,
  };
}

function emptyResult(extra) {
  return {
    ok: true,
    status: 'empty',
    count: 0,
    latestPaperTrade: {},
    recentPaperTrades: [],
    summary: buildSummary([]),
    source: 'data/paper-trading/trades.jsonl',
    updatedAt: nowIso(),
    ...SAFETY,
    ...extra,
  };
}

function buildPaperTradingStatus(options = {}) {
  const file = options.tradesFile || DEFAULT_TRADES_FILE;
  try {
    const exists = fs.existsSync(file) || file === DEFAULT_TRADES_FILE;
    const rows = readTrades(file);
    if (!rows.length) {
      return emptyResult({
        status: exists ? 'empty' : 'empty',
        message: 'Det finns inga låtsastester att visa ännu.',
        fileExists: fs.existsSync(file),
      });
    }

    const sorted = sortNewestFirst(rows);
    const recent = sorted.slice(0, MAX_RECENT).map(normalizeTrade).filter(Boolean);
    const latest = recent[0] || {};
    const summary = buildSummary(rows);

    return {
      ok: true,
      status: 'ok',
      count: rows.length,
      latestPaperTrade: latest,
      recentPaperTrades: recent,
      summary,
      source: 'data/paper-trading/trades.jsonl',
      updatedAt: nowIso(),
      message: `${rows.length} låtsastester lästa (read-only simulering).`,
      ...SAFETY,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      count: 0,
      latestPaperTrade: {},
      recentPaperTrades: [],
      summary: buildSummary([]),
      source: 'data/paper-trading/trades.jsonl',
      updatedAt: nowIso(),
      message: safeError(err),
      ...SAFETY,
    };
  }
}

// Compact summary for embedding in /api/supervisor/overview. Carries the
// headline numbers + the single latest paper trade, never the full list.
function buildSupervisorPaperSummary(options = {}) {
  const full = buildPaperTradingStatus(options);
  return {
    status: full.status,
    count: full.count,
    latestPaperTrade: full.latestPaperTrade && full.latestPaperTrade.id ? full.latestPaperTrade : null,
    summary: full.summary,
    updatedAt: full.updatedAt,
    message: full.message || null,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  PAPER_TIMEFRAME,
  buildPaperTradingStatus,
  buildSupervisorPaperSummary,
  _internal: {
    normalizeTrade,
    resolveStatus,
    deriveLesson,
    sortNewestFirst,
    buildSummary,
    safeError,
  },
};
