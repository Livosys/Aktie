'use strict';

const redisService = require('./redisService');
const { buildSystemHealth } = require('../systemHealth');
const { buildProviderStatus } = require('../providerStatus');
const riskEngineService = require('./riskEngineService');
const exitEngineService = require('./exitEngineService');
const notificationEngineV2 = require('../alerts/notificationEngineV2');

const SOURCE = 'execution_safety_v1';

const KEYS = {
  config: 'safety:config',
  status: 'safety:status',
  lastEvaluation: 'safety:last_evaluation',
  killSwitch: 'safety:kill_switch',
  manualArmed: 'safety:manual_armed',
  recentEvents: 'safety:events:recent',
};

const DEFAULT_SAFETY_CONFIG = Object.freeze({
  enabled: true,
  mode: 'paper',
  live_trading_enabled: false,
  require_manual_arming: true,
  manual_armed: false,
  kill_switch_active: false,
  max_candle_age_seconds: 180,
  max_price_age_seconds: 30,
  max_backend_scan_age_seconds: 120,
  max_redis_stale_seconds: 60,
  block_on_redis_down: false,
  block_on_provider_down: true,
  block_on_system_health_bad: true,
  block_on_market_closed: true,
  block_on_pm2_restart_loop: true,
  max_pm2_restarts_1h: 5,
  block_on_high_memory: true,
  max_memory_mb: 1400,
  block_on_api_error_storm: true,
  max_api_errors_5m: 20,
  block_on_notification_failure: false,
  require_risk_engine_pass: true,
  require_exit_engine_ready: true,
  require_data_provider_ready: true,
  allow_replay_execution: false,
});

const BOOL_FIELDS = [
  'enabled',
  'require_manual_arming',
  'kill_switch_active',
  'block_on_redis_down',
  'block_on_provider_down',
  'block_on_system_health_bad',
  'block_on_market_closed',
  'block_on_pm2_restart_loop',
  'block_on_high_memory',
  'block_on_api_error_storm',
  'block_on_notification_failure',
  'require_risk_engine_pass',
  'require_exit_engine_ready',
  'require_data_provider_ready',
  'allow_replay_execution',
];

const NUMBER_LIMITS = {
  max_candle_age_seconds: [10, 3600],
  max_price_age_seconds: [5, 600],
  max_backend_scan_age_seconds: [10, 3600],
  max_redis_stale_seconds: [5, 3600],
  max_pm2_restarts_1h: [0, 100],
  max_memory_mb: [128, 32768],
  max_api_errors_5m: [0, 10000],
};

let memoryConfig = { ...DEFAULT_SAFETY_CONFIG };
let statusMemory = null;
let lastEvaluationMemory = null;
let recentEventsMemory = [];
let killSwitchMemory = { active: false, reason: null, triggered_at: null, cleared_at: null };
let manualArmedMemory = { manual_armed: false, reason: null, timestamp: null };

function nowIso() {
  return new Date().toISOString();
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

function numberOr(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function secondsSince(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

function normalizeConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const next = { ...DEFAULT_SAFETY_CONFIG, ...source };
  for (const field of BOOL_FIELDS) next[field] = boolValue(next[field], DEFAULT_SAFETY_CONFIG[field]);
  for (const [field, [min, max]] of Object.entries(NUMBER_LIMITS)) {
    next[field] = clamp(next[field], min, max);
  }
  next.mode = 'paper';
  next.live_trading_enabled = false;
  next.manual_armed = boolValue(next.manual_armed, false);
  return next;
}

async function getSafetyConfig() {
  const cached = await redisService.getJson(KEYS.config, null);
  if (cached && typeof cached === 'object') {
    memoryConfig = normalizeConfig(cached);
    return memoryConfig;
  }
  await redisService.setJson(KEYS.config, memoryConfig, 0);
  return memoryConfig;
}

function validateConfigPatch(input = {}) {
  const accepted = {};
  const rejected = {};
  const obj = input && typeof input === 'object' ? input : {};
  const allowed = new Set([...BOOL_FIELDS, ...Object.keys(NUMBER_LIMITS), 'mode', 'live_trading_enabled', 'manual_armed']);

  for (const field of BOOL_FIELDS) {
    if (!(field in obj)) continue;
    if (typeof obj[field] !== 'boolean') rejected[field] = 'must_be_boolean';
    else accepted[field] = obj[field];
  }

  for (const [field, [min, max]] of Object.entries(NUMBER_LIMITS)) {
    if (!(field in obj)) continue;
    const n = Number(obj[field]);
    if (!Number.isFinite(n) || n < min || n > max) rejected[field] = `must_be_${min}_to_${max}`;
    else accepted[field] = Math.round(n);
  }

  if ('mode' in obj) {
    const mode = String(obj.mode || '').toLowerCase();
    if (mode === 'live') rejected.mode = 'live_not_allowed';
    else if (mode !== 'paper') rejected.mode = 'only_paper_supported';
    else accepted.mode = 'paper';
  }

  if ('live_trading_enabled' in obj) {
    if (obj.live_trading_enabled === true) rejected.live_trading_enabled = 'live_trading_not_allowed_v1';
    else if (obj.live_trading_enabled !== false) rejected.live_trading_enabled = 'must_be_false';
    else accepted.live_trading_enabled = false;
  }

  if ('kill_switch_active' in obj) {
    delete accepted.kill_switch_active;
    rejected.kill_switch_active = 'use_kill_switch_endpoint';
  }

  if ('manual_armed' in obj) {
    if (obj.manual_armed === true) rejected.manual_armed = 'use_manual_arm_endpoint';
    else if (obj.manual_armed !== false) rejected.manual_armed = 'must_be_boolean';
    else accepted.manual_armed = false;
  }

  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) rejected[key] = 'field_not_allowed';
  }

  return { accepted, rejected };
}

