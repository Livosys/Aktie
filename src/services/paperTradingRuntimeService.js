'use strict';

/**
 * Read-only paper trading runtime service.
 *
 * Single endpoint-oriented view for the current paper runtime: open/closed
 * trades, recent paper events, blocked candidates and per-strategy activity.
 * It ONLY reads existing files. It never starts paper trading, never places
 * orders, never enables a broker and never mutates risk or learning state.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const automationPlanService = require('./automationPlanService');
const paperAllowlistService = require('./paperAllowlistService');
const strategyCatalog = require('./daytradingStrategyCatalogService');
const strategyIdNormalizer = require('./strategyIdNormalizerService');
const strategyRuntimeMatrixService = require('./strategyRuntimeMatrixService');
const tradeStats = require('./tradeStatsService');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_FILES = Object.freeze({
  trades: path.join(ROOT, 'data/paper-trading/trades.jsonl'),
  events: path.join(ROOT, 'data/paper-trading/events.jsonl'),
  gateDecisions: path.join(ROOT, 'data/paper-trading/gate-decisions.jsonl'),
  state: path.join(ROOT, 'data/paper-trading/state.json'),
  learningOutcomes: path.join(ROOT, 'data/daytrading-learning/outcomes.jsonl'),
  optimizationCandidates: path.join(ROOT, 'data/optimization/paper-candidates.jsonl'),
  optimizationLatest: path.join(ROOT, 'data/optimization/latest.json'),
});

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function nowIso() { return new Date().toISOString(); }

function clampLimit(value, fallback = 50) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.round(n)));
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value) {
  const ms = new Date(value || '').getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function eventTime(row = {}) {
  return iso(
    row.timestamp
    || row.closed_at
    || row.exitTime
    || row.last_update_at
    || row.updated_at
    || row.entryTime
    || row.opened_at
    || row.created_at,
  );
}

function newestFirst(a, b) {
  return String(eventTime(b) || '').localeCompare(String(eventTime(a) || ''));
}

function todayIsoDate(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

function stableHash(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function safeText(value, fallback = '–') {
  const out = text(value, '');
  return out ? out : fallback;
}

function safeNumberText(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return n.toFixed(decimals);
}

function sourceRank(source) {
  const raw = String(source || '').toLowerCase();
  if (raw.includes('paper_trade')) return 0;
  if (raw.includes('trade')) return 1;
  if (raw.includes('learning')) return 2;
  if (raw.includes('optimization')) return 3;
  if (raw.includes('plan')) return 4;
  return 5;
}

function normalizeCandidateSymbol(row = {}) {
  return text(
    row.symbol
    || row.traded_symbol
    || row.underlying_symbol
    || row.testedConfig?.symbol
    || row.appliedConfig?.symbol
    || null,
  );
}

function normalizeCandidateStrategyId(row = {}) {
  return text(
    row.strategy_id
    || row.strategyId
    || row.resolvedStrategyId
    || row.sourceStrategyId
    || row.affected_strategy
    || null,
  );
}

function blockedActivityReason(row = {}, cooldowns = {}, nowMs = Date.now()) {
  const strategyId = normalizeCandidateStrategyId(row);
  const symbol = normalizeCandidateSymbol(row);
  const timestamp = eventTime(row);
  const eventTs = timestamp ? new Date(timestamp).getTime() : NaN;
  if (!strategyId) return 'missing_strategy_id';
  if (!row.runtime_status && !row.paperRuntimeStatus && row.type && /UNKNOWN/i.test(String(row.type))) return 'unknown_runtime_matrix';
  if (Array.isArray(row.riskBlockReasons) && row.riskBlockReasons.length > 0) return 'risk_blocked';
  if (String(row.type || '').toUpperCase().includes('BLOCKED')) return 'blocked';
  if (String(row.type || '').toUpperCase().includes('SKIPPED')) return 'skipped';
  if (String(row.type || '').toUpperCase().includes('OBSERVE_ONLY')) return 'observe_only';
  if (symbol && cooldowns && cooldowns[symbol]) {
    const cooldownAt = new Date(cooldowns[symbol]).getTime();
    if (Number.isFinite(cooldownAt) && Number.isFinite(eventTs) && eventTs <= cooldownAt && cooldownAt > nowMs) {
      return 'cooldown';
    }
  }
  return null;
}

function normalizationSourceName(row = {}) {
  return text(row.source || row.sourceKind || row.sourceLabel || row.mode || row.event || row.type || row.reasonSv || null);
}

function candidateCandidateId(row = {}) {
  return text(
    row.candidateId
    || row.recommendationId
    || row.eventId
    || row.event_id
    || row.tradeId
    || row.trade_id
    || `${normalizeCandidateStrategyId(row) || 'unknown'}:${normalizeCandidateSymbol(row) || 'unknown'}:${eventTime(row) || ''}`,
  );
}

function parseStrategyName(row = {}, fallback = null) {
  return text(row.strategyName || row.strategy_name || row.name || row.strategy_name_sv || fallback);
}

function parseReason(row = {}, fallback = null) {
  return text(
    row.reasonSv
    || row.reason_sv
    || row.reason
    || row.blockedReason
    || row.exitReason
    || row.result
    || fallback,
    fallback,
  );
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function readTail(file, limit) {
  try {
    if (!fs.existsSync(file)) return { rows: [], total: 0, exists: false, degraded: false };
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
    const rows = [];
    let degraded = false;
    for (const line of lines.slice(-Math.max(1, limit))) {
      try { rows.push(JSON.parse(line)); } catch (_) { degraded = true; }
    }
    return { rows, total: lines.length, exists: true, degraded };
  } catch (_) {
    return { rows: [], total: 0, exists: false, degraded: true };
  }
}

function normalizeSource(raw = {}) {
  const explicit = text(raw.source || raw.origin || raw.source_type || raw.sourceType);
  if (explicit) return explicit;
  if (raw.tradingview === true || /^TV_/i.test(String(raw.strategyId || raw.strategy_id || ''))) return 'tradingview';
  const mode = String(raw.mode || '').toLowerCase();
  if (mode.includes('replay')) return 'replay';
  if (mode.includes('batch')) return 'batch';
  if (mode.includes('autopilot')) return 'autopilot';
  return 'scanner';
}

function strategyMeta(raw = {}) {
  const input = text(
    raw.strategy_id
    || raw.strategyId
    || raw.resolvedStrategyId
    || raw.sourceStrategyId
    || raw.strategy
    || raw.setupId
    || raw.setup,
  );
  const normalized = strategyIdNormalizer.explainStrategyId(input);
  const canonicalId = normalized.canonicalStrategyId || null;
  const catalogRow = canonicalId ? strategyCatalog.getStrategyById(canonicalId) : null;
  return {
    inputStrategyKey: input,
    strategy_id: canonicalId,
    strategy_name: catalogRow?.name || text(raw.strategyName || raw.strategy_name || raw.resolvedStrategyName || raw.sourceStrategyName),
    canonicalStatus: normalized.status,
    ambiguous: normalized.ambiguous === true,
    possibleCanonicalIds: normalized.possibleCanonicalIds || [],
    legacyLabel: canonicalId && input && input !== canonicalId ? input : null,
  };
}

function normalizeTrade(row = {}, statusOverride = null) {
  const strategy = strategyMeta(row);
  const closedAt = iso(row.closed_at || row.exitTime);
  const openedAt = iso(row.opened_at || row.entryTime);
  const status = statusOverride || (closedAt ? 'closed' : 'open');
  return {
    tradeId: text(row.tradeId || row.id || row.signalId),
    signalId: text(row.signalId),
    symbol: text(row.symbol),
    marketType: text(row.marketType || row.market || row.market_type),
    marketGroup: text(row.marketGroup || row.market_group),
    direction: text(row.direction || row.side || row.nextMoveBias),
    source: normalizeSource(row),
    strategy_id: strategy.strategy_id,
    strategy_name: strategy.strategy_name,
    inputStrategyKey: strategy.inputStrategyKey,
    canonicalStatus: strategy.canonicalStatus,
    ambiguous: strategy.ambiguous,
    possibleCanonicalIds: strategy.possibleCanonicalIds,
    legacyLabel: strategy.legacyLabel,
    setup: text(row.signalSubtype || row.signal_subtype || row.raw_strategy || row.strategy),
    signalFamily: text(row.signalFamily || row.strategy_family),
    opened_at: openedAt,
    closed_at: closedAt,
    timestamp: status === 'open' ? (openedAt || eventTime(row)) : (closedAt || eventTime(row)),
    result: text(row.result || row.outcome || (status === 'open' ? 'OPEN' : null)),
    pnlPct: num(row.pnlPct ?? row.pnl_pct ?? row.pnl),
    entryPrice: num(row.entryPrice ?? row.entry_price),
    exitPrice: num(row.exitPrice ?? row.exit_price),
    blockedReason: null,
    paperOnly: true,
    status,
    ...SAFETY,
  };
}

function blockedReasonFromRow(row = {}) {
  return text(
    row.blockedReason
    || row.blocked_reason
    || row.reason
    || row.reasonSv
    || row.reason_sv
    || row.decisionCode,
  );
}

function gateStageFromEvent(row = {}) {
  const type = String(row.type || row.event_type || '').toUpperCase();
  const reason = String(blockedReasonFromRow(row) || '').toLowerCase();
  if (type.includes('SAFETY')) return 'safety';
  if (type.includes('RISK')) return 'risk';
  if (type.includes('GATE') && reason.includes('allowlist')) return 'approval_gate';
  if (type.includes('GATE')) return 'market_gate';
  if (type.includes('NEAR_MISS')) return 'market_gate';
  if (type.includes('SKIPPED')) return 'candidate_filter';
  return 'unknown';
}

function normalizeRuntimeEvent(row = {}) {
  const strategy = strategyMeta(row);
  const type = text(row.type || row.event_type || row.event, 'UNKNOWN');
  return {
    eventId: text(row.eventId || row.event_id || row.id),
    type,
    timestamp: eventTime(row),
    symbol: text(row.symbol),
    marketType: text(row.marketType || row.market || row.market_type),
    direction: text(row.direction || row.nextMoveBias),
    source: normalizeSource(row),
    strategy_id: strategy.strategy_id,
    strategy_name: strategy.strategy_name,
    inputStrategyKey: strategy.inputStrategyKey,
    canonicalStatus: strategy.canonicalStatus,
    ambiguous: strategy.ambiguous,
    possibleCanonicalIds: strategy.possibleCanonicalIds,
    legacyLabel: strategy.legacyLabel,
    setup: text(row.signalSubtype || row.signal_subtype || row.setup || row.strategy),
    signalFamily: text(row.signalFamily),
    status: text(row.status || row.decision || null),
    result: text(row.result || row.outcome || null),
    pnlPct: num(row.pnlPct ?? row.pnl_pct ?? row.pnl),
    blockedReason: blockedReasonFromRow(row),
    gateStage: gateStageFromEvent(row),
    paperOnly: true,
    ...SAFETY,
  };
}

function normalizeGateDecision(row = {}) {
  const strategy = strategyMeta(row);
  return {
    eventId: text(row.eventId || row.event_id || row.id || `${row.symbol || 'unknown'}:${row.timestamp || ''}`),
    type: 'GATE_BLOCKED',
    timestamp: eventTime(row),
    symbol: text(row.symbol),
    marketType: text(row.marketType || row.market || row.market_group),
    direction: text(row.direction || row.nextMoveBias),
    source: normalizeSource(row),
    strategy_id: strategy.strategy_id,
    strategy_name: strategy.strategy_name,
    inputStrategyKey: strategy.inputStrategyKey,
    canonicalStatus: strategy.canonicalStatus,
    ambiguous: strategy.ambiguous,
    possibleCanonicalIds: strategy.possibleCanonicalIds,
    legacyLabel: strategy.legacyLabel,
    setup: text(row.signalSubtype || row.signal_subtype),
    signalFamily: text(row.signalFamily),
    status: row.allowed === false ? 'blocked' : 'allowed',
    result: null,
    pnlPct: null,
    blockedReason: blockedReasonFromRow(row),
    gateStage: 'market_gate',
    paperOnly: true,
    ...SAFETY,
  };
}

function uniqueBy(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function recordKey(row = {}) {
  return text(
    row.tradeId
    || row.eventId
    || row.signalId
    || `${row.timestamp || ''}|${row.symbol || ''}|${row.strategy_id || row.inputStrategyKey || ''}|${row.type || row.status || ''}`,
  );
}

function buildStrategies(openTrades, closedTrades, blockedCandidates, recentEvents) {
  const map = new Map();
  const bump = (strategyId, update) => {
    if (!strategyId) return;
    const row = map.get(strategyId) || {
      strategy_id: strategyId,
      strategy_name: null,
      canonicalStatus: 'unknown',
      symbols: new Set(),
      openCount: 0,
      closedCount: 0,
      blockedCount: 0,
      latestEventAt: null,
      latestEventType: null,
      latestBlockedReason: null,
    };
    update(row);
    map.set(strategyId, row);
  };
  for (const trade of openTrades) {
    bump(trade.strategy_id, (row) => {
      row.strategy_name = row.strategy_name || trade.strategy_name || null;
      row.canonicalStatus = trade.canonicalStatus || row.canonicalStatus;
      if (trade.symbol) row.symbols.add(trade.symbol);
      row.openCount += 1;
      row.latestEventAt = !row.latestEventAt || String(trade.timestamp) > row.latestEventAt ? trade.timestamp : row.latestEventAt;
      row.latestEventType = !row.latestEventAt || row.latestEventAt === trade.timestamp ? 'open_trade' : row.latestEventType;
    });
  }
  for (const trade of closedTrades) {
    bump(trade.strategy_id, (row) => {
      row.strategy_name = row.strategy_name || trade.strategy_name || null;
      row.canonicalStatus = trade.canonicalStatus || row.canonicalStatus;
      if (trade.symbol) row.symbols.add(trade.symbol);
      row.closedCount += 1;
      if (!row.latestEventAt || String(trade.timestamp) > row.latestEventAt) {
        row.latestEventAt = trade.timestamp;
        row.latestEventType = 'closed_trade';
      }
    });
  }
  for (const blocked of blockedCandidates) {
    bump(blocked.strategy_id, (row) => {
      row.strategy_name = row.strategy_name || blocked.strategy_name || null;
      row.canonicalStatus = blocked.canonicalStatus || row.canonicalStatus;
      if (blocked.symbol) row.symbols.add(blocked.symbol);
      row.blockedCount += 1;
      if (!row.latestEventAt || String(blocked.timestamp) > row.latestEventAt) {
        row.latestEventAt = blocked.timestamp;
        row.latestEventType = blocked.gateStage || 'blocked_candidate';
        row.latestBlockedReason = blocked.blockedReason || null;
      }
    });
  }
  for (const event of recentEvents) {
    bump(event.strategy_id, (row) => {
      row.strategy_name = row.strategy_name || event.strategy_name || null;
      row.canonicalStatus = event.canonicalStatus || row.canonicalStatus;
      if (event.symbol) row.symbols.add(event.symbol);
      if (!row.latestEventAt || String(event.timestamp) > row.latestEventAt) {
        row.latestEventAt = event.timestamp;
        row.latestEventType = event.type || null;
      }
    });
  }
  return [...map.values()]
    .map((row) => ({
      strategy_id: row.strategy_id,
      strategy_name: row.strategy_name,
      canonicalStatus: row.canonicalStatus,
      symbols: [...row.symbols].sort(),
      openCount: row.openCount,
      closedCount: row.closedCount,
      blockedCount: row.blockedCount,
      latestEventAt: row.latestEventAt,
      latestEventType: row.latestEventType,
      latestBlockedReason: row.latestBlockedReason,
      ...SAFETY,
    }))
    .sort((a, b) => String(b.latestEventAt || '').localeCompare(String(a.latestEventAt || '')));
}

/**
 * Read-only per-strategy risk/reward quality from CLOSED paper trades.
 *
 * Groups normalized closed trades by canonical strategy_id (null → 'unknown')
 * and computes risk/reward metrics via tradeStatsService.computeRiskReward.
 * Purely additive analysis: it never mutates state, places orders or changes
 * allowlist decisions. A broken group can never crash the endpoint — each
 * computation is fault-isolated and falls back to an empty metric object.
 */
