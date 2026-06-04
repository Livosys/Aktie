'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Narrow State Engine Service (v2)
//
// Normalises candle data into a structured Narrow State analysis. This is the
// single "thinking around compression" layer for Trading OS v2.
//
// It reuses the proven scanner classifier (src/scanner/narrowState.js) as the
// source of truth for compression metrics and wraps it in a normalised,
// score-first envelope (0–100) with regime labels, breakout/fakeout/mean-
// reversion flags and robust warnings instead of crashes when data is missing.
//
// SAFETY: This service only analyses, scores and recommends. It never places
// orders, never enables a broker and never enables live trading.
// ────────────────────────────────────────────────────────────────────────────

const { calcIndicators } = require('../scanner/indicators');
const { classifyNarrowState } = require('../scanner/narrowState');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  live_enabled: false,
  paper_only: true,
});

const REGIME_LABELS = Object.freeze([
  'narrow',
  'narrow_breakout_watch',
  'narrow_fakeout_risk',
  'narrow_mean_reversion',
  'trending',
  'volatile',
  'unclear',
]);

// Score bands (0–100)
//   0–39  = not narrow
//   40–59 = weak narrow
//   60–79 = confirmed narrow
//   80–100 = strong compression
function narrowBand(score) {
  if (score >= 80) return 'strong_compression';
  if (score >= 60) return 'confirmed_narrow';
  if (score >= 40) return 'weak_narrow';
  return 'not_narrow';
}

function round(n, decimals = 2) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const f = Math.pow(10, decimals);
  return Math.round(Number(n) * f) / f;
}

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp100(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Normalise loosely-typed candle arrays into { o,h,l,c,v,t } numbers.
function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const o = Number(c.o ?? c.open);
      const h = Number(c.h ?? c.high);
      const l = Number(c.l ?? c.low);
      const cl = Number(c.c ?? c.close);
      const v = Number(c.v ?? c.volume ?? 0);
      if (![o, h, l, cl].every(Number.isFinite)) return null;
      return { o, h, l, c: cl, v: Number.isFinite(v) ? v : 0, t: c.t ?? c.ts ?? null };
    })
    .filter(Boolean);
}

// ── Sub-scores (higher = more narrow / more compressed) ──────────────────────

function compressionScore(metrics, atrPct120, bbwPct120) {
  if (!metrics) return 0;
  let s = 0;
  if (metrics.rangeCompression != null) {
    if (metrics.rangeCompression <= 0.70) s += 45;
    else if (metrics.rangeCompression <= 0.85) s += 35;
    else if (metrics.rangeCompression <= 1.00) s += 20;
  }
  if (metrics.nr7) s += 25;
  if (atrPct120 != null) {
    if (atrPct120 <= 45) s += 20;
    else if (atrPct120 <= 60) s += 10;
  }
  if (bbwPct120 != null) {
    if (bbwPct120 <= 25) s += 15;
    else if (bbwPct120 <= 35) s += 8;
  }
  return clamp100(s);
}

function rangeScore(metrics) {
  if (!metrics || metrics.smaGapAtr == null) return 0;
  let s = 0;
  if (metrics.smaGapAtr <= 0.40) s += 55;
  else if (metrics.smaGapAtr <= 0.70) s += 30;
  else if (metrics.smaGapAtr <= 1.00) s += 12;
  if (metrics.priceToZoneAtr <= 0.50) s += 45;
  else if (metrics.priceToZoneAtr <= 1.00) s += 20;
  return clamp100(s);
}

function volatilityScore(atrPercent, atrPct120) {
  // Higher score = lower volatility (more narrow-friendly).
  let s = 0;
  if (atrPct120 != null) {
    if (atrPct120 <= 45) s += 60;
    else if (atrPct120 <= 60) s += 40;
    else if (atrPct120 <= 80) s += 20;
  } else if (atrPercent != null) {
    // Fallback when historical percentile is unavailable.
    if (atrPercent <= 0.25) s += 50;
    else if (atrPercent <= 0.5) s += 30;
    else if (atrPercent <= 1.0) s += 15;
  }
  return clamp100(s);
}

