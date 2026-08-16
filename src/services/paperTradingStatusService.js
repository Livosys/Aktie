'use strict';

/**
 * Read-only paper trading status service.
 *
 * Inspects the current IBKR Paper execution-intent trade results and turns
 * them into a compact,
 * render-safe status for the supervisor "Låtsashandel" view. It NEVER starts a
 * paper trade, never schedules one, never places orders and never enables a
 * broker. Pure read of existing files.
 *
 * Paper trading in this system is read-only broker paper execution telemetry.
 *
 * Aggregate numbers (win rate, avg pnl, best strategy) are delegated to
 * tradeStatsService so this endpoint can never disagree with the supervisor
 * overview headline numbers — they read the same file through the same math.
 */

const fs = require('fs');
const path = require('path');

const tradeStats = require('./tradeStatsService');
const ibPaperExecutionIntentService = require('./ibPaperExecutionIntentService');

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
function exitReasonFromFilledLeg(leg) {
  const value = String(leg || '').trim();
  if (value === 'stopLoss') return 'stop_loss';
  if (value === 'takeProfit') return 'take_profit';
  if (value === 'emergencyFlatten' || value === 'emergency_flatten') return 'emergency_flatten';
  return value || null;
}

function normalizeIbkrIntentTrade(row = {}) {
  if (!row || row.status !== 'filled') return null;
  const realizedPnl = num(row.filledRealizedPNL ?? row.filledRealizedPnl ?? row.realizedPNL);
  if (realizedPnl === null) return null;
  return {
    tradeId: row.tradeId || row.filledExecId || row.executionId || row.intentId || null,
    signalId: row.signalId || null,
    lifecycleId: row.lifecycleId || null,
    candidateId: row.candidateId || null,
    intentId: row.intentId || row.idempotencyKey || null,
    executionId: row.executionId || null,
    brokerOrderId: row.filledOrderId ?? row.ibOrderId ?? null,
    brokerExecutionId: row.filledExecId || null,
    symbol: row.root || row.localSymbol || null,
    strategyId: row.strategyId || null,
    opened_at: row.entryFilledAt || row.entryExecutionAt || row.signalTimestamp || row.createdAt || null,
    closed_at: row.filledAt || row.filledExecutionAt || row.updatedAt || null,
    result: realizedPnl > 0 ? 'WIN' : (realizedPnl < 0 ? 'LOSS' : 'BREAKEVEN'),
    pnl: realizedPnl,
    exitReason: exitReasonFromFilledLeg(row.filledLeg),
    source: 'ibkr_paper_intent',
    paperOnly: true,
  };
}

function shouldUseIbkrIntentSource(file, options = {}) {
  return Array.isArray(options.ibkrIntents) || file === DEFAULT_TRADES_FILE;
}

function sourceForTrades(file, options = {}) {
  return shouldUseIbkrIntentSource(file, options) ? 'ibkr_paper_intent' : file;
}

