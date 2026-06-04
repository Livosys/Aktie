'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const candidateLog = require('./candidateLogService');
const eventLogService = require('./eventLogService');
const strategyRegistry = require('./strategyRegistryService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  mode: 'paper_only',
});

const ALLOWED_SIGNALS = new Set(['long', 'short', 'exit', 'flat', 'watch']);
const DEFAULT_LOG_FILE = path.resolve(__dirname, '../../data/tradingview-signals.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function cloneJson(value) {
  if (value == null) return {};
  if (typeof value !== 'object') return { value };
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : {};
  } catch (_) {
    return {};
  }
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function safeNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function secretConfigured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function scrubSecret(payload = {}) {
  if (!payload || typeof payload !== 'object') return {};
  const cloned = cloneJson(payload);
  const stack = [cloned];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(current, 'secret')) delete current.secret;
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return cloned;
}

function isIsoTimestamp(value) {
  if (!value) return false;
  return Number.isFinite(new Date(value).getTime());
}

function safeId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `tv_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function createTradingViewConnectorService(options = {}) {
  const logFile = options.logFile || DEFAULT_LOG_FILE;
  const candidateLogger = options.candidateLogger || candidateLog;
  const eventLogger = options.eventLogger || eventLogService;
  const registry = options.registryService || strategyRegistry;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const enabled = options.enabled !== false;
  const webhookSecret = options.webhookSecret ?? process.env.TRADINGVIEW_WEBHOOK_SECRET ?? '';
  const webhookAuthConfigured = secretConfigured(webhookSecret);

  function appendRecord(record) {
    ensureDir(logFile);
    fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');
  }

  function normalizePayload(payload = {}) {
    const errors = [];
    const source = safeString(payload.source);
    const strategy = safeString(payload.strategy);
    const symbol = safeString(payload.symbol);
    const timeframe = safeString(payload.timeframe);
    const signal = safeString(payload.signal)?.toLowerCase() || null;
    const price = payload.price;
    const timestamp = isIsoTimestamp(payload.timestamp) ? new Date(payload.timestamp).toISOString() : now().toISOString();

    if (source !== 'tradingview') errors.push('source_must_be_tradingview');
    if (!strategy) errors.push('strategy_required');
    if (!symbol) errors.push('symbol_required');
    if (!timeframe) errors.push('timeframe_required');
    if (!signal || !ALLOWED_SIGNALS.has(signal)) errors.push('invalid_signal');
    if (price != null && !Number.isFinite(price)) errors.push('price_must_be_number');

    return {
      errors,
      record: {
        id: safeId(),
        source: 'tradingview',
        received_at: timestamp,
        signal_timestamp: timestamp,
        strategy,
        symbol,
        timeframe,
        signal,
        price: Number.isFinite(price) ? price : null,
        rsi: safeNumber(payload.rsi),
        vwap_state: safeString(payload.vwap_state),
        trend_state: safeString(payload.trend_state),
        market_regime: safeString(payload.market_regime),
        metadata: scrubSecret(payload.metadata),
        raw_payload: scrubSecret(payload),
        ...SAFETY,
      },
    };
  }

  function totalSignalsToday(records, todayIso) {
    return records.filter((row) => String(row.received_at || row.signal_timestamp || '').slice(0, 10) === todayIso).length;
  }

  function getStatus() {
    const records = readJsonl(logFile);
    const todayIso = now().toISOString().slice(0, 10);
    const last = records.length > 0
      ? records.reduce((latest, row) => {
          const current = new Date(row.received_at || row.signal_timestamp || 0).getTime();
          const previous = new Date(latest.received_at || latest.signal_timestamp || 0).getTime();
          return Number.isFinite(current) && current >= previous ? row : latest;
        }, records[0])
      : null;
    return {
      ok: true,
      enabled: enabled && webhookAuthConfigured,
      webhook_auth_configured: webhookAuthConfigured,
      mode: SAFETY.mode,
      last_signal_at: last?.received_at || last?.signal_timestamp || null,
      total_signals_today: totalSignalsToday(records, todayIso),
      accepted_signals: records.filter((row) => row.accepted === true).length,
      rejected_signals: records.filter((row) => row.accepted === false).length,
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  function handleWebhook(payload = {}) {
    const suppliedSecret = safeString(payload.secret);
    if (!webhookAuthConfigured) {
      const { record } = normalizePayload(payload);
      const entry = {
        ...record,
        accepted: false,
        rejected_reason: 'auth_not_configured',
        paper_forwarded: false,
        persisted_at: now().toISOString(),
      };
      try {
        appendRecord(entry);
      } catch (_) {
        // ignore log write failures in auth-disabled mode
      }
      return {
        ok: false,
        accepted: false,
        disabled: true,
        statusCode: 503,
        errors: ['webhook_auth_not_configured'],
        ...SAFETY,
      };
    }

    if (suppliedSecret !== webhookSecret) {
      const { record } = normalizePayload(payload);
      const entry = {
        ...record,
        accepted: false,
        rejected_reason: 'auth_failed',
        paper_forwarded: false,
        persisted_at: now().toISOString(),
      };
      try {
        appendRecord(entry);
      } catch (_) {
        // ignore log write failures for rejected auth
      }
      return {
        ok: false,
        accepted: false,
        statusCode: 401,
        errors: ['unauthorized'],
        ...SAFETY,
      };
    }

    const { errors, record } = normalizePayload(payload);
    const accepted = errors.length === 0;
    let registryStrategy = null;
    let registryDecision = { allowed: false, blocked_reason: 'strategy_disabled', strategy: null };
    let registryError = null;

    if (accepted) {
      try {
        if (registry && typeof registry.getStrategy === 'function') {
          registryStrategy = registry.getStrategy(record.strategy);
        }
        if (!registryStrategy && registry && typeof registry.registerTradingViewStrategy === 'function') {
          const registerResult = registry.registerTradingViewStrategy(record.strategy, {
            strategy_name: record.strategy,
            description: `TradingView signal source for ${record.strategy}`,
            mode: 'paper_only',
            source: 'tradingview',
            status: 'paper_only',
            enabled: true,
            market_regime_tags: record.market_regime ? [record.market_regime] : [],
            allowed_timeframes: [record.timeframe].filter(Boolean),
            recommended_tests: ['paper_forward', 'compare_internal_equivalent'],
            performance_summary: {
              win_rate: null,
              avg_pnl: null,
              trades: 0,
              score: null,
            },
            known_weaknesses: [],
            last_learning_review_at: null,
            registry_managed: true,
          });
          registryStrategy = registerResult?.strategy || (typeof registry.getStrategy === 'function' ? registry.getStrategy(record.strategy) : null);
        }
        if (registry && typeof registry.canForwardStrategy === 'function') {
          registryDecision = registry.canForwardStrategy(registryStrategy || record.strategy);
        }
      } catch (err) {
        registryError = err?.message || 'registry_error';
        registryDecision = { allowed: false, blocked_reason: 'registry_error', strategy: registryStrategy };
      }
    }

    const blockedReason = !accepted
      ? errors.join(',')
      : (!registryDecision.allowed ? (registryDecision.blocked_reason || 'strategy_disabled') : null);
    const entry = {
      ...record,
      accepted,
      rejected_reason: accepted ? null : errors.join(','),
      blocked_reason: blockedReason,
      registry_source: registryStrategy?.source || null,
      registry_status: registryStrategy?.status || null,
      registry_strategy_id: registryStrategy?.strategy_id || record.strategy,
      registry_enabled: registryStrategy?.enabled ?? null,
      paper_forwarded: false,
      persisted_at: now().toISOString(),
    };

    try {
      appendRecord(entry);
    } catch (err) {
      return {
        ok: false,
        accepted: false,
        error: err.message,
        errors: ['log_write_failed'],
        ...SAFETY,
      };
    }

    if (!accepted) {
      return {
        ok: false,
        accepted: false,
        errors,
        message: 'TradingView payload rejected',
        ...SAFETY,
      };
    }

    const shouldForwardToPaper = ['long', 'short', 'watch'].includes(record.signal) && registryDecision.allowed !== false;
    let paperForwarded = false;
    if (shouldForwardToPaper && candidateLogger && typeof candidateLogger.logCandidate === 'function') {
      try {
        candidateLogger.logCandidate({
          symbol: record.symbol,
          strategyName: registryStrategy?.strategy_name || record.strategy,
          sourceStrategyId: registryStrategy?.strategy_id || record.strategy,
          sourceStrategyName: registryStrategy?.strategy_name || record.strategy,
          strategyId: registryStrategy?.strategy_id || record.strategy,
          resolvedStrategyId: registryStrategy?.strategy_id || record.strategy,
          resolvedStrategyName: registryStrategy?.strategy_name || record.strategy,
          mappingSource: 'explicit',
          marketGroup: record.market_regime || 'unknown',
          signal: record.signal,
          score: record.rsi,
          setupId: `tradingview:${registryStrategy?.strategy_id || record.strategy}`,
          paperTradeCreated: false,
          wouldHaveBeenBlockedBy: [],
          reasons: [],
          warnings: [],
          timestamp: record.signal_timestamp,
          detected_at: record.signal_timestamp,
          evaluated_at: record.signal_timestamp,
        });
        paperForwarded = true;
      } catch (_) {
        paperForwarded = false;
      }
    }

    try {
      if (eventLogger && typeof eventLogger.appendEvent === 'function') {
          eventLogger.appendEvent({
          event_type: 'tradingview.signal',
          source: 'tradingview',
          timestamp: record.signal_timestamp,
          symbol: record.symbol,
          market: record.market_regime || 'unknown',
          timeframe: record.timeframe,
          raw_signal: record.signal.toUpperCase(),
          strategy: record.strategy,
          strategy_id: registryStrategy?.strategy_id || record.strategy,
          score: record.rsi,
          decision: 'no_trade',
          paper: false,
          reason: `TradingView ${record.signal} signal received`,
          metadata: {
            tradingview: true,
            strategy: record.strategy,
            strategy_id: registryStrategy?.strategy_id || record.strategy,
            strategy_status: registryStrategy?.status || null,
            strategy_source: registryStrategy?.source || null,
            signal: record.signal,
            source: 'tradingview',
            vwap_state: record.vwap_state,
            trend_state: record.trend_state,
            market_regime: record.market_regime,
            ...record.metadata,
            registry_status: registryStrategy?.status || null,
            registry_source: registryStrategy?.source || null,
            blocked_reason: blockedReason,
          },
        });
      }
    } catch (_) {
      // Read-only logging path. Event log failure must not block acceptance.
    }

    const updatedEntry = {
      ...entry,
      paper_forwarded: paperForwarded,
      blocked_reason: blockedReason,
    };
    try {
      const allRecords = readJsonl(logFile);
      if (allRecords.length > 0) {
        allRecords[allRecords.length - 1] = updatedEntry;
        fs.writeFileSync(logFile, `${allRecords.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      }
    } catch (_) {
      // Ignore rewrite failures. Initial append already completed.
    }

    return {
      ok: true,
      accepted: true,
      paper_forwarded: paperForwarded,
      blocked_reason: blockedReason,
      registry_error: registryError,
      registry_strategy: registryStrategy || null,
      record: updatedEntry,
      ...SAFETY,
    };
  }

  return {
    enabled,
    logFile,
    webhookAuthConfigured,
    handleWebhook,
    getStatus,
    normalizePayload,
    readJsonl: () => readJsonl(logFile),
    SAFETY,
  };
}

const defaultConnector = createTradingViewConnectorService();

module.exports = {
  SAFETY,
  ALLOWED_SIGNALS,
  DEFAULT_LOG_FILE,
  createTradingViewConnectorService,
  defaultConnector,
};
