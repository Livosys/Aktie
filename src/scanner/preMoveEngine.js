'use strict';

function round(n, d = 1) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Pre-Move Detection Engine
 *
 * Detects volatility contraction → pre-breakout pressure buildup.
 * Uses only existing scan result fields — no extra data fetches.
 *
 * Output: preMoveContext {
 *   preMoveProbability  0-100
 *   expansionBias       'bullish'|'bearish'|'neutral'
 *   compressionStrength 0-100
 *   breakoutPressure    0-100
 *   preMoveWatchMode    bool
 *   compressionReasons  string[]
 *   explanationSv       string
 * }
 *
 * Safety: does NOT modify tradeScore.
 * Hard-blocked signals still receive context but preMoveWatchMode = false.
 */
function applyPreMove(result) {
  try {
    return _apply(result);
  } catch (err) {
    console.warn('[PreMove] error:', err.message);
    return { ...result, preMoveContext: null };
  }
}

function _apply(result) {
  const {
    bbwPct120, atrPct120, rangeCompression, nr7,
    slope20Atr, priceToZoneAtr, smaGapAtr,
    rsi14, price, sma20,
    narrowType, narrowScore,
    threeFingerSpread, breakoutAlreadyOccurred, autoFilter,
  } = result;

  const isHardBlocked =
    autoFilter?.blocked       === true ||
    threeFingerSpread?.active  === true ||
    breakoutAlreadyOccurred    === true;

  // ── Compression strength (0-100) ──────────────────────────────────────────
  let compressionScore = 0;
  const compressionReasons = [];

  if (bbwPct120 != null) {
    if      (bbwPct120 <= 15) { compressionScore += 35; compressionReasons.push(`BBW extremt lågt (${round(bbwPct120, 0)}:e percentilen)`); }
    else if (bbwPct120 <= 30) { compressionScore += 25; compressionReasons.push(`BBW lågt (${round(bbwPct120, 0)}:e percentilen)`); }
    else if (bbwPct120 <= 50) { compressionScore += 12; }
  }

  if (atrPct120 != null) {
    if      (atrPct120 <= 10) { compressionScore += 35; compressionReasons.push(`ATR extremt lågt (${round(atrPct120, 0)}:e percentilen)`); }
    else if (atrPct120 <= 25) { compressionScore += 25; compressionReasons.push(`ATR lågt (${round(atrPct120, 0)}:e percentilen)`); }
    else if (atrPct120 <= 45) { compressionScore += 12; }
  }

  if (nr7 === true) {
    compressionScore += 20;
    compressionReasons.push('NR7 — smalaste candle på 7 perioder');
  } else if (rangeCompression != null) {
    if      (rangeCompression <= 0.60) { compressionScore += 18; compressionReasons.push(`Candle-kompression ${round(rangeCompression, 2)}x`); }
    else if (rangeCompression <= 0.80) { compressionScore += 10; }
  }

  if (smaGapAtr != null) {
    if      (smaGapAtr <= 0.15) { compressionScore += 15; compressionReasons.push(`SMA-gap extremt litet (${round(smaGapAtr, 2)} ATR)`); }
    else if (smaGapAtr <= 0.30) { compressionScore += 8; }
  }

  const compressionStrength = clamp(compressionScore, 0, 100);

  // ── Expansion bias ────────────────────────────────────────────────────────
  let expansionBias = 'neutral';
  if (price != null && sma20 != null) {
    const aboveSma20 = price > sma20;
    const belowSma20 = price < sma20;
    const rsiUp      = rsi14 != null && rsi14 >= 52;
    const rsiDown    = rsi14 != null && rsi14 <= 48;
    const slopeUp    = slope20Atr != null && slope20Atr > 0.15 && aboveSma20;
    const slopeDown  = slope20Atr != null && slope20Atr > 0.15 && belowSma20;

    if ((aboveSma20 && rsiUp) || slopeUp) expansionBias = 'bullish';
    else if ((belowSma20 && rsiDown) || slopeDown) expansionBias = 'bearish';
  }

  // ── Breakout pressure (0-100) — how coiled the spring is ─────────────────
  let pressureScore = 0;

  if      (compressionStrength >= 65) pressureScore += 40;
  else if (compressionStrength >= 45) pressureScore += 25;
  else if (compressionStrength >= 25) pressureScore += 12;

  if      (narrowType === 'coil_flat')   pressureScore += 25;
  else if (narrowType === 'attack_200')  pressureScore += 18;

  if      ((narrowScore ?? 0) >= 80) pressureScore += 20;
  else if ((narrowScore ?? 0) >= 60) pressureScore += 12;
  else if ((narrowScore ?? 0) >= 40) pressureScore += 5;

  if (priceToZoneAtr != null) {
    if      (priceToZoneAtr <= 0.20) pressureScore += 15;
    else if (priceToZoneAtr <= 0.50) pressureScore += 8;
  }

  const breakoutPressure = clamp(pressureScore, 0, 100);

  // ── Pre-move probability ──────────────────────────────────────────────────
  const preMoveProbability = clamp(
    Math.round(compressionStrength * 0.55 + breakoutPressure * 0.45),
    0, 100
  );

  const preMoveWatchMode = !isHardBlocked && preMoveProbability >= 60 && compressionStrength >= 40;

  // ── Swedish explanation ───────────────────────────────────────────────────
  let explanationSv;
  if (preMoveProbability >= 75) {
    const top = compressionReasons.slice(0, 2).join('. ');
    explanationSv = `Extremt komprimerat läge (${preMoveProbability}%). ${top}. Fjädern är spänd — bevaka noga.`;
  } else if (preMoveProbability >= 55) {
    const top = compressionReasons[0] || 'Volatiliteten är ovanligt låg';
    explanationSv = `Tydlig kompression synlig (${preMoveProbability}%). ${top}. Potential för expansion.`;
  } else if (preMoveProbability >= 35) {
    explanationSv = `Svag kompression (${preMoveProbability}%). Inga tydliga pre-move signaler ännu.`;
  } else {
    explanationSv = 'Ingen märkbar kompression. Normal volatilitetsmiljö.';
  }

  return {
    ...result,
    preMoveContext: {
      preMoveProbability,
      expansionBias,
      compressionStrength,
      breakoutPressure,
      preMoveWatchMode,
      compressionReasons,
      explanationSv,
    },
  };
}

module.exports = { applyPreMove };
