'use strict';

// Native Futures: Narrow Fakeout Reversal
//
// Migrering av Strategy Store-strategin `narrow_fakeout_reversal_v1` till native
// futures-vägen. Ingen handelslogik är nyskriven. Samma legacy-beslutskedja som
// migrering 2–6:
//
//   calcIndicators -> classifyNarrowState -> enrichIndicatorsFromCandles
//                  -> buildDecisionMonitor -> kandidatens signalFamily/signalSubtype
//
// Fakeout-detektorn är `calcFakeoutReversal` i scanner/narrowState.js. Den kräver
// narrowScore >= FAKEOUT_MIN_NARROW_SCORE och sätter eventType NARROW_FAKEOUT,
// varpå classifySignalFamily ger subtypen NARROW_FAKEOUT i en egen gren (före
// bull/bear-uppdelningen). Den här strategin äger den subtypen ensam.
//
// RIKTNING: katalogens runtime-signal har direction 'UNKNOWN' — motorn bestämmer.
// Riktningen tas därför från legacy `deriveDirection(sig)` via
// `familyDebug.direction`, exakt samma värde som aktievägen handlar på (adaptern
// läser nextMoveBias, som deriveDirection kortsluter på). `fakeoutReversal.direction`
// registreras i evidence för spårbarhet men överstyr INTE — att låta den överstyra
// vore ny handelslogik, inte en migrering.
//
// Katalogdefinition (daytradingStrategyCatalogService, id narrow_fakeout_reversal_v1):
//   direction both, runtime_signal NARROW_FAKEOUT (family NARROW_COMPRESSION),
//   default_stop_loss_pct 0.22, default_take_profit_r 1.3.

const { calcIndicators } = require('../scanner/indicators');
const momentumStrategy = require('./nativeFuturesMomentumStrategyService');
const emaStrategy = require('./nativeFuturesEmaPullbackContinuationStrategyService');

const STRATEGY_ID = 'native_futures_narrow_fakeout_reversal_v1';
const STRATEGY_VERSION = 'migration7';
const SOURCE = 'native_futures_narrow_fakeout_reversal_strategy';
const ORIGIN_STRATEGY_ID = 'narrow_fakeout_reversal_v1';
const DEFAULT_TICK_SIZE = 0.25;

const TARGET_SIGNAL_FAMILY = 'NARROW_COMPRESSION';
const TARGET_SIGNAL_SUBTYPE = 'NARROW_FAKEOUT';

const MIN_CANDLES = 20;

const DECISIONS = momentumStrategy.DECISIONS;
const DIRECTIONS = momentumStrategy.DIRECTIONS;

const DEFAULT_OPTIONS = Object.freeze({
  stopLossPct: 0.22,
  takeProfitR: 1.3,
  tickSize: DEFAULT_TICK_SIZE,
});

const {
  contractBlockers,
  marketBlockers,
  quotePrice,
  roundToTick,
} = momentumStrategy._internal;

const { toEngineCandles, legacyCandidateFor } = emaStrategy._internal;

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function upper(value) {
  const text = safeString(value);
  return text ? text.toUpperCase() : null;
}

