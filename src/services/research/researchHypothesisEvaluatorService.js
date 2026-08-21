'use strict';

// ── Research-only evaluator ──────────────────────────────────────────────────
//
// EN evaluator, driven av en hypotesprofil. Inte tolv handskrivna moduler, och
// inte en andra replaymotor.
//
// Den kör i exakt samma ram som de åtta native futures-strategierna: samma
// snapshot, samma contractBlockers/marketBlockers, samma toEngineCandles, samma
// calcIndicators, samma beslutsform. Det är därför Native Replay kan köra den
// utan att en enda rad i motorn ändras — och det är också varför resultatet är
// jämförbart med de riktiga strategiernas.
//
// ── Vad den INTE gör ─────────────────────────────────────────────────────────
//
// Den registreras aldrig hos Paper-providern. listStrategyEvaluators tar
// includeResearch som en egen flagga, och paper-vägen anropar utan flaggor.
// Varje beslut bär dessutom researchOnly: true, paperEligible: false och
// runtimeEligible: false hela vägen ut, så att en läckt signal går att känna
// igen på innehållet och inte bara på id:t.
//
// ── Exit ─────────────────────────────────────────────────────────────────────
//
// Exiten kommer ur hypotesens fixedResearchExit och är KONSTANT över batchen.
// Den prövas inte. Se researchHypothesisService: Broker Risk kräver stop loss,
// så en null-exit är inte körbar, och en varierad exit hade gjort skillnader
// mellan hypoteser omöjliga att tillskriva signalen.

const { calcIndicators } = require('../../scanner/indicators');
const momentumStrategy = require('../nativeFuturesMomentumStrategyService');
const emaStrategy = require('../nativeFuturesEmaPullbackContinuationStrategyService');
const hypothesisService = require('./researchHypothesisService');

const SOURCE = 'research_hypothesis_evaluator';

const DECISIONS = momentumStrategy.DECISIONS;
const DIRECTIONS = momentumStrategy.DIRECTIONS;

const { contractBlockers, marketBlockers, roundToTick } = momentumStrategy._internal;
const { toEngineCandles } = emaStrategy._internal;

const DEFAULT_TICK_SIZE = 0.25;
// bbwPct120 behöver 140 stängningar och atrPct120 136 barer (se indicators.js).
// Under det returnerar primitiven null, och en hypotes som byggde på null hade
// tyst aldrig triggat. Kravet står här så att bristen syns som en orsak.
const MIN_CANDLES = 145;

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function upper(value) {
  const out = text(value);
  return out ? out.toUpperCase() : null;
}

function lower(value) {
  const out = text(value);
  return out ? out.toLowerCase() : null;
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function minutesOfDayUtc(timestamp) {
  const ms = new Date(timestamp).getTime();
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function clockToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h * 60) + (m || 0);
}

function inSession(timestamp, session) {
  const minute = minutesOfDayUtc(timestamp);
  if (minute == null || !session) return false;
  return minute >= clockToMinutes(session.fromUtc) && minute < clockToMinutes(session.toUtc);
}

function baseDecision(hypothesis, snapshot, now, decision, reason, extra = {}) {
  return {
    ok: decision !== DECISIONS.BLOCKED,
    decision,
    strategyId: hypothesis.researchStrategyId,
    strategyVersion: `${hypothesis.hypothesisId}:${hypothesis.hypothesisVersion}:${hypothesis.hypothesisHash}`,
    symbol: upper(snapshot && snapshot.symbol),
    timeframe: lower(snapshot && snapshot.timeframe),
    reason,
    blockers: [],
    evaluatedAt: new Date(now).toISOString(),
    marketSnapshotTimestamp: text(snapshot && snapshot.timestamp),
    source: SOURCE,
    direction: null,
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    // Bärs på VARJE beslut, inte bara på signaler. En blockerad research-rad i
    // en logg ska också gå att identifiera som research.
    researchOnly: true,
    paperEligible: false,
    runtimeEligible: false,
    hypothesisId: hypothesis.hypothesisId,
    hypothesisHash: hypothesis.hypothesisHash,
    conceptStrategyId: hypothesis.strategyId,
    ...extra,
  };
}

