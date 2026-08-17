'use strict';

// Native Futures: VWAP Failed Breakout Short
//
// Migrering av Strategy Store-strategin `vwap_failed_breakout_short` till native
// futures-vägen. Ingen handelslogik är nyskriven. Samma legacy-beslutskedja som
// migrering 2 och 3:
//
//   calcIndicators -> classifyNarrowState -> enrichIndicatorsFromCandles
//                  -> buildDecisionMonitor -> kandidatens signalFamily/signalSubtype
//
// Detta är SHORT-sidan av samma motorgren som `vwap_volume_breakout_long` läser.
// `evaluateVwapReclaimRejection` är riktningsneutral — den kör mot direction UP
// eller DOWN beroende på vad `deriveDirection` ger. Long-strategin matchar
// VWAP_RECLAIM_UP, den här matchar VWAP_REJECTION_DOWN. Ingen av dem kan trigga
// samtidigt: classifySignalFamily returnerar exakt en subtyp per snapshot.
//
// Katalogdefinition (daytradingStrategyCatalogService, id vwap_failed_breakout_short):
//   direction short, runtime_signal VWAP_REJECTION_DOWN (family VWAP_RECLAIM_REJECTION),
//   default_stop_loss_pct 0.2, default_take_profit_r 1.4.
//   signal_rules [vwap_breakout_fails, volume_spike, mean_reversion_down].

const { calcIndicators } = require('../scanner/indicators');
const momentumStrategy = require('./nativeFuturesMomentumStrategyService');
const emaStrategy = require('./nativeFuturesEmaPullbackContinuationStrategyService');

const STRATEGY_ID = 'native_futures_vwap_failed_breakout_short_v1';
const STRATEGY_VERSION = 'migration4';
const SOURCE = 'native_futures_vwap_failed_breakout_short_strategy';
const ORIGIN_STRATEGY_ID = 'vwap_failed_breakout_short';
const DEFAULT_TICK_SIZE = 0.25;

const TARGET_SIGNAL_FAMILY = 'VWAP_RECLAIM_REJECTION';
const TARGET_SIGNAL_SUBTYPE = 'VWAP_REJECTION_DOWN';

const MIN_CANDLES = 20;

const DECISIONS = momentumStrategy.DECISIONS;
const DIRECTIONS = momentumStrategy.DIRECTIONS;

const DEFAULT_OPTIONS = Object.freeze({
  stopLossPct: 0.2,
  takeProfitR: 1.4,
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

function evaluateNativeFuturesVwapFailedBreakoutShortStrategy(snapshot, options = {}) {
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

  const vwapAttempt = candidate.familyDebug?.attemptedFamilies?.VWAP_RECLAIM_REJECTION || null;
  const evidence = {
    originStrategyId: ORIGIN_STRATEGY_ID,
    legacyStrategyId: candidate.strategyId || null,
    signalFamily: candidate.signalFamily || null,
    signalSubtype: candidate.signalSubtype || null,
    legacyDirection: candidate.nextMoveBias || null,
    legacyPriority: candidate.priority || null,
    narrowState: classified.state,
    eventType: classified.eventType,
    timeframeAgreement: candidate.timeframeAgreement || candidate.timeframes || null,
    agreementCount: candidate.agreementCount ?? null,
    hardBlockers: Array.isArray(candidate.hardBlockers) ? [...candidate.hardBlockers] : [],
    extensionLevel: candidate.extensionLevel || null,
    vwap: numberOrNull(candidate.vwap),
    vwapDistancePct: numberOrNull(candidate.vwapDistancePct),
    atr14: numberOrNull(candidate.atr14),
    relVol20: numberOrNull(candidate.relVol20 ?? candidate.rvol),
    volumeState: safeString(candidate.volumeState),
    vwapAttempt: vwapAttempt
      ? {
        matched: vwapAttempt.matched === true,
        missing: vwapAttempt.missing || [],
        failedReasons: vwapAttempt.failedReasons || [],
        details: vwapAttempt.details || {},
      }
      : null,
    candlesEvaluated: engineCandles.length,
  };

  const matched = candidate.signalFamily === TARGET_SIGNAL_FAMILY
    && candidate.signalSubtype === TARGET_SIGNAL_SUBTYPE;

  if (!matched) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'vwap_failed_breakout_short_not_triggered', {
      evidence,
    });
  }

  // Short: stop ÖVER entry, target UNDER. Spegelvänt mot long-strategierna,
  // samma katalogaritmetik.
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

  return baseDecision(snapshot, now, DECISIONS.SIGNAL, 'vwap_failed_breakout_short', {
    direction: DIRECTIONS.SHORT,
    entryPrice: entry,
    stopLoss,
    takeProfit,
    riskReward: Number(takeProfitR.toFixed(2)),
    signalTimestamp: safeString(snapshot.latestCandle && snapshot.latestCandle.timestamp),
    evidence,
  });
}

function createNativeFuturesVwapFailedBreakoutShortStrategy(options = {}) {
  return {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    evaluate(snapshot, overrides = {}) {
      return evaluateNativeFuturesVwapFailedBreakoutShortStrategy(snapshot, { ...options, ...overrides });
    },
  };
}

const defaultNativeFuturesVwapFailedBreakoutShortStrategy = createNativeFuturesVwapFailedBreakoutShortStrategy();

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
  createNativeFuturesVwapFailedBreakoutShortStrategy,
  defaultNativeFuturesVwapFailedBreakoutShortStrategy,
  evaluateNativeFuturesVwapFailedBreakoutShortStrategy,
  _internal: {
    MIN_CANDLES,
  },
};