// Count trailing candles that remain compressed vs the median bar range.
function calcNarrowDuration(candles) {
  if (!candles || candles.length < 12) return 0;
  const n = candles.length;
  const ranges = candles.map((c) => c.h - c.l);
  const baseline = median(ranges.slice(Math.max(0, n - 60), n));
  if (!baseline) return 0;
  let duration = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (ranges[i] <= baseline * 1.05) duration += 1;
    else break;
  }
  return duration;
}

// ── Regime classification ────────────────────────────────────────────────────

function deriveRegime({ narrowScore, classified }) {
  const state = classified?.state;
  const eventType = classified?.eventType;
  const tfs = classified?.threeFingerSpread?.active;

  if (classified?.breakoutAlreadyOccurred) {
    return { regimeLabel: 'narrow_fakeout_risk', breakoutWatch: false, fakeoutRisk: true, meanReversionCandidate: false };
  }
  if (eventType === 'WIDE_REVERSAL_WATCH') {
    return { regimeLabel: 'narrow_fakeout_risk', breakoutWatch: false, fakeoutRisk: true, meanReversionCandidate: true };
  }
  if (tfs || state === 'WIDE_AVOID' || state === 'THREE_FINGER_SPREAD_AVOID') {
    return { regimeLabel: 'volatile', breakoutWatch: false, fakeoutRisk: false, meanReversionCandidate: false };
  }
  if (state === 'REGULAR_TREND') {
    return { regimeLabel: 'trending', breakoutWatch: false, fakeoutRisk: false, meanReversionCandidate: false };
  }

  if (narrowScore >= 60) {
    const breakoutEvent = [
      'BULLISH_ELEPHANT_BREAKOUT',
      'BEARISH_ELEPHANT_BREAKDOWN',
      'BULLISH_COLOR_CHANGE',
      'BEARISH_COLOR_CHANGE',
    ].includes(eventType);
    if (breakoutEvent) {
      return { regimeLabel: 'narrow_breakout_watch', breakoutWatch: true, fakeoutRisk: false, meanReversionCandidate: false };
    }
    // Confirmed narrow but price is leaning into an edge with no confirmation →
    // a mean-reversion candidate back toward VWAP / range mid.
    const nearEdge = classified && Math.abs(classified.position || 0) >= 1;
    if (nearEdge) {
      return { regimeLabel: 'narrow_mean_reversion', breakoutWatch: true, fakeoutRisk: true, meanReversionCandidate: true };
    }
    return { regimeLabel: 'narrow', breakoutWatch: true, fakeoutRisk: false, meanReversionCandidate: true };
  }

  if (narrowScore >= 40) {
    return { regimeLabel: 'narrow', breakoutWatch: false, fakeoutRisk: false, meanReversionCandidate: false };
  }
  return { regimeLabel: 'unclear', breakoutWatch: false, fakeoutRisk: false, meanReversionCandidate: false };
}

// ── Main analysis from raw candles ───────────────────────────────────────────

/**
 * Analyse a candle series and return a normalised Narrow State envelope.
 * Robust to missing data: returns warnings instead of throwing.
 *
 * @param {object} input
 * @param {string} input.symbol
 * @param {string} [input.timeframe]
 * @param {Array}  input.candles  array of { o,h,l,c,v,t } (aliases accepted)
 * @param {object} [input.indicators] optional precomputed indicator bundle
 */