async function updateStatus(patch = {}) {
  statusMemory = {
    ok: true,
    source: SOURCE,
    updatedAt: nowIso(),
    redis: redisService.status(),
    keys: KEYS,
    ...statusMemory,
    ...patch,
  };
  await redisService.setJson(KEYS.status, statusMemory, 0);
  return statusMemory;
}

async function storeEvent(event = {}) {
  const row = {
    ok: true,
    source: SOURCE,
    timestamp: nowIso(),
    ...event,
  };
  const current = await redisService.getJson(KEYS.recentEvents, recentEventsMemory);
  const next = [row, ...(Array.isArray(current) ? current : recentEventsMemory)].slice(0, 100);
  recentEventsMemory = next;
  await redisService.setJson(KEYS.recentEvents, next, 24 * 60 * 60);
  return row;
}

async function getKillSwitchState() {
  const stored = await redisService.getJson(KEYS.killSwitch, killSwitchMemory);
  if (stored && typeof stored === 'object') {
    killSwitchMemory = {
      active: stored.active === true,
      reason: stored.reason || null,
      triggered_at: stored.triggered_at || null,
      cleared_at: stored.cleared_at || null,
      clear_reason: stored.clear_reason || null,
    };
  }
  return killSwitchMemory;
}

async function getManualArmedState() {
  const stored = await redisService.getJson(KEYS.manualArmed, manualArmedMemory);
  if (stored && typeof stored === 'object') {
    manualArmedMemory = {
      manual_armed: stored.manual_armed === true,
      reason: stored.reason || null,
      timestamp: stored.timestamp || null,
    };
  }
  return manualArmedMemory;
}

function normalizeProviderStatus(value) {
  const v = String(value || '').toLowerCase();
  if (['ok', 'up', 'ready', 'healthy'].includes(v)) return 'ok';
  if (['degraded', 'fallback', 'warning'].includes(v)) return 'degraded';
  if (['down', 'error', 'failed', 'offline'].includes(v)) return 'down';
  return 'unknown';
}

function normalizeRedisStatus(value) {
  const v = String(value || '').toLowerCase();
  if (['ok', 'redis', 'ready'].includes(v)) return 'ok';
  if (['fallback', 'memory'].includes(v)) return 'fallback';
  if (['down', 'error', 'failed'].includes(v)) return 'down';
  return 'unknown';
}

function validateDataFreshness(context = {}, config = memoryConfig) {
  const warnings = [];
  const block_reasons = [];
  const data = context.data || {};
  const priceAge = secondsSince(data.last_price_at);
  const candleAge = secondsSince(data.last_candle_at);
  const scanAge = secondsSince(data.last_scan_at);
  const providerStatus = normalizeProviderStatus(data.provider_status);

  if (priceAge == null) warnings.push('missing_last_price_at');
  else if (priceAge > config.max_price_age_seconds) block_reasons.push('stale_price');

  if (candleAge == null) warnings.push('missing_last_candle_at');
  else if (candleAge > config.max_candle_age_seconds) block_reasons.push('stale_candle');

  if (scanAge == null) warnings.push('missing_last_scan_at');
  else if (scanAge > config.max_backend_scan_age_seconds) block_reasons.push('stale_scan');

  if (config.require_data_provider_ready && config.block_on_provider_down && providerStatus === 'down') {
    block_reasons.push('provider_down');
  } else if (providerStatus === 'degraded') {
    warnings.push('provider_degraded');
  } else if (providerStatus === 'unknown') {
    warnings.push('provider_status_unknown');
  }

  return {
    ok: block_reasons.length === 0,
    block_reasons,
    warnings,
    snapshot: { price_age_seconds: priceAge, candle_age_seconds: candleAge, scan_age_seconds: scanAge, provider_status: providerStatus },
  };
}

