'use strict';

// Native Futures: Trend Continuation
//
// Migrering av Strategy Store-strategin `trend_continuation` till native
// futures-vägen. Ingen handelslogik är nyskriven. Samma legacy-beslutskedja som
// migrering 2–4:
//
//   calcIndicators -> classifyNarrowState -> enrichIndicatorsFromCandles
//                  -> buildDecisionMonitor -> kandidatens signalFamily/signalSubtype
//
// REGULAR_PULLBACK är den FÖRSTA grenen i `classifySignalFamily` och kortsluter
// alla andra familjer. Den här strategin äger därför den grenen ensam, och kan
// per konstruktion aldrig trigga samtidigt som narrow/ema/vwap-migreringarna.
//
// TVÅRIKTAD: katalogen anger direction 'both'. Riktningen tas från legacy
// `deriveDirection(sig)`, som exponeras oförändrad via `familyDebug.direction`
// (decisionMonitor kör buildSignalFamilyDebug på SAMMA familyInput som
// classifySignalFamily). Ingen egen riktningshärledning görs här.
//
// Katalogdefinition (daytradingStrategyCatalogService, id trend_continuation):
//   direction both, runtime_signal REGULAR_PULLBACK (family REGULAR_PULLBACK),
//   default_sl 0.24, default_tp 1.8.
//   signal_rules [trend_confirmed, pause_or_flag, breaks_pause_in_trend_direction,
//   volume_not_weak] — motorns pullback-detektor sätter eventType REGULAR_PULLBACK
//   först när de villkoren är uppfyllda.

const { calcIndicators } = require('../scanner/indicators');
const momentumStrategy = require('./nativeFuturesMomentumStrategyService');
const emaStrategy = require('./nativeFuturesEmaPullbackContinuationStrategyService');

const STRATEGY_ID = 'native_futures_trend_continuation_v1';
const STRATEGY_VERSION = 'migration5';
const SOURCE = 'native_futures_trend_continuation_strategy';
const ORIGIN_STRATEGY_ID = 'trend_continuation';
const DEFAULT_TICK_SIZE = 0.25;

const TARGET_SIGNAL_FAMILY = 'REGULAR_PULLBACK';
const TARGET_SIGNAL_SUBTYPE = 'REGULAR_PULLBACK';

const MIN_CANDLES = 20;

const DECISIONS = momentumStrategy.DECISIONS;
const DIRECTIONS = momentumStrategy.DIRECTIONS;

const DEFAULT_OPTIONS = Object.freeze({
  stopLossPct: 0.24,
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

// Legacy-riktningen, oförändrad. 'UP'/'DOWN' -> LONG/SHORT, allt annat = ingen affär.
function legacyDirectionOf(candidate) {
  const raw = upper(candidate && candidate.familyDebug && candidate.familyDebug.direction);
  if (raw === 'UP') return DIRECTIONS.LONG;
  if (raw === 'DOWN') return DIRECTIONS.SHORT;
  return null;
}

function evaluateNativeFuturesTrendContinuationStrategy(snapshot, options = {}) {
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
    eventType: classified.eventType,
    engineSignal: classified.signal,
    timeframeAgreement: candidate.timeframeAgreement || candidate.timeframes || null,
    agreementCount: candidate.agreementCount ?? null,
    hardBlockers: Array.isArray(candidate.hardBlockers) ? [...candidate.hardBlockers] : [],
    extensionLevel: candidate.extensionLevel || null,
    ema21: numberOrNull(candidate.ema21),
    ema50: numberOrNull(candidate.ema50),
    atr14: numberOrNull(candidate.atr14),
    vwap: numberOrNull(candidate.vwap),
    volumeState: safeString(candidate.volumeState),
    candlesEvaluated: engineCandles.length,
  };

  const matched = candidate.signalFamily === TARGET_SIGNAL_FAMILY
    && candidate.signalSubtype === TARGET_SIGNAL_SUBTYPE;

  if (!matched) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'trend_continuation_not_triggered', {
      evidence,
    });
  }

  // Legacy gav familjen men ingen tydlig riktning — då tar strategin ingen affär.
  // Samma utfall som aktievägen, där kandidaten blir en observation utan entry.
  if (!direction) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'trend_continuation_direction_unclear', {
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

  return baseDecision(snapshot, now, DECISIONS.SIGNAL, 'trend_continuation', {
    direction,
    entryPrice: entry,
    stopLoss,
    takeProfit,
    riskReward: Number(takeProfitR.toFixed(2)),
    signalTimestamp: safeString(snapshot.latestCandle && snapshot.latestCandle.timestamp),
    evidence,
  });
}

function createNativeFuturesTrendContinuationStrategy(options = {}) {
  return {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    evaluate(snapshot, overrides = {}) {
      return evaluateNativeFuturesTrendContinuationStrategy(snapshot, { ...options, ...overrides });
    },
  };
}

const defaultNativeFuturesTrendContinuationStrategy = createNativeFuturesTrendContinuationStrategy();

module.exports = {
  STRATEGY_ID,
  STRATEGY_VERSION,
  ORIGIN_STRATEGY_ID,
  TARGET_SIGNAL_FAMILY,
  TARGET_SIGNAL_SUBTYPE,
  DECISIONS,
  DIRECTIONS,
  createNativeFuturesTrendContinuationStrategy,
  defaultNativeFuturesTrendContinuationStrategy,
  evaluateNativeFuturesTrendContinuationStrategy,
  _internal: {
    legacyDirectionOf,
    MIN_CANDLES,
  },
};