function lower(value) {
  const text = safeString(value);
  return text ? text.toLowerCase() : null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveNumber(value, fallback) {
  const n = numberOrNull(value);
  return n != null && n > 0 ? n : fallback;
}

function baseDecision(snapshot, now, decision, reason, extra = {}) {
  return {
    ok: decision !== DECISIONS.BLOCKED,
    decision,
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    symbol: upper(snapshot && snapshot.symbol),
    timeframe: lower(snapshot && snapshot.timeframe),
    reason,
    blockers: [],
    evaluatedAt: nowIso(now),
    marketSnapshotTimestamp: safeString(snapshot && snapshot.timestamp),
    source: SOURCE,
    direction: null,
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    ...extra,
  };
}

function legacyDirectionOf(candidate) {
  const raw = upper(candidate && candidate.familyDebug && candidate.familyDebug.direction);
  if (raw === 'UP') return DIRECTIONS.LONG;
  if (raw === 'DOWN') return DIRECTIONS.SHORT;
  return null;
}

function evaluateNativeFuturesNarrowFakeoutReversalStrategy(snapshot, options = {}) {
  const now = options.now || new Date();
  const settings = { ...DEFAULT_OPTIONS, ...options };

  if (!snapshot || typeof snapshot !== 'object') {
    return baseDecision(null, now, DECISIONS.BLOCKED, 'missing_market_snapshot', {
      blockers: ['missing_market_snapshot'],
    });
  }

  const blockers = [
    ...contractBlockers(snapshot),
    ...marketBlockers(snapshot),
  ];
  if (blockers.length > 0) {
    return baseDecision(snapshot, now, DECISIONS.BLOCKED, blockers[0], {
      blockers: [...new Set(blockers)],
    });
  }

  const engineCandles = toEngineCandles(snapshot.candles);
  if (engineCandles.length < MIN_CANDLES) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'insufficient_candle_history', {
      evidence: { candlesAvailable: engineCandles.length, candlesRequired: MIN_CANDLES },
    });
  }

  const indicators = calcIndicators(engineCandles);
  if (!indicators) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'insufficient_indicator_data', {
      evidence: { candlesAvailable: engineCandles.length },
    });
  }

  const entry = roundToTick(quotePrice(snapshot.latestQuote), settings.tickSize);
  if (entry == null) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'missing_entry_price');
  }

  const { classified, candidate } = legacyCandidateFor({
    snapshot,
    engineCandles,
    indicators,
    price: entry,
    now,
  });

  if (!candidate) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'legacy_decision_unavailable');
  }

  const fakeout = classified.fakeoutReversal || {};
  const direction = legacyDirectionOf(candidate);
  const evidence = {
    originStrategyId: ORIGIN_STRATEGY_ID,
    legacyStrategyId: candidate.strategyId || null,
    signalFamily: candidate.signalFamily || null,
    signalSubtype: candidate.signalSubtype || null,
    legacyDirection: candidate.familyDebug ? candidate.familyDebug.direction : null,
    legacyBias: candidate.nextMoveBias || null,
    legacyPriority: candidate.priority || null,
    narrowState: classified.state,
    narrowScore: classified.narrowScore,
    eventType: classified.eventType,
    engineSignal: classified.signal,
    fakeoutActive: fakeout.active === true,
    fakeoutDirection: safeString(fakeout.direction),
    fakeoutBrokenSide: safeString(fakeout.brokenSide),
    fakeoutBarsSinceBreak: numberOrNull(fakeout.barsSinceBreak),
    timeframeAgreement: candidate.timeframeAgreement || candidate.timeframes || null,
    hardBlockers: Array.isArray(candidate.hardBlockers) ? [...candidate.hardBlockers] : [],
    extensionLevel: candidate.extensionLevel || null,
    atr14: numberOrNull(candidate.atr14),
    vwap: numberOrNull(candidate.vwap),
    candlesEvaluated: engineCandles.length,
  };

  const matched = candidate.signalFamily === TARGET_SIGNAL_FAMILY
    && candidate.signalSubtype === TARGET_SIGNAL_SUBTYPE;

  if (!matched) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'narrow_fakeout_reversal_not_triggered', {
      evidence,
    });
  }

  if (!direction) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'narrow_fakeout_direction_unclear', {
      evidence,
    });
  }

  const stopLossPct = positiveNumber(settings.stopLossPct, DEFAULT_OPTIONS.stopLossPct);
  const takeProfitR = positiveNumber(settings.takeProfitR, DEFAULT_OPTIONS.takeProfitR);
  const isLong = direction === DIRECTIONS.LONG;
  const stopLoss = roundToTick(
    isLong ? entry * (1 - (stopLossPct / 100)) : entry * (1 + (stopLossPct / 100)),
    settings.tickSize,
  );
  if (stopLoss == null || (isLong ? stopLoss >= entry : stopLoss <= entry)) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'invalid_stop_distance', { evidence });
  }
  const risk = Math.abs(entry - stopLoss);
  const takeProfit = roundToTick(
    isLong ? entry + (risk * takeProfitR) : entry - (risk * takeProfitR),
    settings.tickSize,
  );
  if (takeProfit == null || (isLong ? takeProfit <= entry : takeProfit >= entry)) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'invalid_target_distance', { evidence });
  }

  return baseDecision(snapshot, now, DECISIONS.SIGNAL, 'narrow_fakeout_reversal', {
    direction,
    entryPrice: entry,
    stopLoss,
    takeProfit,
    riskReward: Number(takeProfitR.toFixed(2)),
    signalTimestamp: safeString(snapshot.latestCandle && snapshot.latestCandle.timestamp),
    evidence,
  });
}

function createNativeFuturesNarrowFakeoutReversalStrategy(options = {}) {
  return {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    evaluate(snapshot, overrides = {}) {
      return evaluateNativeFuturesNarrowFakeoutReversalStrategy(snapshot, { ...options, ...overrides });
    },
  };
}

const defaultNativeFuturesNarrowFakeoutReversalStrategy = createNativeFuturesNarrowFakeoutReversalStrategy();

module.exports = {
  STRATEGY_ID,
  STRATEGY_VERSION,
  // Strategins parametrar. Exponeras för att Strategy DNA ska kunna härledas
  // ur koden i stället för ur en handskriven tabell — och för att en mutation
  // ska kunna ändra ett värde utan att någon rör strategikoden.
  DEFAULT_OPTIONS,
  ORIGIN_STRATEGY_ID,
  TARGET_SIGNAL_FAMILY,
  TARGET_SIGNAL_SUBTYPE,
  DECISIONS,
  DIRECTIONS,
  createNativeFuturesNarrowFakeoutReversalStrategy,
  defaultNativeFuturesNarrowFakeoutReversalStrategy,
  evaluateNativeFuturesNarrowFakeoutReversalStrategy,
  _internal: {
    legacyDirectionOf,
    MIN_CANDLES,
  },
};
