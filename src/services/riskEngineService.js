'use strict';

const redisService = require('./redisService');
const notificationEngineV2 = require('../alerts/notificationEngineV2');

const SOURCE = 'risk_engine_v2';
const DISABLED_SOURCE = 'risk_engine_disabled';

const KEYS = {
  config: 'risk:config',
  status: 'risk:status',
  lastEvaluation: 'risk:last_evaluation',
  evaluationPrefix: 'risk:evaluation:',
  blocksToday: 'risk:blocks:today',
};

const LAST_EVALUATION_TTL_SECONDS = 30 * 60;
const INTERNAL_CONFIG_MODES = new Set(['paper', 'replay']);
const EVALUATION_SOURCES = new Set(['paper_pipeline', 'replay', 'manual_api_test']);

const DEFAULT_RISK_CONFIG = Object.freeze({
  enabled: true,
  mode: 'paper',
  account_balance: 100000,
  risk_per_trade_pct: 0.5,
  max_position_pct: 15,
  max_daily_loss_pct: 2,
  max_trades_per_day: 20,
  max_consecutive_losses: 4,
  min_confidence: 65,
  min_liquidity_score: 50,
  max_spread_pct: 0.25,
  max_volatility_score: 80,
  cooldown_after_loss_minutes: 10,
  pause_after_daily_loss: true,
  pause_after_consecutive_losses: true,
  allow_agent_block: true,
  allow_memory_block: true,
});

const CONFIG_BOUNDS = Object.freeze({
  risk_per_trade_pct: { min: 0.1, max: 5 },
  max_position_pct: { min: 1, max: 100 },
  max_daily_loss_pct: { min: 0.5, max: 20 },
  max_trades_per_day: { min: 1, max: 500, integer: true },
  max_consecutive_losses: { min: 1, max: 20, integer: true },
  min_confidence: { min: 0, max: 100 },
  max_spread_pct: { min: 0.01, max: 5 },
});

const SAFE_CONFIG_FIELDS = new Set([
  'enabled',
  'mode',
  'account_balance',
  'risk_per_trade_pct',
  'max_position_pct',
  'max_daily_loss_pct',
  'max_trades_per_day',
  'max_consecutive_losses',
  'min_confidence',
  'min_liquidity_score',
  'max_spread_pct',
  'max_volatility_score',
  'cooldown_after_loss_minutes',
  'pause_after_daily_loss',
  'pause_after_consecutive_losses',
  'allow_agent_block',
  'allow_memory_block',
]);

let memoryConfig = { ...DEFAULT_RISK_CONFIG };
let latestEvaluation = null;
let latestStatus = null;
let blocksTodayMemory = { date: todayKey(), blocks: [] };
let lastFallbackLogAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function secondsUntilEndOfToday() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5));
  return Math.max(60, Math.floor((end.getTime() - now.getTime()) / 1000));
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolValue(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
  }
  return fallback;
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function warnRedisFallback(action) {
  const now = Date.now();
  if (now - lastFallbackLogAt < 60_000) return;
  lastFallbackLogAt = now;
  console.warn(`[risk-engine] Redis fallback aktiv (${action})`);
}

function resetBlocksMemoryIfStale() {
  const date = todayKey();
  if (blocksTodayMemory.date !== date) {
    blocksTodayMemory = { date, blocks: [] };
  }
}

function normalizeEvaluationSource(value, fallback = 'paper_pipeline') {
  const source = String(value || '').trim();
  return EVALUATION_SOURCES.has(source) ? source : fallback;
}

