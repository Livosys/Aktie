'use strict';

/**
 * Read-only paper risk pause summary.
 *
 * This service only reads existing paper-trading files and the current risk
 * config. It never mutates risk state, never resets pause, never places orders
 * and never touches broker/live execution.
 */

const fs = require('fs');
const path = require('path');

const riskEngineService = require('./riskEngineService');
const tradeStats = require('./tradeStatsService');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_FILES = Object.freeze({
  trades: path.join(ROOT, 'data/paper-trading/trades.jsonl'),
  events: path.join(ROOT, 'data/paper-trading/events.jsonl'),
});

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function nowIso() {
  return new Date().toISOString();
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const out = String(value).trim();
  return out || fallback;
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

function normalizeResult(row = {}) {
  const cls = typeof tradeStats.classifyResult === 'function'
    ? tradeStats.classifyResult(row, { deriveFromPnl: true })
    : null;
  if (cls === 'win') return 'WIN';
  if (cls === 'loss') return 'LOSS';
  if (cls === 'timeout') return 'TIMEOUT';
  if (cls === 'breakeven') return 'BREAKEVEN';
  return text(row.result || row.outcome || '').toUpperCase() || 'UNKNOWN';
}

function eventTime(row = {}) {
  const raw = row.timestamp || row.closed_at || row.exitTime || row.updated_at || row.entryTime || row.opened_at || row.created_at || null;
  const ms = new Date(raw || '').getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeRiskEvent(row = {}) {
  return {
    eventId: text(row.eventId || row.event_id || row.id || null),
    type: text(row.type || row.event_type || row.event || null),
    timestamp: eventTime(row),
    symbol: text(row.symbol || row.traded_symbol || row.underlying_symbol || null),
    strategy_id: text(row.strategy_id || row.strategyId || row.resolvedStrategyId || row.sourceStrategyId || null),
    strategy_name: text(row.strategy_name || row.strategyName || null),
    reason: text(row.reasonSv || row.reason_sv || row.reason || row.blockedReason || row.result || null),
  };
}

function isRiskPauseEvent(row = {}) {
  const type = String(row.type || row.event_type || row.event || '').toUpperCase();
  const reason = String(row.reasonSv || row.reason_sv || row.reason || row.blockedReason || '').toLowerCase();
  return type === 'RISK_PAUSE_TRIGGERED' || /consecutive_losses_limit|systempaus/.test(reason);
}

function buildConsecutiveLossState(closedTrades) {
  const sorted = arr(closedTrades)
    .slice()
    .sort((a, b) => String(eventTime(a) || '').localeCompare(String(eventTime(b) || '')));

  let consecutiveLosses = 0;
  let lastLossAt = null;
  for (const trade of sorted.slice().reverse()) {
    const result = normalizeResult(trade);
    if (result === 'LOSS') {
      consecutiveLosses += 1;
      if (!lastLossAt) lastLossAt = eventTime(trade);
      continue;
    }
    if (result === 'WIN') break;
  }

  return { consecutive_losses: consecutiveLosses, last_loss_at: lastLossAt };
}

function buildLatestRiskPauseEvent(events) {
  const latest = arr(events)
    .map(normalizeRiskEvent)
    .filter((row) => row.timestamp && isRiskPauseEvent(row))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0] || null;

  if (!latest) return null;
  return {
    ...latest,
    label: latest.strategy_name || latest.strategy_id || latest.symbol || '–',
  };
}

async function buildPaperRiskPauseSummary(options = {}) {
  const files = { ...DEFAULT_FILES, ...(options.files || {}) };
  const riskConfig = options.riskConfig || await riskEngineService.getRiskConfig();
  const trades = readJsonl(files.trades);
  const events = readJsonl(files.events);
  const closedTrades = trades.filter((row) => normalizeResult(row) !== 'OPEN');
  const riskState = buildConsecutiveLossState(closedTrades);
  const pauseReasons = [];
  if (riskConfig.pause_after_consecutive_losses && riskState.consecutive_losses >= riskConfig.max_consecutive_losses) {
    pauseReasons.push('consecutive_losses_limit');
  }
  const pauseTrading = pauseReasons.length > 0;
  const latestRiskPauseEvent = buildLatestRiskPauseEvent(events);

  return {
    ok: true,
    source: 'paperRiskPauseSummaryService',
    generatedAt: nowIso(),
    summary: {
      active: pauseTrading,
      pause_trading: pauseTrading,
      pause_reasons: pauseReasons,
      pause_reason: pauseReasons[0] || null,
      pause_after_consecutive_losses: riskConfig.pause_after_consecutive_losses === true,
      consecutive_losses: riskState.consecutive_losses,
      max_consecutive_losses: Number(riskConfig.max_consecutive_losses) || 4,
      last_loss_at: riskState.last_loss_at,
      latest_risk_pause_event: latestRiskPauseEvent,
    },
    safety: { ...SAFETY },
    ...SAFETY,
  };
}

function createPaperRiskPauseSummaryService(overrides = {}) {
  const files = { ...DEFAULT_FILES, ...(overrides.files || {}) };
  const riskConfigProvider = overrides.riskConfigProvider || (() => riskEngineService.getRiskConfig());
  return {
    SAFETY,
    async getRiskPauseSummary(options = {}) {
      const riskConfig = options.riskConfig || await riskConfigProvider();
      return buildPaperRiskPauseSummary({ files, riskConfig });
    },
  };
}

const defaultPaperRiskPauseSummaryService = createPaperRiskPauseSummaryService();

module.exports = {
  SAFETY,
  DEFAULT_FILES,
  buildPaperRiskPauseSummary,
  createPaperRiskPauseSummaryService,
  defaultPaperRiskPauseSummaryService,
  _internal: {
    readJsonl,
    normalizeResult,
    eventTime,
    normalizeRiskEvent,
    isRiskPauseEvent,
    buildConsecutiveLossState,
    buildLatestRiskPauseEvent,
  },
};
