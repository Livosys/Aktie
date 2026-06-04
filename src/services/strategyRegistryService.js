'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const daytradingCatalog = require('./daytradingStrategyCatalogService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  live_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  broker_enabled: false,
});

const STATUS_VALUES = new Set(['active', 'paper_only', 'watch', 'experimental', 'paused', 'deprecated']);
const SOURCE_VALUES = new Set(['internal', 'tradingview', 'replay', 'batch', 'manual']);
const DEFAULT_REGISTRY_FILE = path.resolve(__dirname, '../../data/strategy-registry.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(registryFile) {
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function safeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item != null).map((item) => String(item));
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : {};
  } catch (_) {
    return {};
  }
}

function safeId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `registry_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeStatus(value, fallback = 'paper_only') {
  const raw = String(value || fallback || '').toLowerCase();
  if (STATUS_VALUES.has(raw)) return raw;
  return fallback;
}

function normalizeSource(value, fallback = 'internal') {
  const raw = String(value || fallback || '').toLowerCase();
  if (SOURCE_VALUES.has(raw)) return raw;
  return fallback;
}

function mapCatalogStatus(status) {
  const raw = String(status || '').toLowerCase();
  if (raw === 'active') return 'active';
  if (raw === 'testing') return 'experimental';
  if (raw === 'paused') return 'paused';
  if (raw === 'roadmap') return 'watch';
  if (raw === 'legacy') return 'deprecated';
  return 'paper_only';
}

function defaultPerformanceSummary() {
  return {
    win_rate: null,
    avg_pnl: null,
    trades: 0,
    score: null,
  };
}

function createStrategyRegistryService(options = {}) {
  const registryFile = options.registryFile || DEFAULT_REGISTRY_FILE;
  const catalogService = options.daytradingCatalog || daytradingCatalog;

  function readJsonl() {
    try {
      if (!fs.existsSync(registryFile)) return [];
      return fs.readFileSync(registryFile, 'utf8')
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

  function appendJsonl(row) {
    ensureDir(registryFile);
    fs.appendFileSync(registryFile, `${JSON.stringify(row)}\n`, 'utf8');
  }

  function baseStrategyFromCatalog(strategy = {}) {
    const enabled = strategy.enabled !== false;
    const status = mapCatalogStatus(strategy.status);
    return {
      strategy_id: safeString(strategy.id),
      strategy_name: safeString(strategy.name || strategy.id),
      source: 'internal',
      status,
      enabled,
      disabled_reason: enabled ? null : 'catalog_disabled',
      mode: 'paper_only',
      catalog_status: safeString(strategy.status),
      catalog_enabled: enabled,
      description: safeString(strategy.description || strategy.description_sv || ''),
      performance_summary: strategy.performanceSummary || defaultPerformanceSummary(),
      known_weaknesses: safeArray(strategy.known_weaknesses),
      recommended_tests: safeArray(strategy.recommended_tests),
      last_learning_review_at: strategy.last_learning_review_at || null,
      market_regime_tags: safeArray(strategy.marketRegimeTags),
      allowed_timeframes: safeArray(strategy.allowedTimeframes),
      entry_rules: safeArray(strategy.entryRules),
      exit_rules: safeArray(strategy.exitRules),
      updated_at: null,
      created_at: null,
      history_count: 0,
      registry_managed: false,
      ...SAFETY,
    };
  }

  function blankStrategy(strategyId) {
    return {
      strategy_id: safeString(strategyId),
      strategy_name: safeString(strategyId),
      source: 'manual',
      status: 'paper_only',
      enabled: true,
      disabled_reason: null,
      mode: 'paper_only',
      catalog_status: null,
      catalog_enabled: null,
      description: '',
      performance_summary: defaultPerformanceSummary(),
      known_weaknesses: [],
      recommended_tests: [],
      last_learning_review_at: null,
      market_regime_tags: [],
      allowed_timeframes: [],
      entry_rules: [],
      exit_rules: [],
      updated_at: null,
      created_at: null,
      history_count: 0,
      registry_managed: true,
      ...SAFETY,
    };
  }

  function applyRecord(current, record = {}) {
    const next = { ...current };
    next.history_count = (Number(next.history_count || 0) || 0) + 1;
    if (record.strategy_name) next.strategy_name = safeString(record.strategy_name) || next.strategy_name;
    if (record.source) next.source = normalizeSource(record.source, next.source);
    if (record.status) next.status = normalizeStatus(record.status, next.status);
    if (record.enabled != null) next.enabled = record.enabled === true;
    if (Object.prototype.hasOwnProperty.call(record, 'disabled_reason')) next.disabled_reason = record.disabled_reason || null;
    if (Object.prototype.hasOwnProperty.call(record, 'mode')) next.mode = safeString(record.mode) || next.mode;
    if (Object.prototype.hasOwnProperty.call(record, 'catalog_status')) next.catalog_status = safeString(record.catalog_status) || next.catalog_status;
    if (Object.prototype.hasOwnProperty.call(record, 'catalog_enabled')) next.catalog_enabled = record.catalog_enabled;
    if (Object.prototype.hasOwnProperty.call(record, 'description')) next.description = safeString(record.description) || '';
    if (Object.prototype.hasOwnProperty.call(record, 'performance_summary')) {
      const summary = safeObject(record.performance_summary);
      next.performance_summary = Object.keys(summary).length > 0 ? summary : defaultPerformanceSummary();
    }
    if (Object.prototype.hasOwnProperty.call(record, 'known_weaknesses')) next.known_weaknesses = safeArray(record.known_weaknesses);
    if (Object.prototype.hasOwnProperty.call(record, 'recommended_tests')) next.recommended_tests = safeArray(record.recommended_tests);
    if (Object.prototype.hasOwnProperty.call(record, 'last_learning_review_at')) next.last_learning_review_at = record.last_learning_review_at || null;
    if (Object.prototype.hasOwnProperty.call(record, 'market_regime_tags')) next.market_regime_tags = safeArray(record.market_regime_tags);
    if (Object.prototype.hasOwnProperty.call(record, 'allowed_timeframes')) next.allowed_timeframes = safeArray(record.allowed_timeframes);
    if (Object.prototype.hasOwnProperty.call(record, 'entry_rules')) next.entry_rules = safeArray(record.entry_rules);
    if (Object.prototype.hasOwnProperty.call(record, 'exit_rules')) next.exit_rules = safeArray(record.exit_rules);
    if (Object.prototype.hasOwnProperty.call(record, 'registry_managed')) next.registry_managed = record.registry_managed === true;
    if (record.created_at && !next.created_at) next.created_at = record.created_at;
    if (record.updated_at) next.updated_at = record.updated_at;
    if (!next.created_at) next.created_at = record.created_at || record.recorded_at || null;
    if (!next.updated_at) next.updated_at = record.updated_at || record.recorded_at || null;
    return next;
  }

  function loadHistory() {
    return readJsonl();
  }

  function getLatestBlockedRecord() {
    const history = loadHistory();
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const row = history[i];
      const blockedReason = safeString(row.blocked_reason || row.rejected_reason || row.disabled_reason);
      if (!blockedReason) continue;
      return {
        strategy_id: safeString(row.strategy_id || row.strategyId) || null,
        strategy_name: safeString(row.strategy_name || row.strategyName) || null,
        blocked_reason: blockedReason,
        source: normalizeSource(row.source, 'internal'),
        status: normalizeStatus(row.status, 'paper_only'),
        recorded_at: row.recorded_at || row.updated_at || row.persisted_at || row.created_at || null,
      };
    }
    return null;
  }

  function buildState() {
    const catalog = typeof catalogService.getCatalog === 'function' ? (catalogService.getCatalog().strategies || []) : [];
    const byId = new Map();

    for (const strategy of catalog) {
      byId.set(strategy.id, baseStrategyFromCatalog(strategy));
    }

    for (const record of loadHistory()) {
      const strategyId = safeString(record.strategy_id || record.strategyId);
      if (!strategyId) continue;
      const existing = byId.get(strategyId) || blankStrategy(strategyId);
      byId.set(strategyId, applyRecord(existing, {
        ...record,
        strategy_id: strategyId,
      }));
    }

    return [...byId.values()]
      .map((strategy) => {
        const source = normalizeSource(strategy.source, 'internal');
        const status = normalizeStatus(strategy.status, strategy.enabled === false ? 'paused' : 'paper_only');
        return {
          ...strategy,
          source,
          status,
          enabled: strategy.enabled !== false,
          disabled_reason: strategy.disabled_reason || null,
          paper_only: true,
          ...SAFETY,
        };
      })
      .sort((a, b) => String(a.strategy_name || a.strategy_id || '').localeCompare(String(b.strategy_name || b.strategy_id || '')));
  }

  function currentMap() {
    return new Map(buildState().map((strategy) => [strategy.strategy_id, strategy]));
  }

  function getStrategy(strategyId) {
    const id = safeString(strategyId);
    if (!id) return null;
    return currentMap().get(id) || null;
  }

  function listStrategies() {
    return buildState();
  }

  function ensureStrategy(strategyId, defaults = {}) {
    const id = safeString(strategyId);
    if (!id) return { ok: false, error: 'strategy_id_required', ...SAFETY };
    const existing = getStrategy(id);
    if (existing) return { ok: true, strategy: existing, created: false, ...SAFETY };

    const now = nowIso();
    const source = normalizeSource(defaults.source, 'internal');
    const status = normalizeStatus(defaults.status, 'paper_only');
    const record = {
      event_id: safeId(),
      event_type: 'strategy.registered',
      recorded_at: now,
      strategy_id: id,
      strategy_name: safeString(defaults.strategy_name || defaults.strategyName || id) || id,
      source,
      status,
      enabled: defaults.enabled != null ? defaults.enabled === true : true,
      disabled_reason: defaults.disabled_reason || null,
      mode: defaults.mode || 'paper_only',
      catalog_status: defaults.catalog_status || null,
      catalog_enabled: defaults.catalog_enabled != null ? defaults.catalog_enabled : null,
      description: defaults.description || '',
      performance_summary: (() => {
        const summary = safeObject(defaults.performance_summary);
        return Object.keys(summary).length > 0 ? summary : defaultPerformanceSummary();
      })(),
      known_weaknesses: safeArray(defaults.known_weaknesses),
      recommended_tests: safeArray(defaults.recommended_tests),
      last_learning_review_at: defaults.last_learning_review_at || null,
      market_regime_tags: safeArray(defaults.market_regime_tags),
      allowed_timeframes: safeArray(defaults.allowed_timeframes),
      entry_rules: safeArray(defaults.entry_rules),
      exit_rules: safeArray(defaults.exit_rules),
      registry_managed: defaults.registry_managed === true || source !== 'internal',
      created_at: now,
      updated_at: now,
    };
    appendJsonl(record);
    return { ok: true, created: true, strategy: getStrategy(id), ...SAFETY };
  }

  function registerTradingViewStrategy(strategyId, defaults = {}) {
    const id = safeString(strategyId);
    if (!id) return { ok: false, error: 'strategy_id_required', ...SAFETY };
    const existing = getStrategy(id);
    if (existing) return { ok: true, created: false, strategy: existing, ...SAFETY };
    return ensureStrategy(id, {
      ...defaults,
      source: 'tradingview',
      status: 'paper_only',
      enabled: true,
      mode: 'paper_only',
      registry_managed: true,
    });
  }

  function pauseStrategy(strategyId, reason = 'paused') {
    const id = safeString(strategyId);
    if (!id) return { ok: false, error: 'strategy_id_required', ...SAFETY };
    const current = getStrategy(id);
    if (!current) return { ok: false, error: 'strategy_not_found', ...SAFETY };
    const now = nowIso();
    appendJsonl({
      event_id: safeId(),
      event_type: 'strategy.paused',
      recorded_at: now,
      strategy_id: id,
      strategy_name: current.strategy_name || id,
      source: current.source || 'manual',
      status: 'paused',
      enabled: false,
      disabled_reason: safeString(reason) || 'paused',
      mode: current.mode || 'paper_only',
      catalog_status: current.catalog_status || null,
      catalog_enabled: current.catalog_enabled,
      description: current.description || '',
      performance_summary: current.performance_summary || defaultPerformanceSummary(),
      known_weaknesses: current.known_weaknesses || [],
      recommended_tests: current.recommended_tests || [],
      last_learning_review_at: current.last_learning_review_at || null,
      market_regime_tags: current.market_regime_tags || [],
      allowed_timeframes: current.allowed_timeframes || [],
      entry_rules: current.entry_rules || [],
      exit_rules: current.exit_rules || [],
      registry_managed: true,
      created_at: current.created_at || now,
      updated_at: now,
    });
    return { ok: true, strategy: getStrategy(id), ...SAFETY };
  }

  function activateStrategy(strategyId) {
    const id = safeString(strategyId);
    if (!id) return { ok: false, error: 'strategy_id_required', ...SAFETY };
    const current = getStrategy(id);
    if (!current) return { ok: false, error: 'strategy_not_found', ...SAFETY };
    const now = nowIso();
    appendJsonl({
      event_id: safeId(),
      event_type: 'strategy.activated',
      recorded_at: now,
      strategy_id: id,
      strategy_name: current.strategy_name || id,
      source: current.source || 'manual',
      status: 'active',
      enabled: true,
      disabled_reason: null,
      mode: current.mode || 'paper_only',
      catalog_status: current.catalog_status || null,
      catalog_enabled: current.catalog_enabled,
      description: current.description || '',
      performance_summary: current.performance_summary || defaultPerformanceSummary(),
      known_weaknesses: current.known_weaknesses || [],
      recommended_tests: current.recommended_tests || [],
      last_learning_review_at: current.last_learning_review_at || null,
      market_regime_tags: current.market_regime_tags || [],
      allowed_timeframes: current.allowed_timeframes || [],
      entry_rules: current.entry_rules || [],
      exit_rules: current.exit_rules || [],
      registry_managed: true,
      created_at: current.created_at || now,
      updated_at: now,
    });
    return { ok: true, strategy: getStrategy(id), ...SAFETY };
  }

  function canForwardStrategy(strategyOrId) {
    const strategy = typeof strategyOrId === 'string' ? getStrategy(strategyOrId) : strategyOrId;
    if (!strategy) {
      return { allowed: false, blocked_reason: 'strategy_disabled', strategy: null, ...SAFETY };
    }
    const status = normalizeStatus(strategy.status, 'paper_only');
    const enabled = strategy.enabled !== false;
    const blocked = !enabled || ['paused', 'deprecated'].includes(status);
    return {
      allowed: !blocked,
      blocked_reason: blocked ? 'strategy_disabled' : null,
      strategy,
      ...SAFETY,
    };
  }

  function getLatestTradingViewStrategy() {
    const strategies = listStrategies().filter((strategy) => strategy.source === 'tradingview');
    if (strategies.length === 0) return null;
    return strategies
      .slice()
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0] || null;
  }

  function getStatus() {
    const strategies = listStrategies();
    const latestTradingViewStrategy = getLatestTradingViewStrategy();
    const latestBlocked = getLatestBlockedRecord();
    const summary = {
      total_strategies: strategies.length,
      active_strategies: strategies.filter((strategy) => strategy.enabled !== false && strategy.status === 'active').length,
      tradingview_strategies: strategies.filter((strategy) => strategy.source === 'tradingview').length,
      paused_strategies: strategies.filter((strategy) => strategy.status === 'paused').length,
      deprecated_strategies: strategies.filter((strategy) => strategy.status === 'deprecated').length,
      paper_only_strategies: strategies.filter((strategy) => strategy.status === 'paper_only').length,
      watch_strategies: strategies.filter((strategy) => strategy.status === 'watch').length,
      experimental_strategies: strategies.filter((strategy) => strategy.status === 'experimental').length,
      enabled_strategies: strategies.filter((strategy) => strategy.enabled !== false).length,
    };
    return {
      ok: true,
      ...summary,
      latest_tradingview_strategy: latestTradingViewStrategy,
      latest_blocked_reason: latestBlocked?.blocked_reason || null,
      latest_blocked_strategy: latestBlocked || null,
      strategies,
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  function getSnapshot() {
    return listStrategies();
  }

  return {
    SAFETY,
    REGISTRY_FILE: registryFile,
    getStatus,
    getStrategy,
    getSnapshot,
    listStrategies,
    ensureStrategy,
    registerTradingViewStrategy,
    pauseStrategy,
    activateStrategy,
    canForwardStrategy,
  };
}

const defaultStrategyRegistry = createStrategyRegistryService();

module.exports = {
  SAFETY,
  DEFAULT_REGISTRY_FILE,
  STATUS_VALUES,
  SOURCE_VALUES,
  createStrategyRegistryService,
  mapCatalogStatus,
  normalizeStatus,
  normalizeSource,
  ...defaultStrategyRegistry,
};
