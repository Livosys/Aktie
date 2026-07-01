'use strict';

/**
 * Read-only IB Paper scanner control-room view.
 *
 * This service only normalizes already-existing scanner/runtime/history payloads
 * for display. It never submits, arms, cancels, retries, queues, or mutates any
 * paper/live trading state.
 */

const fs = require('fs');
const path = require('path');

const paperTradingRuntimeService = require('./paperTradingRuntimeService');
const auditTrailService = require('./auditTrailService');

const ROOT = path.resolve(__dirname, '../..');
const SIGNAL_MEMORY_FILE = path.join(ROOT, 'data/signal-memory/signal_memory.json');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const ETF_SYMBOLS = new Set(['QQQ', 'SPY', 'DIA', 'IWM', 'TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'TNA', 'TZA']);

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

function latestTime(row = {}) {
  return iso(row.timestamp || row.latestActivityAt || row.created_at || row.createdAt || row.resolved_at || row.opened_at || row.closed_at || row.entryTime || row.exitTime);
}

function classifyAsset(row = {}) {
  const symbol = text(row.symbol, '').toUpperCase();
  const rawGroup = text(row.assetGroup || row.assetType || row.marketGroup || row.market_group || row.marketType || row.market, '').toLowerCase();
  if (rawGroup.includes('crypto') || /(?:USDT|USDC|PERP)$/.test(symbol)) return 'crypto';
  if (rawGroup.includes('etf') || ETF_SYMBOLS.has(symbol)) return 'qqqEtf';
  return 'stocks';
}

function assetLabel(assetType) {
  if (assetType === 'crypto') return 'crypto';
  if (assetType === 'qqqEtf') return 'QQQ/ETF';
  return 'stock';
}

function normalizeDirection(row = {}) {
  const value = text(row.side || row.resolvedDirection || row.normalizedDirection || row.direction || row.nextMoveBias || row.signalDirection || row.action);
  if (!value) return null;
  const upper = value.toUpperCase();
  if (['BUY', 'LONG', 'UP'].includes(upper)) return 'BUY';
  if (['SELL', 'SHORT', 'DOWN'].includes(upper)) return 'SELL';
  return value;
}

function normalizeBlockers(value) {
  return [...new Set(arr(value).map((item) => text(item)).filter(Boolean))];
}

function baseRecord(kind, row = {}, sourceFallback = null) {
  const assetType = classifyAsset(row);
  return {
    kind,
    symbol: text(row.symbol),
    assetType,
    assetLabel: assetLabel(assetType),
    strategyId: text(row.strategyId || row.strategy_id || row.canonicalStrategyId || row.sourceStrategyId || row.resolvedStrategyId),
    source: text(row.source || row.rawSource || row.activitySource || sourceFallback),
    direction: normalizeDirection(row),
    confidence: row.confidence ?? row.directionConfidence ?? null,
    score: num(row.score ?? row.gateScore),
    marketGroup: text(row.marketGroup || row.market_group || row.marketType || row.market || row.assetGroup),
    setupReady: row.setupBuilder?.setupReady === true || row.setupReady === true,
    bracketReady: row.bracketReady === true || row.setupBuilder?.bracketReady === true,
    blockers: normalizeBlockers(row.blockers || row.setupBuilder?.blockers || row.bracketBlockers),
    timestamp: latestTime(row),
    entryPrice: num(row.entryPrice ?? row.entryReferencePrice ?? row.setupBuilder?.entryPrice),
    stopLossPrice: num(row.stopLossPrice ?? row.stopLoss ?? row.setupBuilder?.stopLossPrice),
    takeProfitPrice: num(row.takeProfitPrice ?? row.takeProfit ?? row.takeProfit1 ?? row.setupBuilder?.takeProfitPrice),
    quantity: num(row.wouldForceQuantity ?? row.quantity ?? row.setupBuilder?.quantity),
    status: text(row.status || row.result || row.decision || row.readiness),
    reason: text(row.reasonSv || row.reason || row.blockedReason || row.message),
  };
}

function normalizePlanCandidate(row = {}) {
  return {
    ...baseRecord(row.setupBuilder?.setupReady === true ? 'setup' : 'candidate', row, 'ib_multi_strategy_plan'),
    allowed: row.allowed === true,
    openOrderConflict: row.openOrderConflict === true,
    positionConflict: row.positionConflict === true,
    duplicateConflict: row.duplicateConflict === true,
    perStrategyCapReached: row.perStrategyCapReached === true,
    globalCapReached: row.globalCapReached === true,
    rawBlockers: normalizeBlockers(row.rawBlueprintBlockers),
  };
}

function normalizeRuntimeCandidate(row = {}) {
  const blockers = [];
  if (!(num(row.entryPrice ?? row.entryReferencePrice) > 0)) blockers.push('missing_entry_price');
  if (!(num(row.stopLossPrice ?? row.stopLoss) > 0)) blockers.push('missing_stop_loss');
  if (!(num(row.takeProfitPrice ?? row.takeProfit ?? row.takeProfit1) > 0)) blockers.push('missing_take_profit');
  if (blockers.length > 0) blockers.push('bracket_required_missing');
  return {
    ...baseRecord('candidate', { ...row, blockers: [...arr(row.blockers), ...blockers] }, 'paper_runtime_daily_selection_preview'),
    allowed: false,
    previewOnly: true,
    wouldCreateTrade: row.wouldCreateTrade === true,
  };
}

function normalizeAuditSignal(row = {}) {
  const details = row.details && typeof row.details === 'object' ? row.details : {};
  return {
    ...baseRecord('signal', {
      ...row,
      symbol: row.symbol,
      strategy_id: row.strategy_id,
      source: row.source || 'audit',
      direction: details.direction || details.nextMoveBias || details.signal,
      score: details.score,
      marketGroup: details.group,
    }, 'audit_candidates'),
    signal: text(details.signal || row.type),
    message: text(row.message),
  };
}

function normalizeSignalMemory(row = {}) {
  const features = row.features_json && typeof row.features_json === 'object' ? row.features_json : {};
  return {
    ...baseRecord('signal', {
      ...row,
      source: row.source || 'signal_memory',
      direction: row.direction || features.direction,
      marketGroup: features.market || features.group,
      timestamp: row.created_at || row.resolved_at,
    }, 'signal_memory'),
    outcomeType: text(row.outcome_type),
    moveAfter5mPct: num(row.move_after_5m_pct),
  };
}

function normalizePaperTrade(row = {}, status = null) {
  return {
    ...baseRecord('paper_trade', row, 'paper_trading_runtime'),
    paperTradeStatus: status || row.status || null,
    pnlPct: num(row.pnlPct ?? row.pnl_pct ?? row.pnl),
    result: text(row.result || row.outcome),
    isIbPaperOrder: false,
  };
}

function readSignalMemory(file = SIGNAL_MEMORY_FILE) {
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function newestFirst(a, b) {
  return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
}

function groupLatest(records, limit) {
  const grouped = { crypto: [], stocks: [], qqqEtf: [] };
  for (const record of records.filter((row) => row && row.symbol)) {
    const key = grouped[record.assetType] ? record.assetType : 'stocks';
    grouped[key].push(record);
  }
  for (const key of Object.keys(grouped)) {
    grouped[key] = grouped[key].sort(newestFirst).slice(0, limit);
  }
  return grouped;
}

function countsByAsset(records) {
  const out = { crypto: 0, stocks: 0, qqqEtf: 0 };
  for (const row of records) {
    if (out[row.assetType] != null) out[row.assetType] += 1;
  }
  return out;
}

function buildScannerControlRoom(options = {}) {
  const limit = Math.max(1, Math.min(50, Math.round(Number(options.limit) || 50)));
  const runtime = options.runtime || paperTradingRuntimeService.buildPaperTradingRuntime({ limit: 100 });
  const multiStrategyPlan = options.multiStrategyPlan || null;
  const auditCandidates = options.auditCandidates || auditTrailService.getCandidateAuditEvents({ limit: 100 });
  const signalMemoryRows = options.signalMemoryRows || readSignalMemory(options.signalMemoryFile).slice(-250);

  const liveScannerCandidates = [
    ...arr(runtime?.dailySelectionPreview?.candidates).map(normalizeRuntimeCandidate),
    ...arr(multiStrategyPlan?.candidates).map(normalizePlanCandidate),
  ].sort(newestFirst);

  const paperTrades = [
    ...arr(runtime?.openTrades).map((row) => normalizePaperTrade(row, 'open')),
    ...arr(runtime?.closedTrades).map((row) => normalizePaperTrade(row, 'closed')),
  ].sort(newestFirst);

  const signals = [
    ...arr(auditCandidates?.events).map(normalizeAuditSignal),
    ...arr(signalMemoryRows).map(normalizeSignalMemory),
  ].sort(newestFirst);

  const historyRecords = [...paperTrades, ...liveScannerCandidates, ...signals].sort(newestFirst);
  const ibPaperOrders = [];

  return {
    ok: true,
    readOnly: true,
    mode: 'ib_paper_scanner_control_room',
    generatedAt: new Date().toISOString(),
    source: 'interactiveBrokersScannerControlRoomService',
    summary: {
      liveScannerCandidateCount: liveScannerCandidates.length,
      setupReadyCount: liveScannerCandidates.filter((row) => row.setupReady === true).length,
      bracketReadyCount: liveScannerCandidates.filter((row) => row.bracketReady === true).length,
      allowedCandidateCount: liveScannerCandidates.filter((row) => row.allowed === true).length,
      signalCount: signals.length,
      paperTradeCount: paperTrades.length,
      closedPaperTradeCount: paperTrades.filter((row) => row.paperTradeStatus === 'closed').length,
      ibPaperOrderCount: ibPaperOrders.length,
      historyKind: paperTrades.length > 0 ? 'internal_paper_trades_plus_signals' : 'signal_history_only',
      note: paperTrades.length > 0
        ? 'Historiken innehåller interna paper trades och scanner-signaler. Inga IB Paper-orders hittades.'
        : 'Historiken innehåller signaler/kandidater, inte utförda trades.',
    },
    liveScanner: {
      candidates: liveScannerCandidates.slice(0, limit),
      countsByAsset: countsByAsset(liveScannerCandidates),
    },
    latest50: groupLatest(historyRecords, limit),
    paperTrades: {
      latest: paperTrades.slice(0, limit),
      byAsset: groupLatest(paperTrades, limit),
    },
    signals: {
      latest: signals.slice(0, limit),
      byAsset: groupLatest(signals, limit),
    },
    ibPaperOrders: {
      latest: ibPaperOrders,
      byAsset: { crypto: [], stocks: [], qqqEtf: [] },
    },
    safety: { ...SAFETY },
  };
}

module.exports = {
  SAFETY,
  buildScannerControlRoom,
  _internal: {
    classifyAsset,
    normalizePlanCandidate,
    normalizeRuntimeCandidate,
    normalizeAuditSignal,
    normalizeSignalMemory,
    normalizePaperTrade,
    groupLatest,
  },
};