/** Kompressionsmåttet, som hypotesen valt det. */
function compressionValue(indicators, estimator) {
  if (estimator === 'atr_pct_120') return num(indicators.atrPct120);
  if (estimator === 'bbw_pct_120') return num(indicators.bbwPct120);
  return null;
}

/**
 * Rullande intervall över fönstret FÖRE den utlösande baren.
 *
 * `useCloses` byter referens från high/low till stängningar. Skillnaden är inte
 * kosmetisk: ett intervall byggt på extrempunkter är per definition bredare än
 * ett byggt på stängningar, och cykel 1 mätte att det är just den bredden som
 * stryper signalflödet — 8,1 % av de komprimerade barerna bryter sitt
 * high/low-intervall mot 19,2 % för stängningsintervallet.
 */
function rollingRange(candles, window, { useCloses = false } = {}) {
  if (candles.length < window + 1) return null;
  const slice = candles.slice(-(window + 1), -1);
  let high = -Infinity;
  let low = Infinity;
  for (const bar of slice) {
    const top = useCloses ? bar.c : bar.h;
    const bottom = useCloses ? bar.c : bar.l;
    if (top > high) high = top;
    if (bottom < low) low = bottom;
  }
  return Number.isFinite(high) && Number.isFinite(low) ? { high, low } : null;
}

/**
 * Har baren brutit intervallet, enligt hypotesens kvalificering?
 *
 * @returns {{broke: boolean, direction: string|null, range: object}}
 */
function qualifyBreakout(signal, candles, atr14) {
  const useCloses = signal.breakoutRule === 'close_beyond_rolling_close_range';
  const range = rollingRange(candles, signal.compressionWindow, { useCloses });
  if (!range) return null;
  const last = candles[candles.length - 1];

  // Tolerans i stället för strikt olikhet. En exakt gräns på tickdata är
  // godtycklig: en stängning en tick under intervalltoppen är inte ett annat
  // marknadsläge än en stängning en tick över.
  const tolerance = signal.breakoutRule === 'close_within_atr_tolerance_of_range'
    ? (Number(signal.breakoutToleranceAtr) || 0) * (Number(atr14) || 0)
    : 0;

  if (last.c > range.high - tolerance) return { broke: true, direction: DIRECTIONS.LONG, range };
  if (last.c < range.low + tolerance) return { broke: true, direction: DIRECTIONS.SHORT, range };
  return { broke: false, direction: null, range };
}

function evaluateCompressionRangeBreak(hypothesis, candles, indicators) {
  const signal = hypothesis.signal;
  const compression = compressionValue(indicators, signal.volatilityEstimator);
  if (compression == null) {
    return { ok: false, reason: 'volatility_estimator_unavailable', evidence: { estimator: signal.volatilityEstimator } };
  }
  if (compression > signal.compressionThreshold) {
    return { ok: false, reason: 'not_in_low_volatility_regime', evidence: { compression, threshold: signal.compressionThreshold } };
  }
  const atr14 = num(indicators.atr14);
  const breakout = qualifyBreakout(signal, candles, atr14);
  if (!breakout) {
    return { ok: false, reason: 'insufficient_range_window', evidence: { window: signal.compressionWindow } };
  }
  const relVol = num(indicators.relVol20);
  const evidence = {
    compression,
    compressionThreshold: signal.compressionThreshold,
    breakoutRule: signal.breakoutRule,
    rangeHigh: breakout.range.high,
    rangeLow: breakout.range.low,
    relVol20: relVol,
    atr14,
  };
  // Brottet prövas FÖRE volymen. Båda krävs, så ordningen ändrar inget utfall —
  // men den ändrar vilken orsak som rapporteras, och en bar som aldrig bröt sitt
  // intervall ska inte bokföras som "volymen saknades". Cykel 1:s trattanalys
  // läste den siffran.
  if (!breakout.broke) return { ok: false, reason: 'no_range_break', evidence };

  // volumeRule 'none' är inte samma sak som en tröskel på 1,0. Den ena ställer
  // ingen fråga; den andra ställer en fråga som nästan alltid besvaras ja.
  if (signal.volumeRule !== 'none' && (relVol == null || relVol < signal.volumeThreshold)) {
    return { ok: false, reason: 'volume_expansion_missing', evidence };
  }
  return {
    ok: true,
    direction: breakout.direction,
    reason: breakout.direction === DIRECTIONS.LONG
      ? 'low_volatility_range_break_up'
      : 'low_volatility_range_break_down',
    evidence,
  };
}

