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
const path = require('path');

const strategyCatalog = require('./daytradingStrategyCatalogService');
const strategyIdNormalizer = require('./strategyIdNormalizerService');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_FILES = Object.freeze({
  trades: path.join(ROOT, 'data/paper-trading/trades.jsonl'),
  events: path.join(ROOT, 'data/paper-trading/events.jsonl'),
  gateDecisions: path.join(ROOT, 'data/paper-trading/gate-decisions.jsonl'),
  state: path.join(ROOT, 'data/paper-trading/state.json'),
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
  },
};
