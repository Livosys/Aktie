'use strict';

// Strategy Trade Control — central paper-only regelmotor för:
//  - cooldown per strategyId (default 30 min)
//  - strategy family-exklusivitet (endast bästa kandidaten i en familj får
//    trade:a vid samma tillfälle, öppen position i familjen blockerar nya,
//    family cooldown efter senaste trade i familjen)
//
// Servicen är ren regel-logik utan sidoeffekter: den läser aldrig ledger,
// startar inget, skapar aldrig trades och rör aldrig broker/live-vägar.
// Både Paper Trading (paperTradingAgent) och Futures Paper
// (futuresPaperScannerService) anropar den med sina egna trade-fakta.

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const BLOCK_REASON_STRATEGY_COOLDOWN = 'strategy_cooldown_active';
const BLOCK_REASON_FAMILY_NOT_BEST = 'strategy_family_not_best_candidate';
const BLOCK_REASON_FAMILY_POSITION_OPEN = 'strategy_family_position_open';
const BLOCK_REASON_FAMILY_COOLDOWN = 'strategy_family_cooldown_active';

const DEFAULT_COOLDOWN_MINUTES = 30;
const DEFAULT_FAMILY_COOLDOWN_MINUTES = 30;

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getStrategyTradeControlConfig(overrides = {}) {
  return {
    cooldownMinutes: overrides.cooldownMinutes
      ?? envInt('STRATEGY_COOLDOWN_MINUTES', DEFAULT_COOLDOWN_MINUTES),
    familyCooldownMinutes: overrides.familyCooldownMinutes
      ?? envInt('STRATEGY_FAMILY_COOLDOWN_MINUTES', DEFAULT_FAMILY_COOLDOWN_MINUTES),
    familyExclusiveEnabled: overrides.familyExclusiveEnabled
      ?? envBool('STRATEGY_FAMILY_EXCLUSIVE_ENABLED', true),
  };
}

