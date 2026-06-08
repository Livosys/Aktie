'use strict';

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  live_enabled: false,
  paper_only: true,
  replay_mode: true,
});

const MARKET_LABELS = Object.freeze({
  crypto: 'Krypto',
  stocks: 'Aktier',
  index: 'Index',
  etf: 'ETF',
  all: 'Alla',
});

const SCANNER_EMITTER_STRATEGY_IDS = Object.freeze(new Set([
  'crypto_momentum_scalper',
  'ema_pullback_continuation',
  'narrow_breakout',
  'narrow_state_expansion_long',
  'trend_continuation',
  'vwap_failed_breakout_short',
  'vwap_volume_breakout_long',
]));

const STATUS_VALUES = new Set(['active', 'paper_only', 'watch', 'experimental', 'paused', 'deprecated']);
const SOURCE_VALUES = new Set(['internal', 'tradingview', 'replay', 'batch', 'manual']);
const CATALOG_STATE_FILE = path.resolve(process.env.DAYTRADING_STRATEGY_CATALOG_FILE || path.resolve(__dirname, '../../data/config/daytrading-strategy-catalog.jsonl'));

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
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

function safeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item != null).map((item) => String(item));
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  fs.mkdirSync(path.dirname(CATALOG_STATE_FILE), { recursive: true });
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