function normalizeConfig(input = {}) {
  const out = { ...DEFAULT_RISK_CONFIG, ...(input && typeof input === 'object' ? input : {}) };
  out.enabled = boolValue(out.enabled, DEFAULT_RISK_CONFIG.enabled);
  out.mode = INTERNAL_CONFIG_MODES.has(String(out.mode || '').toLowerCase())
    ? String(out.mode).toLowerCase()
    : DEFAULT_RISK_CONFIG.mode;
  out.account_balance = clamp(out.account_balance, 1000, 1000000000);
  out.risk_per_trade_pct = clamp(out.risk_per_trade_pct, 0.1, 5);
  out.max_position_pct = clamp(out.max_position_pct, 1, 100);
  out.max_daily_loss_pct = clamp(out.max_daily_loss_pct, 0.5, 20);
  out.max_trades_per_day = Math.round(clamp(out.max_trades_per_day, 1, 500));
  out.max_consecutive_losses = Math.round(clamp(out.max_consecutive_losses, 1, 20));
  out.min_confidence = clamp(out.min_confidence, 0, 100);
  out.min_liquidity_score = clamp(out.min_liquidity_score, 0, 100);
  out.max_spread_pct = clamp(out.max_spread_pct, 0.01, 5);
  out.max_volatility_score = clamp(out.max_volatility_score, 0, 100);
  out.cooldown_after_loss_minutes = Math.round(clamp(out.cooldown_after_loss_minutes, 0, 1440));
  out.pause_after_daily_loss = boolValue(out.pause_after_daily_loss, true);
  out.pause_after_consecutive_losses = boolValue(out.pause_after_consecutive_losses, true);
  out.allow_agent_block = boolValue(out.allow_agent_block, true);
  out.allow_memory_block = boolValue(out.allow_memory_block, true);
  return out;
}

function validatePartialConfig(partialConfig = {}) {
  const input = partialConfig && typeof partialConfig === 'object' ? partialConfig : {};
  const accepted = {};
  const rejected = {};

  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_CONFIG_FIELDS.has(key)) {
      rejected[key] = 'field_not_allowed';
      continue;
    }

    if (['enabled', 'pause_after_daily_loss', 'pause_after_consecutive_losses', 'allow_agent_block', 'allow_memory_block'].includes(key)) {
      if (typeof value !== 'boolean') rejected[key] = 'must_be_boolean';
      else accepted[key] = value;
      continue;
    }

    if (key === 'mode') {
      const mode = String(value || '').toLowerCase();
      if (mode === 'live') rejected[key] = 'live_mode_not_enabled';
      else if (mode !== 'paper') rejected[key] = 'mode_locked_to_paper';
      else accepted[key] = mode;
      continue;
    }

    if (key === 'account_balance') {
      const n = numberOrNull(value);
      if (n == null || n < 1000 || n > 1000000000) rejected[key] = 'must_be_1000_to_1000000000';
      else accepted[key] = n;
      continue;
    }

    if (key === 'min_liquidity_score' || key === 'max_volatility_score') {
      const n = numberOrNull(value);
      if (n == null || n < 0 || n > 100) rejected[key] = 'must_be_0_to_100';
      else accepted[key] = n;
      continue;
    }

    if (key === 'cooldown_after_loss_minutes') {
      const n = numberOrNull(value);
      if (n == null || n < 0 || n > 1440) rejected[key] = 'must_be_0_to_1440';
      else accepted[key] = Math.round(n);
      continue;
    }

    const bounds = CONFIG_BOUNDS[key];
    if (!bounds) {
      rejected[key] = 'field_not_configurable';
      continue;
    }
    const n = numberOrNull(value);
    if (n == null || n < bounds.min || n > bounds.max) {
      rejected[key] = `must_be_${bounds.min}_to_${bounds.max}`;
      continue;
    }
    accepted[key] = bounds.integer ? Math.round(n) : n;
  }

  return { accepted, rejected };
}

async function getRiskConfig() {
  const cached = await redisService.getJson(KEYS.config, null);
  if (cached && typeof cached === 'object') {
    memoryConfig = normalizeConfig(cached);
    return memoryConfig;
  }
  const ok = await redisService.setJson(KEYS.config, memoryConfig, 0);
  if (!ok) warnRedisFallback('config');
  return memoryConfig;
}

