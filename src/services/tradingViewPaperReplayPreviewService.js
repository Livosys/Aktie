'use strict';

const crypto = require('crypto');

const strategyRegistry = require('./strategyRegistryService');
const paperAllowlistService = require('./paperAllowlistService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const DEFAULT_MAX_SIGNAL_AGE_MINUTES = 30;
const ALLOWED_SIGNALS = new Set(['long', 'short', 'exit', 'flat', 'watch']);
const VALID_SYMBOL_RE = /^[A-Z0-9._/-]{1,32}$/i;
const DEFAULT_MESSAGE = 'TradingView kan bara förhandsgranskas i säkert testläge. Inga riktiga order kan läggas.';

function safeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeBoolean(value) {
  return value === true;
}

function safeClone(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return null;
    if (Object.prototype.hasOwnProperty.call(cloned, 'secret')) delete cloned.secret;
    return cloned;
  } catch (_) {
    return null;
  }
}

function isIsoTimestamp(value) {
  if (!value) return false;
  return Number.isFinite(new Date(value).getTime());
}

function secretConfigured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseFlag(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function resolveFeatureFlags(env = process.env) {
  return {
    previewEnabled: parseFlag(env.TRADINGVIEW_PAPER_PREVIEW_ENABLED, false),
    forwardingEnabled: parseFlag(env.TRADINGVIEW_PAPER_FORWARDING_ENABLED, false),
    replayQueueEnabled: parseFlag(env.TRADINGVIEW_REPLAY_QUEUE_ENABLED, false),
  };
}

function normalizedTimestamp(value) {
  if (!isIsoTimestamp(value)) return null;
  return new Date(value).toISOString();
}

function normalizeCandidate(input = {}) {
  const errors = [];
  const source = safeString(input.source).toLowerCase() || 'tradingview';
  const strategyId = safeString(input.strategyId || input.strategy_id || input.strategy || input.strategyName || input.strategy_name);
  const symbol = safeString(input.symbol).toUpperCase();
  const timeframe = safeString(input.timeframe);
  const signal = safeString(input.signal || input.side || input.direction).toLowerCase();
  const timestamp = normalizedTimestamp(input.timestamp);
  const price = safeNumber(input.price);
  const marketRegime = safeString(input.market_regime || input.marketRegime || input.regime) || null;
  const metadata = safeClone(input.metadata);

  if (source !== 'tradingview') errors.push('source_must_be_tradingview');
  if (!strategyId) errors.push('strategy_required');
  if (!symbol) errors.push('symbol_required');
  else if (!VALID_SYMBOL_RE.test(symbol)) errors.push('invalid_symbol');
  if (!timeframe) errors.push('timeframe_required');
  if (!signal || !ALLOWED_SIGNALS.has(signal)) errors.push('invalid_signal');

  const candidate = {
    source: 'tradingview',
    strategyId,
    strategy_id: strategyId,
    symbol,
    timeframe,
    signal,
    side: signal,
    timestamp,
    price,
    marketRegime,
    metadata,
  };

  return { candidate, errors };
}

function dedupSeed(candidate = {}) {
  return [
    candidate.source || 'tradingview',
    candidate.strategyId || candidate.strategy_id || '',
    candidate.symbol || '',
    candidate.timeframe || '',
    candidate.signal || '',
    candidate.side || '',
    candidate.timestamp || '',
    candidate.price != null ? String(candidate.price) : '',
    candidate.marketRegime || '',
  ].join('|');
}

function stableDedupKey(candidate) {
  return crypto.createHash('sha256').update(dedupSeed(candidate)).digest('hex').slice(0, 24);
}

function ageIsTooOld(timestampIso, maxAgeMinutes, referenceTimeMs = Date.now()) {
  if (!timestampIso) return false;
  const ts = new Date(timestampIso).getTime();
  if (!Number.isFinite(ts)) return false;
  const ageMs = referenceTimeMs - ts;
  return ageMs > Math.max(1, Number(maxAgeMinutes) || DEFAULT_MAX_SIGNAL_AGE_MINUTES) * 60 * 1000;
}

function createTradingViewPaperReplayPreviewService(options = {}) {
  const env = options.env || process.env;
  const registry = options.registryService || strategyRegistry;
  const allowlistService = options.allowlistService || paperAllowlistService;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const maxSignalAgeMinutes = Number(env.TRADINGVIEW_PAPER_PREVIEW_MAX_AGE_MINUTES || DEFAULT_MAX_SIGNAL_AGE_MINUTES);
  const webhookSecret = safeString(options.webhookSecret ?? env.TRADINGVIEW_WEBHOOK_SECRET ?? '');
  const webhookAuthConfigured = secretConfigured(webhookSecret);
  const featureFlags = resolveFeatureFlags(env);

  function loadAllowlistStatus() {
    try {
      if (!allowlistService || typeof allowlistService.getPaperAllowlistStatus !== 'function') return null;
      return allowlistService.getPaperAllowlistStatus();
    } catch (_) {
      return null;
    }
  }

  function loadStrategy(strategyId) {
    if (!registry || typeof registry.getStrategy !== 'function') return null;
    return registry.getStrategy(strategyId) || null;
  }

  function canForward(strategy) {
    if (!registry || typeof registry.canForwardStrategy !== 'function') {
      return { allowed: true, blocked_reason: null, strategy };
    }
    return registry.canForwardStrategy(strategy || null);
  }

  function previewTradingViewSignal(input = {}) {
    try {
      const normalized = normalizeCandidate(input);
      const candidate = normalized.candidate;
      const validationErrors = [...normalized.errors];
      const referenceTimeMs = now().getTime();
      const strategy = candidate.strategyId ? loadStrategy(candidate.strategyId) : null;
      const allowlistStatus = loadAllowlistStatus();
      const allowlistApprovedIds = new Set((Array.isArray(allowlistStatus?.allowlist) ? allowlistStatus.allowlist : []).map((row) => row && row.id).filter(Boolean));
      const allowlistRequired = allowlistApprovedIds.size > 0 || Number(allowlistStatus?.totalApproved || 0) > 0;
      const allowlistApproved = candidate.strategyId ? allowlistApprovedIds.has(candidate.strategyId) : false;
      const registryDecision = strategy ? canForward(strategy) : { allowed: false, blocked_reason: 'strategy_not_found', strategy: null };
      const dedupKey = stableDedupKey(candidate);
      const timestampTooOld = ageIsTooOld(candidate.timestamp, maxSignalAgeMinutes, referenceTimeMs);
      if (timestampTooOld) validationErrors.push('signal_too_old');

      const suppliedSecret = safeString(input.secret);
      if (webhookAuthConfigured) {
        if (!suppliedSecret) validationErrors.push('auth_required');
        else if (suppliedSecret !== webhookSecret) validationErrors.push('unauthorized');
      } else {
        validationErrors.push('auth_not_configured');
      }

      if (strategy === null) {
        validationErrors.push('strategy_not_found');
      } else if (registryDecision.allowed === false) {
        validationErrors.push(registryDecision.blocked_reason || 'strategy_disabled');
      }

      if (!validationErrors.length && allowlistRequired && !allowlistApproved) {
        validationErrors.push('not_in_allowlist');
      }

      const previewReady = featureFlags.previewEnabled
        && webhookAuthConfigured
        && validationErrors.length === 0
        && strategy !== null
        && registryDecision.allowed !== false
        && (!allowlistRequired || allowlistApproved)
        && !featureFlags.forwardingEnabled
        && !featureFlags.replayQueueEnabled;

      const blockedReason = validationErrors[0]
        || (featureFlags.previewEnabled ? 'preview_only' : 'feature_flag_disabled');

      return {
        ok: true,
        accepted: false,
        dryRun: true,
        wouldCreatePaperTest: false,
        wouldCreateReplayTest: false,
        blockedReason,
        previewReady,
        enabled: featureFlags.previewEnabled,
        forwardingEnabled: featureFlags.forwardingEnabled,
        replayQueueEnabled: featureFlags.replayQueueEnabled,
        authConfigured: webhookAuthConfigured,
        featureFlags: { ...featureFlags },
        validationErrors,
        candidate: {
          ...candidate,
          strategyName: strategy?.strategy_name || strategy?.strategyName || strategy?.name || null,
          strategySource: strategy?.source || null,
          strategyStatus: strategy?.status || null,
          allowlistApproved,
          registryAllowed: registryDecision.allowed !== false,
        },
        dedupKey,
        message: blockedReason === 'feature_flag_disabled'
          ? 'TradingView kan bara förhandsgranskas i säkert testläge. Inga riktiga order kan läggas.'
          : (blockedReason === 'auth_not_configured'
            ? 'TradingView-preview saknar webhook-sekret. Inga riktiga order kan läggas.'
            : DEFAULT_MESSAGE),
        safety: { ...SAFETY },
        ...SAFETY,
      };
    } catch (err) {
      return {
        ok: false,
        accepted: false,
        dryRun: true,
        wouldCreatePaperTest: false,
        wouldCreateReplayTest: false,
        blockedReason: 'preview_service_error',
        error: err && err.message ? err.message : String(err),
        candidate: null,
        dedupKey: null,
        previewReady: false,
        enabled: false,
        forwardingEnabled: false,
        replayQueueEnabled: false,
        authConfigured: webhookAuthConfigured,
        featureFlags: { ...featureFlags },
        safety: { ...SAFETY },
        ...SAFETY,
      };
    }
  }

  function loadPreviewHistorySummary() {
    try {
      const logService = options.previewLogService || require('./tradingViewPreviewLogService');
      if (!logService || typeof logService.getPreviewHistorySummary !== 'function') return null;
      return logService.getPreviewHistorySummary();
    } catch (_) {
      return null;
    }
  }

  function buildTradingViewPreviewStatus() {
    const enabled = featureFlags.previewEnabled === true;
    if (!enabled) {
      const message = 'TradingView kan bara förhandsgranskas i säkert testläge. Inga riktiga order kan läggas.';
      return {
        ok: true,
        status: 'empty',
        source: 'tradingViewPaperReplayPreviewService',
        emptyReason: 'feature_flag_disabled',
        blockedReason: 'feature_flag_disabled',
        enabled: false,
        previewReady: false,
        forwardingEnabled: featureFlags.forwardingEnabled,
        replayQueueEnabled: featureFlags.replayQueueEnabled,
        authConfigured: webhookAuthConfigured,
        webhookAuthConfigured,
        previewCount: 0,
        latestPreview: null,
        latestBlockedReason: 'feature_flag_disabled',
        blockedCount: 0,
        allowlist: null,
        featureFlags: { ...featureFlags },
        message,
        summary: {
          status: 'empty',
          source: 'tradingViewPaperReplayPreviewService',
          emptyReason: 'feature_flag_disabled',
          blockedReason: 'feature_flag_disabled',
          enabled: false,
          previewReady: false,
          forwardingEnabled: featureFlags.forwardingEnabled,
          replayQueueEnabled: featureFlags.replayQueueEnabled,
          authConfigured: webhookAuthConfigured,
          previewCount: 0,
          latestPreview: null,
          latestBlockedReason: 'feature_flag_disabled',
          blockedCount: 0,
          message,
          paperOnly: true,
        },
        safety: { ...SAFETY },
        ...SAFETY,
      };
    }

    const allowlistStatus = loadAllowlistStatus();
    const historySummary = loadPreviewHistorySummary();
    const previewCount = Number(historySummary?.previewCount) || 0;
    const latestPreview = historySummary?.latestPreview || null;
    const latestBlockedReason = historySummary?.latestBlockedReason != null ? historySummary.latestBlockedReason : null;
    const previewReady = webhookAuthConfigured;
    const blockedCount = Array.isArray(historySummary?.entries)
      ? historySummary.entries.filter((row) => row && row.accepted !== true).length
      : 0;
    const hasHistory = previewCount > 0;
    const status = hasHistory ? 'ok' : (webhookAuthConfigured ? 'empty' : 'degraded');
    const emptyReason = hasHistory ? null : (webhookAuthConfigured ? 'no_preview_history' : 'auth_not_configured');
    const message = webhookAuthConfigured
      ? 'TradingView kan förhandsgranskas i säkert testläge. Inga riktiga order kan läggas.'
      : 'TradingView-preview är inte redo eftersom webhook-sekret saknas.';

    return {
      ok: true,
      status,
      source: 'tradingViewPaperReplayPreviewService',
      emptyReason,
      enabled,
      previewReady,
      forwardingEnabled: featureFlags.forwardingEnabled,
      replayQueueEnabled: featureFlags.replayQueueEnabled,
      authConfigured: webhookAuthConfigured,
      webhookAuthConfigured,
      previewCount,
      latestPreview,
      latestBlockedReason,
      blockedCount,
      allowlist: allowlistStatus ? {
        source: allowlistStatus.source || 'paperAllowlistService',
        totalApproved: allowlistStatus.totalApproved || 0,
        readyForPaperRuntime: allowlistStatus.readyForPaperRuntime || 0,
        pendingRuntimeConnection: allowlistStatus.pendingRuntimeConnection || 0,
      } : null,
      featureFlags: { ...featureFlags },
      message,
      summary: {
        status,
        source: 'tradingViewPaperReplayPreviewService',
        emptyReason,
        enabled,
        previewReady,
        forwardingEnabled: featureFlags.forwardingEnabled,
        replayQueueEnabled: featureFlags.replayQueueEnabled,
        authConfigured: webhookAuthConfigured,
        previewCount,
        latestPreview,
        latestBlockedReason,
        blockedCount,
        message,
        paperOnly: true,
      },
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    resolveFeatureFlags,
    normalizeCandidate,
    stableDedupKey,
    previewTradingViewSignal,
    buildTradingViewPreviewStatus,
  };
}

const defaultTradingViewPaperReplayPreviewService = createTradingViewPaperReplayPreviewService();

module.exports = {
  SAFETY,
  DEFAULT_MAX_SIGNAL_AGE_MINUTES,
  ALLOWED_SIGNALS,
  VALID_SYMBOL_RE,
  DEFAULT_MESSAGE,
  createTradingViewPaperReplayPreviewService,
  defaultTradingViewPaperReplayPreviewService,
  resolveFeatureFlags: (...args) => defaultTradingViewPaperReplayPreviewService.resolveFeatureFlags(...args),
  normalizeCandidate: (...args) => defaultTradingViewPaperReplayPreviewService.normalizeCandidate(...args),
  stableDedupKey: (...args) => defaultTradingViewPaperReplayPreviewService.stableDedupKey(...args),
  previewTradingViewSignal: (...args) => defaultTradingViewPaperReplayPreviewService.previewTradingViewSignal(...args),
  buildTradingViewPreviewStatus: (...args) => defaultTradingViewPaperReplayPreviewService.buildTradingViewPreviewStatus(...args),
};
