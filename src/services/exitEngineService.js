'use strict';

const redisService = require('./redisService');

const SOURCE = 'exit_engine_v1';

const KEYS = {
  config: 'exit:config',
  status: 'exit:status',
  lastEvaluation: 'exit:last_evaluation',
  symbolEvaluationPrefix: 'exit:evaluation:',
  recentDecisions: 'exit:decisions:recent',
};

const DEFAULT_EXIT_CONFIG = Object.freeze({
  enabled: true,
  mode: 'paper',
  near_target_enabled: true,
  near_target_ratio: 0.9,
  near_target_min_profit_pct: 0.12,
  momentum_fade_enabled: true,
  trailing_enabled: true,
  trail_after_profit_pct: 0.10,
  trailing_distance_pct: 0.07,
  break_even_enabled: true,
  break_even_after_profit_pct: 0.08,
  tighten_stop_enabled: true,
  tighten_after_minutes: 6,
  timeout_intelligence_enabled: true,
  max_hold_minutes_default: 12,
  adaptive_target_enabled: true,
  min_target_pct: 0.10,
  max_target_pct: 0.30,
  partial_profit_enabled: false,
  partial_profit_ratio: 0.5,
  partial_profit_at_pct: 0.15,
});

const NUMBER_LIMITS = {
  near_target_ratio: [0.5, 0.99],
  near_target_min_profit_pct: [0.01, 2],
  trail_after_profit_pct: [0.01, 2],
  trailing_distance_pct: [0.01, 2],
  break_even_after_profit_pct: [0.01, 2],
  tighten_after_minutes: [1, 120],
  max_hold_minutes_default: [1, 240],
  min_target_pct: [0.01, 5],
  max_target_pct: [0.01, 10],
  partial_profit_ratio: [0.1, 0.9],
  partial_profit_at_pct: [0.01, 5],
};

const BOOL_FIELDS = [
  'enabled',
  'near_target_enabled',
  'momentum_fade_enabled',
  'trailing_enabled',
  'break_even_enabled',
  'tighten_stop_enabled',
  'timeout_intelligence_enabled',
  'adaptive_target_enabled',
  'partial_profit_enabled',
];

let memoryConfig = { ...DEFAULT_EXIT_CONFIG };
let lastEvaluationMemory = null;
let recentDecisionsMemory = [];
let statusMemory = null;

function nowIso() {
  return new Date().toISOString();
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
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

function boolValue(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
  }
  return fallback;
}

function normalizeDirection(value) {
  const v = String(value || '').toUpperCase();
  if (['UP', 'LONG', 'BUY'].includes(v)) return 'UP';
  if (['DOWN', 'SHORT', 'SELL'].includes(v)) return 'DOWN';
  return 'UNKNOWN';
}

function normalizeConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const next = { ...DEFAULT_EXIT_CONFIG, ...source };
  for (const field of BOOL_FIELDS) next[field] = boolValue(next[field], DEFAULT_EXIT_CONFIG[field]);
  for (const [field, [min, max]] of Object.entries(NUMBER_LIMITS)) {
    next[field] = clamp(next[field], min, max);
  }
  next.mode = String(next.mode || 'paper').toLowerCase() === 'paper' ? 'paper' : 'paper';
  if (next.min_target_pct > next.max_target_pct) {
    const min = next.max_target_pct;
    next.max_target_pct = next.min_target_pct;
    next.min_target_pct = min;
  }
  return next;
}

async function getExitConfig() {
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
  const allowed = new Set([...BOOL_FIELDS, ...Object.keys(NUMBER_LIMITS), 'mode']);

  for (const field of BOOL_FIELDS) {
    if (!(field in obj)) continue;
    if (typeof obj[field] !== 'boolean') rejected[field] = 'must_be_boolean';
    else accepted[field] = obj[field];
  }

  for (const [field, [min, max]] of Object.entries(NUMBER_LIMITS)) {
    if (!(field in obj)) continue;
    const n = Number(obj[field]);
    if (!Number.isFinite(n) || n < min || n > max) rejected[field] = `must_be_${min}_to_${max}`;
    else accepted[field] = n;
  }

  if ('mode' in obj) {
    const mode = String(obj.mode || '').toLowerCase();
    if (mode === 'live') rejected.mode = 'live_not_allowed';
    else if (mode !== 'paper') rejected.mode = 'only_paper_supported';
    else accepted.mode = 'paper';
  }

  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) rejected[key] = 'field_not_allowed';
  }

  return { accepted, rejected };
}

