'use strict';

// Native Futures: Narrow State Expansion Long
//
// Migrering av Strategy Store-strategin `narrow_state_expansion_long` till native
// futures-vägen. Ingen handelslogik är nyskriven: narrow state-klassificeringen körs
// av den befintliga motorn `scanner/narrowState.js` och indikatorerna av den befintliga
// `scanner/indicators.js`. Modulen översätter bara native-snapshoten till det format de
// motorerna redan talar, och katalogens parametrar till konkreta nivåer.
//
// Katalogdefinition (daytradingStrategyCatalogService, id narrow_state_expansion_long):
//   direction long, signal_rules [narrow_state_detected, upside_breakout, volume_spike,
//   strong_move_up], default_stop_loss_pct 0.2, default_take_profit_r 1.7.
// I motorn motsvaras de fyra reglerna exakt av eventType BULLISH_ELEPHANT_BREAKOUT
// (kräver narrow state + bullish elephant bar, dvs. stark rörelse med volymbekräftelse)
// tillsammans med signal LONG_TRIGGERED. Long only — short tas aldrig.

const { classifyNarrowState } = require('../scanner/narrowState');
const { calcIndicators } = require('../scanner/indicators');
const momentumStrategy = require('./nativeFuturesMomentumStrategyService');

const STRATEGY_ID = 'native_futures_narrow_state_expansion_long_v1';
const STRATEGY_VERSION = 'migration1';
const SOURCE = 'native_futures_narrow_state_expansion_strategy';
const ORIGIN_STRATEGY_ID = 'narrow_state_expansion_long';
const DEFAULT_TICK_SIZE = 0.25;

// Minsta serie för att motorn ska kunna klassificera. calcIndicators kräver 20 ljus och
// returnerar annars null; sma200/bbwPct120/atrPct120 kräver mer och degraderar till null
// var för sig, precis som på aktievägen.
const MIN_CANDLES = 20;

// Motorns två narrow-tillstånd. Övriga tillstånd (REGULAR_TREND, WIDE_AVOID,
// BREAKOUT_ALREADY_OCCURRED, THREE_FINGER_SPREAD_AVOID, NO_TRADE) är per definition
// inte narrow state och tillhör därmed inte den här strategin.
const NARROW_STATES = new Set(['HIGH_QUALITY_NARROW', 'MEDIUM_NARROW']);

const DECISIONS = momentumStrategy.DECISIONS;
const DIRECTIONS = momentumStrategy.DIRECTIONS;