function readStateHistory() {
  try {
    if (!fs.existsSync(CATALOG_STATE_FILE)) return [];
    return fs.readFileSync(CATALOG_STATE_FILE, 'utf8')
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

function appendStateRecord(record) {
  ensureDir();
  fs.appendFileSync(CATALOG_STATE_FILE, `${JSON.stringify(record)}\n`, 'utf8');
}

function defaultPerformanceSummary() {
  return {
    win_rate: null,
    avg_pnl: null,
    trades: 0,
    score: null,
  };
}

function defaultLearningFields() {
  return {
    performance_summary: defaultPerformanceSummary(),
    known_weaknesses: [],
    recommended_tests: [],
    last_learning_review_at: null,
    learning_notes: [],
  };
}

function mapStatusFromCatalog(strategy = {}) {
  const status = String(strategy.status || '').toLowerCase();
  if (STATUS_VALUES.has(status)) return status;
  if (status === 'testing') return 'experimental';
  if (status === 'roadmap') return 'watch';
  if (status === 'legacy') return 'deprecated';
  if (status === 'paused') return 'paused';
  return strategy.active === false ? 'paused' : 'active';
}

function inferMarketRegimeTags(strategy = {}) {
  const tags = new Set();
  const rules = Array.isArray(strategy.signal_rules) ? strategy.signal_rules : [];
  const text = [strategy.id, strategy.name, strategy.explanation, strategy.description_sv, strategy.simple_explanation_sv, ...rules]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' ');

  if (strategy.market_group) tags.add(String(strategy.market_group).toLowerCase());
  if (text.includes('vwap')) tags.add('vwap');
  if (text.includes('ema')) tags.add('ema');
  if (text.includes('narrow')) tags.add('narrow');
  if (text.includes('opening_range')) tags.add('opening_range');
  if (text.includes('index') || text.includes('qqq') || text.includes('spy')) tags.add('index');
  if (text.includes('gap')) tags.add('gap');
  if (text.includes('volume_spike') || text.includes('volymtopp')) tags.add('volume_spike');
  if (text.includes('volatility')) tags.add('volatility');
  if (text.includes('support') || text.includes('resistance')) tags.add('support_resistance');
  if (text.includes('trend')) tags.add('trend');
  if (text.includes('crypto')) tags.add('crypto');

  return [...tags];
}

function normalizeStrategyRecord(strategy = {}) {
  const source = normalizeSource(strategy.source, 'internal');
  const enabled = strategy.enabled !== false && strategy.active !== false;
  const signalRules = Array.isArray(strategy.signal_rules) ? [...strategy.signal_rules] : [];
  const allowedTimeframes = Array.isArray(strategy.default_timeframes) ? [...strategy.default_timeframes] : [];
  const exitRules = [];
  if (strategy.default_stop_loss_pct != null || strategy.default_sl != null) exitRules.push('stop_loss');
  if (strategy.default_take_profit_r != null || strategy.default_tp != null) exitRules.push('take_profit');
  if (strategy.default_timeout_min != null || strategy.default_holding_time_min != null || strategy.default_holding_time != null) exitRules.push('timeout');
  const learning = {
    ...defaultLearningFields(),
    performance_summary: safeObject(strategy.performance_summary || strategy.performanceSummary) || defaultPerformanceSummary(),
    known_weaknesses: safeArray(strategy.known_weaknesses),
    recommended_tests: safeArray(strategy.recommended_tests),
    last_learning_review_at: strategy.last_learning_review_at || null,
    learning_notes: safeArray(strategy.learning_notes),
  };
  const explicitStatus = safeString(strategy.status);
  const status = normalizeStatus(
    explicitStatus
      || (source === 'tradingview' ? 'paper_only' : null)
      || (enabled ? (strategy.is_new ? 'experimental' : mapStatusFromCatalog(strategy)) : 'paused'),
    enabled ? 'paper_only' : 'paused',
  );

  return {
    ...strategy,
    source,
    description: strategy.description_sv || strategy.explanation || '',
    enabled,
    status,
    mode: safeString(strategy.mode) || 'paper_only',
    disabled_reason: strategy.disabled_reason || null,
    disabled_at: strategy.disabled_at || null,
    catalog_status: safeString(strategy.catalog_status || strategy.status) || null,
    catalog_enabled: strategy.catalog_enabled != null ? strategy.catalog_enabled : enabled,
    entryRules: signalRules,
    exitRules,
    allowedTimeframes,
    marketRegimeTags: inferMarketRegimeTags(strategy),
    supportsScanner: SCANNER_EMITTER_STRATEGY_IDS.has(strategy.id),
    supportsReplay: true,
    supportsBatch: true,
    supportsPaper: true,
    supportsLearning: true,
    performanceSummary: learning.performance_summary,
    known_weaknesses: learning.known_weaknesses,
    recommended_tests: learning.recommended_tests,
    last_learning_review_at: learning.last_learning_review_at,
    learning_notes: learning.learning_notes,
    paper_only: true,
    live_enabled: false,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
  };
}

function strategy({
  id,
  name,
  explanation,
  description_sv,
  simple_explanation_sv,
  engines_used,
  market_group,
  market,
  signal_rules,
  default_sl,
  default_stop_loss_pct,
  default_tp,
  default_take_profit_r,
  default_holding_time,
  default_holding_time_min,
  default_timeout_min,
  confidence_threshold = 65,
  default_timeframes,
  active = true,
  direction = 'both',
  is_new = false,
  family = null,
  version = null,
  learning_tags,
  required_indicators,
  optional_indicators,
  exit_rules,
  risk_notes,
}) {
  const marketGroup = market_group || market || 'all';
  const stopLoss = default_stop_loss_pct ?? default_sl;
  const takeProfit = default_take_profit_r ?? default_tp;
  const holdingTime = default_holding_time_min ?? default_holding_time;
  const timeout = default_timeout_min ?? holdingTime;
  const description = description_sv || explanation;
  return {
    id,
    name,
    market: marketGroup,
    direction,
    family: family || null,
    version: version || null,
    learning_tags: Array.isArray(learning_tags) ? learning_tags : [],
    required_indicators: Array.isArray(required_indicators) ? required_indicators : [],
    optional_indicators: Array.isArray(optional_indicators) ? optional_indicators : [],
    exit_rules: Array.isArray(exit_rules) ? exit_rules : [],
    risk_notes: risk_notes || null,
    description_sv: description,
    simple_explanation_sv: simple_explanation_sv || description,
    engines_used: engines_used || [],
    default_stop_loss_pct: stopLoss,
    default_take_profit_r: takeProfit,
    default_holding_time_min: holdingTime,
    default_timeout_min: timeout,
    confidence_threshold,
    paper_only: true,
    connected: true,
    replay_enabled: true,
    batch_enabled: true,
    live_enabled: false,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    safety_note_sv: 'Endast paper/replay/test. Strategin får inte lägga riktiga orders.',
    is_new,
    explanation: description,
    market_group: marketGroup,
    market_label: MARKET_LABELS[marketGroup] || marketGroup,
    signal_rules: signal_rules || engines_used || [],
    default_sl: stopLoss,
    default_tp: takeProfit,
    default_holding_time: holdingTime,
    default_timeframes,
    active,
  };
}

function cloneStrategyState(record = {}) {
  return {
    strategy_id: safeString(record.strategy_id || record.id),
    strategy_name: safeString(record.strategy_name || record.name || record.id),
    source: normalizeSource(record.source, 'internal'),
    status: normalizeStatus(record.status, 'paper_only'),
    enabled: record.enabled !== false,
    disabled_reason: record.disabled_reason || null,
    disabled_at: record.disabled_at || null,
    mode: safeString(record.mode) || 'paper_only',
    catalog_status: safeString(record.catalog_status || null),
    catalog_enabled: record.catalog_enabled,
    description: safeString(record.description || ''),
    performance_summary: safeObject(record.performance_summary || record.performanceSummary) || defaultPerformanceSummary(),
    known_weaknesses: safeArray(record.known_weaknesses),
    recommended_tests: safeArray(record.recommended_tests),
    last_learning_review_at: record.last_learning_review_at || null,
    learning_notes: safeArray(record.learning_notes),
    market_regime_tags: safeArray(record.market_regime_tags),
    allowed_timeframes: safeArray(record.allowed_timeframes || record.allowedTimeframes),
    entry_rules: safeArray(record.entry_rules || record.entryRules),
    exit_rules: safeArray(record.exit_rules || record.exitRules),
    updated_at: record.updated_at || null,
    created_at: record.created_at || null,
    registry_managed: record.registry_managed === true,
    ...SAFETY,
  };
}

function applyStrategyPatch(current = {}, patch = {}) {
  const next = cloneStrategyState(current);
  const source = normalizeSource(patch.source, next.source || 'internal');
  const patchEnabled = patch.enabled;
  const patchActive = patch.active;
  if (Object.prototype.hasOwnProperty.call(patch, 'strategy_name')) next.strategy_name = safeString(patch.strategy_name) || next.strategy_name;
  if (Object.prototype.hasOwnProperty.call(patch, 'source')) next.source = source;
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) next.status = normalizeStatus(patch.status, next.status);
  else if (patch.source === 'tradingview' && !patch.status) next.status = 'paper_only';
  else if ((patchEnabled === false) || (patchActive === false)) next.status = 'paused';
  if (patchEnabled != null) next.enabled = patchEnabled === true;
  else if (patchActive != null) next.enabled = patchActive === true;
  if (Object.prototype.hasOwnProperty.call(patch, 'disabled_reason')) next.disabled_reason = patch.disabled_reason || null;
  if (Object.prototype.hasOwnProperty.call(patch, 'disabled_at')) next.disabled_at = patch.disabled_at || null;
  if (Object.prototype.hasOwnProperty.call(patch, 'mode')) next.mode = safeString(patch.mode) || next.mode;
  if (Object.prototype.hasOwnProperty.call(patch, 'catalog_status')) next.catalog_status = safeString(patch.catalog_status) || null;
  if (Object.prototype.hasOwnProperty.call(patch, 'catalog_enabled')) next.catalog_enabled = patch.catalog_enabled;
  if (Object.prototype.hasOwnProperty.call(patch, 'description')) next.description = safeString(patch.description) || '';
  if (Object.prototype.hasOwnProperty.call(patch, 'performance_summary')) next.performance_summary = safeObject(patch.performance_summary) || defaultPerformanceSummary();
  if (Object.prototype.hasOwnProperty.call(patch, 'known_weaknesses')) next.known_weaknesses = safeArray(patch.known_weaknesses);
  if (Object.prototype.hasOwnProperty.call(patch, 'recommended_tests')) next.recommended_tests = safeArray(patch.recommended_tests);
  if (Object.prototype.hasOwnProperty.call(patch, 'last_learning_review_at')) next.last_learning_review_at = patch.last_learning_review_at || null;
  if (Object.prototype.hasOwnProperty.call(patch, 'learning_notes')) next.learning_notes = safeArray(patch.learning_notes);
  if (Object.prototype.hasOwnProperty.call(patch, 'market_regime_tags')) next.market_regime_tags = safeArray(patch.market_regime_tags);
  if (Object.prototype.hasOwnProperty.call(patch, 'allowed_timeframes')) next.allowed_timeframes = safeArray(patch.allowed_timeframes);
  if (Object.prototype.hasOwnProperty.call(patch, 'entry_rules')) next.entry_rules = safeArray(patch.entry_rules);
  if (Object.prototype.hasOwnProperty.call(patch, 'exit_rules')) next.exit_rules = safeArray(patch.exit_rules);
  if (Object.prototype.hasOwnProperty.call(patch, 'registry_managed')) next.registry_managed = patch.registry_managed === true;
  if (patch.created_at && !next.created_at) next.created_at = patch.created_at;
  if (patch.updated_at) next.updated_at = patch.updated_at;
  if (!next.created_at) next.created_at = patch.created_at || patch.recorded_at || null;
  if (!next.updated_at) next.updated_at = patch.updated_at || patch.recorded_at || null;
  next.paper_only = true;
  next.live_enabled = false;
  next.actions_allowed = false;
  next.can_place_orders = false;
  next.live_trading_enabled = false;
  return next;
}

