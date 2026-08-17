'use strict';

// Native Futures: EMA Pullback Continuation
//
// Migrering av Strategy Store-strategin `ema_pullback_continuation` till native
// futures-vägen. Ingen handelslogik är nyskriven. Modulen kör EXAKT samma
// beslutskedja som aktievägen kör i produktion:
//
//   scanner/indicators.js       calcIndicators(candles2m)
//   scanner/narrowState.js      classifyNarrowState(...)          (v2-motorn)
//   scanner/indicatorEnrichment enrichIndicatorsFromCandles(...)  (ema/vwap/tf-fält)
//   scanner/decisionMonitor.js  buildDecisionMonitor(...)         (bias, blockerare,
//                                                                  extension, familj)
//
// Beslutet tas alltså av `classifySignalFamily` inuti decisionMonitor, med hela
// dess precedens (REGULAR_PULLBACK -> NARROW_COMPRESSION -> VWAP -> EMA) intakt.
// Den här modulen läser bara ut resultatet och översätter träffen till nivåer.
//
// VIKTIGT om tidsramar: legacy hämtar ALDRIG 15m/30m/1h-ljus. `tf1h`/`tf30m`/`tf15m`
// härleds av `deriveTimeframesFromCandles` ur SAMMA 2m-serie genom att slica de
// sista 60/30/15 ljusen (indicatorEnrichment.js:186-201). Native-snapshoten bär
// redan 2m-serien, så ingen ny datakälla och ingen ny tidsram behövs.
//
// Katalogdefinition (daytradingStrategyCatalogService, id ema_pullback_continuation):
//   direction long, runtime_signal EMA_PULLBACK_UP (family EMA_TREND_PULLBACK),
//   default_sl 0.22, default_tp 1.7.

const { classifyNarrowState } = require('../scanner/narrowState');
const { calcIndicators } = require('../scanner/indicators');
const { enrichIndicatorsFromCandles } = require('../scanner/indicatorEnrichment');
const { buildDecisionMonitor } = require('../scanner/decisionMonitor');
const momentumStrategy = require('./nativeFuturesMomentumStrategyService');

const STRATEGY_ID = 'native_futures_ema_pullback_continuation_v1';
const STRATEGY_VERSION = 'migration2';
const SOURCE = 'native_futures_ema_pullback_continuation_strategy';
const ORIGIN_STRATEGY_ID = 'ema_pullback_continuation';
const DEFAULT_TICK_SIZE = 0.25;

// Legacy-familjen och -subtypen som katalogen kopplar till strategin. Endast long
// finns i katalogen (direction: 'long'), så EMA_PULLBACK_DOWN tas aldrig.
const TARGET_SIGNAL_FAMILY = 'EMA_TREND_PULLBACK';
const TARGET_SIGNAL_SUBTYPE = 'EMA_PULLBACK_UP';

// Samma minimikrav som narrow state-migreringen: calcIndicators returnerar null
// under 20 ljus. Tidsramsslicen degraderar var för sig precis som på aktievägen.
const MIN_CANDLES = 20;

const DECISIONS = momentumStrategy.DECISIONS;
const DIRECTIONS = momentumStrategy.DIRECTIONS;

const DEFAULT_OPTIONS = Object.freeze({
  stopLossPct: 0.22,
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

// Native-snapshoten normaliserar ljus till open/high/low/close/volume. Motorerna
// läser aktievägens korta fältnamn. Översättningen är ren omdöpning.
// (normalizeCandles i indicatorEnrichment tar båda, men narrowState/indicators
// kräver de korta.)
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
      if (!t) return null;
      return { o, h, l, c, v: numberOrNull(row.volume) || 0, t, ts: t };
    })
    .filter(Boolean);
}