function analyzeNarrowState(input = {}) {
  const symbol = input.symbol ? String(input.symbol).toUpperCase() : null;
  const timeframe = input.timeframe || '2m';
  const candles = normalizeCandles(input.candles);
  const warnings = [];
  const reasons = [];

  if (candles.length < 20) {
    warnings.push('insufficient_candles');
    return emptyEnvelope(symbol, timeframe, candles.length, warnings, reasons);
  }

  const indicators = input.indicators || calcIndicators(candles);
  if (!indicators) {
    warnings.push('insufficient_candles');
    return emptyEnvelope(symbol, timeframe, candles.length, warnings, reasons);
  }

  if (indicators.atr14 == null || indicators.atr14 === 0) warnings.push('missing_atr');
  if (indicators.vwap == null) warnings.push('missing_vwap');
  const hasVolume = candles.some((c) => c.v > 0);
  if (!hasVolume || indicators.relVol20 == null) warnings.push('missing_volume');

  const price = candles[candles.length - 1].c;
  const lastUpdate = candles[candles.length - 1].t || new Date().toISOString();

  // Reuse proven classifier as the metric source of truth.
  let classified = null;
  try {
    classified = classifyNarrowState({ symbol, price, candles2m: candles, indicators, lastUpdate });
  } catch (err) {
    warnings.push('classifier_error');
    return emptyEnvelope(symbol, timeframe, candles.length, warnings, reasons);
  }

  const narrowScore = clamp100(classified.narrowScore || 0);
  const isNarrowState = narrowScore >= 60;

  // Range high/low/mid — prefer the 8-bar trigger zone, fall back to recent5.
  const rangeHigh = classified.zoneHigh ?? classified.recentHigh ?? null;
  const rangeLow = classified.zoneLow ?? classified.recentLow ?? null;
  const rangeMid = rangeHigh != null && rangeLow != null ? round((rangeHigh + rangeLow) / 2, 4) : null;

  const atr14 = indicators.atr14;
  const atrPercent = atr14 && price ? round((atr14 / price) * 100, 3) : null;
  const rangePercent = rangeHigh != null && rangeLow != null && price
    ? round(((rangeHigh - rangeLow) / price) * 100, 3)
    : null;
  const emaSpreadPercent = indicators.ema9 != null && indicators.ema21 != null && price
    ? round((Math.abs(indicators.ema9 - indicators.ema21) / price) * 100, 3)
    : null;
  const vwapDistancePercent = indicators.vwapDistancePct != null ? round(indicators.vwapDistancePct, 3) : null;
  const volumeCompression = indicators.relVol20 != null ? indicators.relVol20 < 1 : null;

  const metrics = {
    rangeCompression: classified.rangeCompression,
    nr7: classified.nr7,
    smaGapAtr: classified.smaGapAtr,
    priceToZoneAtr: classified.priceToZoneAtr,
  };

  const compScore = compressionScore(metrics, indicators.atrPct120, indicators.bbwPct120);
  const rngScore = rangeScore(metrics);
  const volScore = volatilityScore(atrPercent, indicators.atrPct120);
  const narrowDuration = calcNarrowDuration(candles);

  const { regimeLabel, breakoutWatch, fakeoutRisk, meanReversionCandidate } = deriveRegime({ narrowScore, classified });

  // Confidence: blend classifier confidence with score band stability.
  const confidence = clamp100((Number(classified.confidence) || 0) * 0.6 + narrowScore * 0.4);

  // Human-readable reasons (Swedish, reuse classifier text where present).
  if (Array.isArray(classified.reasonSv)) reasons.push(...classified.reasonSv);
  if (metrics.nr7) reasons.push('NR7 — smalaste candle av senaste 7.');
  if (narrowDuration >= 5) reasons.push(`Narrow i ${narrowDuration} candles i rad.`);

  return {
    symbol,
    timeframe,
    isNarrowState,
    narrowScore,
    narrowBand: narrowBand(narrowScore),
    compressionScore: compScore,
    rangeScore: rngScore,
    volatilityScore: volScore,
    atrPercent,
    rangePercent,
    emaSpreadPercent,
    vwapDistancePercent,
    volumeCompression,
    candlesAnalyzed: candles.length,
    narrowDuration,
    rangeHigh: rangeHigh != null ? round(rangeHigh, 4) : null,
    rangeLow: rangeLow != null ? round(rangeLow, 4) : null,
    rangeMid,
    breakoutWatch,
    fakeoutRisk,
    meanReversionCandidate,
    regimeLabel,
    confidence,
    reasons: reasons.slice(0, 6),
    warnings,
    // Useful passthrough for strategies / learning (non-breaking extras)
    price: round(price, 4),
    longTrigger: classified.longTrigger ?? null,
    shortTrigger: classified.shortTrigger ?? null,
    vwap: classified.vwap ?? null,
    rsi14: classified.rsi14 ?? null,
    relVol20: indicators.relVol20 != null ? round(indicators.relVol20, 2) : null,
    eventType: classified.eventType,
    state: classified.state,
    lastUpdate,
    ...SAFETY,
  };
}

