'use strict';

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/**
 * Engine v3 — Del 1: Market Regime Filter
 *
 * Input:  v2 classifyNarrowState result for the reference symbol (QQQ for stocks).
 * Output: { marketRegime, marketScore, marketDirection, marketReasonSv }
 *
 * marketRegime values:
 *   BULLISH   — broad market supports long setups
 *   BEARISH   — broad market suppresses long setups, supports shorts
 *   CHOPPY    — unclear direction, reduce score slightly
 *   HIGH_RISK — extreme extended state, warn but don't auto-block
 *   UNKNOWN   — no reference data available (crypto, pre-market, data gap)
 *
 * marketScore: 0–100, 50 = neutral. >55 = net bullish, <45 = net bearish.
 */
function calcMarketRegime(refResult) {
  const noData = {
    marketRegime: 'UNKNOWN',
    marketScore: 50,
    marketDirection: 'neutral',
    marketReasonSv: ['Marknadsdata saknas. Ingen referenssymbol tillgänglig.'],
  };

  if (!refResult || !refResult.price || !refResult.sma20) return noData;

  const {
    price, sma20, sma200, rsi14,
    threeFingerSpread, state,
    slope20Atr, slope200Atr,
    positionCode,
  } = refResult;

  const tfs = threeFingerSpread || {};
  const reasons = [];
  let score = 50;

  // ── Price vs SMA20 ────────────────────────────────────────────────────────
  if (price > sma20) {
    score += 14;
    reasons.push(`Pris ${round(price, 2)} ovanför SMA20 ${round(sma20, 2)} — kortsiktig trend uppåt.`);
  } else {
    score -= 14;
    reasons.push(`Pris ${round(price, 2)} under SMA20 ${round(sma20, 2)} — kortsiktig trend nedåt.`);
  }

  // ── Price vs SMA200 ───────────────────────────────────────────────────────
  if (sma200 !== null && sma200 !== undefined) {
    if (sma20 > sma200) {
      score += 12;
      reasons.push(`SMA20 ovanför SMA200 — långsiktig upptrend bekräftad.`);
    } else {
      score -= 12;
      reasons.push(`SMA20 under SMA200 — långsiktig nedtrend.`);
    }
  } else {
    reasons.push('SMA200 saknas — för lite historik för långsiktig trend.');
  }

  // ── SMA20 Slope ───────────────────────────────────────────────────────────
  if (slope20Atr !== null && slope20Atr !== undefined) {
    const rising = price > sma20;
    if (slope20Atr > 0.30) {
      const dir = rising ? 'aktivt uppåt' : 'aktivt nedåt';
      score += rising ? 8 : -8;
      reasons.push(`SMA20-lutning ${round(slope20Atr, 2)} ATR — rör sig ${dir}.`);
    } else if (slope20Atr <= 0.08) {
      score -= 4;
      reasons.push(`SMA20 näst intill flat (${round(slope20Atr, 2)} ATR) — marknaden saknar riktning.`);
    }
  }

  // ── SMA200 Slope ──────────────────────────────────────────────────────────
  if (slope200Atr !== null && slope200Atr !== undefined) {
    if (slope200Atr > 0.15) {
      reasons.push(`SMA200 rör sig (${round(slope200Atr, 2)} ATR) — stark bakgrundstrend.`);
      score += price > sma20 ? 5 : -5;
    }
  }

  // ── RSI14 ─────────────────────────────────────────────────────────────────
  if (rsi14 !== null && rsi14 !== undefined) {
    if (rsi14 > 55 && rsi14 <= 70)      { score += 8;  reasons.push(`RSI ${round(rsi14, 1)} — hälsosam bullish styrka.`); }
    else if (rsi14 > 70)                { score += 3;  reasons.push(`RSI ${round(rsi14, 1)} — överköpt, risk för rekyl.`); }
    else if (rsi14 < 40 && rsi14 >= 30) { score -= 8;  reasons.push(`RSI ${round(rsi14, 1)} — svag, bearish press.`); }
    else if (rsi14 < 30)                { score -= 14; reasons.push(`RSI ${round(rsi14, 1)} — kraftigt översålt.`); }
  }

  // ── Three Finger Spread / Wide condition ──────────────────────────────────
  if (tfs.active) {
    if (tfs.direction === 'bearish') {
      score -= 20;
      reasons.push('Referenssymbol i Three Finger Spread nedåt — marknadens risk för longs är hög.');
    } else {
      score -= 5;
      reasons.push('Referenssymbol i Three Finger Spread uppåt — marknaden är utsträckt, chasingrisk.');
    }
  } else if (state === 'WIDE_AVOID') {
    score -= 8;
    reasons.push('Referenssymbol i WIDE_AVOID — marknaden är utsträckt från zonen.');
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));

  // ── Derive regime ─────────────────────────────────────────────────────────
  let marketRegime;
  if (tfs.active && tfs.direction === 'bearish' && tfs.strength === 'super_wide') {
    marketRegime = 'HIGH_RISK';
  } else if (finalScore >= 63) {
    marketRegime = 'BULLISH';
  } else if (finalScore <= 37) {
    marketRegime = 'BEARISH';
  } else if (tfs.active || state === 'WIDE_AVOID') {
    marketRegime = 'CHOPPY';
  } else {
    marketRegime = 'CHOPPY';
  }

  const marketDirection =
    finalScore > 55 ? 'bullish' :
    finalScore < 45 ? 'bearish' : 'neutral';

  return {
    marketRegime,
    marketScore: finalScore,
    marketDirection,
    marketReasonSv: reasons.slice(0, 5),
  };
}

module.exports = { calcMarketRegime };