function buildState() {
  const base = STRATEGIES.map((row) => normalizeStrategyRecord(row));
  const byId = new Map(base.map((row) => [row.id, { ...row, strategy_id: row.id, strategy_name: row.name || row.id }]));

  for (const record of readStateHistory()) {
    const strategyId = safeString(record.strategy_id || record.strategyId || record.id);
    if (!strategyId) continue;
    const current = byId.get(strategyId) || cloneStrategyState({ strategy_id: strategyId, strategy_name: strategyId, source: 'manual' });
    const next = applyStrategyPatch(current, {
      ...record,
      strategy_id: strategyId,
      strategy_name: record.strategy_name || record.strategyName || current.strategy_name,
    });
    byId.set(strategyId, next);
  }

  return [...byId.values()]
    .map((strategyRow) => ({
      ...strategyRow,
      id: strategyRow.strategy_id || strategyRow.id,
      name: strategyRow.strategy_name || strategyRow.name || strategyRow.strategy_id,
      status: normalizeStatus(strategyRow.status, strategyRow.enabled === false ? 'paused' : 'paper_only'),
      enabled: strategyRow.enabled !== false,
      source: normalizeSource(strategyRow.source, 'internal'),
      mode: safeString(strategyRow.mode) || 'paper_only',
      disabled_reason: strategyRow.disabled_reason || null,
      disabled_at: strategyRow.disabled_at || null,
      catalog_status: strategyRow.catalog_status || null,
      catalog_enabled: strategyRow.catalog_enabled != null ? strategyRow.catalog_enabled : strategyRow.enabled !== false,
      performanceSummary: strategyRow.performance_summary || defaultPerformanceSummary(),
      known_weaknesses: safeArray(strategyRow.known_weaknesses),
      recommended_tests: safeArray(strategyRow.recommended_tests),
      last_learning_review_at: strategyRow.last_learning_review_at || null,
      learning_notes: safeArray(strategyRow.learning_notes),
      marketRegimeTags: safeArray(strategyRow.market_regime_tags),
      allowedTimeframes: safeArray(strategyRow.allowed_timeframes),
      entryRules: safeArray(strategyRow.entry_rules),
      exitRules: safeArray(strategyRow.exit_rules),
    }))
    .sort((a, b) => String(a.name || a.id || '').localeCompare(String(b.name || b.id || '')));
}

function currentMap() {
  return new Map(buildState().map((strategy) => [strategy.id, strategy]));
}

function getBaseStrategy(strategyId) {
  const id = safeString(strategyId);
  if (!id) return null;
  return STRATEGIES.find((strategy) => strategy.id === id) || null;
}

function ensureStrategy(strategyId, defaults = {}) {
  const id = safeString(strategyId);
  if (!id) return { ok: false, error: 'strategy_id_required', ...SAFETY };
  const existing = getStrategyById(id);
  if (existing) return { ok: true, strategy: existing, created: false, ...SAFETY };

  const now = nowIso();
  const record = {
    event_id: `${id}:${now}`,
    event_type: 'strategy.registered',
    recorded_at: now,
    strategy_id: id,
    strategy_name: safeString(defaults.strategy_name || defaults.strategyName || id) || id,
    source: normalizeSource(defaults.source, 'manual'),
    status: normalizeStatus(defaults.status, 'paper_only'),
    enabled: defaults.enabled != null ? defaults.enabled === true : true,
    disabled_reason: defaults.disabled_reason || null,
    disabled_at: defaults.disabled_at || null,
    mode: safeString(defaults.mode) || 'paper_only',
    catalog_status: defaults.catalog_status || null,
    catalog_enabled: defaults.catalog_enabled != null ? defaults.catalog_enabled : null,
    description: defaults.description || '',
    performance_summary: safeObject(defaults.performance_summary || defaults.performanceSummary) || defaultPerformanceSummary(),
    known_weaknesses: safeArray(defaults.known_weaknesses),
    recommended_tests: safeArray(defaults.recommended_tests),
    last_learning_review_at: defaults.last_learning_review_at || null,
    learning_notes: safeArray(defaults.learning_notes),
    market_regime_tags: safeArray(defaults.market_regime_tags),
    allowed_timeframes: safeArray(defaults.allowed_timeframes || defaults.allowedTimeframes),
    entry_rules: safeArray(defaults.entry_rules || defaults.entryRules),
    exit_rules: safeArray(defaults.exit_rules || defaults.exitRules),
    registry_managed: defaults.registry_managed === true || normalizeSource(defaults.source, 'manual') !== 'internal',
    created_at: now,
    updated_at: now,
  };
  appendStateRecord(record);
  return { ok: true, created: true, strategy: getStrategyById(id), ...SAFETY };
}

function registerTradingViewStrategy(strategyId, defaults = {}) {
  const id = safeString(strategyId);
  if (!id) return { ok: false, error: 'strategy_id_required', ...SAFETY };
  const existing = getStrategyById(id);
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
  const current = getStrategyById(id);
  if (!current) return { ok: false, error: 'strategy_not_found', ...SAFETY };
  const now = nowIso();
  appendStateRecord({
    event_id: `${id}:pause:${now}`,
    event_type: 'strategy.paused',
    recorded_at: now,
    strategy_id: id,
    strategy_name: current.strategy_name || current.name || id,
    source: current.source || 'manual',
    status: 'paused',
    enabled: false,
    disabled_reason: safeString(reason) || 'paused',
    disabled_at: now,
    mode: current.mode || 'paper_only',
    catalog_status: current.catalog_status || null,
    catalog_enabled: current.catalog_enabled,
    description: current.description || '',
    performance_summary: current.performanceSummary || defaultPerformanceSummary(),
    known_weaknesses: current.known_weaknesses || [],
    recommended_tests: current.recommended_tests || [],
    last_learning_review_at: current.last_learning_review_at || null,
    learning_notes: current.learning_notes || [],
    market_regime_tags: current.marketRegimeTags || [],
    allowed_timeframes: current.allowedTimeframes || [],
    entry_rules: current.entryRules || [],
    exit_rules: current.exitRules || [],
    registry_managed: true,
    created_at: current.created_at || now,
    updated_at: now,
  });
  return { ok: true, strategy: getStrategyById(id), ...SAFETY };
}

function activateStrategy(strategyId) {
  const id = safeString(strategyId);
  if (!id) return { ok: false, error: 'strategy_id_required', ...SAFETY };
  const current = getStrategyById(id);
  if (!current) return { ok: false, error: 'strategy_not_found', ...SAFETY };
  const now = nowIso();
  const base = getBaseStrategy(id);
  const status = current.source === 'tradingview'
    ? 'paper_only'
    : normalizeStatus(base ? mapStatusFromCatalog(base) : current.status || 'active', 'active');
  appendStateRecord({
    event_id: `${id}:activate:${now}`,
    event_type: 'strategy.activated',
    recorded_at: now,
    strategy_id: id,
    strategy_name: current.strategy_name || current.name || id,
    source: current.source || 'manual',
    status,
    enabled: true,
    disabled_reason: null,
    disabled_at: null,
    mode: current.mode || 'paper_only',
    catalog_status: current.catalog_status || null,
    catalog_enabled: current.catalog_enabled,
    description: current.description || '',
    performance_summary: current.performanceSummary || defaultPerformanceSummary(),
    known_weaknesses: current.known_weaknesses || [],
    recommended_tests: current.recommended_tests || [],
    last_learning_review_at: current.last_learning_review_at || null,
    learning_notes: current.learning_notes || [],
    market_regime_tags: current.marketRegimeTags || [],
    allowed_timeframes: current.allowedTimeframes || [],
    entry_rules: current.entryRules || [],
    exit_rules: current.exitRules || [],
    registry_managed: true,
    created_at: current.created_at || now,
    updated_at: now,
  });
  return { ok: true, strategy: getStrategyById(id), ...SAFETY };
}

