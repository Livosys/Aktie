'use strict';
/**
 * Market Regime Engine V2
 *
 * More granular than calcMarketRegime in marketRegime.js.
 * Runs alongside Engine v3 (does not replace it).
 *
 * Input:  v2 classifyNarrowState result for the reference symbol
 *         (QQQ for stocks, BTCUSDT for crypto).
 * Output: marketContext { regime, direction, strength, volatility,
 *                         riskLevel, score, reasonSv, flags }
 *
 * Regimes: BULLISH_TREND | BEARISH_TREND | CHOPPY | RANGE_DAY |
 *          TREND_DAY_UP | TREND_DAY_DOWN | HIGH_VOLATILITY | PANIC | UNKNOWN
 *
 * Score effect on live tradeScore: max ±5 (Engine v3 already applies ±10).
 */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(n, d) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

const UNKNOWN_CTX = Object.freeze({
  regime:     'UNKNOWN',
  direction:  'neutral',
  strength:   0,
  volatility: 'normal',
  riskLevel:  'medium',
  score:      50,
  reasonSv:   ['Ingen marknadsreferens tillgänglig.'],
  flags: Object.freeze({ trendDay: false, rangeDay: false, panic: false, highVolatility: false, choppy: false }),
});

// ── Core engine ───────────────────────────────────────────────────────────────

/**
 * Compute rich marketContext from a reference symbol result.
 */
function calcMarketRegimeV2(refResult) {
  try {
    return _calc(refResult);
  } catch (err) {
    console.warn('[MarketRegimeEngine] calcMarketRegimeV2 error:', err.message);
    return { ...UNKNOWN_CTX, flags: { ...UNKNOWN_CTX.flags } };
  }
}

