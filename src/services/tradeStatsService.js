'use strict';

/**
 * Trade Stats Service — canonical, READ-ONLY trade statistics.
 *
 * This is the single source of truth for how a trade outcome is classified and
 * how win rate is computed across the whole platform. The default source is
 * IBKR Paper execution intents; explicit file options are kept for legacy
 * fixtures and archived replays. Historically, services disagreed on the same
 * paper rows because they treated TIMEOUT differently:
 *
 *   - setupPerformanceService      → decisiveWinRate (TIMEOUT excluded)  → 58.5%
 *   - aiOptimizationAgentService   → winRate         (TIMEOUT in denom)  → 47.99%
 *   - daytradingLearningEngine     → winRate         (TIMEOUT in denom)  → 47.99%
 *
 * (On the live 423-trade file: 203 WIN / 144 LOSS / 76 TIMEOUT.)
 *
 * Both are "correct" for their own definition — they answer different
 * questions. This service exposes BOTH numbers side by side with explicit
 * names so consumers (and the Supervisor) stop guessing.
 *
 * SAFETY: this service only READS data. It never writes files, never places
 * orders, never enables a broker, never changes risk. It is pure analysis.
 *
 * Canonical definitions
 * ---------------------
 *   WIN        — outcome resolved in profit (hit target / closed positive)
 *   LOSS       — outcome resolved at a loss (hit stop / closed negative)
 *   TIMEOUT    — trade closed by max-hold timer, NOT by target or stop
 *   BREAKEVEN  — closed flat (≈ 0 pnl)
 *   DECISIVE   — WIN + LOSS only (a trade that actually resolved directionally)
 *
 *   totalTrades      — every classified trade (win+loss+timeout+breakeven+unknown)
 *   winRate          — WIN / totalTrades            (TIMEOUT counts AGAINST you)
 *   decisiveWinRate  — WIN / DECISIVE               (TIMEOUT excluded entirely)
 *   timeoutRate      — TIMEOUT / totalTrades
 *   avgPnl           — mean pnlPct across trades that have a pnl
 *   totalPnl         — sum of pnlPct
 *
 * Why TIMEOUT is its own bucket: a timeout is not a clean win or loss. Counting
 * it as a loss (winRate) is the conservative, honest view — "the strategy did
 * not produce a decisive winner here". Excluding it (decisiveWinRate) answers
 * "when the trade DID resolve, how often was it right?". Both matter; neither is
 * the whole truth alone. Supervisor should show winRate as the headline and
 * decisiveWinRate as context.
 */

const fs = require('fs');
const path = require('path');
const ibPaperExecutionIntentService = require('./ibPaperExecutionIntentService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'trade_stats_v1',
});

const DATA_DIR = path.resolve(process.env.TRADE_STATS_DATA_DIR || path.resolve(__dirname, '../../data'));
const PAPER_TRADES_FILE = path.join(DATA_DIR, 'paper-trading', 'trades.jsonl');

const WIN_TOKENS = new Set(['win', 'won', 'tp', 'target', 'target_hit', 'take_profit']);
const LOSS_TOKENS = new Set(['loss', 'lose', 'lost', 'sl', 'stop', 'stop_loss', 'stopped_out']);
const TIMEOUT_TOKENS = new Set(['timeout', 'time_out', 'timed_out', 'max_hold', 'expired']);
const BREAKEVEN_TOKENS = new Set(['breakeven', 'break_even', 'be', 'flat', 'even']);