function validateSystemHealth(context = {}, config = memoryConfig) {
  const warnings = [];
  const block_reasons = [];
  const system = context.system || {};
  const redisStatus = normalizeRedisStatus(system.redis_status);
  const notificationStatus = normalizeProviderStatus(system.notification_status);
  const memoryMb = numberOr(system.memory_mb, null);
  const pm2Restarts1h = numberOr(system.pm2_restarts_1h, 0);
  const apiErrors5m = numberOr(system.api_errors_5m, 0);

  if (config.block_on_redis_down && redisStatus === 'down') block_reasons.push('redis_down');
  else if (redisStatus !== 'ok') warnings.push(`redis_${redisStatus}`);

  if (config.block_on_high_memory && memoryMb != null && memoryMb > config.max_memory_mb) block_reasons.push('high_memory');
  if (memoryMb == null) warnings.push('memory_unknown');

  if (config.block_on_pm2_restart_loop && pm2Restarts1h > config.max_pm2_restarts_1h) block_reasons.push('pm2_restart_loop');
  if (config.block_on_api_error_storm && apiErrors5m > config.max_api_errors_5m) block_reasons.push('api_error_storm');
  if (config.block_on_notification_failure && notificationStatus === 'down') block_reasons.push('system_health_bad');
  else if (notificationStatus !== 'ok' && notificationStatus !== 'unknown') warnings.push(`notification_${notificationStatus}`);

  return {
    ok: block_reasons.length === 0,
    block_reasons,
    warnings,
    snapshot: {
      redis_status: redisStatus,
      memory_mb: memoryMb,
      pm2_restarts_1h: pm2Restarts1h,
      api_errors_5m: apiErrors5m,
      notification_status: notificationStatus,
    },
  };
}

function validateRuntimeIntegrity(context = {}, config = memoryConfig) {
  const warnings = [];
  const block_reasons = [];
  const risk = context.risk || {};
  const exit = context.exit || {};

  if (config.require_risk_engine_pass && risk.allowed === false) block_reasons.push('risk_blocked');
  if (config.require_risk_engine_pass && risk.pause_trading === true) block_reasons.push('risk_pause');
  if (config.require_exit_engine_ready && exit.ready === false) block_reasons.push('exit_engine_not_ready');

  return { ok: block_reasons.length === 0, block_reasons, warnings, snapshot: { risk_allowed: risk.allowed, risk_pause_trading: risk.pause_trading, exit_ready: exit.ready } };
}

function validateMarketSession(context = {}, config = memoryConfig) {
  const warnings = [];
  const block_reasons = [];
  const market = context.market || {};
  if (config.block_on_market_closed && market.is_open === false) block_reasons.push('market_closed');
  if (market.is_open == null) warnings.push('market_session_unknown');
  return { ok: block_reasons.length === 0, block_reasons, warnings, snapshot: { is_open: market.is_open, market_group: market.market_group || null, session: market.session || null } };
}

async function buildHealthSnapshot() {
  const warnings = [];
  const redis = redisService.status();
  const memory = process.memoryUsage ? process.memoryUsage() : {};
  let systemHealth = null;
  let provider = null;
  let risk = null;
  let exit = null;
  let notification = null;

  try { systemHealth = await buildSystemHealth(); } catch (err) { warnings.push(`system_health_unavailable:${err.message || String(err)}`); }
  try { provider = await buildProviderStatus(); } catch (err) { warnings.push(`provider_status_unavailable:${err.message || String(err)}`); }
  try { risk = await riskEngineService.getRiskStatus(); } catch (err) { warnings.push(`risk_status_unavailable:${err.message || String(err)}`); }
  try { exit = await exitEngineService.getExitEngineStatus(); } catch (err) { warnings.push(`exit_status_unavailable:${err.message || String(err)}`); }
  try { notification = await notificationEngineV2.getStatus(); } catch (err) { warnings.push(`notification_status_unavailable:${err.message || String(err)}`); }

  return {
    warnings,
    redis,
    provider,
    system_health: systemHealth,
    risk_engine: risk,
    exit_engine: exit,
    notification_engine: notification ? {
      enabled: notification.enabled,
      configured: notification.configured,
      provider: notification.provider,
      fallback_logging: notification.fallback_logging,
    } : null,
    process: {
      memory_mb: memory.rss ? Math.round(memory.rss / 1024 / 1024) : null,
      heap_used_mb: memory.heapUsed ? Math.round(memory.heapUsed / 1024 / 1024) : null,
      uptime_seconds: Math.round(process.uptime ? process.uptime() : 0),
      pid: process.pid,
    },
  };
}