function _calc(refResult) {
  if (!refResult || !refResult.price || !refResult.sma20) {
    return { ...UNKNOWN_CTX, flags: { ...UNKNOWN_CTX.flags } };
  }

  const {
    price, sma20, sma200, rsi14,
    slope20Atr, slope200Atr,
    rangeCompression, relVol20, atrPct120, bbwPct120,
    threeFingerSpread, breakoutAlreadyOccurred, state,
  } = refResult;

  const tfs     = threeFingerSpread || {};
  const reasons = [];
  const flags   = { trendDay: false, rangeDay: false, panic: false, highVolatility: false, choppy: false };

  // ── 1. Direction: price vs SMA20 / SMA200 ────────────────────────────────
  const aboveSma20  = price > sma20;
  const aboveSma200 = sma200 != null ? price > sma200 : null;
  const sma20AboveSma200 = sma200 != null ? sma20 > sma200 : null;

  let dirScore = 50;
  let direction = 'neutral';

  if (aboveSma20 && aboveSma200 === true) {
    direction = 'bullish'; dirScore = 72;
    reasons.push('Priset är över SMA20 och SMA200 — bullish läge.');
  } else if (!aboveSma20 && aboveSma200 === false) {
    direction = 'bearish'; dirScore = 28;
    reasons.push('Priset är under SMA20 och SMA200 — bearish läge.');
  } else if (aboveSma20 && aboveSma200 === false) {
    direction = 'bullish'; dirScore = 58;
    reasons.push('Priset är över SMA20 men under SMA200 — blandad bild.');
  } else if (!aboveSma20 && aboveSma200 === true) {
    direction = 'bearish'; dirScore = 42;
    reasons.push('Priset är under SMA20 men över SMA200 — osäkert läge.');
  } else {
    dirScore = 50;
    reasons.push('Priset nära SMA20 — neutralt.');
  }

  if (sma20AboveSma200 !== null) {
    if (sma20AboveSma200) dirScore = clamp(dirScore + 6, 0, 100);
    else dirScore = clamp(dirScore - 6, 0, 100);
  }

  // ── 2. Slope ──────────────────────────────────────────────────────────────
  let slopeScore = 50;

  if (slope20Atr != null) {
    // slope20Atr is absolute magnitude; use direction to sign it
    const signedSlope = aboveSma20 ? slope20Atr : -slope20Atr;
    if (signedSlope > 0.12) {
      slopeScore += 18; reasons.push(`SMA20 lutar uppåt (styrka ${round(slope20Atr, 2)} ATR).`);
    } else if (signedSlope > 0.04) {
      slopeScore += 8;  reasons.push('SMA20 lutar lätt uppåt.');
    } else if (signedSlope < -0.12) {
      slopeScore -= 18; reasons.push(`SMA20 lutar nedåt (styrka ${round(slope20Atr, 2)} ATR).`);
    } else if (signedSlope < -0.04) {
      slopeScore -= 8;  reasons.push('SMA20 lutar lätt nedåt.');
    } else {
      flags.choppy = true; reasons.push('SMA20 är relativt flat — sidrörelse möjlig.');
    }
  }

  if (slope200Atr != null) {
    const signed200 = (sma200 != null && sma20 > sma200) ? slope200Atr : -slope200Atr;
    if (signed200 > 0.05)  slopeScore = clamp(slopeScore + 8, 0, 100);
    else if (signed200 < -0.05) slopeScore = clamp(slopeScore - 8, 0, 100);
  }

  slopeScore = clamp(slopeScore, 0, 100);

  // ── 3. RSI ────────────────────────────────────────────────────────────────
  let rsiScore = 50;
  if (rsi14 != null) {
    if (rsi14 > 75)      { rsiScore = 78; reasons.push(`RSI ${rsi14} — kraftigt överköpt.`); }
    else if (rsi14 > 60) { rsiScore = 65; reasons.push(`RSI ${rsi14} — styrka, stödjer long.`); }
    else if (rsi14 < 25) { rsiScore = 22; reasons.push(`RSI ${rsi14} — kraftigt översålt.`); }
    else if (rsi14 < 40) { rsiScore = 35; reasons.push(`RSI ${rsi14} — svaghet, stödjer short.`); }
  }

  // ── 4. Volatility ─────────────────────────────────────────────────────────
  let volatility  = 'normal';
  let volRiskAdj  = 0;

  if (atrPct120 != null) {
    if (atrPct120 > 200) {
      volatility = 'extreme'; flags.panic = true; volRiskAdj = -20;
      reasons.push(`ATR ${atrPct120}% av normalläget — extrem volatilitet (PANIC).`);
    } else if (atrPct120 > 150) {
      volatility = 'high'; flags.highVolatility = true; volRiskAdj = -10;
      reasons.push(`ATR ${atrPct120}% av normalläget — hög volatilitet.`);
    } else if (atrPct120 < 65) {
      volatility = 'low'; volRiskAdj = +5;
      reasons.push('ATR under normalläget — lugn marknad.');
    }
  } else if (relVol20 != null) {
    if (relVol20 > 2.5) {
      volatility = 'high'; flags.highVolatility = true; volRiskAdj = -8;
      reasons.push(`Relativ volym ${round(relVol20, 1)}x — ovanligt hög aktivitet.`);
    } else if (relVol20 > 1.8) {
      reasons.push(`Relativ volym ${round(relVol20, 1)}x — förhöjd aktivitet.`);
    }
  }

  // ── 5. Range day vs trend day ─────────────────────────────────────────────
  let rangeScore = 50;

  if (rangeCompression != null) {
    if (rangeCompression <= 0.65) {
      flags.rangeDay = true; rangeScore = 30;
      reasons.push(`Kompression ${round(rangeCompression, 2)}x — tight range-dag.`);
    } else if (rangeCompression <= 0.82) {
      rangeScore = 40;
    } else if (rangeCompression >= 1.40) {
      flags.trendDay = true; rangeScore = 70;
      reasons.push(`Breddning ${round(rangeCompression, 2)}x — trenddag möjlig.`);
    } else if (rangeCompression >= 1.15) {
      rangeScore = 60;
    }
  } else if (bbwPct120 != null) {
    if (bbwPct120 < 55)       { flags.rangeDay  = true; rangeScore = 32; reasons.push('Bollinger Bands smala — tight range-dag.'); }
    else if (bbwPct120 > 145) { flags.trendDay   = true; rangeScore = 68; reasons.push('Bollinger Bands breda — utbrott möjligt.'); }
  }

  // ── 6. Three Finger Spread ────────────────────────────────────────────────
  if (tfs.active) {
    volRiskAdj -= 8;
    flags.highVolatility = true;
    reasons.push('Three Finger Spread aktiv — priset är utsträckt.');
  }

  if (breakoutAlreadyOccurred) {
    reasons.push('Utbrott har redan skett — undvik att jaga.');
  }

  // ── 7. Choppy check ───────────────────────────────────────────────────────
  const neutralDir   = Math.abs(dirScore - 50) < 12;
  const neutralSlope = Math.abs(slopeScore - 50) < 10;
  if (!flags.trendDay && !flags.rangeDay && neutralDir && neutralSlope) {
    flags.choppy = true;
  }

  // ── 8. Final score ────────────────────────────────────────────────────────
  const rawScore = Math.round(
    dirScore   * 0.35 +
    slopeScore * 0.30 +
    rsiScore   * 0.15 +
    rangeScore * 0.10 +
    50         * 0.10  // vol neutral base
  ) + volRiskAdj;

  const score    = clamp(rawScore, 0, 100);
  const strength = clamp(Math.round(Math.abs(score - 50) * 2), 0, 100);

  // ── 9. Regime ─────────────────────────────────────────────────────────────
  let regime;

  if (flags.panic) {
    regime = 'PANIC';
  } else if (flags.highVolatility && strength >= 30) {
    regime = score >= 55 ? 'TREND_DAY_UP' : score <= 45 ? 'TREND_DAY_DOWN' : 'HIGH_VOLATILITY';
    if (regime !== 'HIGH_VOLATILITY') flags.trendDay = true;
  } else if (flags.highVolatility) {
    regime = 'HIGH_VOLATILITY';
  } else if (flags.rangeDay) {
    regime = 'RANGE_DAY';
  } else if (flags.trendDay) {
    regime = score >= 60 ? 'TREND_DAY_UP' : score <= 40 ? 'TREND_DAY_DOWN' : 'CHOPPY';
  } else if (score >= 68) {
    regime = 'BULLISH_TREND';
  } else if (score <= 32) {
    regime = 'BEARISH_TREND';
  } else if (flags.choppy) {
    regime = 'CHOPPY';
  } else {
    regime = direction === 'bullish' ? 'BULLISH_TREND' :
             direction === 'bearish' ? 'BEARISH_TREND' : 'UNKNOWN';
  }

  // ── 10. Risk level ────────────────────────────────────────────────────────
  let riskLevel;
  if (flags.panic || (flags.highVolatility && strength >= 40)) riskLevel = 'extreme';
  else if (flags.highVolatility || flags.choppy)               riskLevel = 'high';
  else if (flags.rangeDay || strength < 20)                    riskLevel = 'low';
  else                                                         riskLevel = 'medium';

  return {
    regime,
    direction,
    strength,
    volatility,
    riskLevel,
    score,
    reasonSv: reasons.length > 0 ? reasons : ['Neutralt marknadsläge.'],
    flags,
  };
}