function buildStrategyPerformance(closedTrades) {
  const groups = new Map();
  for (const trade of arr(closedTrades)) {
    const key = trade.strategy_id || 'unknown';
    if (!groups.has(key)) {
      groups.set(key, { strategy_id: trade.strategy_id || null, strategy_name: trade.strategy_name || null, rows: [] });
    }
    const group = groups.get(key);
    if (!group.strategy_name && trade.strategy_name) group.strategy_name = trade.strategy_name;
    group.rows.push(trade);
  }

  const strategies = [...groups.entries()].map(([key, group]) => {
    let metrics;
    try { metrics = tradeStats.computeRiskReward(group.rows); } catch (_) { metrics = {}; }
    const safeMetrics = metrics && typeof metrics === 'object' ? metrics : {};
    let statusLabel;
    try { statusLabel = tradeStats.riskRewardStatusLabel(safeMetrics); } catch (_) { statusLabel = 'Neutral – granska manuellt'; }
    return {
      strategy_id: group.strategy_id,
      strategy_key: key,
      strategy_name: group.strategy_name || (key === 'unknown' ? 'Okänd strategi' : key),
      ...safeMetrics,
      statusLabel,
      ...SAFETY,
    };
  });

  // Sort: highest risk first (lossToWinRatio desc, nulls last), then worst net
  // PnL first (netPnlPct asc), then most data first (closedTrades desc).
  strategies.sort((a, b) => {
    const al = (a.lossToWinRatio === null || a.lossToWinRatio === undefined) ? -Infinity : a.lossToWinRatio;
    const bl = (b.lossToWinRatio === null || b.lossToWinRatio === undefined) ? -Infinity : b.lossToWinRatio;
    if (bl !== al) return bl - al;
    const anet = (a.netPnlPct === null || a.netPnlPct === undefined) ? 0 : a.netPnlPct;
    const bnet = (b.netPnlPct === null || b.netPnlPct === undefined) ? 0 : b.netPnlPct;
    if (anet !== bnet) return anet - bnet;
    return (Number(b.closedTrades) || 0) - (Number(a.closedTrades) || 0);
  });

  let overall = {};
  try { overall = tradeStats.computeRiskReward(arr(closedTrades)); } catch (_) { overall = {}; }
  let avgLossVsWinMultiple = null;
  if (overall && overall.avgWinPct && overall.avgLossPct) {
    avgLossVsWinMultiple = Math.round((Math.abs(overall.avgLossPct) / overall.avgWinPct) * 100) / 100;
  }

  return {
    strategies,
    summary: {
      ...overall,
      avgLossVsWinMultiple,
      strategyCount: strategies.length,
      ...SAFETY,
    },
  };
}