function baseEvaluation(context = {}, config = memoryConfig, killSwitch = killSwitchMemory, manual = manualArmedMemory) {
  return {
    ok: true,
    allowed: false,
    safety_level: 'safe',
    live_execution_allowed: false,
    paper_execution_allowed: true,
    block_reasons: [],
    warnings: [],
    requires_manual_action: false,
    manual_action: null,
    kill_switch_active: killSwitch.active === true || config.kill_switch_active === true,
    manual_armed: manual.manual_armed === true || config.manual_armed === true,
    live_trading_enabled: false,
    source: SOURCE,
    timestamp: nowIso(),
    symbol: context.symbol || null,
    direction: context.direction || null,
    tradeIntent: context.tradeIntent || 'NONE',
    context_source: context.source || null,
    replay_mode: context.replay_mode === true,
  };
}

async function persistEvaluation(evaluation) {
  lastEvaluationMemory = evaluation;
  await redisService.setJson(KEYS.lastEvaluation, evaluation, 30 * 60);
  await updateStatus({
    safety_level: evaluation.safety_level,
    allowed: evaluation.allowed,
    live_execution_allowed: evaluation.live_execution_allowed,
    paper_execution_allowed: evaluation.paper_execution_allowed,
    last_evaluation: evaluation,
    last_block_reasons: evaluation.block_reasons,
    kill_switch_active: evaluation.kill_switch_active,
  });
}

async function evaluateExecutionSafety(context = {}, options = {}) {
  const persist = options.persist !== false;
  const config = normalizeConfig(options.config || await getSafetyConfig());
  const killSwitch = await getKillSwitchState();
  const manual = await getManualArmedState();
  const evaluation = baseEvaluation(context || {}, config, killSwitch, manual);
  const blockReasons = [];
  const warnings = [];

  try {
    const source = String(context?.source || '').toLowerCase();
    const replayMode = context?.replay_mode === true || source.includes('replay');
    const dataFreshness = validateDataFreshness(context, config);
    const systemHealth = validateSystemHealth(context, config);
    const marketSession = validateMarketSession(context, config);
    const runtime = validateRuntimeIntegrity(context, config);

    blockReasons.push(...dataFreshness.block_reasons, ...systemHealth.block_reasons, ...marketSession.block_reasons, ...runtime.block_reasons);
    warnings.push(...dataFreshness.warnings, ...systemHealth.warnings, ...marketSession.warnings, ...runtime.warnings);

    if (!config.enabled) warnings.push('execution_safety_disabled');
    if (!config.live_trading_enabled) blockReasons.push('live_trading_disabled');
    if (config.require_manual_arming && !evaluation.manual_armed) {
      blockReasons.push('manual_not_armed');
      evaluation.requires_manual_action = true;
      evaluation.manual_action = 'manual_arm_required';
    }
    if (evaluation.kill_switch_active) blockReasons.push('kill_switch_active');
    if (replayMode && !config.allow_replay_execution) blockReasons.push('replay_mode_blocked');

    const systemOverall = String(context?.system?.overall_status || '').toUpperCase();
    if (config.block_on_system_health_bad && ['BAD', 'CRITICAL', 'BROKEN', 'ERROR'].includes(systemOverall)) {
      blockReasons.push('system_health_bad');
    }

    const priceAge = dataFreshness.snapshot.price_age_seconds;
    const providerDown = dataFreshness.block_reasons.includes('provider_down');
    const paperBlockReasons = [];
    if (evaluation.kill_switch_active) paperBlockReasons.push('kill_switch_active');
    if (runtime.block_reasons.includes('risk_pause')) paperBlockReasons.push('risk_pause');
    if (runtime.block_reasons.includes('risk_blocked')) paperBlockReasons.push('risk_blocked');
    if (providerDown) paperBlockReasons.push('provider_down');
    if (priceAge != null && priceAge > config.max_price_age_seconds * 4) paperBlockReasons.push('stale_price');
    if (config.block_on_system_health_bad && (systemHealth.block_reasons.includes('system_health_bad') || blockReasons.includes('system_health_bad'))) {
      paperBlockReasons.push('system_health_bad');
    }

    evaluation.block_reasons = Array.from(new Set(blockReasons));
    evaluation.warnings = Array.from(new Set(warnings));
    evaluation.live_execution_allowed = false;
    evaluation.paper_execution_allowed = paperBlockReasons.length === 0;
    evaluation.allowed = evaluation.live_execution_allowed;
    evaluation.paper_block_reasons = Array.from(new Set(paperBlockReasons));
    evaluation.data_freshness = dataFreshness.snapshot;
    evaluation.system_health = systemHealth.snapshot;
    evaluation.market_session = marketSession.snapshot;
    evaluation.runtime_integrity = runtime.snapshot;

    if (evaluation.kill_switch_active) evaluation.safety_level = 'kill_switch';
    else if (evaluation.block_reasons.length || !evaluation.paper_execution_allowed) evaluation.safety_level = 'block';
    else if (evaluation.warnings.length) evaluation.safety_level = 'warning';
    else evaluation.safety_level = 'safe';
  } catch (err) {
    evaluation.safety_level = 'block';
    evaluation.paper_execution_allowed = false;
    evaluation.live_execution_allowed = false;
    evaluation.allowed = false;
    evaluation.block_reasons = ['system_health_bad'];
    evaluation.warnings = [`execution_safety_error:${err.message || String(err)}`];
  }

  if (persist) {
    await persistEvaluation(evaluation);
    if (evaluation.paper_execution_allowed === false || evaluation.safety_level === 'kill_switch') {
      await storeEvent({ type: 'SAFETY_BLOCKED', symbol: evaluation.symbol, block_reasons: evaluation.paper_block_reasons || evaluation.block_reasons, safety_level: evaluation.safety_level });
    }
  }
  return evaluation;
}

