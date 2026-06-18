'use strict';

/**
 * Paper-only manual risk review / resume control.
 *
 * This service never changes live safety, broker state, execution state or
 * historical trades. It only creates a paper-only override record that lets
 * the paper agent continue after a manual review window.
 */

const fs = require('fs');
const path = require('path');

const riskEngineService = require('./riskEngineService');
const paperRiskPauseSummaryService = require('./paperRiskPauseSummaryService');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_FILES = Object.freeze({
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

const DEFAULT_MAX_AGE_MINUTES = 60;
const BLOCKED_TRUE_FLAGS = new Set([
  'live_trading_enabled',
  'can_place_orders',
  'actions_allowed',
  'broker_enabled',
]);

function nowIso() {
  return new Date().toISOString();
}

function text(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
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

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function validateResumeRequest(body = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const rejected = {};
  for (const [key, value] of Object.entries(input)) {
    if (BLOCKED_TRUE_FLAGS.has(key) && value === true) rejected[key] = 'paper_only';
  }
  if (input.confirmPaperOnly !== true) rejected.confirmPaperOnly = 'required';
  const reason = text(input.reason, '');
  if (!reason) rejected.reason = 'required';
  if (reason.length > 500) rejected.reason = 'too_long';
  return { rejected, reason };
}

function normalizeState(raw = {}, now = new Date()) {
  const state = raw && typeof raw === 'object' ? raw : {};
  const resumedAt = text(state.resumedAt || state.resumed_at || null);
  const expiresAt = text(state.expiresAt || state.expires_at || null);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now || '').getTime();
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  const active = Boolean(
    state.paperOnly === true
    && resumedAt
    && Number.isFinite(expiresMs)
    && expiresMs > nowMs,
  );
  return {
    paperOnly: state.paperOnly === true,
    resumedAt,
    resumedBy: text(state.resumedBy || state.resumed_by || null),
    reason: text(state.reason || null),
    previousConsecutiveLosses: numberOrNull(state.previousConsecutiveLosses),
    previousPauseReason: text(state.previousPauseReason || null),
    maxAgeMinutes: numberOrNull(state.maxAgeMinutes),
    expiresAt,
    active,
    expired: Boolean(resumedAt && !active),
    latestAuditEvent: state.latestAuditEvent && typeof state.latestAuditEvent === 'object' ? state.latestAuditEvent : null,
    updatedAt: text(state.updatedAt || state.updated_at || null),
  };
}

function loadState(files = DEFAULT_FILES, now = new Date()) {
  const stateFile = files.riskReviewState || files.state;
  const raw = readJson(stateFile, null);
  if (!raw || typeof raw !== 'object') {
    return normalizeState({ paperOnly: true }, now);
  }
  return normalizeState(raw, now);
}

function isPaperReviewActive(files = DEFAULT_FILES, now = new Date()) {
  return loadState(files, now).active === true;
}

function buildAuditEvent({ state, previousSummary, now = new Date() }) {
  const timestamp = now instanceof Date ? now.toISOString() : nowIso();
  return {
    eventId: `paper_review_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    timestamp,
    type: 'PAPER_RISK_REVIEW_RESUMED',
    symbol: null,
    strategyId: null,
    strategyName: null,
    reasonSv: state.reason,
    decision: 'manual_override',
    status: 'resumed',
    mode: 'paper',
    paperOnly: true,
    review: {
      resumedAt: state.resumedAt,
      resumedBy: state.resumedBy,
      expiresAt: state.expiresAt,
      maxAgeMinutes: state.maxAgeMinutes,
      previousConsecutiveLosses: state.previousConsecutiveLosses,
      previousPauseReason: state.previousPauseReason,
      previousPauseActive: previousSummary?.summary?.pause_trading === true,
    },
    safety: { ...SAFETY },
  };
}

async function resumePaperTesting(input = {}, options = {}) {
  const files = { ...DEFAULT_FILES, ...(options.files || {}) };
  const stateFile = files.riskReviewState || files.state;
  const { rejected, reason } = validateResumeRequest(input);
  if (Object.keys(rejected).length) {
    return {
      ok: false,
      error: 'invalid_request',
      rejected,
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  if (BLOCKED_TRUE_FLAGS.size) {
    for (const field of BLOCKED_TRUE_FLAGS) {
      if (input[field] === true) {
        return {
          ok: false,
          error: 'paper_only_flags_rejected',
          rejected: { [field]: 'paper_only' },
          safety: { ...SAFETY },
          ...SAFETY,
        };
      }
    }
  }

  const currentRiskConfig = options.riskConfig || await riskEngineService.getRiskConfig();
  const currentSummary = options.currentSummary || await paperRiskPauseSummaryService.buildPaperRiskPauseSummary({
    files,
    riskConfig: currentRiskConfig,
    now: options.now || new Date(),
  });

  if (currentSummary?.summary?.pause_trading !== true) {
    return {
      ok: false,
      error: 'risk_pause_not_active',
      summary: currentSummary,
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  if (currentSummary?.summary?.pause_reason !== 'consecutive_losses_limit') {
    return {
      ok: false,
      error: 'unsupported_pause_reason',
      summary: currentSummary,
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES;
  const resumedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + maxAgeMinutes * 60_000).toISOString();
  const state = normalizeState({
    paperOnly: true,
    resumedAt,
    resumedBy: 'manual',
    reason,
    previousConsecutiveLosses: currentSummary?.summary?.consecutive_losses ?? null,
    previousPauseReason: currentSummary?.summary?.pause_reason || null,
    maxAgeMinutes,
    expiresAt,
    updatedAt: resumedAt,
  }, now);

  const auditEvent = buildAuditEvent({ state, previousSummary: currentSummary, now });
  state.latestAuditEvent = auditEvent;
  writeJsonAtomic(stateFile, state);
  appendJsonl(files.events, auditEvent);

  const updatedSummary = await paperRiskPauseSummaryService.buildPaperRiskPauseSummary({
    files,
    riskConfig: currentRiskConfig,
    now,
  });

  return {
    ok: true,
    message: 'Paper testing återupptagen efter manuell risk review.',
    state,
    auditEvent,
    summary: updatedSummary,
    safety: { ...SAFETY },
    ...SAFETY,
  };
}

function createPaperRiskReviewService(overrides = {}) {
  const files = { ...DEFAULT_FILES, ...(overrides.files || {}) };
  return {
    SAFETY,
    DEFAULT_MAX_AGE_MINUTES,
    getPaperRiskReviewState(options = {}) {
      return loadState(files, options.now || new Date());
    },
    isPaperReviewActive(options = {}) {
      return isPaperReviewActive(files, options.now || new Date());
    },
    resumePaperTesting(input = {}, options = {}) {
      return resumePaperTesting(input, { ...options, files });
    },
  };
}

const defaultPaperRiskReviewService = createPaperRiskReviewService();

module.exports = {
  SAFETY,
  DEFAULT_FILES,
  DEFAULT_MAX_AGE_MINUTES,
  validateResumeRequest,
  normalizeState,
  loadState,
  isPaperReviewActive,
  resumePaperTesting,
  createPaperRiskReviewService,
  defaultPaperRiskReviewService,
};