/**
 * Spikbaren, k barer bakåt, med indikatorerna SOM DE SÅG UT DÅ.
 *
 * calcIndicators räknar alltid på fönstrets sista bar, så relVol20 och atr14
 * för en tidigare bar kräver ett kortare fönster. Att i stället återanvända
 * dagens värden hade varit lookahead: spikens relativa volym hade mätts mot en
 * period som innehåller spiken själv.
 */
function spikeAt(signal, candles, k) {
  const window = candles.slice(0, candles.length - k);
  if (window.length < MIN_CANDLES) return null;
  const indicators = calcIndicators(window);
  if (!indicators) return null;
  const atr = num(indicators.atr14);
  const relVol = num(indicators.relVol20);
  if (atr == null || atr <= 0 || relVol == null || relVol < signal.relativeVolumeThreshold) return null;
  const bar = window[window.length - 1];
  const expansion = Math.abs(bar.c - bar.o) / atr;
  if (expansion < signal.priceExpansionThreshold) return null;
  return { bar, atr, relVol, expansion, direction: bar.c > bar.o ? DIRECTIONS.LONG : DIRECTIONS.SHORT };
}

/**
 * Entry timing: gå in när priset återvänt en andel av spikkroppen.
 *
 * ── Varför bakåt och inte framåt ─────────────────────────────────────────────
 *
 * Cykel 1 mätte att exekveringskostnaden, inte courtaget, är den rörliga
 * kostnaden — och att strategin per konstruktion väljer ut just de barer där en
 * marknadsorder är dyrast. Två utvägar fanns: vänta, eller vänta på ett bättre
 * pris.
 *
 * Att bara VÄNTA är mätt sämre: nästa bars stängning ligger i genomsnitt +0,79
 * punkter i signalens riktning, alltså 0,79 punkter dyrare. Bar +2 ligger på
 * −0,14 och rörelsen är slut. Fördröjning prövas därför inte.
 *
 * Retracering är mätt möjlig: 74,8 % av spikarna återvänder minst 25 % av
 * kroppen inom tre barer, 64,3 % minst 50 %.
 *
 * Regeln är en SIGNALREGEL, inte en ordertyp: hypotesen signalerar först på den
 * bar där nivån nåtts, och entry sker på den barens stängning som vanligt.
 * Ingen limitorder, ingen ändring i motorn, ingen ändring i Broker Risk.
 */
function evaluatePullbackEntry(hypothesis, candles) {
  const signal = hypothesis.signal;
  const last = candles[candles.length - 1];
  for (let k = 1; k <= signal.pullbackWindowBars; k += 1) {
    const spike = spikeAt(signal, candles, k);
    if (!spike) continue;
    const body = Math.abs(spike.bar.c - spike.bar.o);
    if (body <= 0) continue;
    const long = spike.direction === DIRECTIONS.LONG;
    const level = long ? spike.bar.c - (signal.pullbackFraction * body)
      : spike.bar.c + (signal.pullbackFraction * body);

    // Nivån måste nås av DEN HÄR baren och inte av någon dessförinnan. Utan
    // det villkoret skulle samma spik ge en signal på varje efterföljande bar.
    const reachedNow = long ? last.l <= level : last.h >= level;
    if (!reachedNow) continue;
    const between = candles.slice(candles.length - k, candles.length - 1);
    const reachedEarlier = between.some((bar) => (long ? bar.l <= level : bar.h >= level));
    if (reachedEarlier) continue;

    return {
      ok: true,
      direction: spike.direction,
      reason: 'volume_spike_pullback_entry',
      evidence: {
        entryModel: signal.entryModel,
        pullbackFraction: signal.pullbackFraction,
        barsSinceSpike: k,
        spikeClose: spike.bar.c,
        pullbackLevel: level,
        relVol20: spike.relVol,
        expansion: spike.expansion,
        atr14: spike.atr,
      },
    };
  }
  return { ok: false, reason: 'no_qualifying_pullback', evidence: { entryModel: signal.entryModel } };
}