function toMs(value) {
  if (value == null) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// Familj för en strategi/kandidat. Prioritet:
//  1. explicit strategyFamily på kandidaten/traden
//  2. `family`-fältet i strategikatalogen (daytradingStrategyCatalogService)
//  3. rå signalFamily-etikett från signalen
// Returnerar null om ingen familj kan härledas — då gäller bara
// strategyId-cooldown, aldrig family gate.
function resolveStrategyFamily({ strategyId = null, strategyFamily = null, signalFamily = null } = {}) {
  const explicit = String(strategyFamily || '').trim();
  if (explicit) return explicit.toLowerCase();
  if (strategyId) {
    try {
      // Lazy require: undviker require-cykler mellan catalog/agent/scanner.
      const catalog = require('./daytradingStrategyCatalogService');
      const family = String(catalog.getStrategyById(String(strategyId))?.family || '').trim();
      if (family) return family.toLowerCase();
    } catch (_) { /* katalogfel får aldrig blockera paper-flödet */ }
  }
  const fromSignal = String(signalFamily || '').trim();
  if (fromSignal) return fromSignal.toLowerCase();
  return null;
}

// Cooldown per strategyId: blockera om strategin öppnade eller stängde en
// trade under de senaste `cooldownMinutes` minuterna.
function evaluateStrategyCooldown({ strategyId = null, lastTradeAt = null, now = new Date(), cooldownMinutes = null } = {}) {
  const minutes = Number.isFinite(Number(cooldownMinutes)) && Number(cooldownMinutes) > 0
    ? Number(cooldownMinutes)
    : getStrategyTradeControlConfig().cooldownMinutes;
  const cooldownMs = minutes * 60_000;
  const nowMs = toMs(now) || Date.now();
  const lastMs = toMs(lastTradeAt);
  const cooldownActive = lastMs > 0 && (nowMs - lastMs) < cooldownMs;
  const nextAllowedAt = lastMs > 0 ? new Date(lastMs + cooldownMs).toISOString() : null;
  return {
    strategyId: strategyId || null,
    cooldownMinutes: minutes,
    cooldownActive,
    strategyCooldownDecision: cooldownActive ? 'blocked' : 'allowed',
    blockReason: cooldownActive ? BLOCK_REASON_STRATEGY_COOLDOWN : null,
    lastTradeAt: lastMs > 0 ? new Date(lastMs).toISOString() : null,
    nextAllowedAt: cooldownActive ? nextAllowedAt : null,
    cooldownMinutesRemaining: cooldownActive ? Math.ceil((lastMs + cooldownMs - nowMs) / 60_000) : 0,
  };
}

// Rangordna kandidater inom sina familjer: rank 1 = bäst (högst score).
// scoreOf ska ge kandidatens confidence/score enligt befintlig scoring.
// Deterministisk tie-break: högre score, sedan strategyId i bokstavsordning.
// Returnerar en Map keyed på kandidat-objektet → { strategyFamily, familyRank,
// isBestInFamily, familyCandidateCount }.
function rankFamilyCandidates(candidates = [], { familyOf, scoreOf } = {}) {
  const familyFn = typeof familyOf === 'function'
    ? familyOf
    : (c) => resolveStrategyFamily({
      strategyId: c?.strategyId || c?.strategy_id || null,
      strategyFamily: c?.strategyFamily || null,
      signalFamily: c?.signalFamily || c?.rawSignalSummary?.signalFamily || null,
    });
  const scoreFn = typeof scoreOf === 'function'
    ? scoreOf
    : (c) => {
      const n = Number(c?.confidence ?? c?.confidenceScore ?? c?.score);
      return Number.isFinite(n) ? n : 0;
    };

  const byFamily = new Map();
  const result = new Map();
  for (const candidate of (Array.isArray(candidates) ? candidates : []).filter(Boolean)) {
    const family = familyFn(candidate) || null;
    if (!family) {
      result.set(candidate, { strategyFamily: null, familyRank: null, isBestInFamily: true, familyCandidateCount: 0 });
      continue;
    }
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(candidate);
  }
  for (const [family, rows] of byFamily.entries()) {
    const sorted = rows.slice().sort((a, b) => {
      const diff = scoreFn(b) - scoreFn(a);
      if (diff !== 0) return diff;
      return String(a.strategyId || a.strategy_id || '').localeCompare(String(b.strategyId || b.strategy_id || ''));
    });
    sorted.forEach((candidate, index) => {
      result.set(candidate, {
        strategyFamily: family,
        familyRank: index + 1,
        isBestInFamily: index === 0,
        familyCandidateCount: sorted.length,
      });
    });
  }
  return result;
}

// Family gate för en enskild kandidat. Kontrollordning:
//  1. öppen trade i familjen → strategy_family_position_open
//  2. family cooldown aktiv → strategy_family_cooldown_active
//  3. inte bästa kandidaten i familjen just nu → strategy_family_not_best_candidate
function evaluateFamilyGate({
  strategyFamily = null,
  familyRank = null,
  familyHasOpenPosition = false,
  familyLastTradeAt = null,
  now = new Date(),
  config = null,
} = {}) {
  const cfg = config || getStrategyTradeControlConfig();
  const base = {
    strategyFamily: strategyFamily || null,
    familyRank: familyRank ?? null,
    familyGateDecision: 'not_applicable',
    familyBlockReason: null,
    familyNextAllowedAt: null,
    familyCooldownMinutesRemaining: 0,
    familyExclusiveEnabled: cfg.familyExclusiveEnabled === true,
  };
  if (!strategyFamily || cfg.familyExclusiveEnabled !== true) return base;

  if (familyHasOpenPosition === true) {
    return { ...base, familyGateDecision: 'blocked', familyBlockReason: BLOCK_REASON_FAMILY_POSITION_OPEN };
  }

  const cooldownMs = cfg.familyCooldownMinutes * 60_000;
  const nowMs = toMs(now) || Date.now();
  const lastMs = toMs(familyLastTradeAt);
  if (lastMs > 0 && (nowMs - lastMs) < cooldownMs) {
    return {
      ...base,
      familyGateDecision: 'blocked',
      familyBlockReason: BLOCK_REASON_FAMILY_COOLDOWN,
      familyNextAllowedAt: new Date(lastMs + cooldownMs).toISOString(),
      familyCooldownMinutesRemaining: Math.ceil((lastMs + cooldownMs - nowMs) / 60_000),
    };
  }

  if (Number.isFinite(Number(familyRank)) && Number(familyRank) > 1) {
    return { ...base, familyGateDecision: 'blocked', familyBlockReason: BLOCK_REASON_FAMILY_NOT_BEST };
  }

  return { ...base, familyGateDecision: 'allowed' };
}

// Samlad bedömning: strategy cooldown först, sedan family gate. Returnerar
// alltid hela metadata-uppsättningen så candidates/trades kan bära den.
function evaluateStrategyTradeControl({
  strategyId = null,
  strategyName = null,
  strategyFamily = null,
  signalFamily = null,
  familyRank = null,
  lastTradeAt = null,
  familyHasOpenPosition = false,
  familyLastTradeAt = null,
  now = new Date(),
  config = null,
} = {}) {
  const cfg = config || getStrategyTradeControlConfig();
  const family = resolveStrategyFamily({ strategyId, strategyFamily, signalFamily });
  const cooldown = evaluateStrategyCooldown({
    strategyId,
    lastTradeAt,
    now,
    cooldownMinutes: cfg.cooldownMinutes,
  });
  const familyGate = evaluateFamilyGate({
    strategyFamily: family,
    familyRank,
    familyHasOpenPosition,
    familyLastTradeAt,
    now,
    config: cfg,
  });

  const blockReason = cooldown.blockReason || familyGate.familyBlockReason || null;
  return {
    strategyId: strategyId || null,
    strategyName: strategyName || null,
    strategyFamily: family,
    familyRank: familyGate.familyRank,
    familyGateDecision: familyGate.familyGateDecision,
    familyBlockReason: familyGate.familyBlockReason,
    strategyCooldownDecision: cooldown.strategyCooldownDecision,
    cooldownActive: cooldown.cooldownActive,
    cooldownMinutesRemaining: cooldown.cooldownMinutesRemaining,
    lastTradeAt: cooldown.lastTradeAt,
    nextAllowedAt: cooldown.blockReason
      ? cooldown.nextAllowedAt
      : (familyGate.familyBlockReason === BLOCK_REASON_FAMILY_COOLDOWN ? familyGate.familyNextAllowedAt : null),
    familyNextAllowedAt: familyGate.familyNextAllowedAt,
    familyCooldownMinutesRemaining: familyGate.familyCooldownMinutesRemaining,
    allowed: blockReason === null,
    blockReason,
    config: cfg,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  BLOCK_REASON_STRATEGY_COOLDOWN,
  BLOCK_REASON_FAMILY_NOT_BEST,
  BLOCK_REASON_FAMILY_POSITION_OPEN,
  BLOCK_REASON_FAMILY_COOLDOWN,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_FAMILY_COOLDOWN_MINUTES,
  getStrategyTradeControlConfig,
  resolveStrategyFamily,
  evaluateStrategyCooldown,
  rankFamilyCandidates,
  evaluateFamilyGate,
  evaluateStrategyTradeControl,
};