async function shouldAllowLiveExecution(context = {}) {
  const evaluation = await evaluateExecutionSafety(context);
  return evaluation.live_execution_allowed === true;
}

async function updateSafetyConfig(partialConfig = {}) {
  const { accepted, rejected } = validateConfigPatch(partialConfig);
  if (Object.keys(rejected).length) {
    return { ok: false, error: 'invalid_safety_config', accepted, rejected, config: await getSafetyConfig() };
  }
  const current = await getSafetyConfig();
  const next = normalizeConfig({ ...current, ...accepted, mode: 'paper', live_trading_enabled: false });
  memoryConfig = next;
  await redisService.setJson(KEYS.config, next, 0);
  await updateStatus({ config_updated_at: nowIso(), config: next });
  await storeEvent({ type: 'SAFETY_CONFIG_UPDATED', updated: accepted });
  return { ok: true, config: next, updated: accepted, rejected: {} };
}

async function triggerKillSwitch(reason = 'manual_trigger') {
  const row = {
    active: true,
    reason: String(reason || 'manual_trigger').slice(0, 500),
    triggered_at: nowIso(),
    cleared_at: null,
  };
  killSwitchMemory = row;
  await redisService.setJson(KEYS.killSwitch, row, 0);
  const current = await getSafetyConfig();
  memoryConfig = normalizeConfig({ ...current, kill_switch_active: true });
  await redisService.setJson(KEYS.config, memoryConfig, 0);
  await updateStatus({ kill_switch_active: true, kill_switch_triggered_at: row.triggered_at });
  const event = await storeEvent({ type: 'EXECUTION_KILL_SWITCH_TRIGGERED', reason: row.reason });
  void notificationEngineV2.processExecutionSafetyEvent({
    type: 'kill_switch_triggered',
    reason: row.reason,
    safety_level: 'kill_switch',
    source: SOURCE,
  }).catch((err) => console.warn('[execution-safety] kill switch notification failed:', err.message));
  return { ok: true, kill_switch_active: true, kill_switch: row, event };
}

