'use strict';

// Native Futures: Mean Reversion VWAP
//
// Migrering av Strategy Store-strategin `mean_reversion_vwap` till native
// futures-vägen. Använder den nya modulära signal-producern
// (vwapMeanReversionProducer) som detekterar när priset har extended långt
// från VWAP och visar tecken på återgång.
//
// Katalogdefinition (daytradingStrategyCatalogService, id mean_reversion_vwap):
//   direction both, runtime_signal VWAP_MEAN_REVERSION (family VWAP_MEAN_REVERSION),
//   default_stop_loss_pct 0.25, default_take_profit_r 1.3.

const { calcIndicators } = require('../scanner/indicators');
const momentumStrategy = require('./nativeFuturesMomentumStrategyService');

const STRATEGY_ID = 'native_futures_mean_reversion_vwap_v1';
const STRATEGY_VERSION = 'migration1';
const SOURCE = 'native_futures_mean_reversion_vwap_strategy';
const ORIGIN_STRATEGY_ID = 'mean_reversion_vwap';
const DEFAULT_TICK_SIZE = 0.25;

const TARGET_SIGNAL_FAMILY = 'VWAP_MEAN_REVERSION';
const TARGET_SIGNAL_SUBTYPE = 'VWAP_MEAN_REVERSION';

const MIN_CANDLES = 20;

const DECISIONS = momentumStrategy.DECISIONS;
const DIRECTIONS = momentumStrategy.DIRECTIONS;

const DEFAULT_OPTIONS = Object.freeze({
  stopLossPct: 0.25,
  takeProfitR: 1.3,
  tickSize: DEFAULT_TICK_SIZE,
});

const {
  contractBlockers,
  marketBlockers,
  quotePrice,
  roundToTick,
} = momentumStrategy._internal;

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

function evaluateNativeFuturesMeanReversionVwapStrategy(snapshot, options = {}) {
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

  const engineCandles = snapshot.candles || [];
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

  const vwap = numberOrNull(indicators.vwap);
  const rsi14 = numberOrNull(indicators.rsi14);
  const distancePct = vwap && entry ? Math.abs((entry - vwap) / vwap) * 100 : null;

  // Mean reversion requires extreme extension (>1.5% from VWAP)
  if (!distancePct || distancePct < 1.5) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'price_too_close_to_vwap', {
      evidence: { distancePct: numberOrNull(distancePct), vwap, entry },
    });
  }

  // Need momentum signal (RSI extremes)
  if (!rsi14 || (rsi14 > 30 && rsi14 < 70)) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'no_momentum_exhaustion', {
      evidence: { rsi14, distancePct },
    });
  }

  // Determine direction based on position and RSI
  let direction;
  if (entry > vwap && rsi14 > 70) {
    direction = DIRECTIONS.SHORT; // Overbought → revert down
  } else if (entry < vwap && rsi14 < 30) {
    direction = DIRECTIONS.LONG; // Oversold → revert up
  } else {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'direction_momentum_mismatch', {
      evidence: { entry, vwap, rsi14 },
    });
  }

  const stopLossPct = positiveNumber(settings.stopLossPct, DEFAULT_OPTIONS.stopLossPct);
  const takeProfitR = positiveNumber(settings.takeProfitR, DEFAULT_OPTIONS.takeProfitR);

  const stopLoss = direction === DIRECTIONS.LONG
    ? roundToTick(entry * (1 - (stopLossPct / 100)), settings.tickSize)
    : roundToTick(entry * (1 + (stopLossPct / 100)), settings.tickSize);

  if (stopLoss == null || (direction === DIRECTIONS.LONG && stopLoss >= entry) || (direction === DIRECTIONS.SHORT && stopLoss <= entry)) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'invalid_stop_distance', {
      evidence: { direction, entry, stopLoss },
    });
  }

  const takeProfit = direction === DIRECTIONS.LONG
    ? roundToTick(entry + ((entry - stopLoss) * takeProfitR), settings.tickSize)
    : roundToTick(entry - ((stopLoss - entry) * takeProfitR), settings.tickSize);

  return baseDecision(snapshot, now, DECISIONS.SIGNAL, 'mean_reversion_vwap_triggered', {
    direction,
    entryPrice: entry,
    stopLoss,
    takeProfit,
    riskReward: Number(takeProfitR.toFixed(2)),
    signalTimestamp: safeString(snapshot.latestCandle && snapshot.latestCandle.timestamp),
    evidence: {
      originStrategyId: ORIGIN_STRATEGY_ID,
      vwap,
      vwapDistancePct: numberOrNull(distancePct),
      rsi14,
    },
  });
}

function createNativeFuturesMeanReversionVwapStrategy(options = {}) {
  return {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    evaluate(snapshot, overrides = {}) {
      return evaluateNativeFuturesMeanReversionVwapStrategy(snapshot, { ...options, ...overrides });
    },
  };
}

const defaultNativeFuturesMeanReversionVwapStrategy = createNativeFuturesMeanReversionVwapStrategy();

module.exports = {
  STRATEGY_ID,
  STRATEGY_VERSION,
  DEFAULT_OPTIONS,
  ORIGIN_STRATEGY_ID,
  TARGET_SIGNAL_FAMILY,
  TARGET_SIGNAL_SUBTYPE,
  DECISIONS,
  DIRECTIONS,
  createNativeFuturesMeanReversionVwapStrategy,
  defaultNativeFuturesMeanReversionVwapStrategy,
  evaluateNativeFuturesMeanReversionVwapStrategy,
  _internal: {
    MIN_CANDLES,
  },
};