function deprecateStrategy(strategyId, reason = 'deprecated') {
  const id = safeString(strategyId);
  if (!id) return { ok: false, error: 'strategy_id_required', ...SAFETY };
  const current = getStrategyById(id);
  if (!current) return { ok: false, error: 'strategy_not_found', ...SAFETY };
  const now = nowIso();
  appendStateRecord({
    event_id: `${id}:deprecate:${now}`,
    event_type: 'strategy.deprecated',
    recorded_at: now,
    strategy_id: id,
    strategy_name: current.strategy_name || current.name || id,
    source: current.source || 'manual',
    status: 'deprecated',
    enabled: false,
    disabled_reason: safeString(reason) || 'deprecated',
    disabled_at: now,
    mode: current.mode || 'paper_only',
    catalog_status: current.catalog_status || null,
    catalog_enabled: current.catalog_enabled,
    description: current.description || '',
    performance_summary: current.performanceSummary || defaultPerformanceSummary(),
    known_weaknesses: current.known_weaknesses || [],
    recommended_tests: current.recommended_tests || [],
    last_learning_review_at: current.last_learning_review_at || null,
    learning_notes: current.learning_notes || [],
    market_regime_tags: current.marketRegimeTags || [],
    allowed_timeframes: current.allowedTimeframes || [],
    entry_rules: current.entryRules || [],
    exit_rules: current.exitRules || [],
    registry_managed: true,
    created_at: current.created_at || now,
    updated_at: now,
  });
  return { ok: true, strategy: getStrategyById(id), ...SAFETY };
}

function canForwardStrategy(strategyId) {
  const strategy = typeof strategyId === 'string' ? getStrategyById(strategyId) : strategyId;
  if (!strategy) return { allowed: false, blocked_reason: 'strategy_disabled', strategy: null, ...SAFETY };
  const status = normalizeStatus(strategy.status, 'paper_only');
  const blocked = strategy.enabled === false || status === 'paused' || status === 'deprecated';
  return {
    allowed: !blocked,
    blocked_reason: blocked ? 'strategy_disabled' : null,
    strategy,
    ...SAFETY,
  };
}

function getLatestTradingViewStrategy() {
  const strategies = buildState().filter((strategy) => strategy.source === 'tradingview');
  if (strategies.length === 0) return null;
  return strategies
    .slice()
    .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0] || null;
}

