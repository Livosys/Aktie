'use strict';

// Native Futures: EMA Breakdown
//
// Migrering av Strategy Store-strategin `ema_breakdown` till native
// futures-vägen. Använder den nya modulära signal-producern
// (emaBreakdownProducer) som detekterar bearish breakdowns genom EMA-nivåer.
//
// Katalogdefinition (daytradingStrategyCatalogService, id ema_breakdown):
//   direction short, runtime_signal EMA_BREAKDOWN_DOWN (family EMA_BREAKDOWN),
//   default_stop_loss_pct 0.22, default_take_profit_r 1.5.

const { calcIndicators } = require('../scanner/indicators');
const momentumStrategy = require('./nativeFuturesMomentumStrategyService');

const STRATEGY_ID = 'native_futures_ema_breakdown_v1';
const STRATEGY_VERSION = 'migration1';
const SOURCE = 'native_futures_ema_breakdown_strategy';
const ORIGIN_STRATEGY_ID = 'ema_breakdown';
const DEFAULT_TICK_SIZE = 0.25;

const TARGET_SIGNAL_FAMILY = 'EMA_BREAKDOWN';
const TARGET_SIGNAL_SUBTYPE = 'EMA_BREAKDOWN_DOWN';

const MIN_CANDLES = 20;

const DECISIONS = momentumStrategy.DECISIONS;
const DIRECTIONS = momentumStrategy.DIRECTIONS;

const DEFAULT_OPTIONS = Object.freeze({
  stopLossPct: 0.22,
  takeProfitR: 1.5,
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

function evaluateNativeFuturesEmaBreakdownStrategy(snapshot, options = {}) {
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

  const ema21 = numberOrNull(indicators.ema21);
  const ema50 = numberOrNull(indicators.ema50);
  const ema9 = numberOrNull(indicators.ema9);

  // Breakdown requires price BELOW ema21
  if (!ema21 || entry >= ema21) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'price_not_below_ema21', {
      evidence: { entry, ema21 },
    });
  }

  // EMA stack must be broken (downtrend)
  const stackBrokenDown = (ema9 !== null && ema9 < ema21) || (ema21 < ema50);
  if (!stackBrokenDown) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'ema_stack_not_broken_down', {
      evidence: { ema9, ema21, ema50 },
    });
  }

  // SHORT direction only
  const direction = DIRECTIONS.SHORT;

  const stopLossPct = positiveNumber(settings.stopLossPct, DEFAULT_OPTIONS.stopLossPct);
  const takeProfitR = positiveNumber(settings.takeProfitR, DEFAULT_OPTIONS.takeProfitR);

  const stopLoss = roundToTick(entry * (1 + (stopLossPct / 100)), settings.tickSize);
  if (stopLoss == null || stopLoss <= entry) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'invalid_stop_distance', {
      evidence: { entry, stopLoss },
    });
  }

  const takeProfit = roundToTick(entry - ((stopLoss - entry) * takeProfitR), settings.tickSize);

  return baseDecision(snapshot, now, DECISIONS.SIGNAL, 'ema_breakdown_triggered', {
    direction,
    entryPrice: entry,
    stopLoss,
    takeProfit,
    riskReward: Number(takeProfitR.toFixed(2)),
    signalTimestamp: safeString(snapshot.latestCandle && snapshot.latestCandle.timestamp),
    evidence: {
      originStrategyId: ORIGIN_STRATEGY_ID,
      entry,
      ema9,
      ema21,
      ema50,
      stackBrokenDown: true,
    },
  });
}

function createNativeFuturesEmaBreakdownStrategy(options = {}) {
  return {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    evaluate(snapshot, overrides = {}) {
      return evaluateNativeFuturesEmaBreakdownStrategy(snapshot, { ...options, ...overrides });
    },
  };
}

const defaultNativeFuturesEmaBreakdownStrategy = createNativeFuturesEmaBreakdownStrategy();

module.exports = {
  STRATEGY_ID,
  STRATEGY_VERSION,
  DEFAULT_OPTIONS,
  ORIGIN_STRATEGY_ID,
  TARGET_SIGNAL_FAMILY,
  TARGET_SIGNAL_SUBTYPE,
  DECISIONS,
  DIRECTIONS,
  createNativeFuturesEmaBreakdownStrategy,
  defaultNativeFuturesEmaBreakdownStrategy,
  evaluateNativeFuturesEmaBreakdownStrategy,
  _internal: {
    MIN_CANDLES,
  },
};
