'use strict';

/**
 * Trade Stats Service — canonical, READ-ONLY trade statistics.
 *
 * This is the single source of truth for how a trade outcome is classified and
 * how win rate is computed across the whole platform. Today several services
 * read the same `paper-trading/trades.jsonl` but disagree on the numbers,
 * purely because they treat TIMEOUT differently:
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

// ── convenience: canonical paper-trade stats from disk (read-only) ────────────
function loadPaperTrades() {
  return readJsonl(PAPER_TRADES_FILE);
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
  // disk convenience (read-only)
  loadPaperTrades,
  buildPaperTradeStats,
  buildPaperTradeComparison,
};