const STRATEGIES = Object.freeze([
  strategy({
    id: 'vwap_momentum_long',
    name: 'VWAP Momentum Long',
    explanation: 'Pris återtar VWAP med stark volym.',
    market_group: 'all',
    signal_rules: ['price_reclaims_vwap', 'volume_above_average', 'momentum_up', 'avoid_extended_entry'],
    default_sl: 0.18,
    default_tp: 1.6,
    default_holding_time: 8,
    default_timeframes: ['1m', '2m', '5m'],
    direction: 'long',
  }),
  strategy({
    id: 'vwap_rejection_short',
    name: 'VWAP Rejection Short',
    explanation: 'Pris avvisas vid VWAP och tappar styrka.',
    market_group: 'all',
    signal_rules: ['price_rejects_vwap', 'lower_high_near_vwap', 'volume_confirms_down_move', 'momentum_fades'],
    default_sl: 0.18,
    default_tp: 1.5,
    default_holding_time: 10,
    default_timeframes: ['1m', '2m', '5m'],
    direction: 'short',
  }),
  strategy({
    id: 'opening_range_breakout',
    name: 'Opening Range Breakout',
    explanation: 'Bryter över/under första 5/15/30 min range.',
    market_group: 'stocks',
    signal_rules: ['opening_range_defined', 'breaks_range_with_volume', 'holds_break_level', 'market_open_only'],
    default_sl: 0.28,
    default_tp: 1.8,
    default_holding_time: 25,
    default_timeframes: ['1m', '5m', '15m'],
  }),
  strategy({
    id: 'opening_range_fakeout',
    name: 'Opening Range Fakeout',
    explanation: 'Bryter range men faller tillbaka.',
    market_group: 'stocks',
    signal_rules: ['opening_range_defined', 'range_break_fails', 'closes_back_inside_range', 'volume_exhaustion'],
    default_sl: 0.24,
    default_tp: 1.4,
    default_holding_time: 15,
    default_timeframes: ['1m', '5m', '15m'],
  }),
  strategy({
    id: 'ema_pullback_continuation',
    name: 'EMA Pullback Continuation',
    explanation: 'Trend + rekyl mot EMA + fortsättning.',
    market_group: 'all',
    signal_rules: ['ema_trend_aligned', 'pullback_to_ema', 'continuation_candle', 'no_major_index_conflict'],
    default_sl: 0.22,
    default_tp: 1.7,
    default_holding_time: 18,
    default_timeframes: ['2m', '5m', '15m'],
  }),
  strategy({
    id: 'ema_breakdown',
    name: 'EMA Breakdown',
    explanation: 'Pris tappar EMA med volym.',
    market_group: 'all',
    signal_rules: ['price_loses_ema', 'volume_expands', 'lower_low_confirmed', 'avoid_chop'],
    default_sl: 0.22,
    default_tp: 1.5,
    default_holding_time: 14,
    default_timeframes: ['2m', '5m', '15m'],
    direction: 'short',
  }),
  strategy({
    id: 'narrow_breakout',
    name: 'Narrow Breakout',
    explanation: 'Lugnt läge följt av snabb rörelse.',
    market_group: 'all',
    signal_rules: ['narrow_state_detected', 'range_compression', 'breakout_candle', 'relative_volume_rising'],
    default_sl: 0.2,
    default_tp: 1.8,
    default_holding_time: 12,
    default_timeframes: ['1m', '2m', '5m'],
  }),
  strategy({
    id: 'volume_spike_momentum',
    name: 'Volume Spike Momentum',
    explanation: 'Ovanligt hög volym + snabb rörelse.',
    market_group: 'all',
    signal_rules: ['relative_volume_spike', 'fast_price_expansion', 'spread_not_extreme', 'follow_through_required'],
    default_sl: 0.2,
    default_tp: 1.6,
    default_holding_time: 7,
    default_timeframes: ['1m', '2m', '5m'],
  }),
  strategy({
    id: 'vwap_volume_breakout_long',
    name: 'VWAP Volume Breakout Long',
    description_sv: 'Pris bryter upp över VWAP med stark volym.',
    simple_explanation_sv: 'Systemet letar efter när priset går över en viktig nivå och många köpare kommer in samtidigt.',
    engines_used: ['VWAP-återtagning', 'Volymtopp', 'Stark rörelse'],
    market: 'all',
    direction: 'long',
    signal_rules: ['price_breaks_above_vwap', 'volume_spike', 'strong_move_up'],
    default_stop_loss_pct: 0.18,
    default_take_profit_r: 1.5,
    default_holding_time_min: 8,
    default_timeout_min: 8,
    confidence_threshold: 65,
    default_timeframes: ['1m', '2m', '5m'],
    is_new: true,
  }),
  strategy({
    id: 'vwap_failed_breakout_short',
    name: 'VWAP Failed Breakout Short',
    description_sv: 'Pris försöker bryta över VWAP men faller snabbt tillbaka.',
    simple_explanation_sv: 'Systemet letar efter falska uppgångar där priset tappar styrka.',
    engines_used: ['VWAP-avvisning', 'Volymtopp', 'Rekyl/medelvärde'],
    market: 'all',
    direction: 'short',
    signal_rules: ['vwap_breakout_fails', 'volume_spike', 'mean_reversion_down'],
    default_stop_loss_pct: 0.2,
    default_take_profit_r: 1.4,
    default_holding_time_min: 8,
    default_timeout_min: 8,
    confidence_threshold: 65,
    default_timeframes: ['1m', '2m', '5m'],
    is_new: true,
  }),
  strategy({
    id: 'narrow_state_expansion_long',
    name: 'Narrow State Expansion Long',
    description_sv: 'Lugnt och ihoptryckt pris bryter upp med stark volym.',
    simple_explanation_sv: 'Systemet väntar på att priset ska vara lugnt först och sedan röra sig starkt uppåt.',
    engines_used: ['Narrow State', 'Utbrott', 'Volymtopp', 'Stark rörelse'],
    market: 'all',
    direction: 'long',
    signal_rules: ['narrow_state_detected', 'upside_breakout', 'volume_spike', 'strong_move_up'],
    default_stop_loss_pct: 0.2,
    default_take_profit_r: 1.7,
    default_holding_time_min: 10,
    default_timeout_min: 10,
    confidence_threshold: 68,
    default_timeframes: ['1m', '2m', '5m'],
    is_new: true,
  }),
  strategy({
    id: 'narrow_state_fakeout_reversal',
    name: 'Narrow State Fakeout Reversal',
    description_sv: 'Pris bryter ut från narrow state men vänder snabbt tillbaka.',
    simple_explanation_sv: 'Systemet letar efter falska utbrott där priset lurar marknaden och sedan vänder.',
    engines_used: ['Narrow State', 'Utbrott', 'Rekyl/medelvärde'],
    market: 'all',
    direction: 'both',
    signal_rules: ['narrow_state_detected', 'breakout_fails', 'mean_reversion'],
    default_stop_loss_pct: 0.22,
    default_take_profit_r: 1.3,
    default_holding_time_min: 8,
    default_timeout_min: 8,
    confidence_threshold: 66,
    default_timeframes: ['1m', '2m', '5m'],
    is_new: true,
  }),
  // ── Narrow State-first family (v2 research strategies) ──────────────────────
  strategy({
    id: 'narrow_breakout_v1',
    name: 'Narrow Breakout Strategy',
    family: 'narrow_state',
    version: 'v1',
    description_sv: 'Testar om priset bryter ut efter compression (narrow state). Long över rangeHigh, short under rangeLow, med volym- och VWAP-bekräftelse.',
    simple_explanation_sv: 'Systemet väntar på att priset är väldigt lugnt och ihoptryckt och testar sedan utbrottet uppåt eller nedåt.',
    engines_used: ['Narrow State', 'Compression', 'Range Breakout', 'Volym', 'VWAP'],
    market: 'all',
    direction: 'both',
    signal_rules: ['narrow_state_detected', 'narrow_score_gte_60', 'price_breaks_range', 'volume_or_relvol_confirms', 'vwap_side_aligned', 'rsi_side_aligned'],
    required_indicators: ['narrowState', 'atr', 'range'],
    optional_indicators: ['vwap', 'rsi', 'volume', 'relativeVolume', 'ema'],
    exit_rules: ['stop_loss_inside_range', 'take_profit_r_multiple', 'exit_on_range_reentry', 'time_based_exit'],
    risk_notes: 'Endast paper/replay/test. Stop precis innanför range. Undvik om compression redan brutit (breakoutAlreadyOccurred).',
    learning_tags: ['narrow_state', 'breakout', 'compression', 'range_break'],
    default_stop_loss_pct: 0.2,
    default_take_profit_r: 1.8,
    default_holding_time_min: 12,
    default_timeout_min: 12,
    confidence_threshold: 65,
    default_timeframes: ['1m', '2m', '5m'],
    is_new: true,
  }),
  strategy({
    id: 'narrow_fakeout_reversal_v1',
    name: 'Narrow Fakeout Reversal Strategy',
    family: 'narrow_state',
    version: 'v1',
    description_sv: 'Testar falska breakouts efter narrow state. Pris bryter rangeHigh/rangeLow men återvänder snabbt in i range — reversal mot VWAP/rangeMid.',
    simple_explanation_sv: 'Systemet letar efter falska utbrott där priset lurar marknaden och snabbt vänder tillbaka in i lugnzonen.',
    engines_used: ['Narrow State', 'Fakeout', 'Range Reversal', 'VWAP', 'Volym'],
    market: 'all',
    direction: 'both',
    signal_rules: ['narrow_state_detected', 'narrow_score_gte_60', 'range_break_fails', 'fast_reentry_into_range', 'volume_not_confirming_breakout', 'reversal_toward_vwap_or_mid'],
    required_indicators: ['narrowState', 'atr', 'range'],
    optional_indicators: ['vwap', 'rsi', 'volume', 'relativeVolume'],
    exit_rules: ['stop_loss_outside_range', 'target_vwap_or_range_mid', 'target_opposite_range_edge', 'time_based_exit'],
    risk_notes: 'Endast paper/replay/test. Kräver tydlig återgång in i range och svag breakout-volym.',
    learning_tags: ['narrow_state', 'fakeout', 'reversal', 'mean_reversion'],
    default_stop_loss_pct: 0.22,
    default_take_profit_r: 1.3,
    default_holding_time_min: 8,
    default_timeout_min: 8,
    confidence_threshold: 66,
    default_timeframes: ['1m', '2m', '5m'],
    is_new: true,
  }),
  strategy({
    id: 'narrow_vwap_mean_reversion_v1',
    name: 'Narrow VWAP Mean Reversion Strategy',
    family: 'narrow_state',
    version: 'v1',
    description_sv: 'Testar om priset återgår till VWAP/rangeMid under narrow market. Long nära rangeLow, short nära rangeHigh när breakout saknar bekräftelse.',
    simple_explanation_sv: 'Systemet köper nära kanten av lugnzonen och siktar på att priset återgår till mitten/VWAP.',
    engines_used: ['Narrow State', 'VWAP', 'Mean Reversion', 'Range'],
    market: 'all',
    direction: 'both',
    signal_rules: ['narrow_state_detected', 'narrow_score_gte_60', 'price_near_range_edge', 'breakout_lacks_confirmation', 'vwap_present', 'reversal_candle_or_rsi_shift'],
    required_indicators: ['narrowState', 'atr', 'range', 'vwap'],
    optional_indicators: ['rsi', 'volume', 'ema'],
    exit_rules: ['stop_loss_outside_range', 'target_vwap', 'target_range_mid', 'time_based_exit'],
    risk_notes: 'Endast paper/replay/test. Kräver VWAP-data; undvik vid stark trend eller 3-finger spread.',
    learning_tags: ['narrow_state', 'mean_reversion', 'vwap', 'range_edge'],
    default_stop_loss_pct: 0.2,
    default_take_profit_r: 1.4,
    default_holding_time_min: 10,
    default_timeout_min: 10,
    confidence_threshold: 64,
    default_timeframes: ['1m', '2m', '5m'],
    is_new: true,
  }),
  strategy({
    id: 'volume_spike_continuation',
    name: 'Volume Spike Continuation',
    description_sv: 'Ovanligt hög volym följs av fortsatt rörelse i samma riktning.',
    simple_explanation_sv: 'Systemet letar efter stark volym som fortsätter driva priset.',
    engines_used: ['Volymtopp', 'Stark rörelse', 'Utbrott'],
    market: 'all',
    direction: 'both',
    signal_rules: ['volume_spike', 'strong_directional_move', 'breakout_follow_through'],
    default_stop_loss_pct: 0.18,
    default_take_profit_r: 1.5,
    default_holding_time_min: 7,
    default_timeout_min: 7,
    confidence_threshold: 65,
    default_timeframes: ['1m', '2m', '5m'],
    is_new: true,
  }),
  strategy({
    id: 'pullback_to_vwap_long',
    name: 'Pullback To VWAP Long',
    description_sv: 'Pris är i upptrend, går tillbaka till VWAP och studsar upp.',
    simple_explanation_sv: 'Systemet väntar på en liten paus i en uppgång och försöker hitta ny fortsättning upp.',
    engines_used: ['VWAP-återtagning', 'EMA-trend', 'EMA-rekyl'],
    market: 'all',
    direction: 'long',
    signal_rules: ['ema_trend_aligned', 'pullback_to_vwap', 'vwap_bounce_up'],
    default_stop_loss_pct: 0.2,
    default_take_profit_r: 1.4,
    default_holding_time_min: 10,
    default_timeout_min: 10,
    confidence_threshold: 64,
    default_timeframes: ['2m', '5m', '15m'],
    is_new: true,
  }),
  strategy({
    id: 'trend_exhaustion_short',
    name: 'Trend Exhaustion Short',
    description_sv: 'Pris har gått starkt upp men börjar tappa kraft.',
    simple_explanation_sv: 'Systemet letar efter när en uppgång börjar bli trött och kan vända ner.',
    engines_used: ['Stark rörelse', 'Rekyl/medelvärde', 'Volymtopp'],
    market: 'all',
    direction: 'short',
    signal_rules: ['strong_move_up', 'momentum_exhaustion', 'volume_spike_exhaustion'],
    default_stop_loss_pct: 0.22,
    default_take_profit_r: 1.3,
    default_holding_time_min: 8,
    default_timeout_min: 8,
    confidence_threshold: 67,
    default_timeframes: ['1m', '2m', '5m'],
    is_new: true,
  }),
  strategy({
    id: 'index_supported_momentum_long',
    name: 'Index Supported Momentum Long',
    description_sv: 'Aktie visar momentum upp samtidigt som QQQ/SPY stödjer rörelsen.',
    simple_explanation_sv: 'Systemet tar bara aktiesignaler när stora index också hjälper till.',
    engines_used: ['Stark rörelse', 'Volymtopp', 'Indexbekräftelse'],
    market: 'stocks',
    direction: 'long',
    signal_rules: ['stock_momentum_up', 'volume_spike', 'qqq_or_spy_confirms'],
    default_stop_loss_pct: 0.2,
    default_take_profit_r: 1.5,
    default_holding_time_min: 8,
    default_timeout_min: 8,
    confidence_threshold: 66,
    default_timeframes: ['1m', '2m', '5m'],
    is_new: true,
  }),
  strategy({
    id: 'crypto_fast_momentum',
    name: 'Crypto Fast Momentum',
    description_sv: 'Krypto rör sig snabbt med stark volym och kort hålltid.',
    simple_explanation_sv: 'Systemet letar efter snabba kryptorörelser och försöker stänga tidigt.',
    engines_used: ['Stark rörelse', 'Volymtopp', 'Utbrott'],
    market: 'crypto',
    direction: 'both',
    signal_rules: ['crypto_symbol', 'fast_momentum', 'volume_spike', 'breakout'],
    default_stop_loss_pct: 0.2,
    default_take_profit_r: 1.3,
    default_holding_time_min: 6,
    default_timeout_min: 6,
    confidence_threshold: 65,
    default_timeframes: ['1m', '2m', '5m'],
    is_new: true,
  }),
  strategy({
    id: 'opening_range_retest_long',
    name: 'Opening Range Retest Long',
    description_sv: 'Pris bryter opening range, testar nivån igen och fortsätter upp.',
    simple_explanation_sv: 'Systemet väntar inte bara på första utbrottet, utan även på att priset bekräftar nivån igen.',
    engines_used: ['Opening Range', 'Utbrott', 'Volymtopp', 'Stark rörelse'],
    market: 'stocks',
    direction: 'long',
    signal_rules: ['opening_range_defined', 'breaks_range_with_volume', 'retests_break_level', 'strong_move_up'],
    default_stop_loss_pct: 0.22,
    default_take_profit_r: 1.6,
    default_holding_time_min: 15,
    default_timeout_min: 15,
    confidence_threshold: 67,
    default_timeframes: ['1m', '5m', '15m'],
    is_new: true,
  }),
  strategy({
    id: 'mean_reversion_vwap',
    name: 'Mean Reversion VWAP',
    explanation: 'Överreaktion tillbaka mot VWAP.',
    market_group: 'all',
    signal_rules: ['price_extended_from_vwap', 'momentum_exhaustion', 'reversal_candle', 'target_vwap_mean'],
    default_sl: 0.25,
    default_tp: 1.3,
    default_holding_time: 16,
    default_timeframes: ['2m', '5m', '15m'],
  }),
  strategy({
    id: 'trend_continuation',
    name: 'Trend Continuation',
    explanation: 'Stark trend + paus + fortsättning.',
    market_group: 'all',
    signal_rules: ['trend_confirmed', 'pause_or_flag', 'breaks_pause_in_trend_direction', 'volume_not_weak'],
    default_sl: 0.24,
    default_tp: 1.8,
    default_holding_time: 22,
    default_timeframes: ['5m', '15m', '30m'],
  }),
  strategy({
    id: 'support_bounce',
    name: 'Support Bounce',
    explanation: 'Studs från stöd.',
    market_group: 'all',
    signal_rules: ['support_zone_identified', 'rejection_wick_or_hold', 'buyers_step_in', 'risk_defined_below_support'],
    default_sl: 0.22,
    default_tp: 1.5,
    default_holding_time: 18,
    default_timeframes: ['2m', '5m', '15m'],
    direction: 'long',
  }),
  strategy({
    id: 'resistance_rejection',
    name: 'Resistance Rejection',
    explanation: 'Avvisning från motstånd.',
    market_group: 'all',
    signal_rules: ['resistance_zone_identified', 'failed_break_or_rejection', 'sellers_step_in', 'risk_defined_above_resistance'],
    default_sl: 0.22,
    default_tp: 1.5,
    default_holding_time: 18,
    default_timeframes: ['2m', '5m', '15m'],
    direction: 'short',
  }),
  strategy({
    id: 'index_confirmed_long',
    name: 'Index Confirmed Long',
    explanation: 'Aktie long bara om QQQ/SPY stödjer.',
    market_group: 'stocks',
    signal_rules: ['stock_long_setup', 'qqq_or_spy_bullish', 'index_not_breaking_down', 'market_compass_aligned'],
    default_sl: 0.24,
    default_tp: 1.7,
    default_holding_time: 20,
    default_timeframes: ['2m', '5m', '15m'],
    direction: 'long',
  }),
  strategy({
    id: 'index_confirmed_short',
    name: 'Index Confirmed Short',
    explanation: 'Aktie short om QQQ/SPY är svag.',
    market_group: 'stocks',
    signal_rules: ['stock_short_setup', 'qqq_or_spy_bearish', 'index_not_reclaiming', 'market_compass_aligned'],
    default_sl: 0.24,
    default_tp: 1.7,
    default_holding_time: 20,
    default_timeframes: ['2m', '5m', '15m'],
    direction: 'short',
  }),
  strategy({
    id: 'crypto_momentum_scalper',
    name: 'Crypto Momentum Scalper',
    explanation: 'Krypto + stark volym + kort hålltid.',
    market_group: 'crypto',
    signal_rules: ['crypto_symbol', 'strong_relative_volume', 'fast_momentum', 'short_hold_only'],
    default_sl: 0.2,
    default_tp: 1.4,
    default_holding_time: 6,
    default_timeframes: ['1m', '2m', '5m'],
  }),
  strategy({
    id: 'low_volatility_breakout',
    name: 'Low Volatility Breakout',
    explanation: 'Låg volatilitet -> breakout.',
    market_group: 'all',
    signal_rules: ['low_volatility_regime', 'tight_range', 'range_break', 'volume_expansion'],
    default_sl: 0.18,
    default_tp: 1.9,
    default_holding_time: 16,
    default_timeframes: ['2m', '5m', '15m'],
  }),
  strategy({
    id: 'high_volatility_reversal',
    name: 'High Volatility Reversal',
    explanation: 'Hög volatilitet -> reversal.',
    market_group: 'all',
    signal_rules: ['high_volatility_regime', 'exhaustion_move', 'failed_follow_through', 'reversal_confirmation'],
    default_sl: 0.32,
    default_tp: 1.25,
    default_holding_time: 10,
    default_timeframes: ['1m', '2m', '5m'],
  }),
  strategy({
    id: 'gap_continuation',
    name: 'Gap Continuation',
    explanation: 'Gap upp/ned fortsätter.',
    market_group: 'stocks',
    signal_rules: ['opening_gap', 'gap_holds', 'volume_confirms_direction', 'no_immediate_fade'],
    default_sl: 0.3,
    default_tp: 1.7,
    default_holding_time: 30,
    default_timeframes: ['5m', '15m', '30m'],
  }),
  strategy({
    id: 'gap_fade',
    name: 'Gap Fade',
    explanation: 'Gap upp/ned fylls tillbaka.',
    market_group: 'stocks',
    signal_rules: ['opening_gap', 'failed_continuation', 'moves_back_toward_prior_close', 'volume_fade_or_reversal'],
    default_sl: 0.28,
    default_tp: 1.35,
    default_holding_time: 22,
    default_timeframes: ['2m', '5m', '15m'],
  }),
  strategy({
    id: 'news_volatility_watch',
    name: 'News Volatility Watch',
    explanation: 'Hög volatilitet efter nyhet, paper-test only.',
    market_group: 'all',
    signal_rules: ['news_or_event_volatility', 'wide_spreads_checked', 'paper_observation_only', 'no_live_execution'],
    default_sl: 0.35,
    default_tp: 1.2,
    default_holding_time: 8,
    default_timeframes: ['1m', '2m', '5m'],
    active: false,
  }),
  strategy({
    id: 'gold_sigma',
    name: 'GoldSigma',
    explanation: 'EMA 9/39/81 pullback on Gold. Long bias in bull trend. +48% backtest 2020-2026.',
    market_group: 'all',
    signal_rules: ['ema_9_39_81_aligned', 'pullback_to_ema9', 'green_candle', 'volume_above_average'],
    default_sl: 1.0,
    default_tp: 2.0,
    default_holding_time: 20,
    default_timeframes: ['5m'],
    direction: 'long',
    status: 'experimental',
  }),
  strategy({
    id: 'vol_expansion',
    name: 'VolExpansion',
    explanation: 'BB squeeze then expansion + EMA trend + RSI filter. +17.9% backtest, 572 trades.',
    market_group: 'crypto',
    signal_rules: ['bb_squeeze_detected', 'bb_expansion_starts', 'ema_trend_aligned', 'rsi_in_range', 'atr_expanding'],
    default_sl: 5.0,
    default_tp: 8.0,
    default_holding_time: 120,
    default_timeframes: ['1h'],
    status: 'experimental',
  }),
  strategy({
    id: 'gold_swing',
    name: 'GoldSwing',
    explanation: 'EMA pullback in trend, wider parameters than GoldSigma. +10-40% backtest.',
    market_group: 'all',
    signal_rules: ['ema_trend_aligned', 'pullback_to_fast_ema', 'volume_ok'],
    default_sl: 1.5,
    default_tp: 3.0,
    default_holding_time: 25,
    default_timeframes: ['5m'],
    status: 'experimental',
  }),
  strategy({
    id: 'iron_scalper',
    name: 'IronScalper',
    explanation: 'EMA alignment + RSI 40-60 + volume spike. Works on any asset. +2-15% backtest.',
    market_group: 'all',
    signal_rules: ['ema_trend_aligned', 'rsi_neutral_zone', 'volume_spike'],
    default_sl: 0.5,
    default_tp: 1.0,
    default_holding_time: 8,
    default_timeframes: ['5m'],
    status: 'experimental',
  }),
  strategy({
    id: 'rsi_divergence',
    name: 'RSI Divergence',
    explanation: 'Price new high/low but RSI does not. Expected 60-65% win rate.',
    market_group: 'all',
    signal_rules: ['price_new_extreme', 'rsi_diverges', 'confirmation_candle'],
    default_sl: 1.5,
    default_tp: 3.0,
    default_holding_time: 60,
    default_timeframes: ['1h'],
    status: 'experimental',
  }),
  strategy({
    id: 'vwap_momentum_v2',
    name: 'VWAP Momentum v2',
    explanation: 'Price reclaims or rejects VWAP with volume spike 2x+. Upgraded VWAP setup.',
    market_group: 'all',
    signal_rules: ['price_crosses_vwap', 'volume_2x_average', 'momentum_candle'],
    default_sl: 0.15,
    default_tp: 1.5,
    default_holding_time: 12,
    default_timeframes: ['5m'],
    status: 'experimental',
  }),
  strategy({
    id: 'orb_session',
    name: 'Opening Range Breakout (Session)',
    explanation: 'Break of first 30min high/low. London 08:00 UTC / NY 13:30 UTC.',
    market_group: 'stocks',
    signal_rules: ['session_open_detected', 'range_30min_defined', 'breaks_range_with_volume'],
    default_sl: 0.2,
    default_tp: 0.5,
    default_holding_time: 20,
    default_timeframes: ['5m'],
    status: 'experimental',
  }),
  strategy({
    id: 'bb_squeeze',
    name: 'Bollinger Band Squeeze',
    explanation: 'BB width narrows then expands with volume. One of the most reliable setups.',
    market_group: 'all',
    signal_rules: ['bb_squeeze_detected', 'bb_expansion_starts', 'volume_above_average'],
    default_sl: 1.0,
    default_tp: 2.0,
    default_holding_time: 40,
    default_timeframes: ['15m'],
    status: 'experimental',
  }),
  strategy({
    id: 'supertrend',
    name: 'Supertrend',
    explanation: 'Supertrend flips direction. ATR multiplier 3.0, period 10. Simple and effective.',
    market_group: 'all',
    signal_rules: ['supertrend_flips_direction', 'atr_confirms'],
    default_sl: 0,
    default_tp: 3.0,
    default_holding_time: 120,
    default_timeframes: ['1h'],
    status: 'experimental',
  }),
  strategy({
    id: 'macd_volume',
    name: 'MACD + Volume',
    explanation: 'MACD histogram crosses zero with volume confirmation. Classic with volume filter.',
    market_group: 'crypto',
    signal_rules: ['macd_crosses_zero', 'volume_above_20bar_avg'],
    default_sl: 1.0,
    default_tp: 2.5,
    default_holding_time: 120,
    default_timeframes: ['1h'],
    status: 'experimental',
  }),
  strategy({
    id: 'sr_break',
    name: 'Support/Resistance Break',
    explanation: 'Key level break with strong candle + volume 1.5x+. High probability setup.',
    market_group: 'all',
    signal_rules: ['key_level_identified', 'breaks_with_strong_candle', 'volume_1_5x_avg'],
    default_sl: 1.0,
    default_tp: 2.0,
    default_holding_time: 45,
    default_timeframes: ['15m'],
    status: 'experimental',
  }),
  strategy({
    id: 'fvg',
    name: 'Fair Value Gap (FVG)',
    explanation: 'Price fills institutional imbalance zone. Smart money concept.',
    market_group: 'all',
    signal_rules: ['fvg_identified', 'price_retraces_to_fvg', 'confirmation_candle'],
    default_sl: 1.0,
    default_tp: 2.0,
    default_holding_time: 45,
    default_timeframes: ['15m'],
    status: 'experimental',
  }),
  strategy({
    id: 'smc',
    name: 'Smart Money Concepts',
    explanation: 'Break of structure + order block retest. Institutional trading concepts.',
    market_group: 'all',
    signal_rules: ['break_of_structure', 'order_block_identified', 'price_retests_ob'],
    default_sl: 1.5,
    default_tp: 3.0,
    default_holding_time: 120,
    default_timeframes: ['1h'],
    status: 'experimental',
  }),
  strategy({
    id: 'mean_reversion_us30',
    name: 'MeanReversion US30',
    explanation: 'Price deviates from VWAP then returns. +11% backtest on US30.',
    market_group: 'index',
    signal_rules: ['price_far_from_vwap', 'rsi_oversold_or_overbought', 'reversal_candle'],
    default_sl: 1.0,
    default_tp: 1.5,
    default_holding_time: 45,
    default_timeframes: ['15m'],
    status: 'experimental',
  }),
  strategy({
    id: 'ema_pullback_v2',
    name: 'EMA Pullback Continuation v2',
    explanation: 'EMA9 > EMA21 > EMA50 triple alignment. Pullback to EMA9 and bounce.',
    market_group: 'all',
    signal_rules: ['triple_ema_aligned', 'pullback_to_ema9', 'bounce_candle', 'volume_ok'],
    default_sl: 0.5,
    default_tp: 1.5,
    default_holding_time: 20,
    default_timeframes: ['5m'],
    status: 'experimental',
  }),
]);

