'use strict';

/**
 * Multi-Timeframe Confirmation Engine v2
 *
 * Phase 1 — calcMtf (called from engineV3):
 *   Analyses 5m/15m candles aggregated from the same 1m bars used for 2m.
 *   Computes direction and alignment metadata. Stores raw adjustment in
 *   mtfRawAdjustment; does NOT yet apply it (done by applyMtf).
 *
 * Phase 2 — applyMtf (pipeline step after confidenceEngine):
 *   Applies the raw adjustment with full hard-block safety:
 *   TFS / breakoutAlreadyOccurred / autoFilter.blocked → mtfAdjustment = 0.
 *
 * Adjustment table (raw, before hard-block check):
 *   confirmed     both 5m & 15m agree with 2m direction  → +6
 *   aligned       one TF agrees, other neutral            → +3
 *   mixed         one agrees, one conflicts               →  0
 *   conflicting   one TF conflicts, other neutral         → -3
 *   full_conflict both TFs conflict with 2m              → -6
 *   neutral       2m neutral OR no higher-TF data         →  0
 */

const { sma, rsi } = require('./indicators');

const MIN_SMA20 = 20;

// ── Per-TF direction ──────────────────────────────────────────────────────────

function calcTfContext(candles, label) {
  if (!candles || candles.length < MIN_SMA20) {
    return { label, direction: 'neutral', status: 'insufficient', barCount: candles ? candles.length : 0 };
  }

  const closes = candles.map((c) => c.c);
  const price  = closes[closes.length - 1];
  const sma20v = sma(closes, 20);
  if (!sma20v) return { label, direction: 'neutral', status: 'insufficient', barCount: candles.length };

  const rsi14v = closes.length >= 16 ? rsi(closes, 14) : null;

  const priceAbove = price > sma20v;
  const priceBelow = price < sma20v;

  // Slope: SMA20 3 bars ago vs now
  let slope = null;
  if (candles.length >= 23) {
    const oldSma = sma(closes.slice(0, -3), 20);
    if (oldSma && oldSma > 0) slope = ((sma20v - oldSma) / oldSma) * 100;
  }

  // Direction: price-vs-SMA20 + RSI confirmation
  let direction = 'neutral';
  if      (priceAbove && (rsi14v === null || rsi14v > 48)) direction = 'bullish';
  else if (priceBelow && (rsi14v === null || rsi14v < 52)) direction = 'bearish';

  // Slope tiebreaker for borderline neutral
  if (direction === 'neutral' && slope !== null) {
    if (slope > 0.05 && priceAbove) direction = 'bullish';
    if (slope < -0.05 && priceBelow) direction = 'bearish';
  }

  return {
    label,
    direction,
    status:         'ok',
    barCount:       candles.length,
    sma20:          Math.round(sma20v * 100) / 100,
    rsi14:          rsi14v !== null ? Math.round(rsi14v * 10) / 10 : null,
    price:          Math.round(price * 100) / 100,
    slope:          slope !== null ? Math.round(slope * 1000) / 1000 : null,
    priceAboveSma20: priceAbove,
  };
}

// ── Swedish helpers ───────────────────────────────────────────────────────────

function dirSv(d) {
  if (d === 'bullish') return 'uppåt';
  if (d === 'bearish') return 'nedåt';
  return 'neutral';
}

// ── Phase 1: calcMtf (called from engineV3, before confidence engine) ────────

