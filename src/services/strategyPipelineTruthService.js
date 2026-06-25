'use strict';

// ---------------------------------------------------------------------------
// Strategy Pipeline Truth — READ-ONLY observability
// ---------------------------------------------------------------------------
// Answers, per strategy: "is it proposed/rejected/approved, is it in the
// catalog, is it on the paper allowlist, does it emit signals/candidates/paper
// trades (24h/3d/7d), what is its most common blocker, and WHERE in the chain
// does it stop?".
//
// Safety: pure read of data files + approval/catalog services. NEVER writes,
// NEVER approves, NEVER places an order, NEVER changes trading behaviour. The
// gate (PAPER_ENTRY_QUALITY_GATE_ENABLED) is never read or set here.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const automationApprovalService = require('./automationApprovalService');
const daytradingStrategyCatalog = require('./daytradingStrategyCatalogService');
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
const SKIPPED_FILE = path.join(DATA_DIR, 'daytrading-learning/skipped-signals.jsonl');

const WINDOW_MS = Object.freeze({ '24h': 86400e3, '3d': 3 * 86400e3, '7d': 7 * 86400e3 });
const PRIMARY_WINDOW = '7d'; // window used for the chainStop verdict
const CACHE_TTL_MS = 20_000;
const TRADES_TAIL_BYTES = 8 * 1024 * 1024;
const SKIPPED_TAIL_BYTES = 16 * 1024 * 1024;

let _cache = null;
let _cacheAt = 0;

// Canonical chain-stop codes (stable for UI/tests).
const CHAIN_STOP = Object.freeze({
  PROPOSED_NOT_APPROVED: 'proposed_not_approved',
  APPROVED_NOT_ALLOWLISTED: 'approved_not_allowlisted',
  NO_MATCHING_SIGNAL_SUBTYPE: 'no_matching_signal_subtype',
  ALLOWLIST_BLOCK: 'allowlist_block',
  MARKET_CLOSED: 'market_closed',
  LOW_CONFIDENCE: 'low_confidence',
  QUALITY_GATE: 'quality_gate',
  MISSING_DATA: 'missing_data',
  RUNTIME_GATE: 'runtime_gate',
  TRADES_OK: 'trades_ok',
  UNKNOWN: 'unknown',
});

const CHAIN_STOP_SV = Object.freeze({
  proposed_not_approved: 'Föreslagen men inte godkänd — väntar på manuellt godkännande.',
  approved_not_allowlisted: 'Godkänd men inte på paper-allowlist:en i runtime.',
  no_matching_signal_subtype: 'Godkänd men signal-subtypen matchar nästan aldrig — inga kandidater.',
  allowlist_block: 'Emitterar signaler men blockeras av godkänd-allowlist:en.',
  market_closed: 'Marknaden stängd — signalerna kom utanför handelstid.',
  low_confidence: 'Stoppas oftast av låg confidence (riskmotor).',
  quality_gate: 'Stoppas oftast av kvalitetsgate (vänta / jaga inte / svag volym).',
  missing_data: 'Stoppas av saknad data.',
  runtime_gate: 'Stoppas av runtime-gate (risk / cooldown / max trades).',
  trades_ok: 'Gör paper trades — men fler stoppas av kvalitets-/runtime-gater.',
  unknown: 'Orsak ej klassificerad.',
});

function safeStr(v) { return v == null ? '' : String(v).trim(); }
function tsOf(v) { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; }

// Read a JSONL file line-by-line, keeping only rows whose timestamp is within
// the widest window. Avoids holding the whole 70MB string longer than needed.
function readRowsSince(file, sinceTs, tsField = 'timestamp') {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  const maxBytes = file === SKIPPED_FILE ? SKIPPED_TAIL_BYTES : TRADES_TAIL_BYTES;
  const tail = readJsonlTail(file, { maxBytes, maxLines: 120_000 });
  for (const obj of tail.rows) {
    const ts = tsOf(obj[tsField] || obj.exitTime || obj.closed_at || obj.entryTime || obj.opened_at);
    if (ts != null && ts >= sinceTs) rows.push({ ...obj, _ts: ts });
  }
  return { rows, partial: tail.partial, warnings: tail.warnings, sourceBytes: tail.size, sourceRows: tail.rows.length };
}

function mapCategoryToChainStop(category) {
  switch (category) {
    case 'market_closed': return CHAIN_STOP.MARKET_CLOSED;
    case 'low_confidence': return CHAIN_STOP.LOW_CONFIDENCE;
    case 'wait':
    case 'do_not_chase': return CHAIN_STOP.QUALITY_GATE;
    case 'risk_block':
    case 'cooldown':
    case 'max_trades_limit': return CHAIN_STOP.RUNTIME_GATE;
    case 'missing_data': return CHAIN_STOP.MISSING_DATA;
    default: return CHAIN_STOP.UNKNOWN;
  }
}