function emptyEnvelope(symbol, timeframe, candlesAnalyzed, warnings, reasons) {
  return {
    symbol,
    timeframe,
    isNarrowState: false,
    narrowScore: 0,
    narrowBand: 'not_narrow',
    compressionScore: 0,
    rangeScore: 0,
    volatilityScore: 0,
    atrPercent: null,
    rangePercent: null,
    emaSpreadPercent: null,
    vwapDistancePercent: null,
    volumeCompression: null,
    candlesAnalyzed,
    narrowDuration: 0,
    rangeHigh: null,
    rangeLow: null,
    rangeMid: null,
    breakoutWatch: false,
    fakeoutRisk: false,
    meanReversionCandidate: false,
    regimeLabel: 'unclear',
    confidence: 0,
    reasons: reasons.length ? reasons : ['Otillräcklig data för Narrow State-analys.'],
    warnings,
    price: null,
    longTrigger: null,
    shortTrigger: null,
    vwap: null,
    rsi14: null,
    relVol20: null,
    eventType: 'NO_TRADE',
    state: 'NO_TRADE',
    lastUpdate: new Date().toISOString(),
    ...SAFETY,
  };
}

// ── Normalise an existing scanner result into the same envelope ──────────────
// The live scanner already produces classifyNarrowState() output; this maps it
// onto the normalised Narrow State envelope without recomputing indicators.
function normalizeFromScanResult(result = {}, timeframe = '2m') {
  if (!result || typeof result !== 'object') return null;
  const narrowScore = clamp100(result.narrowScore || 0);
  const { regimeLabel, breakoutWatch, fakeoutRisk, meanReversionCandidate } = deriveRegime({ narrowScore, classified: result });
  const price = result.price ?? null;
  const rangeHigh = result.zoneHigh ?? result.recentHigh ?? null;
  const rangeLow = result.zoneLow ?? result.recentLow ?? null;
  const rangeMid = rangeHigh != null && rangeLow != null ? round((rangeHigh + rangeLow) / 2, 4) : null;
  const atrPercent = result.atr14 && price ? round((result.atr14 / price) * 100, 3) : null;

  return {
    symbol: result.symbol || null,
    timeframe,
    isNarrowState: narrowScore >= 60,
    narrowScore,
    narrowBand: narrowBand(narrowScore),
    compressionScore: compressionScore(
      { rangeCompression: result.rangeCompression, nr7: result.nr7 },
      result.atrPct120,
      result.bbwPct120,
    ),
    rangeScore: rangeScore({ smaGapAtr: result.smaGapAtr, priceToZoneAtr: result.priceToZoneAtr }),
    volatilityScore: volatilityScore(atrPercent, result.atrPct120),
    atrPercent,
    rangePercent: rangeHigh != null && rangeLow != null && price ? round(((rangeHigh - rangeLow) / price) * 100, 3) : null,
    emaSpreadPercent: null,
    vwapDistancePercent: result.vwapDistancePct != null ? round(result.vwapDistancePct, 3) : null,
    volumeCompression: result.relVol20 != null ? result.relVol20 < 1 : null,
    candlesAnalyzed: result.candleCount || 0,
    narrowDuration: null,
    rangeHigh: rangeHigh != null ? round(rangeHigh, 4) : null,
    rangeLow: rangeLow != null ? round(rangeLow, 4) : null,
    rangeMid,
    breakoutWatch,
    fakeoutRisk,
    meanReversionCandidate,
    regimeLabel,
    confidence: clamp100((Number(result.confidence) || 0) * 0.6 + narrowScore * 0.4),
    reasons: Array.isArray(result.reasonSv) ? result.reasonSv.slice(0, 6) : [],
    warnings: [],
    price,
    longTrigger: result.longTrigger ?? null,
    shortTrigger: result.shortTrigger ?? null,
    vwap: result.vwap ?? null,
    rsi14: result.rsi14 ?? null,
    relVol20: result.relVol20 ?? null,
    eventType: result.eventType,
    state: result.state,
    lastUpdate: result.lastUpdate || null,
    ...SAFETY,
  };
}

