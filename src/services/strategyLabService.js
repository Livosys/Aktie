'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const redisService = require('./redisService');
const { runReplay } = require('../scanner/replayEngine');
const replayIntelligenceService = require('./replayIntelligenceService');
const tradingAgentsAdapterService = require('./tradingAgentsAdapterService');

const KEYS = Object.freeze({
  config: 'strategy:config',
  presets: 'strategy:presets',
  activePreset: 'strategy:active_preset',
  latestTest: 'strategy:test:latest',
  testPrefix: 'strategy:test:',
  latestCompare: 'strategy:compare:latest',
  lastPipeline: 'strategy:pipeline:last',
});

const METHOD_NAMES = [
  'ema_filter', 'narrow_state', 'vwap_reclaim', 'vwap_rejection',
  'market_compass', 'market_gate', 'ai_agent', 'memory', 'trading_agents',
  'risk_engine', 'execution_safety', 'exit_engine', 'notification_engine',
  'volume_strength', 'data_freshness', 'market_group', 'cooldown',
];

const STRATEGY_DATA_DIR = path.resolve(__dirname, '../../data/strategy-lab');
const STRATEGY_CONFIG_FILE = path.join(STRATEGY_DATA_DIR, 'config-v1.json');
const STRATEGY_PRESETS_FILE = path.join(STRATEGY_DATA_DIR, 'presets-v1.json');
const STRATEGY_RESULTS_DIR = path.join(STRATEGY_DATA_DIR, 'results');