function normalizeLearningOutcome(row = {}) {
  const strategy = strategyMeta(row);
  return {
    eventId: text(row.id || row.event_id || row.trade_id || row.timestamp),
    type: text(row.type || 'paper_trade'),
    timestamp: eventTime(row),
    symbol: text(row.symbol || row.traded_symbol || row.underlying_symbol),
    source: text(row.source || 'daytrading-learning'),
    strategy_id: strategy.strategy_id,
    strategy_name: strategy.strategy_name,
    setup: text(row.signal_subtype || row.raw_strategy || row.signal_type || row.strategy),
    confidence: num(row.confidence),
    score: num(row.score ?? row.underlying_signal_strength),
    result: text(row.outcome || row.status || row.result?.outcome || null),
    pnlPct: num(row.pnl_percent ?? row.paper_pnl_percent ?? row.pnl ?? row.result?.pnl_pct),
    blockedReason: null,
    reason: text(row.exit_reason || row.extra?.recommendation || row.result?.outcome || null),
    paperOnly: true,
    ...SAFETY,
  };
}

function resolveSymbolFromDisplayName(displayName) {
  const value = text(displayName, '');
  if (!value) return null;
  const parts = value.split('·').map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

function resolveOptimizationLatestSymbol(latest = {}, strategyId = null) {
  const best = latest?.daytradingStrategies?.bestStrategy || null;
  if (best && (!strategyId || best.strategy_id === strategyId)) {
    const symbols = Array.isArray(best.symbols) ? best.symbols : [];
    if (symbols.length > 0 && symbols[0]?.symbol) return text(symbols[0].symbol);
  }
  const strategies = Array.isArray(latest?.daytradingStrategies?.strategies) ? latest.daytradingStrategies.strategies : [];
  const row = strategies.find((item) => item && (!strategyId || item.strategy_id === strategyId));
  if (row && Array.isArray(row.symbols) && row.symbols[0]?.symbol) return text(row.symbols[0].symbol);
  return null;
}

function normalizeOptimizationCandidate(row = {}, latestOptimization = {}) {
  const strategyId = normalizeCandidateStrategyId(row);
  const displaySymbol = text(row.testedConfig?.symbol || resolveSymbolFromDisplayName(row.displayName));
  const latestSymbol = displaySymbol || resolveOptimizationLatestSymbol(latestOptimization, strategyId);
  return {
    eventId: text(row.candidateId || row.id || row.recommendationId),
    type: 'OPTIMIZATION_CANDIDATE',
    timestamp: iso(row.updatedAt || row.createdAt),
    symbol: latestSymbol,
    source: text(row.sourceLabel || row.sourceKind || row.source || 'optimization'),
    strategy_id: strategyId,
    strategy_name: text(row.strategyName || row.strategy_name),
    setup: text(row.testedConfig?.timeframe || row.sourceKind || row.reason || row.sourceLabel),
    confidence: row.confidence ?? row.recommendation?.confidence ?? null,
    score: num(row.overallScore ?? row.metrics?.score ?? row.summarySnapshot?.metrics?.score),
    winRate: num(row.metrics?.winRate ?? row.metrics?.win_rate ?? row.summarySnapshot?.metrics?.winRate),
    pnlPct: num(row.metrics?.totalPnlPct ?? row.metrics?.avgPnlPct ?? row.summarySnapshot?.metrics?.totalPnlPct ?? row.summarySnapshot?.metrics?.avgPnlPct),
    result: text(row.recommendation?.decision || row.allowlistStatus || null),
    blockedReason: null,
    reason: text(row.recommendation?.reason || row.allowlistReason || row.reason || null),
    paperOnly: true,
    ...SAFETY,
  };
}

function normalizeActivityRecord(row = {}, latestOptimization = {}) {
  if (!row) return null;
  if (row.type === 'OPTIMIZATION_CANDIDATE') return normalizeOptimizationCandidate(row, latestOptimization);
  if (row.source === 'daytrading-learning' || row.paper_only === true || row.live === false) {
    return normalizeLearningOutcome(row);
  }
  if (row.tradeId || row.signalId || row.opened_at || row.closed_at || row.result || row.pnlPct != null) {
    return normalizeTrade(row, row.status || (row.closed_at ? 'closed' : 'open'));
  }
  return normalizeRuntimeEvent(row);
}

function loadDailySelectionSources(files) {
  const tradesRead = readTail(files.trades, 250);
  const eventsRead = readTail(files.events, 250);
  const learningRead = readTail(files.learningOutcomes, 250);
  const candidatesRead = readTail(files.optimizationCandidates, 250);
  const latestOptimization = readJson(files.optimizationLatest, {});
  const state = readJson(files.state, {});

  return {
    openTradeRows: arr(state?.openTrades).map((row) => normalizeTrade(row, 'open')).filter(Boolean),
    tradeRows: tradesRead.rows.map((row) => normalizeTrade(row, 'closed')).filter(Boolean),
    eventRows: eventsRead.rows.map(normalizeRuntimeEvent).filter(Boolean),
    learningRows: learningRead.rows.map(normalizeLearningOutcome).filter(Boolean),
    candidateRows: candidatesRead.rows.map((row) => normalizeOptimizationCandidate(row, latestOptimization)).filter(Boolean),
    latestOptimization,
  };
}

function findLatestEligibleActivity(strategyId, sources, cooldowns, nowMs) {
  const rows = [
    ...arr(sources.openTradeRows),
    ...arr(sources.tradeRows),
    ...arr(sources.eventRows),
    ...arr(sources.learningRows),
    ...arr(sources.candidateRows),
  ].filter((row) => normalizeCandidateStrategyId(row) === strategyId);

  const eligible = rows.filter((row) => !blockedActivityReason(row, cooldowns, nowMs));
  eligible.sort((a, b) => {
    const timeDiff = String(eventTime(b) || '').localeCompare(String(eventTime(a) || ''));
    if (timeDiff !== 0) return timeDiff;
    const sourceDiff = sourceRank(a.source) - sourceRank(b.source);
    if (sourceDiff !== 0) return sourceDiff;
    return String(candidateCandidateId(a)).localeCompare(String(candidateCandidateId(b)));
  });
  return eligible[0] || null;
}

function buildDailySelectionCandidate({ strategyId, plannedRow, matrixRow, allowRow, activity, latestOptimization }) {
  const fallbackSymbol = normalizeCandidateSymbol(activity)
    || resolveOptimizationLatestSymbol(latestOptimization, strategyId)
    || resolveSymbolFromDisplayName(allowRow?.name)
    || null;
  const symbol = safeText(fallbackSymbol, '–');
  const latestActivityAt = eventTime(activity) || plannedRow?.evidence?.lastTested || matrixRow?.lastTested || null;
  const strategyName = text(matrixRow?.name || allowRow?.name || plannedRow?.name || strategyCatalog.getStrategyById(strategyId)?.name || strategyId);
  const source = normalizationSourceName(activity) || plannedRow?.source || 'paper_only';
  const setup = safeText(
    activity?.setup
    || activity?.signal_subtype
    || activity?.raw_strategy
    || activity?.strategy
    || plannedRow?.nextStep
    || matrixRow?.simulationSummary?.badge?.label
    || null,
  );
  const confidence = activity?.confidence ?? plannedRow?.confidence ?? activity?.confidenceScore ?? matrixRow?.simulationSummary?.score ?? null;
  const score = activity?.score ?? plannedRow?.evidence?.simWinRate ?? matrixRow?.simulationSummary?.score ?? null;
  const winRate = activity?.winRate ?? matrixRow?.paperSummary?.winRate ?? matrixRow?.simulationSummary?.winRate ?? null;
  const pnl = activity?.pnlPct ?? matrixRow?.paperSummary?.totalPnl ?? matrixRow?.simulationSummary?.totalPnl ?? null;
  const decision = text(matrixRow?.recommendation || plannedRow?.recommendation || activity?.result || null);
  const reason = text(
    plannedRow?.reason
    || matrixRow?.simulationSummary?.badge?.label
    || activity?.reason
    || activity?.reasonSv
    || plannedRow?.nextStep
    || null,
  );
  const candidateId = candidateCandidateId(activity) || `${strategyId}:${symbol}:${latestActivityAt || ''}`;

  return {
    candidateId,
    symbol,
    canonicalStrategyId: strategyId,
    strategyName,
    setup,
    confidence: confidence == null ? null : confidence,
    source,
    latestActivityAt,
    reason,
    previewOnly: true,
    wouldCreateTrade: false,
    blockedExecution: true,
    safetyLabel: 'Preview only - ingen trade skapas',
    score: score == null ? null : score,
    winRate: winRate == null ? null : winRate,
    pnl: pnl == null ? null : pnl,
    decision: decision || null,
    blockedBy: null,
    activitySource: activity?.source || null,
    activityType: activity?.type || null,
  };
}

function buildDailySelectionPreview(options = {}) {
  const files = { ...DEFAULT_FILES, ...(options.files || {}) };
  const now = options.now ? new Date(options.now) : new Date();
  const seedDate = todayIsoDate(now);
  const limit = Math.max(1, Math.min(3, Math.round(Number(options.selectionCount || 3) || 3)));

  const plan = automationPlanService.getAutomationPlan();
  const allowlistStatus = paperAllowlistService.getPaperAllowlistStatus();
  const matrix = strategyRuntimeMatrixService.getStrategyRuntimeMatrix();
  const matrixRows = Array.isArray(matrix.strategies) ? matrix.strategies : [];
  const matrixById = new Map(matrixRows.map((row) => [row.id || row.strategy_id, row]));
  const allowRows = Array.isArray(allowlistStatus.allowlist) ? allowlistStatus.allowlist : [];
  const allowById = new Map(allowRows.map((row) => [row.id, row]));
  const sources = loadDailySelectionSources(files);
  const cooldowns = readJson(files.state, {})?.cooldowns || {};
  const nowMs = now.getTime();

  const pool = [];
  for (const plannedRow of arr(plan.recommendedPaperCandidates)) {
    const strategyId = plannedRow?.id;
    if (!strategyId) continue;
    const allowRow = allowById.get(strategyId);
    const matrixRow = matrixById.get(strategyId);
    if (!allowRow || allowRow.readyForPaperRuntime !== true) continue;
    if (!matrixRow || matrixRow.paperRuntimeStatus !== 'active' || (Array.isArray(matrixRow.blockers) && matrixRow.blockers.length > 0)) continue;

    let activity = findLatestEligibleActivity(strategyId, sources, cooldowns, nowMs);
    if (!activity) {
      activity = normalizeOptimizationCandidate({
        candidateId: strategyId,
        strategyId,
        strategyName: allowRow?.name || plannedRow?.name || strategyId,
        source: 'plan_fallback',
        updatedAt: plannedRow?.evidence?.lastTested || now.toISOString(),
        reason: plannedRow?.reason,
      }, sources.latestOptimization);
    }

    const candidate = buildDailySelectionCandidate({
      strategyId,
      plannedRow,
      matrixRow,
      allowRow,
      activity,
      latestOptimization: sources.latestOptimization,
    });

    if (!candidate.symbol) candidate.symbol = '–';
    pool.push(candidate);
  }

  pool.sort((a, b) => {
    const ha = stableHash(`${seedDate}:${a.canonicalStrategyId}:${a.symbol}:${a.candidateId || ''}`);
    const hb = stableHash(`${seedDate}:${b.canonicalStrategyId}:${b.symbol}:${b.candidateId || ''}`);
    if (ha !== hb) return ha.localeCompare(hb);
    return String(b.latestActivityAt || '').localeCompare(String(a.latestActivityAt || ''));
  });

  const selected = pool.slice(0, limit);

  return {
    date: seedDate,
    mode: 'preview_only',
    selectionCount: limit,
    selectedCount: selected.length,
    candidates: selected.map((candidate) => ({
      ...candidate,
      safety: { ...SAFETY },
    })),
    explanation: selected.length
      ? 'Preview av framtida 3-per-dag-logik. Urvalet är read-only, stabilt per datum och skapar inga trades.'
      : 'Inga säkra kandidater just nu',
    emptyStateText: selected.length ? null : 'Inga säkra kandidater just nu',
    safety: { ...SAFETY },
  };
}

function buildPaperTradingRuntime(options = {}) {
  const limit = clampLimit(options.limit, 50);
  const files = { ...DEFAULT_FILES, ...(options.files || {}) };
  const warnings = [];

  const state = readJson(files.state, {});
  const openTrades = arr(state?.openTrades).map((row) => normalizeTrade(row, 'open')).filter(Boolean).sort(newestFirst);

  const tradesRead = readTail(files.trades, Math.max(limit * 4, 200));
  if (tradesRead.degraded) warnings.push('trades_file_degraded');
  const closedTrades = tradesRead.rows.map((row) => normalizeTrade(row, 'closed')).filter(Boolean).sort(newestFirst);

  const eventsRead = readTail(files.events, Math.max(limit * 4, 200));
  if (eventsRead.degraded) warnings.push('events_file_degraded');
  const recentEvents = eventsRead.rows.map(normalizeRuntimeEvent).filter(Boolean).sort(newestFirst);

  const gateRead = readTail(files.gateDecisions, Math.max(limit * 4, 200));
  if (gateRead.degraded) warnings.push('gate_decisions_file_degraded');
  const gateBlocked = gateRead.rows
    .filter((row) => row && row.allowed === false)
    .map(normalizeGateDecision)
    .filter(Boolean)
    .sort(newestFirst);

  const blockedFromEvents = recentEvents
    .filter((row) => ['approval_gate', 'market_gate', 'risk', 'safety', 'candidate_filter'].includes(row.gateStage))
    .filter((row) => row.blockedReason || row.status === 'blocked');

  const allBlockedCandidates = uniqueBy(
    [...blockedFromEvents, ...gateBlocked].sort(newestFirst),
    (row) => `${row.timestamp}|${row.symbol}|${row.strategy_id}|${row.blockedReason}|${row.gateStage}`,
  );
  const blockedCandidates = allBlockedCandidates.slice(0, limit);

  const limitedOpenTrades = openTrades.slice(0, limit);
  const limitedClosedTrades = closedTrades.slice(0, limit);
  const limitedRecentEvents = recentEvents.slice(0, limit);
  const strategies = buildStrategies(limitedOpenTrades, limitedClosedTrades, blockedCandidates, limitedRecentEvents).slice(0, limit);
  const mergedRecords = uniqueBy(
    [...limitedOpenTrades, ...limitedClosedTrades, ...blockedCandidates, ...limitedRecentEvents].sort(newestFirst),
    recordKey,
  ).slice(0, limit);

  const dailySelectionPreview = buildDailySelectionPreview({ files, selectionCount: 3 });

  // Per-strategy risk/reward quality, computed over ALL closed trades (not the
  // limited window) so the metrics reflect the full paper history. Fault-isolated.
  let strategyPerformance = { strategies: [], summary: null };
  try {
    const allClosed = readJsonl(files.trades).map((row) => normalizeTrade(row, 'closed')).filter(Boolean);
    strategyPerformance = buildStrategyPerformance(allClosed);
  } catch (_) {
    warnings.push('strategy_performance_failed');
  }

  const latestEventAt = [
    limitedOpenTrades[0]?.timestamp,
    limitedClosedTrades[0]?.timestamp,
    limitedRecentEvents[0]?.timestamp,
    blockedCandidates[0]?.timestamp,
  ].filter(Boolean).sort().pop() || null;

  return {
    ok: true,
    mode: 'paper_only',
    safety: { ...SAFETY },
    status: warnings.length ? 'degraded' : 'ok',
    source: 'paperTradingRuntimeService',
    summary: {
      openCount: openTrades.length,
      closedCount: closedTrades.length,
      eventCount: eventsRead.total,
      blockedCount: allBlockedCandidates.length,
      latestEventAt,
      returnedCount: mergedRecords.length,
      limit,
    },
    openTrades: limitedOpenTrades,
    closedTrades: limitedClosedTrades,
    recentEvents: limitedRecentEvents,
    blockedCandidates,
    strategies,
    strategyPerformance,
    dailySelectionPreview,
    limits: {
      requested: limit,
      returnedClosed: limitedClosedTrades.length,
      returnedEvents: limitedRecentEvents.length,
      returnedBlocked: blockedCandidates.length,
    },
    warnings,
    updatedAt: nowIso(),
    ...SAFETY,
  };
}

function buildSupervisorPaperRuntimeSummary(options = {}) {
  const full = buildPaperTradingRuntime(options);
  return {
    status: full.status,
    summary: full.summary,
    latestClosedTrades: full.closedTrades.slice(0, 5),
    latestOpenTrades: full.openTrades.slice(0, 5),
    latestBlockedCandidates: full.blockedCandidates.slice(0, 5),
    strategies: full.strategies.slice(0, 10),
    warnings: full.warnings,
    updatedAt: full.updatedAt,
    source: 'paperTradingRuntimeService',
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  buildPaperTradingRuntime,
  buildSupervisorPaperRuntimeSummary,
  _internal: {
    clampLimit,
    normalizeTrade,
    normalizeRuntimeEvent,
    normalizeGateDecision,
    strategyMeta,
    buildStrategies,
    buildDailySelectionPreview,
    normalizeLearningOutcome,
    normalizeOptimizationCandidate,
    findLatestEligibleActivity,
  },
};