const DEFAULT_OPTIONS = Object.freeze({
  stopLossPct: 0.2,
  takeProfitR: 1.7,
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

// Native-snapshoten normaliserar ljus till open/high/low/close/volume. Narrow state- och
// indikatormotorerna läser aktievägens korta fältnamn. Översättningen är ren omdöpning.
function toEngineCandles(candles = []) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map((row) => {
      const o = numberOrNull(row && row.open);
      const h = numberOrNull(row && row.high);
      const l = numberOrNull(row && row.low);
      const c = numberOrNull(row && row.close);
      if ([o, h, l, c].some((value) => value == null)) return null;
      const t = safeString(row && row.timestamp);
      return { o, h, l, c, v: numberOrNull(row.volume) || 0, t, ts: t };
    })
    .filter(Boolean);
}

function evaluateNativeFuturesNarrowStateExpansionStrategy(snapshot, options = {}) {
  const now = options.now || new Date();
  const settings = { ...DEFAULT_OPTIONS, ...options };

  if (!snapshot || typeof snapshot !== 'object') {
    return baseDecision(null, now, DECISIONS.BLOCKED, 'missing_market_snapshot', {
      blockers: ['missing_market_snapshot'],
    });
  }

  // Samma kontrakts- och marknadsgrindar som momentumstrategin — importerade, inte
  // kopierade, så de två strategierna aldrig kan glida isär.
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

  const classified = classifyNarrowState({
    symbol: upper(snapshot.symbol),
    price: entry,
    candles2m: engineCandles,
    indicators,
    lastUpdate: nowIso(now),
  });

  const evidence = {
    originStrategyId: ORIGIN_STRATEGY_ID,
    narrowState: classified.state,
    narrowType: classified.narrowType,
    eventType: classified.eventType,
    engineSignal: classified.signal,
    narrowScore: classified.narrowScore,
    tradeScore: classified.tradeScore,
    confidence: classified.confidence,
    relVol20: classified.relVol20,
    elephantBarActive: Boolean(classified.elephantBar && classified.elephantBar.active),
    elephantBarDirection: classified.elephantBar ? classified.elephantBar.direction : null,
    candlesEvaluated: engineCandles.length,
  };

  // De fyra katalogreglerna i motorns termer:
  //   narrow_state_detected            -> state HIGH_QUALITY_NARROW | MEDIUM_NARROW
  //   upside_breakout + strong_move_up -> eventType BULLISH_ELEPHANT_BREAKOUT
  //   volume_spike                     -> ligger i elephant bar-motorns volConfirm
  //   (long only)                      -> signal LONG_TRIGGERED
  // Narrow-state-kravet måste stå explicit: motorn ger BULLISH_ELEPHANT_BREAKOUT även
  // ur REGULAR_TREND, och den vägen tillhör en annan strategi än den som migreras.
  const isNarrowState = NARROW_STATES.has(classified.state);
  const isExpansionLong = isNarrowState
    && classified.eventType === 'BULLISH_ELEPHANT_BREAKOUT'
    && classified.signal === 'LONG_TRIGGERED';

  if (!isExpansionLong) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'narrow_state_expansion_not_triggered', {
      evidence,
    });
  }

  const stopLossPct = positiveNumber(settings.stopLossPct, DEFAULT_OPTIONS.stopLossPct);
  const takeProfitR = positiveNumber(settings.takeProfitR, DEFAULT_OPTIONS.takeProfitR);
  const stopLoss = roundToTick(entry * (1 - (stopLossPct / 100)), settings.tickSize);
  if (stopLoss == null || stopLoss >= entry) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'invalid_stop_distance', { evidence });
  }
  const takeProfit = roundToTick(entry + ((entry - stopLoss) * takeProfitR), settings.tickSize);

  return baseDecision(snapshot, now, DECISIONS.SIGNAL, 'narrow_state_expansion_long', {
    direction: DIRECTIONS.LONG,
    entryPrice: entry,
    stopLoss,
    takeProfit,
    riskReward: Number(takeProfitR.toFixed(2)),
    signalTimestamp: safeString(snapshot.latestCandle && snapshot.latestCandle.timestamp),
    evidence,
  });
}

function createNativeFuturesNarrowStateExpansionStrategy(options = {}) {
  return {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    evaluate(snapshot, overrides = {}) {
      return evaluateNativeFuturesNarrowStateExpansionStrategy(snapshot, { ...options, ...overrides });
    },
  };
}

const defaultNativeFuturesNarrowStateExpansionStrategy = createNativeFuturesNarrowStateExpansionStrategy();

module.exports = {
  STRATEGY_ID,
  STRATEGY_VERSION,
  // Strategins parametrar. Exponeras för att Strategy DNA ska kunna härledas
  // ur koden i stället för ur en handskriven tabell — och för att en mutation
  // ska kunna ändra ett värde utan att någon rör strategikoden.
  DEFAULT_OPTIONS,
  ORIGIN_STRATEGY_ID,
  DECISIONS,
  DIRECTIONS,
  createNativeFuturesNarrowStateExpansionStrategy,
  defaultNativeFuturesNarrowStateExpansionStrategy,
  evaluateNativeFuturesNarrowStateExpansionStrategy,
  _internal: {
    toEngineCandles,
    MIN_CANDLES,
  },
};