function nowIso() { return new Date().toISOString(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function pct(part, total) {
  return total ? round((part / total) * 100, 2) : 0;
}

// ── Strategy Lab v1 ──────────────────────────────────────────────────────────

const V1_ALLOWED_FIELDS = Object.freeze({
  risk: new Set(['enabled', 'risk_per_trade_pct', 'max_position_pct', 'max_daily_loss_pct', 'max_trades_per_day', 'min_confidence', 'max_spread_pct', 'max_consecutive_losses']),
  exit: new Set(['enabled', 'near_target_ratio', 'near_target_min_profit_pct', 'trailing_distance_pct', 'trail_after_profit_pct', 'break_even_after_profit_pct', 'max_hold_minutes_default', 'min_target_pct', 'max_target_pct']),
  memory: new Set(['enabled', 'min_sample_size', 'bad_setup_winrate_threshold', 'max_positive_adjustment', 'max_negative_adjustment', 'block_enabled']),
  agent: new Set(['enabled', 'confidence_adjustment_enabled', 'max_positive_adjustment', 'max_negative_adjustment', 'allow_agent_block']),
  execution_safety: new Set(['enabled', 'block_on_provider_down', 'block_on_system_health_bad', 'block_on_market_closed', 'block_on_redis_down']),
});

const V1_FORBIDDEN_FIELDS = new Set([
  'live_trading_enabled', 'allow_live_orders', 'place_orders', 'order_execution',
  'broker', 'api_key', 'token', 'secret', 'password', 'private_key',
]);

const V1_DEFAULT_CONFIG = {
  active_preset: 'crypto_vwap_v3_safe',
  market_scope: ['CRYPTO_MAJOR', 'US_STOCKS', 'INDEX_ETF'],
  methods: Object.fromEntries(METHOD_NAMES.map((method) => [method, { enabled: method !== 'ema_filter' }])),
  thresholds: {
    gate_normal: 70,
    gate_conservative: 80,
    gate_observe: 55,
    min_confidence: 65,
    min_volume_strength: 'normal',
    max_spread_pct: 0.25,
  },
  exit: {},
  risk: {},
  memory: {},
  agent: {},
  execution_safety: {},
  replay_mode: true,
  paper_only: true,
  live_trading_enabled: false,
};

function v1EnsureStorage() {
  if (!fs.existsSync(STRATEGY_DATA_DIR)) fs.mkdirSync(STRATEGY_DATA_DIR, { recursive: true });
  if (!fs.existsSync(STRATEGY_RESULTS_DIR)) fs.mkdirSync(STRATEGY_RESULTS_DIR, { recursive: true });
}

function v1ReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function v1WriteJson(file, value) {
  v1EnsureStorage();
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function v1ValidatePatch(input = {}) {
  const obj = input && typeof input === 'object' ? input : {};
  const rejected = {};
  for (const key of Object.keys(obj)) {
    if (V1_FORBIDDEN_FIELDS.has(key)) { rejected[key] = 'unsafe_field'; continue; }
    if (key === 'mode' && String(obj[key]).toLowerCase() === 'live') { rejected[key] = 'unsafe_field'; continue; }
  }
  for (const [section, allowed] of Object.entries(V1_ALLOWED_FIELDS)) {
    const patch = obj[section];
    if (!patch || typeof patch !== 'object') continue;
    for (const field of Object.keys(patch)) {
      if (V1_FORBIDDEN_FIELDS.has(field)) { rejected[`${section}.${field}`] = 'unsafe_field'; continue; }
      if (!allowed.has(field)) { rejected[`${section}.${field}`] = 'field_not_allowed'; }
    }
  }
  return { ok: Object.keys(rejected).length === 0, rejected };
}

function v1NormalizeConfig(input = {}) {
  const out = clone(V1_DEFAULT_CONFIG);
  if (input.active_preset) out.active_preset = String(input.active_preset);
  if (Array.isArray(input.market_scope) && input.market_scope.length) out.market_scope = input.market_scope.map(String);
  out.thresholds = { ...out.thresholds, ...(input.thresholds || {}) };
  for (const [section, allowed] of Object.entries(V1_ALLOWED_FIELDS)) {
    const patch = input[section] && typeof input[section] === 'object' ? input[section] : {};
    out[section] = out[section] || {};
    for (const field of allowed) {
      if (field in patch) out[section][field] = patch[field];
    }
  }
  for (const method of METHOD_NAMES) {
    out.methods[method] = { ...(out.methods[method] || {}), ...(input.methods?.[method] || {}) };
    out.methods[method].enabled = out.methods[method].enabled !== false;
  }
  out.replay_mode = true;
  out.paper_only = true;
  out.live_trading_enabled = false;
  return out;
}

function v1MergeConfig(current, patch = {}) {
  const next = clone(current || V1_DEFAULT_CONFIG);
  if (patch.active_preset) next.active_preset = String(patch.active_preset);
  if (Array.isArray(patch.market_scope)) next.market_scope = patch.market_scope;
  if (patch.thresholds && typeof patch.thresholds === 'object') next.thresholds = { ...next.thresholds, ...patch.thresholds };
  for (const section of Object.keys(V1_ALLOWED_FIELDS)) {
    if (patch[section] && typeof patch[section] === 'object') next[section] = { ...next[section], ...patch[section] };
  }
  if (patch.methods && typeof patch.methods === 'object') {
    for (const method of METHOD_NAMES) {
      if (patch.methods[method] && typeof patch.methods[method] === 'object') {
        next.methods[method] = { ...(next.methods[method] || {}), ...patch.methods[method] };
      }
    }
  }
  return v1NormalizeConfig(next);
}

function v1Preset(id, label, patch) {
  return { id, label, config: v1MergeConfig(V1_DEFAULT_CONFIG, { active_preset: id, ...patch }) };
}

function v1DefaultPresets() {
  return [
    v1Preset('crypto_vwap_v3_safe', 'Crypto VWAP v3 safe', { market_scope: ['CRYPTO_MAJOR'], thresholds: { min_confidence: 65, gate_normal: 70 } }),
    v1Preset('crypto_vwap_aggressive', 'Crypto VWAP aggressive', { market_scope: ['CRYPTO_MAJOR'], thresholds: { min_confidence: 55, gate_normal: 62 } }),
    v1Preset('crypto_narrow_state', 'Crypto narrow state', { market_scope: ['CRYPTO_MAJOR'], methods: { vwap_reclaim: { enabled: false }, vwap_rejection: { enabled: false }, narrow_state: { enabled: true } } }),
    v1Preset('stocks_conservative', 'Stocks conservative', { market_scope: ['US_STOCKS'], thresholds: { min_confidence: 72, gate_normal: 78, max_spread_pct: 0.18 } }),
    v1Preset('index_etf_normal', 'Index ETF normal', { market_scope: ['INDEX_ETF', 'INDEX_ETFS'], thresholds: { min_confidence: 62, gate_normal: 68 } }),
    v1Preset('leveraged_etf_safe', 'Leveraged ETF safe', { market_scope: ['LEVERAGED_ETF', 'LEVERAGED_ETFS'], thresholds: { min_confidence: 75, gate_normal: 82 } }),
    v1Preset('mixed_market_defensive', 'Mixed market defensive', { market_scope: ['CRYPTO_MAJOR', 'US_STOCKS', 'INDEX_ETF', 'INDEX_ETFS', 'LEVERAGED_ETF', 'LEVERAGED_ETFS'], thresholds: { min_confidence: 74, gate_conservative: 84 } }),
    v1Preset('ema_off_vwap_only', 'EMA off VWAP only', { methods: { ema_filter: { enabled: false }, narrow_state: { enabled: false }, vwap_reclaim: { enabled: true }, vwap_rejection: { enabled: true } } }),
    v1Preset('narrow_state_only', 'Narrow state only', { methods: { ema_filter: { enabled: false }, vwap_reclaim: { enabled: false }, vwap_rejection: { enabled: false }, market_gate: { enabled: false }, narrow_state: { enabled: true } } }),
    v1Preset('exit_engine_test', 'Exit Engine test', { methods: { exit_engine: { enabled: true }, risk_engine: { enabled: false }, execution_safety: { enabled: true } } }),
  ];
}

function v1MethodOutput(method, methodConfig, patch = {}) {
  if (methodConfig?.enabled === false) {
    return { method, enabled: false, ok: true, passed: true, score_delta: 0, block: false, reason: 'disabled_by_strategy_config', warnings: [], data: {} };
  }
  return {
    method,
    enabled: true,
    ok: true,
    passed: patch.passed !== false,
    score_delta: round(patch.score_delta || 0, 2),
    block: patch.block === true,
    reason: patch.reason || 'passed',
    warnings: patch.warnings || [],
    data: patch.data || {},
  };
}

function v1InferMarketGroup(symbol, ctx = {}) {
  const s = String(symbol || '').toUpperCase();
  if (ctx.market_group || ctx.marketGroup) return String(ctx.market_group || ctx.marketGroup);
  if (ctx.marketType === 'crypto' || ctx.market_type === 'crypto' || s.endsWith('USDT')) return 'CRYPTO_MAJOR';
  if (['TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'TNA', 'TZA'].includes(s)) return 'LEVERAGED_ETF';
  if (['SPY', 'QQQ', 'DIA', 'IWM'].includes(s)) return 'INDEX_ETF';
  return 'US_STOCKS';
}

function v1Context(context = {}) {
  const symbol = String(context.symbol || 'UNKNOWN').toUpperCase();
  const confidence = Number(context.confidence ?? context.final_confidence ?? context.confidenceScore ?? context.base_confidence ?? 0);
  const score = Number(context.score ?? context.gate_score ?? context.tradeScore ?? context.final_confidence ?? confidence);
  return {
    ...context,
    symbol,
    market_group: v1InferMarketGroup(symbol, context),
    signal_type: context.signal_type || context.signalSubtype || context.eventType || context.engine_signal || 'unknown',
    direction: context.direction || context.engine_signal || context.signal || 'UNKNOWN',
    state: String(context.state || 'unknown'),
    confidence: Number.isFinite(confidence) ? confidence : 0,
    score: Number.isFinite(score) ? score : 0,
    gate_score: Number.isFinite(Number(context.gate_score)) ? Number(context.gate_score) : score,
    gate_mode: context.gate_mode || 'normal',
    volume_state: String(context.volume_state || context.volumeState || 'normal').toLowerCase(),
    data_freshness: String(context.data_freshness || context.dataFreshness || 'REPLAY').toUpperCase(),
    replay_mode: context.replay_mode !== false,
    paper_only: context.paper_only !== false,
  };
}

function v1VolumeRank(value) {
  return { weak: 0, low: 0, normal: 1, medium: 1, strong: 2, high: 2 }[String(value || 'normal').toLowerCase()] ?? 1;
}

function v1EvaluateMethod(methodName, context = {}, config = V1_DEFAULT_CONFIG) {
  const cfg = v1NormalizeConfig(config);
  const ctx = v1Context(context);
  const methodConfig = cfg.methods?.[methodName] || { enabled: true };
  switch (methodName) {
    case 'ema_filter': {
      const alignment = String(ctx.ema_alignment || ctx.emaAlignment || 'unknown').toLowerCase();
      const dir = String(ctx.direction).toUpperCase();
      const conflict = (alignment === 'bearish' && ['BUY', 'UP'].includes(dir)) || (alignment === 'bullish' && ['SELL', 'DOWN'].includes(dir));
      return v1MethodOutput(methodName, methodConfig, { passed: !conflict, score_delta: conflict ? -8 : (alignment === 'unknown' ? 0 : 3), reason: conflict ? 'ema_alignment_conflict' : 'ema_neutral_or_aligned', warnings: conflict ? ['ema_conflict'] : [], data: { alignment } });
    }
    case 'narrow_state':
      return v1MethodOutput(methodName, methodConfig, { score_delta: /narrow|trend/i.test(ctx.state) ? 5 : 0, reason: /narrow|trend/i.test(ctx.state) ? 'narrow_or_trend_state_ok' : 'state_neutral', data: { state: ctx.state } });
    case 'vwap_reclaim':
      return v1MethodOutput(methodName, methodConfig, { score_delta: /RECLAIM/i.test(ctx.signal_type) ? 8 : 0, reason: /RECLAIM/i.test(ctx.signal_type) ? 'vwap_reclaim_detected' : 'vwap_reclaim_not_present' });
    case 'vwap_rejection':
      return v1MethodOutput(methodName, methodConfig, { score_delta: /REJECTION/i.test(ctx.signal_type) ? 6 : 0, reason: /REJECTION/i.test(ctx.signal_type) ? 'vwap_rejection_detected' : 'vwap_rejection_not_present' });
    case 'market_compass': {
      const conflict = ctx.compassConflict === true || ctx.compass_conflict === true;
      return v1MethodOutput(methodName, methodConfig, { passed: !conflict, score_delta: conflict ? -8 : 2, reason: conflict ? 'market_compass_conflict' : 'market_compass_ok', warnings: conflict ? ['compass_conflict'] : [] });
    }
    case 'market_gate': {
      const t = cfg.thresholds;
      const threshold = ctx.gate_mode === 'conservative' ? t.gate_conservative : ctx.gate_mode === 'observe_only' ? t.gate_observe : t.gate_normal;
      const passed = ctx.gate_score >= threshold;
      return v1MethodOutput(methodName, methodConfig, { passed, block: !passed, score_delta: passed ? 3 : -12, reason: passed ? 'market_gate_passed' : 'market_gate_blocked', data: { gate_score: ctx.gate_score, threshold } });
    }
    case 'ai_agent': {
      const delta = Number(ctx.agent_adjustment ?? ctx.aiConfidenceAdjustment ?? 0) || 0;
      const block = ctx.aiShouldBlockTrade === true || ctx.agent_should_block === true;
      return v1MethodOutput(methodName, methodConfig, { passed: !block, block, score_delta: delta, reason: block ? 'ai_agent_block' : 'ai_agent_adjustment' });
    }
    case 'memory': {
      const delta = Number(ctx.memory_adjustment ?? ctx.memoryConfidenceAdjustment ?? 0) || 0;
      return v1MethodOutput(methodName, methodConfig, { score_delta: delta, reason: 'memory_applied_or_neutral' });
    }
    case 'trading_agents': {
      const adj = Number(ctx.trading_agents_adjustment ?? ctx.tradingAgentsAdjustment ?? 0) || 0;
      const block = ctx.trading_agents_should_block === true || ctx.tradingAgentsShouldBlock === true;
      const rec = String(ctx.trading_agents_recommendation || ctx.tradingAgentsRecommendation || '').toUpperCase();
      const observe = rec === 'OBSERVE';
      return v1MethodOutput(methodName, methodConfig, {
        passed: !block,
        block,
        score_delta: round(adj, 2),
        reason: block ? 'trading_agents_research_block' : observe ? 'trading_agents_observe' : adj !== 0 ? 'trading_agents_adjustment' : 'trading_agents_neutral',
        warnings: block ? ['trading_agents_block'] : observe ? ['trading_agents_observe'] : [],
        data: { recommendation: rec || 'none', adjustment: adj, can_place_orders: false },
      });
    }
    case 'risk_engine': {
      const live = ctx.replay_mode === false || ctx.paper_only === false;
      const allowed = ctx.risk_allowed !== false;
      return v1MethodOutput(methodName, methodConfig, { passed: !live && allowed, block: live || !allowed, score_delta: allowed ? 0 : -15, reason: live ? 'risk_engine_requires_replay_or_paper' : allowed ? 'risk_engine_allows' : 'risk_engine_blocks', warnings: live ? ['live_not_allowed'] : [] });
    }
    case 'execution_safety': {
      const live = ctx.replay_mode === false || ctx.paper_only === false;
      const allowed = ctx.execution_safety_allowed !== false;
      return v1MethodOutput(methodName, methodConfig, { passed: !live && allowed, block: live || !allowed, reason: live ? 'execution_safety_blocks_live_strategy_lab' : allowed ? 'execution_safety_replay_ok' : 'execution_safety_blocks', warnings: live ? ['live_not_allowed'] : [] });
    }
    case 'exit_engine':
      return v1MethodOutput(methodName, methodConfig, { reason: 'exit_engine_available', data: { fallback_exit_when_disabled: methodConfig.enabled === false } });
    case 'notification_engine':
      return v1MethodOutput(methodName, methodConfig, { reason: 'notifications_suppressed_in_strategy_lab', data: { send_notifications: false } });
    case 'volume_strength': {
      const passed = v1VolumeRank(ctx.volume_state) >= v1VolumeRank(cfg.thresholds.min_volume_strength);
      return v1MethodOutput(methodName, methodConfig, { passed, score_delta: passed ? 3 : -6, reason: passed ? 'volume_strength_ok' : 'volume_strength_too_low', warnings: passed ? [] : ['weak_volume'] });
    }
    case 'data_freshness': {
      const fresh = ['LIVE', 'REPLAY', 'HISTORICAL'].includes(ctx.data_freshness);
      return v1MethodOutput(methodName, methodConfig, { passed: fresh, block: !fresh, score_delta: fresh ? 0 : -20, reason: fresh ? 'data_freshness_ok' : 'stale_or_unknown_data', warnings: fresh ? [] : ['stale_data'] });
    }
    case 'market_group': {
      const passed = !cfg.market_scope?.length || cfg.market_scope.includes(ctx.market_group);
      return v1MethodOutput(methodName, methodConfig, { passed, block: !passed, reason: passed ? 'market_group_allowed' : 'market_group_out_of_scope', data: { market_group: ctx.market_group, scope: cfg.market_scope } });
    }
    case 'cooldown': {
      const active = ctx.cooldown_active === true;
      return v1MethodOutput(methodName, methodConfig, { passed: !active, block: active, score_delta: active ? -10 : 0, reason: active ? 'cooldown_active' : 'cooldown_clear' });
    }
    default:
      return v1MethodOutput(methodName, methodConfig, { reason: 'unknown_method_neutral', warnings: ['unknown_method'] });
  }
}

async function v1EvaluatePipeline(context = {}, config = V1_DEFAULT_CONFIG) {
  const cfg = v1NormalizeConfig(config);
  const ctx = v1Context(context);
  const methods = METHOD_NAMES.map((method) => v1EvaluateMethod(method, ctx, cfg));
  const liveBlock = ctx.replay_mode === false || ctx.paper_only === false;
  const block_reasons = methods.filter((m) => m.block).map((m) => m.reason);
  if (liveBlock) block_reasons.push('strategy_lab_live_trading_forbidden');
  const warnings = methods.flatMap((m) => m.warnings || []);
  if (liveBlock) warnings.push('live_not_allowed');
  const delta = methods.reduce((sum, m) => sum + (Number(m.score_delta) || 0), 0);
  const score = round(ctx.score + delta, 2);
  const confidence = round(ctx.confidence + delta, 2);
  const final_decision = block_reasons.length ? 'BLOCK' : confidence >= cfg.thresholds.min_confidence ? 'ALLOW' : 'OBSERVE';
  const payload = { ok: true, symbol: ctx.symbol, final_decision, score, confidence, methods, block_reasons, warnings, replay_mode: true, paper_only: true, source: 'strategy_lab_v1' };
  await redisService.setJson(KEYS.lastPipeline, payload, 3600);
  return payload;
}

async function v1GetStrategyConfig() {
  const cached = await redisService.getJson(KEYS.config, null);
  const config = v1NormalizeConfig(cached || v1ReadJson(STRATEGY_CONFIG_FILE, null) || V1_DEFAULT_CONFIG);
  await redisService.setJson(KEYS.config, config, 3600);
  return config;
}

async function v1UpdateStrategyConfig(partialConfig = {}) {
  const { ok, rejected } = v1ValidatePatch(partialConfig);
  if (!ok) return { ok: false, error: 'invalid_config', rejected };
  const config = v1MergeConfig(await v1GetStrategyConfig(), partialConfig);
  v1WriteJson(STRATEGY_CONFIG_FILE, config);
  await redisService.setJson(KEYS.config, config, 3600);
  await redisService.setJson(KEYS.activePreset, config.active_preset, 3600);
  return { ok: true, config, live_trading_enabled: false, replay_mode: true, paper_only: true };
}

async function v1ListPresets() {
  const cached = await redisService.getJson(KEYS.presets, null);
  if (Array.isArray(cached) && cached.length >= 10) return cached;
  const presets = v1ReadJson(STRATEGY_PRESETS_FILE, null) || v1DefaultPresets();
  v1WriteJson(STRATEGY_PRESETS_FILE, presets);
  await redisService.setJson(KEYS.presets, presets, 3600);
  return presets;
}

async function v1SavePreset(input = {}) {
  const id = String(input.id || input.name || '').trim();
  if (!id) return { ok: false, error: 'preset_id_required' };
  const configPatch = input.config || input;
  const { ok, rejected } = v1ValidatePatch(configPatch);
  if (!ok) return { ok: false, error: 'invalid_preset_config', rejected };
  const row = { id, label: input.label || id, config: v1NormalizeConfig(configPatch), updatedAt: nowIso() };
  const presets = (await v1ListPresets()).filter((p) => p.id !== id).concat(row);
  v1WriteJson(STRATEGY_PRESETS_FILE, presets);
  await redisService.setJson(KEYS.presets, presets, 3600);
  return { ok: true, preset: row, presets };
}

async function v1ActivatePreset(presetId) {
  const row = (await v1ListPresets()).find((p) => p.id === presetId);
  if (!row) return { ok: false, error: 'preset_not_found' };
  const config = v1NormalizeConfig({ ...row.config, active_preset: row.id });
  v1WriteJson(STRATEGY_CONFIG_FILE, config);
  await redisService.setJson(KEYS.config, config, 3600);
  await redisService.setJson(KEYS.activePreset, row.id, 3600);
  return { ok: true, preset: row, active_preset: row.id, config };
}

function v1LoadRows({ symbols = [], date_from, date_to, limit = 1200 } = {}) {
  const wanted = new Set(symbols.map((s) => String(s || '').toUpperCase()).filter(Boolean));
  const rows = [];
  for (const session of replayIntelligenceService.listReplaySessions()) {
    for (const event of replayIntelligenceService.getReplayEvents(session.id)) {
      const symbol = String(event.symbol || '').toUpperCase();
      const day = String(event.timestamp || '').slice(0, 10);
      if (wanted.size && !wanted.has(symbol)) continue;
      if (date_from && day < date_from) continue;
      if (date_to && day > date_to) continue;
      rows.push(event);
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

function v1Drawdown(pnls) {
  let equity = 100;
  let peak = 100;
  let max = 0;
  for (const pnl of pnls) {
    equity *= 1 + ((Number(pnl) || 0) / 100);
    peak = Math.max(peak, equity);
    if (peak > 0) max = Math.max(max, ((peak - equity) / peak) * 100);
  }
  return round(max, 4);
}

async function v1RunStrategyReplayTest(input = {}) {
  const config = v1NormalizeConfig(input.config || await v1GetStrategyConfig());
  const rows = v1LoadRows({ symbols: Array.isArray(input.symbols) ? input.symbols : [], date_from: input.date_from || input.start, date_to: input.date_to || input.end, limit: Math.min(Math.max(Number(input.limit) || 1200, 50), 5000) });
  const events = [];
  const methodStats = {};
  for (const row of rows) {
    const pipeline = await v1EvaluatePipeline({ ...row, market_group: v1InferMarketGroup(row.symbol, row), signal_type: row.signalSubtype || row.eventType || row.engine_signal || 'unknown', direction: row.engine_signal, score: row.gate_score ?? row.final_confidence, confidence: row.final_confidence ?? row.base_confidence, data_freshness: 'REPLAY', replay_mode: true, paper_only: true, execution_safety_allowed: true }, config);
    const allow = pipeline.final_decision === 'ALLOW';
    const exitOn = config.methods.exit_engine.enabled !== false;
    const pnl = exitOn ? Number(row.simulated_pnl_pct || 0) : Number(row.baseline_pnl_pct ?? row.simulated_pnl_pct ?? 0);
    const baseline = Number(row.baseline_pnl_pct ?? row.simulated_pnl_pct ?? pnl);
    for (const method of pipeline.methods) {
      const s = methodStats[method.method] || { method: method.method, score_delta: 0, blocks: 0, warnings: 0, count: 0 };
      s.score_delta += Number(method.score_delta) || 0;
      s.blocks += method.block ? 1 : 0;
      s.warnings += (method.warnings || []).length;
      s.count += 1;
      methodStats[method.method] = s;
    }
    events.push({ symbol: row.symbol, timestamp: row.timestamp, final_decision: pipeline.final_decision, pnl_pct: allow ? pnl : 0, baseline_pnl_pct: baseline, pnl_delta_pct: allow ? round(pnl - baseline, 4) : 0, outcome: allow ? (pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'timeout') : 'blocked', exit_reason_code: exitOn ? (row.exit_reason_code || 'strategy_exit') : (row.baseline_exit_reason || 'fallback_exit'), block_reasons: pipeline.block_reasons });
  }
  const trades = events.filter((e) => e.final_decision === 'ALLOW');
  const pnls = trades.map((e) => e.pnl_pct);
  const wins = trades.filter((e) => e.outcome === 'win').length;
  const losses = trades.filter((e) => e.outcome === 'loss').length;
  const timeouts = trades.filter((e) => e.outcome === 'timeout' || String(e.exit_reason_code).includes('timeout')).length;
  const total = pnls.reduce((sum, pnl) => sum + (Number(pnl) || 0), 0);
  const methodRows = Object.values(methodStats).map((m) => ({ ...m, avg_score_delta: m.count ? round(m.score_delta / m.count, 2) : 0 })).sort((a, b) => b.avg_score_delta - a.avg_score_delta);
  const id = `strategy_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const result = { ok: true, id, run_id: id, createdAt: nowIso(), replay_mode: true, paper_only: true, live_trading_enabled: false, source: 'strategy_lab_v1', config, input: { symbols: input.symbols || [], market: input.market || 'all', date_from: input.date_from || input.start || null, date_to: input.date_to || input.end || null, preset: config.active_preset }, summary: { total_events: events.length, total_trades: trades.length, win_rate: pct(wins, trades.length), timeout_rate: pct(timeouts, trades.length), wins, losses, timeouts, avg_pl_pct: trades.length ? round(total / trades.length, 4) : 0, total_pl_pct: round(total, 4), max_drawdown: v1Drawdown(pnls), risk_blocks: events.filter((e) => e.block_reasons.some((r) => String(r).includes('risk'))).length, safety_blocks: events.filter((e) => e.block_reasons.some((r) => String(r).includes('safety') || String(r).includes('live'))).length, exit_improvements: trades.filter((e) => e.pnl_delta_pct > 0.02).length, best_methods: methodRows.slice(0, 5), worst_methods: [...methodRows].reverse().slice(0, 5) }, events: events.slice(0, 250) };
  result.results = { ...result.summary, max_drawdown_pct: result.summary.max_drawdown, exit_engine_impact: { exit_improvements: result.summary.exit_improvements } };
  result.redis_keys = [KEYS.latestTest, `${KEYS.testPrefix}${id}`];
  v1WriteJson(path.join(STRATEGY_RESULTS_DIR, `${id}.json`), result);
  await redisService.setJson(KEYS.latestTest, result, 3600);
  await redisService.setJson(`${KEYS.testPrefix}${id}`, result, 3600);
  return result;
}

function v1LoadResult(id) {
  return v1ReadJson(path.join(STRATEGY_RESULTS_DIR, `${id}.json`), null);
}

function v1ListResults() {
  v1EnsureStorage();
  return fs.readdirSync(STRATEGY_RESULTS_DIR).filter((f) => f.endsWith('.json')).map((f) => v1ReadJson(path.join(STRATEGY_RESULTS_DIR, f), null)).filter(Boolean).sort((a, b) => new Date(b.createdAt || b.created_at || 0) - new Date(a.createdAt || a.created_at || 0)).map((r) => ({ id: r.id || r.run_id, createdAt: r.createdAt || r.created_at, preset: r.config?.active_preset, summary: r.summary || r.results, input: r.input }));
}

async function v1CompareStrategyRuns(runIds = []) {
  const runs = runIds.map(v1LoadResult).filter(Boolean);
  if (runs.length < 2) return { ok: false, error: 'at_least_two_run_ids_required' };
  const rows = runs.map((r) => ({ id: r.id || r.run_id, preset: r.config?.active_preset, total_pl_pct: r.summary?.total_pl_pct ?? r.results?.total_pl_pct ?? 0, win_rate: r.summary?.win_rate ?? r.results?.win_rate ?? 0, max_drawdown: r.summary?.max_drawdown ?? r.results?.max_drawdown_pct ?? 0, total_trades: r.summary?.total_trades ?? r.results?.total_trades ?? 0 }));
  const best = [...rows].sort((a, b) => (b.total_pl_pct + b.win_rate / 10 - b.max_drawdown) - (a.total_pl_pct + a.win_rate / 10 - a.max_drawdown))[0];
  const comparison = { ok: true, createdAt: nowIso(), runIds, rows, best, recommendation: v1RecommendBestConfig(rows), replay_mode: true, paper_only: true };
  v1WriteJson(path.join(STRATEGY_DATA_DIR, 'compare-latest-v1.json'), comparison);
  await redisService.setJson(KEYS.latestCompare, comparison, 3600);
  return comparison;
}

function v1RecommendBestConfig(results = []) {
  const rows = Array.isArray(results) ? results : results.rows || [];
  const best = [...rows].sort((a, b) => (b.total_pl_pct || b.pl || 0) - (a.total_pl_pct || a.pl || 0))[0];
  return best ? { ok: true, message: `${best.preset || best.id} är starkast i jämförelsen.`, best_configuration: best, replay_mode: true, paper_only: true, live_trading_enabled: false } : { ok: false, error: 'results_required' };
}

async function v1GetPipelineStatus() {
  return v1EvaluatePipeline({ symbol: 'BTCUSDT', market_group: 'CRYPTO_MAJOR', signal_type: 'VWAP_RECLAIM_UP', direction: 'BUY', state: 'trend', score: 72, confidence: 70, gate_score: 72, volume_state: 'normal', data_freshness: 'REPLAY', replay_mode: true, paper_only: true, execution_safety_allowed: true, risk_allowed: true }, await v1GetStrategyConfig());
}

async function v1GetResults() {
  const latest = await redisService.getJson(KEYS.latestTest, null);
  const comparison = await redisService.getJson(KEYS.latestCompare, null) || v1ReadJson(path.join(STRATEGY_DATA_DIR, 'compare-latest-v1.json'), null);
  return { ok: true, latest, compare: comparison, comparison, runs: v1ListResults(), redis_keys: Object.values(KEYS), redis: redisService.status() };
}

module.exports = {
  KEYS,
  METHOD_NAMES,
  getPipelineStatus: v1GetPipelineStatus,
  getStrategyConfig: v1GetStrategyConfig,
  updateStrategyConfig: v1UpdateStrategyConfig,
  evaluateMethod: v1EvaluateMethod,
  evaluatePipeline: v1EvaluatePipeline,
  listPresets: v1ListPresets,
  savePreset: v1SavePreset,
  activatePreset: v1ActivatePreset,
  runStrategyReplayTest: v1RunStrategyReplayTest,
  compareStrategyRuns: v1CompareStrategyRuns,
  recommendBestConfig: v1RecommendBestConfig,
  getResults: v1GetResults,
  getTradingAgentsStatus: tradingAgentsAdapterService.getTradingAgentsStatus,
};