function getCatalog() {
  const strategies = buildState();
  return {
    ok: true,
    strategies,
    count: strategies.length,
    market_groups: Object.keys(MARKET_LABELS),
    timeframes: ['1m', '2m', '5m', '15m', '30m', '1h'],
    adjustable_parameters: [
      'stop_loss_pct',
      'take_profit_r',
      'holding_time',
      'timeout',
      'confidence_threshold',
      'volume_requirement',
      'cooldown',
      'max_trades_per_day',
      'market_group',
      'timeframe',
    ],
    ...SAFETY,
  };
}

function getStrategyById(id) {
  const key = safeString(id);
  if (!key) return null;
  const strategy = currentMap().get(key) || null;
  return strategy ? { ...strategy } : null;
}

function inferStrategyForSignal(signal = {}) {
  const subtype = String(signal.signalSubtype || signal.eventType || signal.signalFamily || '').toUpperCase();
  const family = String(signal.signalFamily || '').toUpperCase();
  const state = String(signal.state || '').toUpperCase();
  const symbol = String(signal.symbol || '').toUpperCase();
  const sig = String(signal.signal || '').toUpperCase();
  const marketType = String(signal.marketType || signal.market || '').toLowerCase();

  if (marketType === 'crypto' || symbol.endsWith('USDT')) return getStrategyById('crypto_momentum_scalper');
  if (subtype.includes('VWAP_RECLAIM') || (family.includes('VWAP') && sig.includes('LONG'))) return getStrategyById('vwap_volume_breakout_long');
  if (subtype.includes('VWAP_REJECTION') || (family.includes('VWAP') && sig.includes('SHORT'))) return getStrategyById('vwap_failed_breakout_short');
  if (subtype.includes('EMA_PULLBACK')) return getStrategyById('ema_pullback_continuation');
  if (family.includes('EMA') && sig.includes('SHORT')) return getStrategyById('ema_breakdown');
  if (family.includes('NARROW') || state.includes('NARROW')) return getStrategyById('narrow_breakout');
  if (family.includes('BREAKOUT')) return getStrategyById('low_volatility_breakout');
  if (family.includes('MOMENTUM')) return getStrategyById('volume_spike_momentum');
  if (family.includes('REVERSION') || family.includes('REVERSAL')) return getStrategyById('mean_reversion_vwap');
  if (sig.includes('SHORT')) return getStrategyById('resistance_rejection');
  if (sig.includes('LONG')) return getStrategyById('support_bounce');
  return getStrategyById('trend_continuation');
}

function getStatus() {
  const strategies = buildState();
  const latestTradingViewStrategy = getLatestTradingViewStrategy();
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
    strategies,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  STRATEGIES,
  getCatalog,
  getStrategyById,
  inferStrategyForSignal,
  getStatus,
  ensureStrategy,
  registerTradingViewStrategy,
  pauseStrategy,
  activateStrategy,
  deprecateStrategy,
  canForwardStrategy,
  getLatestTradingViewStrategy,
  normalizeStatus,
  normalizeSource,
  mapStatusFromCatalog,
  readStateHistory,
};