function evaluateRelativeVolumeExpansion(hypothesis, candles, indicators) {
  const signal = hypothesis.signal;
  if (signal.entryModel === 'pullback_fraction_of_spike_body') {
    return evaluatePullbackEntry(hypothesis, candles);
  }
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const relVol = num(indicators.relVol20);
  if (relVol == null || relVol < signal.relativeVolumeThreshold) {
    return { ok: false, reason: 'relative_volume_spike_missing', evidence: { relVol20: relVol, threshold: signal.relativeVolumeThreshold } };
  }
  const atr = num(indicators.atr14);
  if (atr == null || atr <= 0) {
    return { ok: false, reason: 'atr_unavailable', evidence: { atr14: atr } };
  }
  const expansion = Math.abs(last.c - last.o) / atr;
  if (expansion < signal.priceExpansionThreshold) {
    return { ok: false, reason: 'price_expansion_too_small', evidence: { expansion, threshold: signal.priceExpansionThreshold, atr14: atr } };
  }
  const direction = last.c > last.o ? DIRECTIONS.LONG : DIRECTIONS.SHORT;
  const evidence = { relVol20: relVol, expansion, atr14: atr, barDirection: direction };
  if (signal.followThroughRule === 'close_beyond_previous_close') {
    const confirms = direction === DIRECTIONS.LONG ? last.c > previous.c : last.c < previous.c;
    if (!confirms) {
      return { ok: false, reason: 'follow_through_missing', evidence: { ...evidence, previousClose: previous.c } };
    }
  }
  return { ok: true, direction, reason: 'volume_spike_momentum_expansion', evidence };
}

/**
 * Utvärderar EN hypotes mot ett snapshot.
 *
 * Samma kontrakt som en native strategis evaluate(snapshot, options).
 */