// Kör legacy-kedjan och returnerar decisionMonitor-kandidaten. Inget beslut fattas
// här — allt kommer ur de befintliga modulerna.
function legacyCandidateFor({ snapshot, engineCandles, indicators, price, now }) {
  const classified = classifyNarrowState({
    symbol: upper(snapshot.symbol),
    price,
    candles2m: engineCandles,
    indicators,
    lastUpdate: nowIso(now),
  });

  const enriched = enrichIndicatorsFromCandles(classified, engineCandles);
  const latest = engineCandles[engineCandles.length - 1];
  const result = {
    ...classified,
    ...enriched,
    symbol: upper(snapshot.symbol),
    // latestTimestamp() i decisionMonitor läser candleTs först. Färskheten mäts
    // mot senaste 2m-ljuset, precis som aktievägen gör.
    candleTs: latest ? latest.t : null,
    lastUpdate: latest ? latest.t : nowIso(now),
  };

  // liveCandleDebugBySymbol är decisionMonitors enda väg till candleScore2m.
  // Utan den blir 2m-candlescoren tom och EMA-grenens candleAligned alltid false
  // (samma fälla som stoppade futures Trading OS tidigare).
  const monitor = buildDecisionMonitor({
    stockResults: [result],
    cryptoResults: [],
    liveCandleDebugBySymbol: {
      [upper(snapshot.symbol)]: {
        candles: engineCandles.map((row) => ({
          timestamp: row.t,
          open: row.o,
          high: row.h,
          low: row.l,
          close: row.c,
          volume: row.v,
        })),
      },
    },
    familyDebug: true,
  });

  return { classified, candidate: (monitor.candidates || [])[0] || null };
}

function evaluateNativeFuturesEmaPullbackContinuationStrategy(snapshot, options = {}) {
  const now = options.now || new Date();
  const settings = { ...DEFAULT_OPTIONS, ...options };

  if (!snapshot || typeof snapshot !== 'object') {
    return baseDecision(null, now, DECISIONS.BLOCKED, 'missing_market_snapshot', {
      blockers: ['missing_market_snapshot'],
    });
  }

  // Samma kontrakts- och marknadsgrindar som momentum- och narrow state-strategin —
  // importerade, inte kopierade, så grindarna aldrig kan glida isär.
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

  const emaAttempt = candidate.familyDebug?.attemptedFamilies?.EMA_TREND_PULLBACK || null;
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
    ema21: numberOrNull(candidate.ema21),
    ema50: numberOrNull(candidate.ema50),
    atr14: numberOrNull(candidate.atr14),
    vwap: numberOrNull(candidate.vwap),
    emaAttempt: emaAttempt
      ? {
        matched: emaAttempt.matched === true,
        missing: emaAttempt.missing || [],
        failedReasons: emaAttempt.failedReasons || [],
        details: emaAttempt.details || {},
      }
      : null,
    candlesEvaluated: engineCandles.length,
  };

  const matched = candidate.signalFamily === TARGET_SIGNAL_FAMILY
    && candidate.signalSubtype === TARGET_SIGNAL_SUBTYPE;

  if (!matched) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'ema_pullback_continuation_not_triggered', {
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

  return baseDecision(snapshot, now, DECISIONS.SIGNAL, 'ema_pullback_continuation_long', {
    direction: DIRECTIONS.LONG,
    entryPrice: entry,
    stopLoss,
    takeProfit,
    riskReward: Number(takeProfitR.toFixed(2)),
    signalTimestamp: safeString(snapshot.latestCandle && snapshot.latestCandle.timestamp),
    evidence,
  });
}

function createNativeFuturesEmaPullbackContinuationStrategy(options = {}) {
  return {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    evaluate(snapshot, overrides = {}) {
      return evaluateNativeFuturesEmaPullbackContinuationStrategy(snapshot, { ...options, ...overrides });
    },
  };
}

const defaultNativeFuturesEmaPullbackContinuationStrategy = createNativeFuturesEmaPullbackContinuationStrategy();

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
  createNativeFuturesEmaPullbackContinuationStrategy,
  defaultNativeFuturesEmaPullbackContinuationStrategy,
  evaluateNativeFuturesEmaPullbackContinuationStrategy,
  _internal: {
    toEngineCandles,
    legacyCandidateFor,
    MIN_CANDLES,
  },
};