async function updateExitConfig(partialConfig = {}) {
  const { accepted, rejected } = validateConfigPatch(partialConfig);
  if (Object.keys(rejected).length) {
    return { ok: false, error: 'invalid_exit_config', accepted, rejected, config: await getExitConfig() };
  }
  const current = await getExitConfig();
  const next = normalizeConfig({ ...current, ...accepted, mode: 'paper' });
  memoryConfig = next;
  await redisService.setJson(KEYS.config, next, 0);
  await updateStatus({ config_updated_at: nowIso(), config: next });
  return { ok: true, config: next, updated: accepted, rejected: {} };
}

function getOpenedAt(openTrade = {}) {
  return openTrade.opened_at || openTrade.openedAt || openTrade.entryTime || openTrade.createdAt || null;
}

function getTradeId(openTrade = {}) {
  return openTrade.id || openTrade.trade_id || openTrade.tradeId || null;
}

function getEntryPrice(openTrade = {}) {
  return numberOr(openTrade.entry_price ?? openTrade.entryPrice, null);
}

function getCurrentPrice(openTrade = {}, marketState = {}) {
  return numberOr(marketState.price ?? openTrade.current_price ?? openTrade.currentPrice, null);
}

function getCurrentPnlPct(openTrade = {}, marketState = {}) {
  const explicit = numberOr(marketState.current_pnl_pct ?? openTrade.current_pnl_pct ?? openTrade.pnlPct ?? openTrade.unrealizedPct, null);
  if (explicit != null) return explicit;
  const entry = getEntryPrice(openTrade);
  const current = getCurrentPrice(openTrade, marketState);
  if (!entry || !current) return 0;
  const raw = ((current - entry) / entry) * 100;
  return normalizeDirection(openTrade.direction) === 'DOWN' ? -raw : raw;
}

function getTargetPct(openTrade = {}) {
  return numberOr(openTrade.target_pct ?? openTrade.targetPct, DEFAULT_EXIT_CONFIG.max_target_pct);
}

function getStopPct(openTrade = {}) {
  return numberOr(openTrade.stop_loss_pct ?? openTrade.stopPct ?? openTrade.stop_loss ?? 0, 0);
}

function getMaxFavorablePct(openTrade = {}, marketState = {}) {
  const current = getCurrentPnlPct(openTrade, marketState);
  return numberOr(openTrade.max_favorable_pct ?? openTrade.maxFavorablePct, current);
}

function getMaxAdversePct(openTrade = {}) {
  return numberOr(openTrade.max_adverse_pct ?? openTrade.maxAdversePct, 0);
}

function getAgeMinutes(openTrade = {}, marketState = {}) {
  const explicit = numberOr(marketState.age_minutes ?? marketState.ageMin ?? openTrade.age_minutes ?? openTrade.ageMin, null);
  if (explicit != null) return explicit;
  const openedAt = getOpenedAt(openTrade);
  if (!openedAt) return 0;
  const ts = new Date(openedAt).getTime();
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, (Date.now() - ts) / 60000);
}

function normalizeStrength(value, fallback = 'normal') {
  const v = String(value || fallback).toLowerCase();
  if (['strong', 'normal', 'weak', 'fading'].includes(v)) return v;
  if (['low', 'very_low', 'thin'].includes(v)) return 'weak';
  return fallback;
}

function compassAgrees(direction, compass) {
  const d = normalizeDirection(direction);
  const c = String(compass || '').toUpperCase();
  return (d === 'UP' && c === 'UP') || (d === 'DOWN' && c === 'DOWN');
}

function momentumAgainstTrade(openTrade = {}, marketState = {}) {
  const d = normalizeDirection(openTrade.direction);
  const c = String(marketState.market_compass || marketState.marketCompass || '').toUpperCase();
  if (d === 'UP' && c === 'DOWN') return true;
  if (d === 'DOWN' && c === 'UP') return true;
  return normalizeStrength(marketState.momentum_strength, 'normal') === 'fading';
}