// ── low-level readers (read-only) ─────────────────────────────────────────────
function readJsonl(file) {
  try {
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

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function r2(v) { return v === null ? null : Math.round(v * 100) / 100; }
function r4(v) { return v === null ? null : Math.round(v * 10000) / 10000; }

// ── canonical classification ──────────────────────────────────────────────────
/**
 * Classify a single trade's outcome. If an explicit result is present we trust
 * it; otherwise (and only when deriveFromPnl=true) we fall back to pnl sign.
 * Returns one of: 'win' | 'loss' | 'timeout' | 'breakeven' | 'unknown'.
 */
function classifyResult(row, { deriveFromPnl = false } = {}) {
  const raw = String(row && (row.result ?? row.outcome) || '').trim().toLowerCase();
  if (WIN_TOKENS.has(raw)) return 'win';
  if (LOSS_TOKENS.has(raw)) return 'loss';
  if (TIMEOUT_TOKENS.has(raw)) return 'timeout';
  if (BREAKEVEN_TOKENS.has(raw)) return 'breakeven';

  if (deriveFromPnl) {
    const pnl = num(row && (row.pnlPct ?? row.pnl_pct ?? row.pnl));
    if (pnl !== null) {
      if (pnl > 0.01) return 'win';
      if (pnl < -0.01) return 'loss';
      return 'breakeven';
    }
  }
  return 'unknown';
}

function resolveStrategyId(row) {
  return (row && (row.strategy_id || row.strategyId || row.strategy)) || null;
}

function resolveSignalFamily(row) {
  return (row && (row.signalFamily || row.signal_family)) || null;
}

/**
 * Best available grouping key for a trade. Paper trades carry no strategy_id —
 * only signalFamily/signalSubtype — so we fall back gracefully so attribution
 * never silently drops trades into "unknown".
 */
function resolveGroupKey(row) {
  return resolveStrategyId(row)
    || resolveSignalFamily(row)
    || (row && (row.signalSubtype || row.signal_subtype))
    || 'unknown';
}

// ── canonical stats ─────────────────────────────────────────────────────────
/**
 * Compute canonical stats for a set of trade records.
 * @param {object[]} records
 * @param {object} [opts]
 * @param {boolean} [opts.deriveFromPnl=false] derive win/loss from pnl when result missing
 */
function computeStats(records, opts = {}) {
  const rows = Array.isArray(records) ? records : [];
  let win = 0, loss = 0, timeout = 0, breakeven = 0, unknown = 0;
  let pnlSum = 0, pnlCount = 0, best = null, worst = null;

  for (const row of rows) {
    const cls = classifyResult(row, opts);
    if (cls === 'win') win++;
    else if (cls === 'loss') loss++;
    else if (cls === 'timeout') timeout++;
    else if (cls === 'breakeven') breakeven++;
    else unknown++;

    const pnl = num(row && (row.pnlPct ?? row.pnl_pct ?? row.pnl));
    if (pnl !== null) {
      pnlSum += pnl;
      pnlCount++;
      if (best === null || pnl > best) best = pnl;
      if (worst === null || pnl < worst) worst = pnl;
    }
  }

  const totalTrades = win + loss + timeout + breakeven + unknown;
  const decisive = win + loss;

  return {
    totalTrades,
    win,
    loss,
    timeout,
    breakeven,
    unknown,
    decisive,
    winRate: totalTrades > 0 ? r2((win / totalTrades) * 100) : null,
    decisiveWinRate: decisive > 0 ? r2((win / decisive) * 100) : null,
    timeoutRate: totalTrades > 0 ? r2((timeout / totalTrades) * 100) : null,
    avgPnl: pnlCount > 0 ? r4(pnlSum / pnlCount) : null,
    totalPnl: pnlCount > 0 ? r4(pnlSum) : null,
    bestPnl: best === null ? null : r4(best),
    worstPnl: worst === null ? null : r4(worst),
    pnlSampleSize: pnlCount,
    ...SAFETY,
  };
}

/**
 * Group records by a key (default: best-available strategy/family key) and
 * return canonical stats per group, sorted by decisiveWinRate desc.
 */
function computeStatsByGroup(records, keyFn = resolveGroupKey, opts = {}) {
  const rows = Array.isArray(records) ? records : [];
  const buckets = new Map();
  for (const row of rows) {
    const key = String(keyFn(row) || 'unknown');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const groups = [];
  for (const [key, list] of buckets.entries()) {
    groups.push({ key, ...computeStats(list, opts) });
  }
  groups.sort((a, b) => (b.decisiveWinRate || 0) - (a.decisiveWinRate || 0));
  return groups;
}

/**
 * Explain WHY existing services report different win rates for the same data.
 * Returns the canonical stats plus the two legacy methodologies, each with a
 * human-readable formula, so a reviewer can see 48.0% vs 58.5% derive from one
 * choice: whether TIMEOUT sits in the denominator.
 */
function compareMethodologies(records, opts = {}) {
  const s = computeStats(records, opts);
  return {
    canonical: s,
    methodologies: [
      {
        name: 'winRate',
        label_sv: 'Vinstandel (TIMEOUT räknas emot)',
        formula: 'WIN / totalTrades',
        value: s.winRate,
        used_by: ['aiOptimizationAgentService', 'daytradingLearningEngineService'],
        note_sv: 'Konservativ, ärlig vy: timeout är ingen vinst.',
      },
      {
        name: 'decisiveWinRate',
        label_sv: 'Beslutsam vinstandel (TIMEOUT exkluderad)',
        formula: 'WIN / (WIN + LOSS)',
        value: s.decisiveWinRate,
        used_by: ['setupPerformanceService'],
        note_sv: 'När traden faktiskt avgjordes — hur ofta hade den rätt?',
      },
    ],
    difference_explained_sv: s.winRate !== null && s.decisiveWinRate !== null
      ? `Skillnaden (${s.winRate}% vs ${s.decisiveWinRate}%) beror enbart på `
        + `de ${s.timeout} TIMEOUT-traderna: de ingår i nämnaren för winRate men `
        + `exkluderas helt ur decisiveWinRate.`
      : 'För lite data för att jämföra.',
    ...SAFETY,
  };
}

// ── risk/reward quality (pnl-sign based, read-only) ───────────────────────────
/**
 * Compute risk/reward quality for a set of trades, classifying win/loss purely
 * by pnl SIGN (pnlPct > 0 = win, < 0 = loss, === 0 = breakeven). This answers a
 * different question than win rate: "are the wins actually bigger than the
 * losses?" A strategy can win often and still lose money when the average loss
 * is much larger than the average win.
 *
 * Fault isolation: trades without a numeric pnl are counted as `invalid` and
 * excluded from every metric. Division-by-zero never produces NaN/Infinity —
 * those cases return null, and `profitFactorLabel` carries the "∞" sentinel when
 * there are wins but zero losses so the UI can render it as text.
 */
function computeRiskReward(records) {
  const rows = Array.isArray(records) ? records : [];
  let wins = 0, losses = 0, breakeven = 0, invalid = 0;
  let totalWin = 0, totalLoss = 0; // totalLoss accumulates negative pnl
  let maxWin = null, maxLoss = null;

  for (const row of rows) {
    const pnl = num(row && (row.pnlPct ?? row.pnl_pct ?? row.pnl));
    if (pnl === null) { invalid++; continue; }
    if (pnl > 0) {
      wins++; totalWin += pnl;
      if (maxWin === null || pnl > maxWin) maxWin = pnl;
    } else if (pnl < 0) {
      losses++; totalLoss += pnl;
      if (maxLoss === null || pnl < maxLoss) maxLoss = pnl;
    } else {
      breakeven++;
    }
  }

  const closedTrades = wins + losses + breakeven;
  const avgWinPct = wins > 0 ? totalWin / wins : null;
  const avgLossPct = losses > 0 ? totalLoss / losses : null; // negative or null
  const netPnlPct = totalWin + totalLoss;
  const avgTradePct = closedTrades > 0 ? netPnlPct / closedTrades : null;
  const winRatePct = closedTrades > 0 ? (wins / closedTrades) * 100 : null;

  const riskRewardRatio = (avgWinPct !== null && avgLossPct !== null && avgLossPct !== 0)
    ? avgWinPct / Math.abs(avgLossPct) : null;
  const lossToWinRatio = (avgWinPct !== null && avgWinPct !== 0 && avgLossPct !== null)
    ? Math.abs(avgLossPct) / avgWinPct : null;

  let profitFactor = null;
  let profitFactorLabel = null;
  if (totalLoss !== 0) {
    profitFactor = totalWin / Math.abs(totalLoss);
  } else if (totalWin > 0) {
    profitFactorLabel = '∞'; // wins but zero losses — undefined ratio, label only
  }

  return {
    closedTrades,
    wins,
    losses,
    breakeven,
    invalid,
    winRatePct: r2(winRatePct),
    totalWinPct: r4(totalWin),
    totalLossPct: r4(totalLoss),
    netPnlPct: r4(netPnlPct),
    avgWinPct: r4(avgWinPct),
    avgLossPct: r4(avgLossPct),
    avgTradePct: r4(avgTradePct),
    riskRewardRatio: r2(riskRewardRatio),
    lossToWinRatio: r2(lossToWinRatio),
    profitFactor: r2(profitFactor),
    profitFactorLabel,
    maxSingleWinPct: r4(maxWin),
    maxSingleLossPct: r4(maxLoss),
    ...SAFETY,
  };
}

/**
 * Deterministic, human-readable status for a risk/reward metric object.
 * Pure function of the metrics so it can be unit-tested independently.
 */
function riskRewardStatusLabel(metrics = {}) {
  const closed = Number(metrics.closedTrades) || 0;
  const net = metrics.netPnlPct;
  const pf = metrics.profitFactor;
  const lossToWin = metrics.lossToWinRatio;
  if (closed < 5) return 'För lite data';
  if (lossToWin !== null && lossToWin !== undefined && lossToWin >= 2.5) return 'Risk: förlust större än vinst';
  if (net !== null && net !== undefined && net > 0 && pf !== null && pf !== undefined && pf >= 1.5 && closed >= 20) return 'Stabil paper-kandidat';
  if (net !== null && net !== undefined && net > 0 && closed < 20) return 'Lovande men behöver mer data';
  if (net !== null && net !== undefined && net < 0 && closed >= 5) return 'Svag / pausa för granskning';
  return 'Neutral – granska manuellt';
}

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

// ── convenience: canonical paper-trade stats from current source (read-only) ──
function loadPaperTrades(options = {}) {
  if (options.file) return readJsonl(options.file);
  try {
    const intents = Array.isArray(options.ibkrIntents)
      ? options.ibkrIntents
      : ibPaperExecutionIntentService.defaultIbPaperExecutionIntentService
        .listIntents({ limit: Number.MAX_SAFE_INTEGER });
    return intents.map(normalizeIbkrIntentTrade).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function buildPaperTradeStats(opts = {}) {
  return computeStats(loadPaperTrades(), opts);
}

function buildPaperTradeComparison(opts = {}) {
  return compareMethodologies(loadPaperTrades(), opts);
}

module.exports = {
  SAFETY,
  PAPER_TRADES_FILE,
  // classification
  classifyResult,
  resolveStrategyId,
  resolveSignalFamily,
  resolveGroupKey,
  // stats
  computeStats,
  computeStatsByGroup,
  compareMethodologies,
  computeRiskReward,
  riskRewardStatusLabel,
  // disk convenience (read-only)
  loadPaperTrades,
  buildPaperTradeStats,
  buildPaperTradeComparison,
};