function topKey(counter) {
  let best = null; let bestN = -1;
  for (const [k, n] of Object.entries(counter)) { if (n > bestN) { best = k; bestN = n; } }
  return best;
}

function buildStrategyPipelineTruth(options = {}) {
  const cacheable = !options.now && options.cache !== false;
  const cacheKey = 'default';
  const cacheNow = Date.now();
  if (cacheable && _cache && _cache.key === cacheKey && (cacheNow - _cacheAt) < CACHE_TTL_MS) return _cache.value;

  const now = options.now ? new Date(options.now).getTime() : Date.now();
  const widest = now - WINDOW_MS['7d'];
  const warnings = [];
  let partial = false;

  // --- approvals (source of truth for proposed/rejected/approved) ------------
  let approvals = { approvedStrategyIds: [], rejectedStrategyIds: [] };
  try { approvals = automationApprovalService.getAutomationApprovals() || approvals; } catch (_) { /* degrade */ }
  const approvedSet = new Set((approvals.approvedStrategyIds || []).filter(Boolean));
  const rejectedSet = new Set((approvals.rejectedStrategyIds || []).filter(Boolean));

  // --- data within 7d --------------------------------------------------------
  const tradesRead = readRowsSince(TRADES_FILE, widest);
  const skippedRead = readRowsSince(SKIPPED_FILE, widest);
  const trades = tradesRead.rows;
  const skipped = skippedRead.rows;
  partial = Boolean(tradesRead.partial || skippedRead.partial);
  warnings.push(...(tradesRead.warnings || []), ...(skippedRead.warnings || []));

  // --- universe of strategies actually in the pipeline -----------------------
  const universe = new Set([...approvedSet, ...rejectedSet]);
  for (const t of trades) { const id = safeStr(t.strategyId || t.resolvedStrategyId || t.strategy_id); if (id) universe.add(id); }
  for (const s of skipped) { const id = safeStr(s.strategy_id || s.strategyId); if (id && id !== 'null') universe.add(id); }
  universe.delete('');

  const windowKeys = Object.keys(WINDOW_MS);
  const rows = [];

  for (const strategyId of universe) {
    const catalogDef = (() => { try { return daytradingStrategyCatalog.getStrategyById(strategyId); } catch (_) { return null; } })();
    const inCatalog = Boolean(catalogDef);
    const approved = approvedSet.has(strategyId);
    const rejected = rejectedSet.has(strategyId);
    const listedInApprovals = approved || rejected;
    const approvalStatus = approved ? 'approved' : (rejected ? 'rejected' : 'proposed');

    // per-window counts
    const signals = {}; const candidates = {}; const paperTrades = {};
    const blockerByWindow = {};
    for (const wk of windowKeys) {
      const since = now - WINDOW_MS[wk];
      const wTrades = trades.filter((t) => safeStr(t.strategyId || t.resolvedStrategyId || t.strategy_id) === strategyId && t._ts >= since);
      const wSkips = skipped.filter((s) => safeStr(s.strategy_id || s.strategyId) === strategyId && s._ts >= since);
      // emitted signal = either a recorded trade or a logged skip
      const emitted = wTrades.length + wSkips.length;
      // candidate = emitted signal that was actionable (market not closed)
      const actionableSkips = wSkips.filter((s) => safeStr(s.skip_category) !== 'market_closed');
      paperTrades[wk] = wTrades.length;
      signals[wk] = emitted;
      candidates[wk] = wTrades.length + actionableSkips.length;
      // blocker tally (skip categories)
      const cat = {};
      for (const s of wSkips) { const c = safeStr(s.skip_category) || 'unknown'; cat[c] = (cat[c] || 0) + 1; }
      blockerByWindow[wk] = cat;
    }

    // --- chain-stop classification on the primary (7d) window ----------------
    const pCat = blockerByWindow[PRIMARY_WINDOW] || {};
    const commonBlockerReason = topKey(pCat) || null;
    const actionableCat = Object.fromEntries(Object.entries(pCat).filter(([k]) => k !== 'market_closed'));
    const dominantActionable = topKey(actionableCat);
    const s7 = signals[PRIMARY_WINDOW];
    const c7 = candidates[PRIMARY_WINDOW];
    const t7 = paperTrades[PRIMARY_WINDOW];

    let chainStop;
    if (!approved) {
      // allowlist is the wall for everything not approved
      chainStop = s7 === 0 ? CHAIN_STOP.PROPOSED_NOT_APPROVED : CHAIN_STOP.ALLOWLIST_BLOCK;
    } else if (!inCatalog) {
      chainStop = CHAIN_STOP.APPROVED_NOT_ALLOWLISTED;
    } else if (s7 === 0) {
      chainStop = CHAIN_STOP.NO_MATCHING_SIGNAL_SUBTYPE;
    } else if (c7 === 0) {
      chainStop = CHAIN_STOP.MARKET_CLOSED;
    } else if (t7 > 0) {
      chainStop = CHAIN_STOP.TRADES_OK;
    } else {
      chainStop = mapCategoryToChainStop(dominantActionable);
    }

    rows.push({
      strategyId,
      name: safeStr(catalogDef?.name) || strategyId,
      approvalStatus,            // proposed | rejected | approved
      proposed: approvalStatus === 'proposed',
      rejected,
      approved,
      listedInApprovals,
      inCatalog,
      hasDetector: inCatalog,    // the catalog is the detector registry
      emitsSignals: s7 > 0,
      paperEnabled: approved,    // approved-allowlist == paper-enabled in this system
      allowlisted: approved,
      signals,                   // {24h,3d,7d}
      candidates,                // {24h,3d,7d}
      paperTrades,               // {24h,3d,7d}
      commonBlockerReason,
      blockerBreakdown7d: pCat,
      chainStop,
      chainStopSv: CHAIN_STOP_SV[chainStop] || CHAIN_STOP_SV.unknown,
      tradesOk: t7 > 0,
      safety: { ...SAFETY },
    });
  }

  // sort: approved-that-trade first, then approved, then rejected/proposed; by 7d trades desc
  const order = { trades_ok: 0, quality_gate: 1, low_confidence: 2, runtime_gate: 3, no_matching_signal_subtype: 4, market_closed: 5, allowlist_block: 6, proposed_not_approved: 7, approved_not_allowlisted: 8, missing_data: 9, unknown: 10 };
  rows.sort((a, b) => {
    if (a.approved !== b.approved) return a.approved ? -1 : 1;
    const oa = order[a.chainStop] ?? 99; const ob = order[b.chainStop] ?? 99;
    if (oa !== ob) return oa - ob;
    return (b.paperTrades['7d'] || 0) - (a.paperTrades['7d'] || 0);
  });

  // grouped views for the UI
  const groups = {
    approvedTrading: rows.filter((r) => r.approved && r.tradesOk),
    approvedNotTrading: rows.filter((r) => r.approved && !r.tradesOk),
    rejectedButEmitting: rows.filter((r) => !r.approved && r.emitsSignals),
    zeroTradesWhy: rows.filter((r) => (r.paperTrades['7d'] || 0) === 0).map((r) => ({
      strategyId: r.strategyId, name: r.name, approvalStatus: r.approvalStatus,
      chainStop: r.chainStop, chainStopSv: r.chainStopSv, signals7d: r.signals['7d'],
    })),
  };

  const result = {
    ok: true,
    mode: 'paper_only',
    partial,
    warnings,
    generatedAt: new Date(now).toISOString(),
    safety: { ...SAFETY },
    windows: windowKeys,
    primaryWindow: PRIMARY_WINDOW,
    note: 'Read-only. Godkänd betyder inte alltid att strategin är körbar i paper runtime. Denna vy visar var strategin stannar i kedjan.',
    chainStopCodes: Object.values(CHAIN_STOP),
    dataSources: {
      approvals: 'automationApprovalService.getAutomationApprovals',
      catalog: 'daytradingStrategyCatalogService.getStrategyById',
      trades: 'data/paper-trading/trades.jsonl',
      skipped: 'data/daytrading-learning/skipped-signals.jsonl',
    },
    readLimits: {
      cacheTtlMs: CACHE_TTL_MS,
      tradesTailBytes: TRADES_TAIL_BYTES,
      skippedTailBytes: SKIPPED_TAIL_BYTES,
      tradesRowsRead: tradesRead.sourceRows,
      skippedRowsRead: skippedRead.sourceRows,
      tradesSourceBytes: tradesRead.sourceBytes,
      skippedSourceBytes: skippedRead.sourceBytes,
    },
    counts: {
      strategies: rows.length,
      approved: rows.filter((r) => r.approved).length,
      rejected: rows.filter((r) => r.rejected).length,
      proposed: rows.filter((r) => r.proposed).length,
      approvedTrading: groups.approvedTrading.length,
      approvedNotTrading: groups.approvedNotTrading.length,
    },
    strategies: rows,
    groups,
  };

  if (cacheable) {
    _cache = { key: cacheKey, value: result };
    _cacheAt = cacheNow;
  }
  return result;
}

module.exports = {
  SAFETY,
  CHAIN_STOP,
  CHAIN_STOP_SV,
  WINDOW_MS,
  buildStrategyPipelineTruth,
};
