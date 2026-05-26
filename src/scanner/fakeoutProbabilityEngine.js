'use strict';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v, d = 1) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  const f = 10 ** d;
  return Math.round(Number(v) * f) / f;
}
function avg(arr) {
  const vals = arr.filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
function riskLevel(score) {
  if (score >= 70) return 'high';
  if (score >= 52) return 'elevated';
  if (score >= 35) return 'normal';
  return 'low';
}
function riskSv(level) {
  return ({ high: 'hög', elevated: 'förhöjd', normal: 'normal', low: 'låg' })[level] || level;
}
function confidenceLabel(score, blocked) {
  if (blocked) return 'Blockerad';
  if (score >= 70) return 'Mycket stark';
  if (score >= 55) return 'Stark';
  if (score >= 40) return 'Bevaka';
  if (score >= 25) return 'Svag';
  return 'Blockerad';
}
function hardBlocked(result) {
  return result?.autoFilter?.blocked === true ||
    result?.threeFingerSpread?.active === true ||
    result?.breakoutAlreadyOccurred === true;
}
function calcBacktestAdjustment(result, fakeoutCtx) {
  const blocked = hardBlocked(result);
  const momentumScore = result?.momentumContinuationScore ?? 0;
  const mtf = result?.mtfAlignment || 'neutral';
  const fakeoutProbability = fakeoutCtx?.fakeoutProbability ?? 0;
  const fakeoutRiskLevel = fakeoutCtx?.fakeoutRiskLevel || 'normal';

  if (blocked) {
    return {
      momentumBacktestApplied: false,
      momentumBacktestAdjustment: 0,
      momentumBacktestReasonSv: 'Backtest-stöd: Nej. Ingen boost eftersom signalen är hårt blockerad.',
    };
  }

  if (fakeoutProbability >= 70 && ['conflicting', 'full_conflict'].includes(mtf)) {
    return {
      momentumBacktestApplied: true,
      momentumBacktestAdjustment: -5,
      momentumBacktestReasonSv: 'Backtest-stöd: Nej. Hög fakeout-risk kombinerat med MTF-konflikt ger konservativt avdrag.',
    };
  }

  if (fakeoutProbability >= 70) {
    return {
      momentumBacktestApplied: true,
      momentumBacktestAdjustment: -3,
      momentumBacktestReasonSv: 'Backtest-stöd: Nej. FakeoutProbability är hög, därför sänks score konservativt.',
    };
  }

  if (momentumScore >= 71 && ['confirmed', 'aligned'].includes(mtf) && fakeoutRiskLevel !== 'high') {
    const adjustment = mtf === 'confirmed' ? 3 : 2;
    const mtfSv = mtf === 'confirmed' ? 'confirmed' : 'aligned';
    return {
      momentumBacktestApplied: true,
      momentumBacktestAdjustment: adjustment,
      momentumBacktestReasonSv: `Backtest-stöd: Ja. Historisk edge: high momentum + MTF ${mtfSv} ≈ 53.85% WR.`,
    };
  }

  return {
    momentumBacktestApplied: false,
    momentumBacktestAdjustment: 0,
    momentumBacktestReasonSv: 'Backtest-stöd: Nej. Momentum/fakeout/MTF matchar inte de bevisade backtest-villkoren.',
  };
}

function calcFakeoutProbability(result) {
  const candles = result?._candles2m || [];
  const reasons = [];
  let score = 18;

  const continuationScore = result?.momentumContinuationScore ?? 0;
  if (continuationScore > 0 && continuationScore < 38) {
    score += 16;
    reasons.push('Svag follow-through efter signal.');
  } else if (continuationScore >= 70) {
    score -= 8;
  }

  if (['conflicting', 'full_conflict'].includes(result?.mtfAlignment)) {
    score += 18;
    reasons.push('MTF går emot rörelsen.');
  } else if (result?.mtfAlignment === 'mixed') {
    score += 8;
    reasons.push('MTF är blandad.');
  } else if (['confirmed', 'aligned'].includes(result?.mtfAlignment)) {
    score -= 5;
  }

  if (result?.marketRegimeV2 === 'HIGH_VOLATILITY' && continuationScore < 55) {
    score += 14;
    reasons.push('Hög volatilitet utan tydlig continuation.');
  }
  if (['CHOPPY', 'RANGE_DAY'].includes(result?.marketRegimeV2) || ['CHOPPY', 'RANGE_DAY'].includes(result?.marketRegime)) {
    score += 12;
    reasons.push('Range/choppy miljö ökar fakeout-risk.');
  }

  const eb = result?.elephantBar;
  if (eb?.active && continuationScore < 52) {
    score += 12;
    reasons.push('Elephant bar visar risk för exhaustion utan uppföljning.');
  }
  if (eb?.active && eb.closeQuality === 'middle') {
    score += 5;
    reasons.push('Elephant bar stängde inte starkt i riktningen.');
  }

  const relVol = result?.relVol20;
  if (relVol != null && relVol < 0.75) {
    score += 14;
    reasons.push(`Låg relVol (${round(relVol, 2)}x) bekräftar inte rörelsen.`);
  } else if (relVol != null && relVol >= 1.2) {
    score -= 6;
  }

  if (result?.priceToZoneAtr != null && result.priceToZoneAtr > 1.35) {
    score += 10;
    reasons.push('Priset är utsträckt långt från zonen.');
  }
  if (result?.threeFingerSpread?.active) {
    score += 16;
    reasons.push('Three Finger Spread: priset är för långt ifrån.');
  }

  if (candles.length >= 12) {
    const last = candles[candles.length - 1];
    const last5 = candles.slice(-5);
    const prev7 = candles.slice(-12, -5);
    const recentRange = Math.max(...last5.map((c) => c.h)) - Math.min(...last5.map((c) => c.l));
    const prevRange = Math.max(...prev7.map((c) => c.h)) - Math.min(...prev7.map((c) => c.l));
    const avgRange20 = avg(candles.slice(-21, -1).map((c) => c.h - c.l)) || result?.atr14 || 0;
    const lastRange = Math.max(0, last.h - last.l);
    const lastEfficiency = lastRange > 0 ? Math.abs(last.c - last.o) / lastRange : 0;

    if (prevRange > 0 && recentRange / prevRange < 0.55) {
      score += 8;
      reasons.push('Rörelsen tappar range jämfört med tidigare candles.');
    }
    if (avgRange20 > 0 && lastRange > avgRange20 * 1.5 && lastEfficiency < 0.45) {
      score += 9;
      reasons.push('Stor volatil candle men svag stängning.');
    }
  }

  if (result?.breakoutAlreadyOccurred) {
    score += 12;
    reasons.push('Rörelsen har redan gått, chase-risk.');
  }

  const fakeoutProbability = Math.round(clamp(score, 0, 100));
  const fakeoutRiskLevel = riskLevel(fakeoutProbability);
  const fakeoutExplanationSv = reasons.length
    ? `Fakeout-risk ${riskSv(fakeoutRiskLevel)} (${fakeoutProbability}/100): ${reasons.slice(0, 3).join(' ')}`
    : `Fakeout-risk ${riskSv(fakeoutRiskLevel)} (${fakeoutProbability}/100). Inga tydliga fakeout-varningar.`;

  return { fakeoutProbability, fakeoutRiskLevel, fakeoutReasons: reasons, fakeoutExplanationSv };
}

function applyFakeoutProbability(result) {
  try {
    const ctx = calcFakeoutProbability(result);
    const backtest = calcBacktestAdjustment(result, ctx);
    const penalty = backtest.momentumBacktestAdjustment;
    const baseScore = result.tradeScore ?? 0;
    const nextScore = clamp(baseScore + penalty, 0, 100);
    const expl = [...(result.scoreExplanationSv || [])];
    if (ctx.fakeoutExplanationSv && !expl.includes(ctx.fakeoutExplanationSv)) expl.push(ctx.fakeoutExplanationSv);
    if (backtest.momentumBacktestReasonSv && !expl.includes(backtest.momentumBacktestReasonSv)) expl.push(backtest.momentumBacktestReasonSv);
    return {
      ...result,
      ...ctx,
      fakeoutScoreAdjustment: penalty,
      ...backtest,
      tradeScore: nextScore,
      signalScore: nextScore,
      confidence: result.confidence ? {
        ...result.confidence,
        finalTradeScore: nextScore,
        label: confidenceLabel(nextScore, hardBlocked(result)),
      } : result.confidence,
      scoreExplanationSv: expl,
    };
  } catch (err) {
    console.warn('[FakeoutProbability] error:', err.message);
    return result;
  }
}

module.exports = { calcFakeoutProbability, applyFakeoutProbability };
