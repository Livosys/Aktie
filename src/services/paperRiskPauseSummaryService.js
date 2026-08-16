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

const tradeStats = require('./tradeStatsService');
const consecutiveLossWindow = require('./consecutiveLossWindowService');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_FILES = Object.freeze({
  trades: path.join(ROOT, 'data/paper-trading/trades.jsonl'),
  events: path.join(ROOT, 'data/paper-trading/events.jsonl'),
  riskReviewState: path.join(ROOT, 'data/paper-trading/risk-review-state.json'),
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

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
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

function buildConsecutiveLossState(closedTrades, riskConfig = null) {
  // Delegated to the shared helper so the summary and the live entry-path count
  // consecutive losses identically. Uses this service's own result/time
  // accessors so mode 'off' is byte-for-byte the historical behavior.
  return consecutiveLossWindow.computeConsecutiveLosses(arr(closedTrades), {
    mode: riskConfig ? riskConfig.consecutive_loss_reset : 'off',
    windowHours: riskConfig ? riskConfig.consecutive_loss_window_hours : undefined,
    getResult: (trade) => normalizeResult(trade),
    getTime: (trade) => eventTime(trade),
  });
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

function normalizeRiskReviewState(raw = {}, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now || '').getTime();
  const expiresAt = text(raw.expiresAt || raw.expires_at || null);
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  const active = Boolean(
    raw.paperOnly === true
    && raw.resumedAt
    && Number.isFinite(expiresMs)
    && expiresMs > nowMs,
  );
  const latestAuditEvent = raw.latestAuditEvent && typeof raw.latestAuditEvent === 'object'
    ? raw.latestAuditEvent
    : null;

  return {
    paperOnly: raw.paperOnly === true,
    resumedAt: text(raw.resumedAt || raw.resumed_at || null),
    resumedBy: text(raw.resumedBy || raw.resumed_by || null),
    reason: text(raw.reason || null),
    previousConsecutiveLosses: Number.isFinite(Number(raw.previousConsecutiveLosses))
      ? Number(raw.previousConsecutiveLosses)
      : null,
    previousPauseReason: text(raw.previousPauseReason || null),
    expiresAt,
    maxAgeMinutes: Number.isFinite(Number(raw.maxAgeMinutes)) ? Number(raw.maxAgeMinutes) : null,
    active,
    expired: raw.resumedAt ? !active : false,
    latestAuditEvent,
  };
}

function loadRiskReviewState(files = DEFAULT_FILES, now = new Date()) {
  const raw = readJson(files.riskReviewState, null);
  if (!raw || typeof raw !== 'object') {
    return {
      paperOnly: true,
      active: false,
      expired: false,
      latestAuditEvent: null,
      resumedAt: null,
      resumedBy: null,
      reason: null,
      previousConsecutiveLosses: null,
      previousPauseReason: null,
      expiresAt: null,
      maxAgeMinutes: null,
    };
  }
  return normalizeRiskReviewState(raw, now);
}

async function loadRiskConfigFallback() {
  try {
    const riskEngineService = require('./riskEngineService');
    if (riskEngineService && typeof riskEngineService.getRiskConfig === 'function') {
      return await riskEngineService.getRiskConfig();
    }
  } catch (_) {
    // Optional runtime dependency; status remains read-only with defaults.
  }
  return {};
}

async function buildPaperRiskPauseSummary(options = {}) {
  const files = { ...DEFAULT_FILES, ...(options.files || {}) };
  const riskConfig = options.riskConfig || await loadRiskConfigFallback();
  const useLegacyFiles = Boolean(options.files);
  const trades = Array.isArray(options.trades)
    ? options.trades
    : (useLegacyFiles ? readJsonl(files.trades) : tradeStats.loadPaperTrades());
  const tradeSource = useLegacyFiles ? files.trades : 'ibkr_paper_intent';
  const events = readJsonl(files.events);
  const closedTrades = trades.filter((row) => normalizeResult(row) !== 'OPEN');
  const riskState = buildConsecutiveLossState(closedTrades, riskConfig);
  const pauseReasons = [];
  const consecutiveLossPauseEnabled = false;
  const pauseTrading = pauseReasons.length > 0;
  const latestRiskPauseEvent = buildLatestRiskPauseEvent(events);
  const riskReview = loadRiskReviewState(files, options.now || new Date());
  const effectivePauseTrading = pauseTrading && !riskReview.active;

  return {
    ok: true,
    source: 'paperRiskPauseSummaryService',
    tradeSource,
    generatedAt: nowIso(),
    summary: {
      active: pauseTrading,
      pause_trading: pauseTrading,
      effective_pause_trading: effectivePauseTrading,
      pause_reasons: pauseReasons,
      pause_reason: pauseReasons[0] || null,
      pause_after_consecutive_losses: consecutiveLossPauseEnabled,
      consecutive_loss_pause_removed_for_ordinary_paper: true,
      consecutive_losses: riskState.consecutive_losses,
      max_consecutive_losses: Number(riskConfig.max_consecutive_losses) || 4,
      last_loss_at: riskState.last_loss_at,
      latest_risk_pause_event: latestRiskPauseEvent,
      risk_review: riskReview,
      resume_override_active: riskReview.active === true,
    },
    safety: { ...SAFETY },
    ...SAFETY,
  };
}

function createPaperRiskPauseSummaryService(overrides = {}) {
  const files = { ...DEFAULT_FILES, ...(overrides.files || {}) };
  const riskConfigProvider = overrides.riskConfigProvider || loadRiskConfigFallback;
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
    readJson,
    normalizeResult,
    eventTime,
    normalizeRiskEvent,
    isRiskPauseEvent,
    buildConsecutiveLossState,
    buildLatestRiskPauseEvent,
    loadRiskReviewState,
    normalizeRiskReviewState,
  },
};