// ── Aggregate a set of (scanner) results into a Narrow State overview ─────────
function summarizeNarrowState(scanResults = [], options = {}) {
  const timeframe = options.timeframe || '2m';
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 60;
  const normalized = (Array.isArray(scanResults) ? scanResults : [])
    .map((r) => normalizeFromScanResult(r, timeframe))
    .filter(Boolean);

  const narrow = normalized.filter((r) => r.narrowScore >= minScore);
  const byScoreDesc = [...narrow].sort((a, b) => b.narrowScore - a.narrowScore);

  const topSymbols = byScoreDesc.slice(0, 8).map((r) => ({
    symbol: r.symbol,
    narrowScore: r.narrowScore,
    regimeLabel: r.regimeLabel,
    band: r.narrowBand,
    breakoutWatch: r.breakoutWatch,
    fakeoutRisk: r.fakeoutRisk,
    meanReversionCandidate: r.meanReversionCandidate,
  }));

  const breakoutWatch = byScoreDesc.filter((r) => r.breakoutWatch).slice(0, 8)
    .map((r) => ({ symbol: r.symbol, narrowScore: r.narrowScore, longTrigger: r.longTrigger, shortTrigger: r.shortTrigger }));
  const fakeoutRisk = byScoreDesc.filter((r) => r.fakeoutRisk).slice(0, 8)
    .map((r) => ({ symbol: r.symbol, narrowScore: r.narrowScore, regimeLabel: r.regimeLabel }));
  const meanReversion = byScoreDesc.filter((r) => r.meanReversionCandidate).slice(0, 8)
    .map((r) => ({ symbol: r.symbol, narrowScore: r.narrowScore, vwap: r.vwap, rangeMid: r.rangeMid }));

  const strongest = byScoreDesc[0] || null;

  return {
    timeframe,
    minScore,
    scannedCount: normalized.length,
    activeCount: narrow.length,
    strongCompressionCount: narrow.filter((r) => r.narrowScore >= 80).length,
    topSymbols,
    strongestCompression: strongest
      ? { symbol: strongest.symbol, narrowScore: strongest.narrowScore, band: strongest.narrowBand, regimeLabel: strongest.regimeLabel }
      : null,
    breakoutWatch,
    fakeoutRisk,
    meanReversion,
  };
}

// ── Build Learning Engine metadata for a narrow-state trade/test result ───────
// Pure helper so paper / replay / batch flows can attach a consistent
// narrow-state learning envelope to every outcome.
function buildNarrowLearningMetadata(input = {}) {
  const analysis = input.analysis || {};
  const confirmation = input.confirmationUsed || {};
  return {
    strategy_id: input.strategy_id || input.strategyId || null,
    strategy_family: 'narrow_state',
    narrowScore: input.narrowScore ?? analysis.narrowScore ?? null,
    regimeLabel: input.regimeLabel ?? analysis.regimeLabel ?? null,
    compressionScore: input.compressionScore ?? analysis.compressionScore ?? null,
    breakoutType: input.breakoutType || null, // 'breakout' | 'fakeout' | 'mean_reversion' | null
    fakeoutDetected: input.fakeoutDetected ?? analysis.fakeoutRisk ?? false,
    confirmationUsed: {
      ema: confirmation.ema ?? null,
      rsi: confirmation.rsi ?? null,
      vwap: confirmation.vwap ?? null,
      volume: confirmation.volume ?? null,
      macd: confirmation.macd ?? null,
    },
    result: input.result || null, // 'win' | 'loss' | 'breakeven' | 'skipped'
    pnl_paper: input.pnl_paper ?? input.pnlPaper ?? null,
    maxAdverseExcursion: input.maxAdverseExcursion ?? null,
    maxFavorableExcursion: input.maxFavorableExcursion ?? null,
    exitReason: input.exitReason || null,
    lessonTags: Array.isArray(input.lessonTags) ? input.lessonTags : [],
    timeframe: input.timeframe ?? analysis.timeframe ?? null,
    symbol: input.symbol ?? analysis.symbol ?? null,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  REGIME_LABELS,
  narrowBand,
  analyzeNarrowState,
  normalizeFromScanResult,
  summarizeNarrowState,
  buildNarrowLearningMetadata,
};