function evaluateResearchHypothesis(hypothesis, snapshot, options = {}) {
  const now = options.now || new Date();
  const tickSize = num(options.tickSize) || DEFAULT_TICK_SIZE;

  if (!snapshot || typeof snapshot !== 'object') {
    return baseDecision(hypothesis, null, now, DECISIONS.BLOCKED, 'missing_market_snapshot', {
      blockers: ['missing_market_snapshot'],
    });
  }

  const blockers = [...contractBlockers(snapshot), ...marketBlockers(snapshot)];
  if (blockers.length) {
    return baseDecision(hypothesis, snapshot, now, DECISIONS.BLOCKED, blockers[0], {
      blockers: [...new Set(blockers)],
    });
  }

  const candles = toEngineCandles(snapshot.candles);
  if (candles.length < MIN_CANDLES) {
    return baseDecision(hypothesis, snapshot, now, DECISIONS.NO_SIGNAL, 'insufficient_candle_history', {
      evidence: { candlesAvailable: candles.length, candlesRequired: MIN_CANDLES },
    });
  }

  // ── Timeframe är hypotesens, inte körningens ──────────────────────────────
  //
  // Motorn stegar i EN timeframe och alla evaluators får samma snapshot. En
  // hypotes som deklarerar 5m men utvärderas på ett 2m-snapshot testar därför
  // inte det den påstår sig testa — den blir en exakt dubblett av 2m-hypotesen
  // med samma övriga regler, och rapporten hade tillskrivit likheten
  // "timeframe spelar ingen roll" när den i själva verket berodde på att
  // variabeln aldrig varierades.
  //
  // Det inträffade i första research-passet 2026-08-20 (H006 gav bit för bit
  // identiskt utfall med H001 i båda koncepten). Grinden gör felet omöjligt:
  // en hypotes utvärderar bara i sin egen timeframe, och en batch som vill
  // pröva flera kör ett pass per timeframe.
  const snapshotTimeframe = lower(snapshot.timeframe);
  if (snapshotTimeframe && snapshotTimeframe !== hypothesis.semantics.timeframe) {
    return baseDecision(hypothesis, snapshot, now, DECISIONS.NO_SIGNAL, 'hypothesis_timeframe_mismatch', {
      evidence: { snapshotTimeframe, hypothesisTimeframe: hypothesis.semantics.timeframe },
    });
  }

  const last = candles[candles.length - 1];
  if (!inSession(last.t, hypothesis.session)) {
    return baseDecision(hypothesis, snapshot, now, DECISIONS.NO_SIGNAL, 'outside_research_session', {
      evidence: { barTimestamp: last.t, session: hypothesis.session },
    });
  }

  const indicators = calcIndicators(candles);
  if (!indicators) {
    return baseDecision(hypothesis, snapshot, now, DECISIONS.NO_SIGNAL, 'indicators_unavailable', {
      evidence: { candlesAvailable: candles.length },
    });
  }

  const outcome = hypothesis.signal.kind === 'compression_range_break'
    ? evaluateCompressionRangeBreak(hypothesis, candles, indicators)
    : evaluateRelativeVolumeExpansion(hypothesis, candles, indicators);

  if (!outcome.ok) {
    return baseDecision(hypothesis, snapshot, now, DECISIONS.NO_SIGNAL, outcome.reason, { evidence: outcome.evidence });
  }

  // Entry är signalbarens stängning. Ingen entry-optimering i den här
  // experimentfamiljen — se DEL B4.
  const entry = roundToTick(last.c, tickSize);
  const stopLossPct = hypothesis.exit.stopLossPct.value;
  const takeProfitR = hypothesis.exit.takeProfitR.value;
  const long = outcome.direction === DIRECTIONS.LONG;

  const stopLoss = roundToTick(
    long ? entry * (1 - (stopLossPct / 100)) : entry * (1 + (stopLossPct / 100)),
    tickSize,
  );
  if (stopLoss == null || (long ? stopLoss >= entry : stopLoss <= entry)) {
    return baseDecision(hypothesis, snapshot, now, DECISIONS.NO_SIGNAL, 'invalid_stop_distance', { evidence: outcome.evidence });
  }
  const risk = Math.abs(entry - stopLoss);
  const takeProfit = roundToTick(long ? entry + (risk * takeProfitR) : entry - (risk * takeProfitR), tickSize);
  if (takeProfit == null || (long ? takeProfit <= entry : takeProfit >= entry)) {
    return baseDecision(hypothesis, snapshot, now, DECISIONS.NO_SIGNAL, 'invalid_target_distance', { evidence: outcome.evidence });
  }

  return baseDecision(hypothesis, snapshot, now, DECISIONS.SIGNAL, outcome.reason, {
    direction: outcome.direction,
    entryPrice: entry,
    stopLoss,
    takeProfit,
    riskReward: Number(takeProfitR.toFixed(2)),
    signalTimestamp: text(snapshot.latestCandle && snapshot.latestCandle.timestamp),
    evidence: { ...outcome.evidence, candlesEvaluated: candles.length },
  });
}

/**
 * Hypoteserna som utvärderingsbara enheter, i registrets form.
 *
 * @returns {ReadonlyArray<{strategyId: string, evaluate: Function}>}
 */
function listResearchEvaluators({ strategyId = null, cycle = null } = {}) {
  return Object.freeze(hypothesisService.listHypotheses(strategyId, { cycle }).map((hypothesis) => Object.freeze({
    strategyId: hypothesis.researchStrategyId,
    evaluate: (snapshot, context = {}) => evaluateResearchHypothesis(hypothesis, snapshot, context),
  })));
}

