'use strict';

// Native Futures: Narrow Breakout (bear entry)
//
// Migrering av Strategy Store-strategin `narrow_breakout` till native futures-vägen.
// Ingen handelslogik är nyskriven. Samma legacy-beslutskedja som migrering 2–5:
//
//   calcIndicators -> classifyNarrowState -> enrichIndicatorsFromCandles
//                  -> buildDecisionMonitor -> kandidatens signalFamily/signalSubtype
//
// VARFÖR ENDAST BEAR-SIDAN:
// Katalogen ger `narrow_breakout` tre runtime-signaler:
//   NARROW_BULL_ENTRY  routing_enabled: false      -> ska inte routas
//   NARROW_BEAR_ENTRY  runtime_status: 'partial'   -> den entry-kapabla sidan
//   NARROW_WAIT        can_create_paper_trade: false, entry_capable: false
// Dessutom löser runtime-mappen NARROW_BULL_ENTRY till `narrow_state_expansion_long`,
// som redan är migrerad (migrering 1). Bull-sidan porteras därför INTE här — den
// skulle dubblera en befintlig strategi. NARROW_WAIT matchas aldrig eftersom
// målsubtypen står explicit.
//
// Katalogdefinition (daytradingStrategyCatalogService, id narrow_breakout):
//   runtime_signal NARROW_BEAR_ENTRY (family NARROW_COMPRESSION, direction DOWN),
//   default_sl 0.2, default_tp 1.8.
//   signal_rules [narrow_state_detected, range_compression, breakout_candle,
//   relative_volume_rising] — motorns narrow state-klassificering plus
//   riktningshärledningen i classifySignalFamily.

const { calcIndicators } = require('../scanner/indicators');
const momentumStrategy = require('./nativeFuturesMomentumStrategyService');
const emaStrategy = require('./nativeFuturesEmaPullbackContinuationStrategyService');

const STRATEGY_ID = 'native_futures_narrow_breakout_short_v1';
const STRATEGY_VERSION = 'migration6';
const SOURCE = 'native_futures_narrow_breakout_short_strategy';
const ORIGIN_STRATEGY_ID = 'narrow_breakout';
const DEFAULT_TICK_SIZE = 0.25;

const TARGET_SIGNAL_FAMILY = 'NARROW_COMPRESSION';
const TARGET_SIGNAL_SUBTYPE = 'NARROW_BEAR_ENTRY';

const MIN_CANDLES = 20;

const DECISIONS = momentumStrategy.DECISIONS;
const DIRECTIONS = momentumStrategy.DIRECTIONS;

const DEFAULT_OPTIONS = Object.freeze({
  stopLossPct: 0.2,
  takeProfitR: 1.8,
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

function evaluateNativeFuturesNarrowBreakoutShortStrategy(snapshot, options = {}) {
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

  const evidence = {
    originStrategyId: ORIGIN_STRATEGY_ID,
    legacyStrategyId: candidate.strategyId || null,
    signalFamily: candidate.signalFamily || null,
    signalSubtype: candidate.signalSubtype || null,
    legacyDirection: candidate.familyDebug ? candidate.familyDebug.direction : null,
    legacyBias: candidate.nextMoveBias || null,
    legacyPriority: candidate.priority || null,
    narrowState: classified.state,
    narrowType: classified.narrowType,
    narrowScore: classified.narrowScore,
    eventType: classified.eventType,
    engineSignal: classified.signal,
    relVol20: numberOrNull(classified.relVol20),
    compressionRatio: numberOrNull(classified.compressionRatio),
    timeframeAgreement: candidate.timeframeAgreement || candidate.timeframes || null,
    hardBlockers: Array.isArray(candidate.hardBlockers) ? [...candidate.hardBlockers] : [],
    extensionLevel: candidate.extensionLevel || null,
    atr14: numberOrNull(candidate.atr14),
    candlesEvaluated: engineCandles.length,
  };

  const matched = candidate.signalFamily === TARGET_SIGNAL_FAMILY
    && candidate.signalSubtype === TARGET_SIGNAL_SUBTYPE;

  if (!matched) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'narrow_breakout_short_not_triggered', {
      evidence,
    });
  }

  const stopLossPct = positiveNumber(settings.stopLossPct, DEFAULT_OPTIONS.stopLossPct);
  const takeProfitR = positiveNumber(settings.takeProfitR, DEFAULT_OPTIONS.takeProfitR);
  const stopLoss = roundToTick(entry * (1 + (stopLossPct / 100)), settings.tickSize);
  if (stopLoss == null || stopLoss <= entry) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'invalid_stop_distance', { evidence });
  }
  const takeProfit = roundToTick(entry - ((stopLoss - entry) * takeProfitR), settings.tickSize);
  if (takeProfit == null || takeProfit >= entry) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'invalid_target_distance', { evidence });
  }

  return baseDecision(snapshot, now, DECISIONS.SIGNAL, 'narrow_breakout_short', {
    direction: DIRECTIONS.SHORT,
    entryPrice: entry,
    stopLoss,
    takeProfit,
    riskReward: Number(takeProfitR.toFixed(2)),
    signalTimestamp: safeString(snapshot.latestCandle && snapshot.latestCandle.timestamp),
    evidence,
  });
}

function createNativeFuturesNarrowBreakoutShortStrategy(options = {}) {
  return {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    evaluate(snapshot, overrides = {}) {
      return evaluateNativeFuturesNarrowBreakoutShortStrategy(snapshot, { ...options, ...overrides });
    },
  };
}

const defaultNativeFuturesNarrowBreakoutShortStrategy = createNativeFuturesNarrowBreakoutShortStrategy();

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
  createNativeFuturesNarrowBreakoutShortStrategy,
  defaultNativeFuturesNarrowBreakoutShortStrategy,
  evaluateNativeFuturesNarrowBreakoutShortStrategy,
  _internal: {
    MIN_CANDLES,
  },
};