function calculateAdaptiveTarget(openTrade = {}, marketState = {}, exitConfig = memoryConfig) {
  const cfg = normalizeConfig(exitConfig);
  const base = getTargetPct(openTrade);
  if (!cfg.adaptive_target_enabled) return round(clamp(base, cfg.min_target_pct, cfg.max_target_pct), 4);

  let target = base;
  const volume = normalizeStrength(marketState.volume_strength ?? openTrade.volumeState, 'normal');
  const compass = marketState.market_compass ?? marketState.marketCompass ?? openTrade.compassBias;
  const marketGroup = String(openTrade.market_group || openTrade.marketGroup || 'UNKNOWN').toUpperCase();
  const memorySummary = marketState.memory_summary || openTrade.memory_summary || openTrade.memorySummary || {};
  const signalStats = marketState.signal_stats || openTrade.signal_stats || openTrade.signalStats || {};
  const signalType = String(openTrade.signal_type || openTrade.signalSubtype || '').toUpperCase();
  const version = String(openTrade.version || openTrade.paperRulesVersion || openTrade.ruleVersion || '').toLowerCase();

  if (String(compass || '').toUpperCase() === 'MIXED') target *= 0.85;
  if (volume === 'weak') target *= 0.85;
  if (volume === 'normal') target *= 0.95;
  if (marketGroup === 'UNKNOWN') target *= 0.9;
  if (numberOr(memorySummary.win_rate, 100) < 40) target *= 0.9;
  if (numberOr(memorySummary.timeout_rate ?? signalStats.timeout_rate, 0) > 60) target *= 0.85;
  if (volume === 'strong') target *= 1.05;
  if (compassAgrees(openTrade.direction, compass)) target *= 1.05;
  if (version === 'v3' && marketGroup.includes('CRYPTO') && signalType.includes('VWAP') && volume === 'strong') target *= 1.05;
  if (numberOr(signalStats.target_hit_rate ?? memorySummary.target_hit_rate, 0) >= 60) target *= 1.05;

  return round(clamp(target, cfg.min_target_pct, cfg.max_target_pct), 4);
}

function calculateTrailingStop(openTrade = {}, marketState = {}, exitConfig = memoryConfig) {
  const cfg = normalizeConfig(exitConfig);
  if (!cfg.trailing_enabled) return null;
  const pnl = getCurrentPnlPct(openTrade, marketState);
  const maxFav = Math.max(getMaxFavorablePct(openTrade, marketState), pnl);
  if (maxFav < cfg.trail_after_profit_pct) return null;
  return round(Math.max(0, maxFav - cfg.trailing_distance_pct), 4);
}

function shouldTakeNearTargetProfit(openTrade = {}, marketState = {}, exitConfig = memoryConfig) {
  const cfg = normalizeConfig(exitConfig);
  if (!cfg.enabled || !cfg.near_target_enabled) return { ok: false };
  const pnl = getCurrentPnlPct(openTrade, marketState);
  const target = calculateAdaptiveTarget(openTrade, marketState, cfg);
  const threshold = target * cfg.near_target_ratio;
  if (pnl < threshold || pnl < cfg.near_target_min_profit_pct) return { ok: false, threshold: round(threshold, 4) };
  const momentum = normalizeStrength(marketState.momentum_strength, 'normal');
  if (momentum === 'strong' && cfg.trailing_enabled) {
    return { ok: false, holdForTrailing: true, threshold: round(threshold, 4) };
  }
  return { ok: true, threshold: round(threshold, 4) };
}

function shouldExitOnMomentumFade(openTrade = {}, marketState = {}, exitConfig = memoryConfig) {
  const cfg = normalizeConfig(exitConfig);
  if (!cfg.enabled || !cfg.momentum_fade_enabled) return { ok: false };
  const pnl = getCurrentPnlPct(openTrade, marketState);
  const momentum = normalizeStrength(marketState.momentum_strength, 'normal');
  const volume = normalizeStrength(marketState.volume_strength ?? openTrade.volumeState, 'normal');
  if (momentum === 'fading' && pnl > 0 && volume !== 'strong') return { ok: true };
  return { ok: false };
}

function breakEvenStop(openTrade = {}, marketState = {}, exitConfig = memoryConfig) {
  const cfg = normalizeConfig(exitConfig);
  if (!cfg.break_even_enabled) return null;
  const pnl = getCurrentPnlPct(openTrade, marketState);
  const maxFav = Math.max(getMaxFavorablePct(openTrade, marketState), pnl);
  if (maxFav < cfg.break_even_after_profit_pct) return null;
  return 0.01;
}