function calcMtf(v2result, candles5m, candles15m) {
  const { price, sma20, positionCode } = v2result || {};

  // 2m direction
  let tf2mDirection = 'neutral';
  if (price && sma20) {
    if      (price > sma20) tf2mDirection = 'bullish';
    else if (price < sma20) tf2mDirection = 'bearish';
  }
  if (positionCode === 'in_zone') tf2mDirection = 'neutral';

  const tf5m  = calcTfContext(candles5m,  '5m');
  const tf15m = calcTfContext(candles15m, '15m');
  const has5m  = tf5m.status  === 'ok';
  const has15m = tf15m.status === 'ok';

  if (!has5m && !has15m) {
    return {
      mtfStatus:        'limited',
      tf2mDirection,
      tf5mDirection:    'unknown',
      tf15mDirection:   'unknown',
      mtfAlignment:     'neutral',
      mtfScore:         50,
      mtfRawAdjustment: 0,
      mtfAdjustment:    0,
      mtfDirection:     'neutral',
      mtf5m:            null,
      mtf15m:           null,
      mtfExplanationSv: 'Otillräcklig data för MTF-analys. Ingen justering.',
      mtfReasonSv:      ['Otillräcklig data för MTF-analys. Ingen justering.'],
    };
  }

  const tf5mDir  = has5m  ? tf5m.direction  : 'unknown';
  const tf15mDir = has15m ? tf15m.direction : 'unknown';

  const higherTfs = [tf5mDir, tf15mDir].filter((d) => d !== 'unknown');
  const confirms  = tf2mDirection !== 'neutral'
    ? higherTfs.filter((d) => d === tf2mDirection).length : 0;
  const conflicts = tf2mDirection !== 'neutral'
    ? higherTfs.filter((d) => d !== tf2mDirection && d !== 'neutral').length : 0;

  let mtfAlignment, mtfScore, rawAdj, explanationSv;

  if (tf2mDirection === 'neutral') {
    mtfAlignment = 'neutral'; mtfScore = 50; rawAdj = 0;
    explanationSv = 'MTF neutral — 2m-riktning oklar. Ingen justering.';

  } else if (confirms === 2) {
    mtfAlignment = 'confirmed'; mtfScore = 78; rawAdj = 6;
    explanationSv = `MTF bekräftar: 5m och 15m stödjer ${dirSv(tf2mDirection)}. Score +6.`;

  } else if (confirms === 1 && conflicts === 0) {
    const which = has5m && tf5mDir === tf2mDirection ? '5m' : '15m';
    mtfAlignment = 'aligned'; mtfScore = 62; rawAdj = 3;
    explanationSv = `MTF delvis bekräftar: ${which} stödjer ${dirSv(tf2mDirection)}. Score +3.`;

  } else if (confirms === 1 && conflicts === 1) {
    mtfAlignment = 'mixed'; mtfScore = 50; rawAdj = 0;
    explanationSv = 'MTF blandat: en tidram bekräftar, en annan går emot 2m. Ingen justering.';

  } else if (conflicts === 2) {
    mtfAlignment = 'conflicting'; mtfScore = 28; rawAdj = -6;
    explanationSv = `MTF varnar: 5m och 15m går emot 2m-signal ${dirSv(tf2mDirection)}. Score -6.`;

  } else if (conflicts === 1) {
    const which = has5m && tf5mDir !== tf2mDirection && tf5mDir !== 'neutral' && tf5mDir !== 'unknown' ? '5m' : '15m';
    mtfAlignment = 'conflicting'; mtfScore = 40; rawAdj = -3;
    explanationSv = `MTF varnar: ${which} går emot 2m-signal ${dirSv(tf2mDirection)}. Score -3.`;

  } else {
    mtfAlignment = 'neutral'; mtfScore = 50; rawAdj = 0;
    explanationSv = 'MTF neutral — ingen tydlig bekräftelse. Ingen justering.';
  }

  const known = [tf5mDir, tf15mDir].filter((d) => d !== 'unknown' && d !== 'neutral');
  const mtfDirection = known.length === 0 ? 'neutral'
    : known.every((d) => d === 'bullish') ? 'bullish'
    : known.every((d) => d === 'bearish') ? 'bearish'
    : 'mixed';

  return {
    mtfStatus:        'active',
    tf2mDirection,
    tf5mDirection:    tf5mDir,
    tf15mDirection:   tf15mDir,
    mtfAlignment,
    mtfScore,
    mtfRawAdjustment: rawAdj,   // stored for applyMtf; not sent to client
    mtfAdjustment:    0,         // set correctly by applyMtf
    mtfDirection,
    mtf5m:            has5m  ? tf5m  : null,
    mtf15m:           has15m ? tf15m : null,
    mtfExplanationSv: explanationSv,
    mtfReasonSv:      [explanationSv],
  };
}

// ── Phase 2: applyMtf (pipeline step after confidenceEngine) ─────────────────

function applyMtf(result) {
  try {
    return _applyMtf(result);
  } catch (err) {
    console.warn('[MTF] applyMtf error:', err.message);
    return result;
  }
}

function _applyMtf(result) {
  const rawAdj = result.mtfRawAdjustment ?? 0;

  // Strip internal field always
  const { mtfRawAdjustment, ...rest } = result;

  if (rawAdj === 0) return { ...rest, mtfAdjustment: 0 };

  // Full hard-block safety (autoFilter.blocked available here, set by confidenceEngine)
  const isHardBlocked =
    rest.autoFilter?.blocked       === true ||
    rest.threeFingerSpread?.active === true ||
    rest.breakoutAlreadyOccurred   === true;

  if (isHardBlocked) {
    const expl = rest.mtfExplanationSv
      ? rest.mtfExplanationSv + ' (justering nollställd — signal är hårt blockerad)'
      : 'MTF-justering nollställd — signal är hårt blockerad.';
    return { ...rest, mtfAdjustment: 0, mtfExplanationSv: expl };
  }

  const newScore = Math.max(0, Math.min(100, (rest.tradeScore ?? 0) + rawAdj));
  const expl     = [...(rest.scoreExplanationSv || [])];
  if (rest.mtfExplanationSv && !expl.includes(rest.mtfExplanationSv)) {
    expl.push(rest.mtfExplanationSv);
  }

  return {
    ...rest,
    tradeScore:         newScore,
    signalScore:        newScore,
    mtfAdjustment:      rawAdj,
    scoreExplanationSv: expl,
  };
}

module.exports = { calcMtf, applyMtf };