function buildSignal(signalContext = {}) {
  const c = signalContext && typeof signalContext === 'object' ? signalContext : {};
  const gate = c.gate && typeof c.gate === 'object' ? c.gate : {};
  const agent = c.agent || c.aiAgentAnalysis || {};
  const memory = c.memory || c.memory_summary || agent.memory_summary || {};
  return {
    raw: c,
    symbol: String(c.symbol || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN',
    direction: String(c.direction || c.nextMoveBias || c.bias || '').trim().toUpperCase() || null,
    score: numberOrNull(c.score ?? c.priorityScore ?? c.tradeScore ?? c.confidenceScore),
    confidence: numberOrNull(c.confidence ?? c.confidenceScore ?? c.final_confidence ?? c.score),
    price: numberOrNull(c.price ?? c.entryPrice ?? c.lastPrice),
    stop_loss_pct: numberOrNull(c.stop_loss_pct ?? c.stopLossPct ?? c.stopPct ?? c.stop_pct ?? gate.stopPct),
    target_pct: numberOrNull(c.target_pct ?? c.targetPct ?? c.target_pct ?? gate.targetPct),
    spread_pct: numberOrNull(c.spread_pct ?? c.spreadPct ?? c.bidAskSpreadPct),
    liquidity_score: numberOrNull(c.liquidity_score ?? c.liquidityScore),
    volatility_score: numberOrNull(c.volatility_score ?? c.volatilityScore),
    agent,
    memory,
    gate,
    replay_mode: c.replay_mode === true,
    evaluation_source: c.evaluation_source || c.evaluationSource || null,
  };
}

function buildAccount(accountState = {}, riskConfig = DEFAULT_RISK_CONFIG) {
  const a = accountState && typeof accountState === 'object' ? accountState : {};
  return {
    balance: numberOrNull(a.balance) ?? numberOrNull(a.account_balance) ?? riskConfig.account_balance,
    equity: numberOrNull(a.equity) ?? numberOrNull(a.balance) ?? riskConfig.account_balance,
    daily_pnl_pct: numberOrNull(a.daily_pnl_pct) ?? 0,
    daily_trades: Math.max(0, Math.round(numberOrNull(a.daily_trades) ?? 0)),
    consecutive_losses: Math.max(0, Math.round(numberOrNull(a.consecutive_losses) ?? 0)),
    open_positions: Array.isArray(a.open_positions) ? a.open_positions : [],
    last_loss_at: a.last_loss_at || null,
  };
}

function agentWantsBlock(agent = {}) {
  return agent?.should_block_trade === true || agent?.shouldBlockTrade === true;
}

function memoryBadSetup(memory = {}) {
  const flags = Array.isArray(memory?.risk_flags) ? memory.risk_flags : Array.isArray(memory?.flags) ? memory.flags : [];
  const warning = String(memory?.memory_warning || memory?.warning || '').toLowerCase();
  return memory?.bad_historical_setup === true ||
    memory?.memory_should_block_trade === true ||
    memory?.should_block_trade === true ||
    flags.includes('bad_historical_setup') ||
    /låg träffsäkerhet|bad_historical_setup/.test(warning);
}

function cooldownActive(lastLossAt, minutes) {
  if (!lastLossAt || !minutes) return false;
  const ts = new Date(lastLossAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < minutes * 60_000;
}

function calculatePositionSize(signalContext = {}, accountState = {}, riskConfig = DEFAULT_RISK_CONFIG) {
  const config = normalizeConfig(riskConfig);
  const signal = buildSignal(signalContext);
  const account = buildAccount(accountState, config);
  const accountBalance = numberOrNull(account.balance) ?? config.account_balance;
  const riskAmount = accountBalance * (config.risk_per_trade_pct / 100);
  const maxPosition = accountBalance * (config.max_position_pct / 100);
  const stopPct = signal.stop_loss_pct;
  const price = signal.price;

  let rawPosition = 0;
  if (stopPct != null && stopPct > 0) rawPosition = riskAmount / (stopPct / 100);
  const positionSizeSek = Math.max(0, Math.min(rawPosition, maxPosition));
  const positionSizeUnits = price && price > 0 ? positionSizeSek / price : 0;
  const actualPositionRisk = stopPct && stopPct > 0 ? positionSizeSek * (stopPct / 100) : 0;

  return {
    account_balance: round(accountBalance, 2),
    risk_amount_sek: round(riskAmount, 2),
    max_position_sek: round(maxPosition, 2),
    raw_position_size_sek: round(rawPosition, 2),
    position_size_sek: round(positionSizeSek, 2),
    position_size_units: round(positionSizeUnits, 4),
    max_loss_sek: round(riskAmount, 2),
    actual_position_risk_sek: round(actualPositionRisk, 2),
    position_clamped: rawPosition > maxPosition,
  };
}

function shouldPauseTrading(accountState = {}, riskConfig = DEFAULT_RISK_CONFIG) {
  const config = normalizeConfig(riskConfig);
  const account = buildAccount(accountState, config);
  const reasons = [];
  if (config.pause_after_daily_loss && account.daily_pnl_pct <= -config.max_daily_loss_pct) {
    reasons.push('daily_loss_limit');
  }
  if (config.pause_after_consecutive_losses && account.consecutive_losses >= config.max_consecutive_losses) {
    reasons.push('consecutive_losses_limit');
  }
  return {
    pause: reasons.length > 0,
    reasons,
  };
}

function shouldBlockTrade(riskEvaluation) {
  return riskEvaluation?.allowed === false || (Array.isArray(riskEvaluation?.block_reasons) && riskEvaluation.block_reasons.length > 0);
}

function riskLevel(blockReasons, warnings) {
  if (blockReasons.length) return 'block';
  if (warnings.some((w) => /near_|clamped|pause/.test(w))) return 'medium';
  return 'low';
}

function confidenceAfterRisk(signal, blockReasons, warnings) {
  let confidence = signal.confidence ?? signal.score ?? 0;
  if (blockReasons.includes('spread_too_high')) confidence -= 10;
  if (blockReasons.includes('low_liquidity')) confidence -= 10;
  if (blockReasons.includes('volatility_too_high')) confidence -= 8;
  if (blockReasons.includes('agent_block')) confidence -= 8;
  if (blockReasons.includes('memory_block')) confidence -= 8;
  confidence -= warnings.length * 2;
  return Math.round(clamp(confidence, 0, 100));
}

async function recordBlock(evaluation) {
  resetBlocksMemoryIfStale();
  const row = {
    timestamp: evaluation.timestamp,
    symbol: evaluation.symbol,
    block_reasons: evaluation.block_reasons,
    warnings: evaluation.warnings,
    risk_level: evaluation.risk_level,
  };
  blocksTodayMemory.blocks = [row, ...blocksTodayMemory.blocks].slice(0, 500);
  const ok = await redisService.setJson(KEYS.blocksToday, blocksTodayMemory, secondsUntilEndOfToday());
  if (!ok) warnRedisFallback('blocks_today');
  console.warn(`[risk-engine] risk block ${evaluation.symbol}: ${evaluation.block_reasons.join(',')}`);
}

async function persistEvaluation(evaluation) {
  resetBlocksMemoryIfStale();
  latestEvaluation = evaluation;
  if (!evaluation.allowed) await recordBlock(evaluation);

  latestStatus = {
    ok: true,
    source: SOURCE,
    enabled: evaluation.source !== DISABLED_SOURCE,
    mode: evaluation.mode,
    evaluation_source: evaluation.evaluation_source,
    pause_trading: evaluation.pause_trading,
    pause_reasons: evaluation.pause_reasons || [],
    last_evaluation: evaluation,
    blocks_today_count: blocksTodayMemory.blocks.length,
    updatedAt: evaluation.timestamp,
    redis: redisService.status(),
  };

  const writes = await Promise.all([
    redisService.setJson(KEYS.lastEvaluation, evaluation, LAST_EVALUATION_TTL_SECONDS),
    redisService.setJson(`${KEYS.evaluationPrefix}${evaluation.symbol}`, evaluation, LAST_EVALUATION_TTL_SECONDS),
    redisService.setJson(KEYS.status, latestStatus, 0),
    redisService.addStream('risk:evaluations', evaluation, 500),
  ]);
  if (writes.some((ok) => ok === false)) warnRedisFallback('evaluation');
  void notificationEngineV2.processRiskEvaluation(evaluation).catch((err) => {
    console.warn('[risk-engine] notification v2 failed:', err.message);
  });
  if (evaluation.pause_trading) {
    console.warn(`[risk-engine] pause trading trigger: ${(evaluation.pause_reasons || []).join(',')}`);
  }
}

async function evaluateTradeRisk(signalContext = {}, accountState = {}, options = {}) {
  const riskConfig = normalizeConfig(accountState?._riskConfig || await getRiskConfig());
  const signal = buildSignal(signalContext);
  const account = buildAccount(accountState, riskConfig);
  const timestamp = nowIso();
  const defaultSource = signal.replay_mode ? 'replay' : 'paper_pipeline';
  const evaluationSource = normalizeEvaluationSource(options.evaluationSource || signal.evaluation_source, defaultSource);
  const persist = options.persist === true && !signal.replay_mode;

  if (!riskConfig.enabled) {
    const disabled = {
      ok: true,
      symbol: signal.symbol,
      allowed: true,
      risk_level: 'low',
      position_size_sek: 0,
      position_size_units: 0,
      max_loss_sek: 0,
      risk_reward_ratio: signal.stop_loss_pct && signal.target_pct ? round(signal.target_pct / signal.stop_loss_pct, 2) : null,
      confidence_after_risk: signal.confidence ?? signal.score ?? null,
      block_reasons: [],
      warnings: ['risk_engine_disabled'],
      position_notes: 'Riskmotorn är avstängd. Trade tillåts utan positionsstorlek från risk engine.',
      pause_trading: false,
      pause_reasons: [],
      source: DISABLED_SOURCE,
      evaluation_source: evaluationSource,
      mode: riskConfig.mode,
      timestamp,
    };
    if (persist) await persistEvaluation(disabled);
    return disabled;
  }

  const blockReasons = [];
  const warnings = [];
  if (!signal.price || signal.price <= 0) blockReasons.push('missing_price');
  if (!signal.stop_loss_pct || signal.stop_loss_pct <= 0) blockReasons.push('missing_stop_loss');
  if (signal.confidence != null && signal.confidence < riskConfig.min_confidence) blockReasons.push('low_confidence');
  if (signal.spread_pct != null && signal.spread_pct > riskConfig.max_spread_pct) blockReasons.push('spread_too_high');
  if (signal.liquidity_score != null && signal.liquidity_score < riskConfig.min_liquidity_score) blockReasons.push('low_liquidity');
  if (signal.volatility_score != null && signal.volatility_score > riskConfig.max_volatility_score) blockReasons.push('volatility_too_high');
  if (account.daily_pnl_pct <= -riskConfig.max_daily_loss_pct) blockReasons.push('daily_loss_limit');
  if (account.daily_trades >= riskConfig.max_trades_per_day) blockReasons.push('max_daily_trades');
  if (account.consecutive_losses >= riskConfig.max_consecutive_losses) blockReasons.push('consecutive_losses_limit');
  if (cooldownActive(account.last_loss_at, riskConfig.cooldown_after_loss_minutes)) blockReasons.push('loss_cooldown_active');
  if (riskConfig.allow_agent_block && agentWantsBlock(signal.agent)) blockReasons.push('agent_block');
  if (riskConfig.allow_memory_block && memoryBadSetup(signal.memory)) blockReasons.push('memory_block');

  if (account.daily_pnl_pct <= -(riskConfig.max_daily_loss_pct * 0.75)) warnings.push('near_daily_loss_limit');
  if (account.daily_trades >= Math.floor(riskConfig.max_trades_per_day * 0.8)) warnings.push('near_max_daily_trades');
  if (account.consecutive_losses >= Math.max(1, riskConfig.max_consecutive_losses - 1)) warnings.push('near_consecutive_losses_limit');

  const sizing = calculatePositionSize(signalContext, account, riskConfig);
  if (sizing.position_clamped) warnings.push('position_size_clamped');
  const pauseDecision = shouldPauseTrading(account, riskConfig);
  const allowed = blockReasons.length === 0 && !pauseDecision.pause;
  const pauseReasons = pauseDecision.reasons || [];
  const effectiveBlocks = allowed ? blockReasons : Array.from(new Set([...blockReasons, ...pauseReasons]));

  const evaluation = {
    ok: true,
    symbol: signal.symbol,
    allowed,
    risk_level: riskLevel(effectiveBlocks, warnings),
    position_size_sek: sizing.position_size_sek,
    position_size_units: sizing.position_size_units,
    max_loss_sek: sizing.max_loss_sek,
    actual_position_risk_sek: sizing.actual_position_risk_sek,
    risk_reward_ratio: signal.stop_loss_pct && signal.target_pct ? round(signal.target_pct / signal.stop_loss_pct, 2) : null,
    confidence_after_risk: confidenceAfterRisk(signal, effectiveBlocks, warnings),
    block_reasons: effectiveBlocks,
    warnings,
    position_notes: sizing.position_clamped
      ? `Positionsstorlek clamped till ${sizing.position_size_sek} SEK av max_position_pct ${riskConfig.max_position_pct}%.`
      : `Positionsstorlek baserad på ${riskConfig.risk_per_trade_pct}% risk och stop loss ${signal.stop_loss_pct ?? 'saknas'}%.`,
    pause_trading: pauseDecision.pause,
    pause_reasons: pauseReasons,
    source: SOURCE,
    evaluation_source: evaluationSource,
    mode: riskConfig.mode,
    timestamp,
    risk_amount_sek: sizing.risk_amount_sek,
    max_position_sek: sizing.max_position_sek,
    raw_position_size_sek: sizing.raw_position_size_sek,
    position_clamped: sizing.position_clamped,
    account_snapshot: account,
    config_snapshot: riskConfig,
  };

  if (persist) await persistEvaluation(evaluation);
  return evaluation;
}

async function updateRiskConfig(partialConfig = {}) {
  const { accepted, rejected } = validatePartialConfig(partialConfig);
  if (Object.keys(rejected).length) {
    console.warn(`[risk-engine] invalid config attempt: ${Object.keys(rejected).join(',')}`);
    return {
      ok: false,
      error: 'invalid_config',
      rejected,
      accepted,
      config: await getRiskConfig(),
    };
  }

  const current = await getRiskConfig();
  const next = normalizeConfig({ ...current, ...accepted });
  memoryConfig = next;
  const ok = await redisService.setJson(KEYS.config, next, 0);
  if (!ok) warnRedisFallback('config_update');
  console.log(`[risk-engine] config update: ${Object.keys(accepted).join(',') || 'no_changes'}`);
  latestStatus = {
    ...(latestStatus || {}),
    ok: true,
    config: next,
    updatedAt: nowIso(),
  };
  await redisService.setJson(KEYS.status, latestStatus, 0);
  return { ok: true, config: next, updated: accepted, rejected: {} };
}

async function getRiskStatus() {
  const config = await getRiskConfig();
  resetBlocksMemoryIfStale();
  const redisLatest = await redisService.getJson(KEYS.lastEvaluation, latestEvaluation);
  const redisStatus = await redisService.getJson(KEYS.status, latestStatus);
  const blocksToday = await redisService.getJson(KEYS.blocksToday, null);
  if (blocksToday?.date === todayKey()) blocksTodayMemory = blocksToday;
  return {
    ok: true,
    source: SOURCE,
    enabled: config.enabled,
    mode: config.mode,
    config,
    status: redisStatus || latestStatus,
    last_evaluation: redisLatest || latestEvaluation,
    blocks_today: blocksTodayMemory.blocks || [],
    blocks_today_count: (blocksTodayMemory.blocks || []).length,
    pause_trading: (redisStatus || latestStatus)?.pause_trading === true,
    pause_reasons: (redisStatus || latestStatus)?.pause_reasons || [],
    redis: redisService.status(),
    keys: KEYS,
    timestamp: nowIso(),
  };
}

module.exports = {
  DEFAULT_RISK_CONFIG,
  CONFIG_BOUNDS,
  SAFE_CONFIG_FIELDS: Array.from(SAFE_CONFIG_FIELDS),
  KEYS,
  evaluateTradeRisk,
  calculatePositionSize,
  shouldBlockTrade,
  shouldPauseTrading,
  getRiskStatus,
  getRiskConfig,
  updateRiskConfig,
};