// ── Score adjustment ──────────────────────────────────────────────────────────

function calcRegimeAdjustment(marketContext, signal) {
  if (!marketContext || marketContext.regime === 'UNKNOWN') return 0;

  const { regime, flags } = marketContext;
  const isLong    = signal && (String(signal).includes('LONG') || signal === 'WIDE_REVERSAL_WATCH');
  const isShort   = signal && String(signal).includes('SHORT');
  if (!isLong && !isShort) return 0;

  if (regime === 'PANIC')          return -5;
  if (regime === 'HIGH_VOLATILITY') return -4;
  if (flags.choppy)                return -3;

  const bullish = ['BULLISH_TREND', 'TREND_DAY_UP'].includes(regime);
  const bearish = ['BEARISH_TREND', 'TREND_DAY_DOWN'].includes(regime);

  if (isLong  && bullish) return +3;
  if (isShort && bearish) return +3;
  if (isLong  && bearish) return -4;
  if (isShort && bullish) return -4;

  return 0;
}

// ── Live result enrichment ────────────────────────────────────────────────────

/**
 * Apply market regime V2 to a live result.
 * Adds: marketContext, marketRegimeV2, marketScoreV2, marketDirectionV2.
 * Adjusts tradeScore max ±5.
 */
function applyMarketRegimeV2(result, marketContext) {
  if (!marketContext) {
    return {
      ...result,
      marketContext:    null,
      marketRegimeV2:   'UNKNOWN',
      marketScoreV2:    50,
      marketDirectionV2: 'neutral',
    };
  }

  const adj    = calcRegimeAdjustment(marketContext, result.signal);
  const before = result.tradeScore ?? 0;
  const after  = clamp(before + adj, 0, 100);

  const explanation = [...(result.scoreExplanationSv || [])];
  if (adj > 0) {
    explanation.push('Marknaden stödjer signalriktningen.');
  } else if (adj < 0 && ['PANIC', 'HIGH_VOLATILITY'].includes(marketContext.regime)) {
    explanation.push('Hög volatilitet: större risk för falska signaler.');
  } else if (adj < 0 && marketContext.flags?.choppy) {
    explanation.push('Marknaden är stökig, därför sänks betyget.');
  } else if (adj < 0) {
    explanation.push('Marknaden går emot signalen.');
  }

  return {
    ...result,
    tradeScore:         after,
    signalScore:        after,
    marketContext,
    marketRegimeV2:     marketContext.regime,
    marketScoreV2:      marketContext.score,
    marketDirectionV2:  marketContext.direction,
    scoreExplanationSv: explanation,
  };
}

module.exports = { calcMarketRegimeV2, applyMarketRegimeV2, calcRegimeAdjustment };