function shouldTightenStop(openTrade = {}, marketState = {}, exitConfig = memoryConfig) {
  const cfg = normalizeConfig(exitConfig);
  if (!cfg.enabled || !cfg.tighten_stop_enabled) return { ok: false };
  const pnl = getCurrentPnlPct(openTrade, marketState);
  const ageMin = getAgeMinutes(openTrade, marketState);
  const existing = numberOr(openTrade.exit_engine_stop_pct ?? openTrade.exitEngineStopPct, -getStopPct(openTrade));
  const be = breakEvenStop(openTrade, marketState, cfg);
  const trailing = calculateTrailingStop(openTrade, marketState, cfg);
  const candidates = [existing];
  if (be != null) candidates.push(be);
  if (trailing != null) candidates.push(trailing);
  if (ageMin >= cfg.tighten_after_minutes && pnl > 0) candidates.push(Math.max(0.01, pnl - cfg.trailing_distance_pct));
  const next = round(Math.max(...candidates), 4);
  if (next != null && next > existing) return { ok: true, new_stop_loss_pct: next };
  return { ok: false, new_stop_loss_pct: existing };
}

function isNearTimeout(openTrade = {}, marketState = {}, exitConfig = memoryConfig) {
  const cfg = normalizeConfig(exitConfig);
  const ageMin = getAgeMinutes(openTrade, marketState);
  const maxHold = numberOr(openTrade.max_hold_minutes ?? openTrade.maxHoldMinutes, cfg.max_hold_minutes_default);
  return ageMin >= Math.max(0, maxHold - 2) || ageMin >= maxHold * 0.8;
}

function baseDecision(openTrade, marketState, exitConfig, patch = {}) {
  const cfg = normalizeConfig(exitConfig);
  const adaptiveTarget = calculateAdaptiveTarget(openTrade, marketState, cfg);
  const trailingStop = calculateTrailingStop(openTrade, marketState, cfg);
  const tightened = shouldTightenStop(openTrade, marketState, cfg);
  return {
    ok: true,
    trade_id: getTradeId(openTrade),
    symbol: openTrade?.symbol || null,
    action: 'HOLD',
    reason: 'Ingen exit-signal.',
    exit_reason_code: 'hold',
    current_pnl_pct: round(getCurrentPnlPct(openTrade, marketState), 4),
    adaptive_target_pct: adaptiveTarget,
    trailing_stop_pct: trailingStop,
    new_stop_loss_pct: tightened.new_stop_loss_pct ?? null,
    confidence: 50,
    warnings: [],
    source: SOURCE,
    replay_mode: openTrade?.replay_mode === true || marketState?.replay_mode === true,
    mode: openTrade?.replay_mode === true || marketState?.replay_mode === true ? 'replay' : 'paper',
    timestamp: nowIso(),
    ...patch,
  };
}

function nearTargetPullback(openTrade = {}, marketState = {}, exitConfig = memoryConfig) {
  const cfg = normalizeConfig(exitConfig);
  if (!cfg.near_target_enabled) return { ok: false };
  const pnl = getCurrentPnlPct(openTrade, marketState);
  const maxFav = getMaxFavorablePct(openTrade, marketState);
  const target = calculateAdaptiveTarget(openTrade, marketState, cfg);
  const near = target * cfg.near_target_ratio;
  const pullback = maxFav - pnl;
  if (maxFav >= near && pnl < near && pullback >= Math.max(0.025, cfg.trailing_distance_pct * 0.5) && pnl > 0) {
    return { ok: true, near: round(near, 4), pullback: round(pullback, 4) };
  }
  return { ok: false, near: round(near, 4), pullback: round(pullback, 4) };
}

async function persistEvaluation(decision) {
  lastEvaluationMemory = decision;
  recentDecisionsMemory = [decision, ...recentDecisionsMemory].slice(0, 100);
  await redisService.setJson(KEYS.lastEvaluation, decision, 30 * 60);
  if (decision.symbol) {
    await redisService.setJson(`${KEYS.symbolEvaluationPrefix}${decision.symbol}`, decision, 30 * 60);
  }
  await redisService.setJson(KEYS.recentDecisions, recentDecisionsMemory, 24 * 60 * 60);
  await updateStatus({
    last_evaluation: decision,
    recent_count: recentDecisionsMemory.length,
    last_action: decision.action,
    last_reason_code: decision.exit_reason_code,
  });
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
}