async function clearKillSwitch(reason = 'manual_clear') {
  const previous = await getKillSwitchState();
  const row = {
    active: false,
    reason: previous.reason || null,
    triggered_at: previous.triggered_at || null,
    cleared_at: nowIso(),
    clear_reason: String(reason || 'manual_clear').slice(0, 500),
  };
  killSwitchMemory = row;
  await redisService.setJson(KEYS.killSwitch, row, 0);
  const current = await getSafetyConfig();
  memoryConfig = normalizeConfig({ ...current, kill_switch_active: false });
  await redisService.setJson(KEYS.config, memoryConfig, 0);
  await updateStatus({ kill_switch_active: false, kill_switch_cleared_at: row.cleared_at });
  const event = await storeEvent({ type: 'EXECUTION_KILL_SWITCH_CLEARED', reason: row.clear_reason });
  void notificationEngineV2.processExecutionSafetyEvent({
    type: 'kill_switch_cleared',
    reason: row.clear_reason,
    safety_level: 'warning',
    source: SOURCE,
  }).catch((err) => console.warn('[execution-safety] kill switch clear notification failed:', err.message));
  return { ok: true, kill_switch_active: false, kill_switch: row, event };
}

async function manualArm(reason = 'manual_arm') {
  manualArmedMemory = { manual_armed: true, reason: String(reason || 'manual_arm').slice(0, 500), timestamp: nowIso() };
  await redisService.setJson(KEYS.manualArmed, manualArmedMemory, 0);
  const current = await getSafetyConfig();
  memoryConfig = normalizeConfig({ ...current, manual_armed: true });
  await redisService.setJson(KEYS.config, memoryConfig, 0);
  const event = await storeEvent({ type: 'EXECUTION_MANUAL_ARMED', reason: manualArmedMemory.reason });
  void notificationEngineV2.processExecutionSafetyEvent({ type: 'manual_armed', reason: manualArmedMemory.reason, source: SOURCE }).catch((err) => {
    console.warn('[execution-safety] manual arm notification failed:', err.message);
  });
  return { ok: true, manual_armed: true, event };
}

async function manualDisarm(reason = 'manual_disarm') {
  manualArmedMemory = { manual_armed: false, reason: String(reason || 'manual_disarm').slice(0, 500), timestamp: nowIso() };
  await redisService.setJson(KEYS.manualArmed, manualArmedMemory, 0);
  const current = await getSafetyConfig();
  memoryConfig = normalizeConfig({ ...current, manual_armed: false });
  await redisService.setJson(KEYS.config, memoryConfig, 0);
  const event = await storeEvent({ type: 'EXECUTION_MANUAL_DISARMED', reason: manualArmedMemory.reason });
  void notificationEngineV2.processExecutionSafetyEvent({ type: 'manual_disarmed', reason: manualArmedMemory.reason, source: SOURCE }).catch((err) => {
    console.warn('[execution-safety] manual disarm notification failed:', err.message);
  });
  return { ok: true, manual_armed: false, event };
}

async function getSafetyStatus() {
  const [config, status, lastEvaluation, recent, killSwitch, manual, snapshot] = await Promise.all([
    getSafetyConfig(),
    redisService.getJson(KEYS.status, statusMemory),
    redisService.getJson(KEYS.lastEvaluation, lastEvaluationMemory),
    redisService.getJson(KEYS.recentEvents, recentEventsMemory),
    getKillSwitchState(),
    getManualArmedState(),
    buildHealthSnapshot(),
  ]);

  return {
    ok: true,
    source: SOURCE,
    enabled: config.enabled,
    mode: config.mode,
    live_trading_enabled: false,
    manual_armed: manual.manual_armed === true || config.manual_armed === true,
    kill_switch_active: killSwitch.active === true || config.kill_switch_active === true,
    kill_switch: killSwitch,
    config,
    status: status || statusMemory,
    last_evaluation: lastEvaluation || null,
    recent_events: Array.isArray(recent) ? recent.slice(0, 100) : recentEventsMemory,
    health_snapshot: snapshot,
    redis: redisService.status(),
    keys: KEYS,
    timestamp: nowIso(),
  };
}

module.exports = {
  SOURCE,
  KEYS,
  DEFAULT_SAFETY_CONFIG,
  NUMBER_LIMITS,
  BOOL_FIELDS,
  getSafetyConfig,
  evaluateExecutionSafety,
  getSafetyStatus,
  updateSafetyConfig,
  triggerKillSwitch,
  clearKillSwitch,
  shouldAllowLiveExecution,
  validateDataFreshness,
  validateSystemHealth,
  validateMarketSession,
  validateRuntimeIntegrity,
  manualArm,
  manualDisarm,
};