function readTrades(file, options = {}) {
  try {
    if (Array.isArray(options.trades)) return options.trades;
    if (shouldUseIbkrIntentSource(file, options)) {
      const intents = Array.isArray(options.ibkrIntents)
        ? options.ibkrIntents
        : ibPaperExecutionIntentService.defaultIbPaperExecutionIntentService
          .listIntents({ limit: Number.MAX_SAFE_INTEGER });
      return intents.map(normalizeIbkrIntentTrade).filter(Boolean);
    }
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

function buildSummary(rows, source = 'ibkr_paper_intent') {
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
    status: rows.length ? 'ok' : 'empty',
    source,
    emptyReason: rows.length ? null : 'no_paper_trades',
    message: rows.length ? `${rows.length} låtsastester lästa (read-only simulering).` : 'Det finns inga låtsastester att visa ännu.',
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
  const source = extra?.source || 'ibkr_paper_intent';
  return {
    ok: true,
    status: 'empty',
    count: 0,
    latestPaperTrade: {},
    recentPaperTrades: [],
    summary: buildSummary([], source),
    source,
    updatedAt: nowIso(),
    ...SAFETY,
    ...extra,
  };
}

function buildPaperTradingStatus(options = {}) {
  const file = options.tradesFile || DEFAULT_TRADES_FILE;
  const source = sourceForTrades(file, options);
  const allowlistService = options.allowlistService || null;
  const approvalsService = options.approvalsService || null;
  try {
    const allowlistStatus = allowlistService && typeof allowlistService.getPaperAllowlistStatus === 'function'
      ? allowlistService.getPaperAllowlistStatus()
      : null;
    const approvals = approvalsService && typeof approvalsService.getAutomationApprovals === 'function'
      ? approvalsService.getAutomationApprovals()
      : null;
    const allowlist = allowlistStatus ? {
      source: 'paperAllowlistService|automationApprovalService',
      totalApproved: allowlistStatus.totalApproved || 0,
      readyForPaperRuntime: allowlistStatus.readyForPaperRuntime || 0,
      pendingRuntimeConnection: allowlistStatus.pendingRuntimeConnection || 0,
      paperRuntimeReady: Boolean(allowlistStatus.paperRuntimeReady),
      runtimeConnectionStatus: allowlistStatus.runtimeConnectionStatus || 'unknown',
      approvedStrategyIds: Array.isArray(allowlistStatus.allowlist) ? allowlistStatus.allowlist.map((row) => row.id).filter(Boolean) : [],
      waitingForApproval: Array.isArray(allowlistStatus.waitingForApproval) ? allowlistStatus.waitingForApproval.slice(0, 10) : [],
      approvedCount: num(approvals?.approvedCount) || 0,
      rejectedCount: Array.isArray(approvals?.rejectedStrategyIds) ? approvals.rejectedStrategyIds.length : 0,
      blockedCount: Array.isArray(approvals?.approvedWithBlockers) ? approvals.approvedWithBlockers.length : 0,
      note: allowlistStatus.note || null,
    } : {
      source: 'paperAllowlistService|automationApprovalService',
      totalApproved: 0,
      readyForPaperRuntime: 0,
      pendingRuntimeConnection: 0,
      paperRuntimeReady: false,
      runtimeConnectionStatus: 'unknown',
      approvedStrategyIds: [],
      waitingForApproval: [],
      approvedCount: num(approvals?.approvedCount) || 0,
      rejectedCount: Array.isArray(approvals?.rejectedStrategyIds) ? approvals.rejectedStrategyIds.length : 0,
      blockedCount: Array.isArray(approvals?.approvedWithBlockers) ? approvals.approvedWithBlockers.length : 0,
      note: 'Allowlist saknas i denna miljö.',
    };
    const exists = fs.existsSync(file) || file === DEFAULT_TRADES_FILE;
    const rows = readTrades(file, options);
    if (!rows.length) {
      const summary = {
        ...buildSummary([], source),
        latestPaperTradeId: null,
        allowlistApprovedCount: allowlist.approvedCount,
        allowlistRejectedCount: allowlist.rejectedCount,
        allowlistBlockedCount: allowlist.blockedCount,
        allowlistReadyCount: allowlist.readyForPaperRuntime,
        allowlistPendingCount: allowlist.pendingRuntimeConnection,
      };
      return emptyResult({
        status: exists ? 'empty' : 'empty',
        message: 'Det finns inga låtsastester att visa ännu.',
        fileExists: fs.existsSync(file),
        emptyReason: 'no_paper_trades',
        allowlist,
        source,
        summary,
      });
    }

    const sorted = sortNewestFirst(rows);
    const recent = sorted.slice(0, MAX_RECENT).map(normalizeTrade).filter(Boolean);
    const latest = recent[0] || {};
    const summary = {
      ...buildSummary(rows, source),
      latestPaperTradeId: latest.id || null,
      allowlistApprovedCount: allowlist.approvedCount,
      allowlistRejectedCount: allowlist.rejectedCount,
      allowlistBlockedCount: allowlist.blockedCount,
      allowlistReadyCount: allowlist.readyForPaperRuntime,
      allowlistPendingCount: allowlist.pendingRuntimeConnection,
    };

    return {
      ok: true,
      status: 'ok',
      emptyReason: null,
      count: rows.length,
      latestPaperTrade: latest,
      recentPaperTrades: recent,
      summary,
      allowlist,
      source,
      updatedAt: nowIso(),
      message: `${rows.length} låtsastester lästa (read-only IBKR Paper).`,
      ...SAFETY,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      emptyReason: 'paper_status_error',
      count: 0,
      latestPaperTrade: {},
      recentPaperTrades: [],
      summary: {
        ...buildSummary([]),
        status: 'error',
        emptyReason: 'paper_status_error',
        message: safeError(err),
        latestPaperTradeId: null,
        allowlistApprovedCount: 0,
        allowlistRejectedCount: 0,
        allowlistBlockedCount: 0,
        allowlistReadyCount: 0,
        allowlistPendingCount: 0,
      },
      allowlist: {
        source: 'paperAllowlistService|automationApprovalService',
        totalApproved: 0,
        readyForPaperRuntime: 0,
        pendingRuntimeConnection: 0,
        paperRuntimeReady: false,
        runtimeConnectionStatus: 'unknown',
        approvedStrategyIds: [],
        waitingForApproval: [],
        approvedCount: 0,
        rejectedCount: 0,
        blockedCount: 0,
        note: 'Allowlist kunde inte läsas.',
      },
      source: 'ibkr_paper_intent',
      updatedAt: nowIso(),
      message: safeError(err),
      ...SAFETY,
    };
  }
}

// Compact summary for embedding in /api/supervisor/overview. Carries the
// headline numbers + the single latest paper trade, never the full list.
function buildSupervisorPaperSummary(options = {}) {
  // Wire the read-only allowlist/approval services by default so the supervisor
  // summary's allowlist is populated (previously it was always empty because no
  // services were passed). Lazy-required so a load error can never break this.
  const allowlistService = options.allowlistService || (() => {
    try { return require('./paperAllowlistService'); } catch (_) { return null; }
  })();
  const approvalsService = options.approvalsService || (() => {
    try { return require('./automationApprovalService'); } catch (_) { return null; }
  })();
  const full = buildPaperTradingStatus({ ...options, allowlistService, approvalsService });
  return {
    status: full.status,
    emptyReason: full.emptyReason || full.summary?.emptyReason || null,
    count: full.count,
    latestPaperTrade: full.latestPaperTrade && full.latestPaperTrade.id ? full.latestPaperTrade : null,
    summary: full.summary,
    allowlist: full.allowlist,
    updatedAt: full.updatedAt,
    message: full.message || full.summary?.message || null,
    source: 'paperTradingStatusService',
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