async function evaluateExit(openTrade = {}, marketState = {}, exitConfig = null) {
  const warnings = [];
  const cfg = normalizeConfig(exitConfig || await getExitConfig());
  let decision = baseDecision(openTrade || {}, marketState || {}, cfg);

  try {
    if (!cfg.enabled) {
      decision = { ...decision, reason: 'Exit Engine är avstängd.', confidence: 20 };
    } else {
      const pnl = getCurrentPnlPct(openTrade, marketState);
      const stop = getStopPct(openTrade);
      const adaptiveTarget = calculateAdaptiveTarget(openTrade, marketState, cfg);
      const trailingStop = calculateTrailingStop(openTrade, marketState, cfg);
      const target = adaptiveTarget;
      const near = shouldTakeNearTargetProfit(openTrade, marketState, cfg);
      const pullback = nearTargetPullback(openTrade, marketState, cfg);
      const fade = shouldExitOnMomentumFade(openTrade, marketState, cfg);
      const tightened = shouldTightenStop(openTrade, marketState, cfg);
      const momentum = normalizeStrength(marketState.momentum_strength, 'normal');
      const volume = normalizeStrength(marketState.volume_strength ?? openTrade.volumeState, 'normal');
      const mixed = String(marketState.market_compass || marketState.marketCompass || '').toUpperCase() === 'MIXED';
      let heldForTrailing = false;

      if (!getTradeId(openTrade)) warnings.push('missing_trade_id');
      if (!openTrade?.symbol) warnings.push('missing_symbol');
      if (!getCurrentPrice(openTrade, marketState)) warnings.push('missing_current_price');

      if (stop > 0 && pnl <= -stop) {
        decision = baseDecision(openTrade, marketState, cfg, {
          action: 'EXIT',
          reason: 'Stop loss träffad.',
          exit_reason_code: 'stop_loss',
          confidence: 96,
        });
      } else if (pnl >= target) {
        decision = baseDecision(openTrade, marketState, cfg, {
          action: 'TAKE_PROFIT',
          reason: 'Target träffad.',
          exit_reason_code: 'target_hit',
          confidence: 96,
        });
      } else if (cfg.timeout_intelligence_enabled && isNearTimeout(openTrade, marketState, cfg)) {
        const maxFav = getMaxFavorablePct(openTrade, marketState);
        if (pnl > 0 && momentum === 'fading') {
          decision = baseDecision(openTrade, marketState, cfg, {
            action: 'EXIT',
            reason: 'Nära timeout med positiv PnL och fade.',
            exit_reason_code: 'timeout_intelligence',
            confidence: 86,
          });
        } else if (maxFav >= target * 0.8 && pnl < maxFav - 0.02) {
          decision = baseDecision(openTrade, marketState, cfg, {
            action: 'EXIT',
            reason: 'Nära timeout efter target-nära pullback.',
            exit_reason_code: 'timeout_intelligence',
            confidence: 88,
          });
        } else if (pnl > 0.01 && mixed) {
          decision = baseDecision(openTrade, marketState, cfg, {
            action: 'TAKE_PROFIT',
            reason: 'Nära timeout, lätt plus och mixed marknad.',
            exit_reason_code: 'timeout_intelligence',
            confidence: 82,
          });
        } else if (pnl < 0 && momentumAgainstTrade(openTrade, marketState)) {
          decision = baseDecision(openTrade, marketState, cfg, {
            action: 'EXIT',
            reason: 'Nära timeout, minus och momentum emot trade.',
            exit_reason_code: 'timeout_intelligence',
            confidence: 84,
          });
        }
      }

      if (decision.exit_reason_code === 'hold' && pullback.ok) {
        decision = baseDecision(openTrade, marketState, cfg, {
          action: momentum === 'strong' && cfg.trailing_enabled ? 'TIGHTEN_STOP' : 'EXIT',
          reason: 'Trade nådde nästan target men föll tillbaka.',
          exit_reason_code: 'near_target_pullback',
          new_stop_loss_pct: tightened.new_stop_loss_pct ?? Math.max(0.01, pnl - 0.02),
          confidence: momentum === 'strong' ? 78 : 88,
        });
      }

      if (decision.exit_reason_code === 'hold' && trailingStop != null && pnl <= trailingStop) {
        decision = baseDecision(openTrade, marketState, cfg, {
          action: 'EXIT',
          reason: `Trailing stop träffad vid ${round(trailingStop, 4)}%.`,
          exit_reason_code: 'trailing_stop',
          confidence: 92,
        });
      }

      if (decision.exit_reason_code === 'hold' && near.ok) {
        decision = baseDecision(openTrade, marketState, cfg, {
          action: 'TAKE_PROFIT',
          reason: `Tar vinst nära target (${near.threshold}%).`,
          exit_reason_code: 'near_target_profit',
          confidence: 90,
        });
      } else if (decision.exit_reason_code === 'hold' && near.holdForTrailing) {
        heldForTrailing = true;
        decision = baseDecision(openTrade, marketState, cfg, {
          action: 'HOLD',
          reason: 'Nära target men momentum är starkt; trailing får arbeta.',
          exit_reason_code: 'hold',
          confidence: 72,
        });
      }

      if (decision.exit_reason_code === 'hold' && fade.ok) {
        decision = baseDecision(openTrade, marketState, cfg, {
          action: pnl >= cfg.near_target_min_profit_pct ? 'TAKE_PROFIT' : 'EXIT',
          reason: volume === 'strong' ? 'Momentum fade trots stark volym.' : 'Momentum fade utan stark volym.',
          exit_reason_code: 'momentum_fade',
          confidence: 84,
        });
      }

      const be = breakEvenStop(openTrade, marketState, cfg);
      if (!heldForTrailing && decision.exit_reason_code === 'hold' && be != null && pnl <= Math.max(0.02, be + 0.01)) {
        decision = baseDecision(openTrade, marketState, cfg, {
          action: momentum === 'fading' ? 'EXIT' : 'TIGHTEN_STOP',
          reason: momentum === 'fading' ? 'Positiv trade föll mot break-even med fade.' : 'Break-even skydd aktiverat.',
          exit_reason_code: 'break_even',
          new_stop_loss_pct: Math.max(be, tightened.new_stop_loss_pct || be),
          confidence: momentum === 'fading' ? 82 : 76,
        });
      } else if (!heldForTrailing && decision.exit_reason_code === 'hold' && tightened.ok) {
        decision = baseDecision(openTrade, marketState, cfg, {
          action: 'TIGHTEN_STOP',
          reason: 'Stop tajtas efter positiv utveckling.',
          exit_reason_code: be != null ? 'break_even' : 'hold',
          new_stop_loss_pct: tightened.new_stop_loss_pct,
          confidence: 70,
        });
      }
    }
  } catch (err) {
    decision = baseDecision(openTrade || {}, marketState || {}, cfg, {
      action: 'HOLD',
      reason: 'Exit Engine fallback efter internt fel.',
      exit_reason_code: 'hold',
      confidence: 0,
      warnings: [`exit_engine_error:${err.message || String(err)}`],
    });
  }

  decision.warnings = Array.from(new Set([...(decision.warnings || []), ...warnings]));
  await persistEvaluation(decision);
  return decision;
}

async function getExitEngineStatus() {
  const [config, status, lastEvaluation, recent] = await Promise.all([
    getExitConfig(),
    redisService.getJson(KEYS.status, statusMemory),
    redisService.getJson(KEYS.lastEvaluation, lastEvaluationMemory),
    redisService.getJson(KEYS.recentDecisions, recentDecisionsMemory),
  ]);
  return {
    ok: true,
    source: SOURCE,
    enabled: config.enabled,
    mode: config.mode,
    config,
    last_evaluation: lastEvaluation || null,
    recent_decisions: Array.isArray(recent) ? recent.slice(0, 100) : recentDecisionsMemory,
    status: status || statusMemory,
    redis: redisService.status(),
    keys: KEYS,
    timestamp: nowIso(),
  };
}

module.exports = {
  SOURCE,
  KEYS,
  DEFAULT_EXIT_CONFIG,
  getExitConfig,
  evaluateExit,
  calculateAdaptiveTarget,
  calculateTrailingStop,
  shouldTakeNearTargetProfit,
  shouldExitOnMomentumFade,
  shouldTightenStop,
  getExitEngineStatus,
  updateExitConfig,
};