/**
 * Hypotesens NUMERISKA parametrar.
 *
 * Strategy DNA härleder parameterHash ur defaultOptions. Lämnades de tomma
 * skulle alla tolv hypoteserna få identisk parameterHash, och AI Memory hade
 * då sett dem som ETT experiment — dubblettskyddet hade blockerat elva av tolv
 * innan någon av dem kördes.
 *
 * De KATEGORISKA värdena måste med, inte bara talen. Fem av tolv hypoteser
 * skiljer sig enbart i estimator, timeframe, session eller follow-through-regel;
 * med bara tal fick de identisk dnaHash och hade räknats som samma genom av
 * släktträdet och av hjärnan. Strängarna filtreras ändå bort av optionsFromDna
 * (endast ändliga tal släpps in i evaluate), så de beskriver utan att köra.
 */
function hypothesisParametersOf(hypothesis) {
  const signal = hypothesis.signal;
  const out = {
    stopLossPct: hypothesis.exit.stopLossPct.value,
    takeProfitR: hypothesis.exit.takeProfitR.value,
    holdingTimeMin: hypothesis.exit.holdingTimeMin.value,
    timeframe: hypothesis.semantics.timeframe,
    session: hypothesis.semantics.session,
  };
  if (signal.kind === 'compression_range_break') {
    out.volatilityEstimator = signal.volatilityEstimator;
    out.compressionThreshold = signal.compressionThreshold;
    out.compressionWindow = signal.compressionWindow;
    out.volumeThreshold = signal.volumeThreshold;
    // Cykel 2:s nya dimensioner. De skrivs bara ut när de avviker från cykel
    // 1:s förval — ett fält som alltid finns med hade flyttat varje befintlig
    // dnaHash, och därmed gjort cykel 1:s bokförda experiment oigenkännliga.
    if (signal.breakoutRule && signal.breakoutRule !== 'close_beyond_rolling_range_of_window') {
      out.breakoutRule = signal.breakoutRule;
    }
    if (signal.breakoutToleranceAtr != null) out.breakoutToleranceAtr = signal.breakoutToleranceAtr;
  } else {
    out.relativeVolumeThreshold = signal.relativeVolumeThreshold;
    out.priceExpansionThreshold = signal.priceExpansionThreshold;
    out.followThroughRule = signal.followThroughRule;
    if (signal.entryModel && signal.entryModel !== 'signal_bar_close') {
      out.entryModel = signal.entryModel;
      out.pullbackFraction = signal.pullbackFraction;
      out.pullbackWindowBars = signal.pullbackWindowBars;
    }
  }
  return Object.freeze(out);
}

/** Hypoteserna som registrets deskriptorer, så biblioteket och DNA kan läsa dem. */
function listResearchDescriptors({ strategyId = null, cycle = null } = {}) {
  return Object.freeze(hypothesisService.listHypotheses(strategyId, { cycle }).map((hypothesis) => Object.freeze({
    strategyId: hypothesis.researchStrategyId,
    strategyVersion: `${hypothesis.hypothesisId}:${hypothesis.hypothesisVersion}:${hypothesis.hypothesisHash}`,
    originStrategyId: hypothesis.strategyId,
    migrated: false,
    researchOnly: true,
    runtimeEligible: false,
    paperEligible: false,
    hypothesisId: hypothesis.hypothesisId,
    hypothesisHash: hypothesis.hypothesisHash,
    targetSignalFamily: null,
    targetSignalSubtype: null,
    defaultOptions: hypothesisParametersOf(hypothesis),
  })));
}

/** Deskriptorn för ett enskilt research-id, eller null. */
function getResearchDescriptor(strategyId) {
  return listResearchDescriptors().find((row) => row.strategyId === strategyId) || null;
}

module.exports = {
  SOURCE,
  MIN_CANDLES,
  DECISIONS,
  DIRECTIONS,
  evaluateResearchHypothesis,
  listResearchEvaluators,
  listResearchDescriptors,
  getResearchDescriptor,
  hypothesisParametersOf,
  _internal: { inSession, rollingRange, compressionValue, evaluateCompressionRangeBreak, evaluateRelativeVolumeExpansion },
};
