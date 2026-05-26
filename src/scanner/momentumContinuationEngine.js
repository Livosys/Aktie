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
function dirSv(d) {
  if (d === 'bullish') return 'uppåt';
  if (d === 'bearish') return 'nedåt';
  return 'neutral';
}
function qualityFromScore(score) {
  if (score >= 72) return 'strong';
  if (score >= 55) return 'ok';
  if (score >= 38) return 'weak';
  return 'poor';
}
function qualitySv(q) {
  return ({ strong: 'stark', ok: 'okej', weak: 'svag', poor: 'låg' })[q] || q;
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
function candleDirection(c) {
  if (!c) return 'neutral';
  if (c.c > c.o) return 'bullish';
  if (c.c < c.o) return 'bearish';
  return 'neutral';
}
function bodyEfficiency(c) {
  if (!c) return 0;
  const range = Math.max(0, c.h - c.l);
  if (range <= 0) return 0;
  return Math.abs(c.c - c.o) / range;
}

function calcMomentumContinuation(result) {
  const candles = result?._candles2m || [];
  if (!Array.isArray(candles) || candles.length < 8) {
    return {
      momentumContinuationScore: 0,
      continuationQuality: 'unknown',
      momentumBias: 'neutral',
      momentumExplanationSv: 'Otillräcklig candle-data för momentum continuation.',
      momentumContinuationContext: null,
      momentumContinuationAdjustment: 0,
      momentumWatchMode: false,
    };
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const last5 = candles.slice(-5);
  const prev5 = candles.slice(-10, -5);
  const ranges20 = candles.slice(-21, -1).map((c) => Math.max(0, c.h - c.l));
  const avgRange20 = avg(ranges20) || Math.max(result?.atr14 || 0, 0.0001);
  const atr = Math.max(result?.atr14 || avgRange20 || 0.0001, 0.0001);

  const recentMove = last.c - last5[0].o;
  const bias = recentMove > atr * 0.25 ? 'bullish' : recentMove < -atr * 0.25 ? 'bearish' : candleDirection(last);
  const signed = bias === 'bearish' ? -1 : bias === 'bullish' ? 1 : 0;

  const followThroughBars = signed === 0 ? 0 : last5.filter((c) => signed * (c.c - c.o) > 0).length;
  const followThroughStrength = clamp((followThroughBars / last5.length) * 100, 0, 100);
  const candleEfficiency = clamp(avg(last5.map(bodyEfficiency)) * 100, 0, 100);

  const impulseRange = Math.abs(recentMove);
  const impulseQuality = clamp((impulseRange / (atr * 2.2)) * 100, 0, 100);

  const againstMoves = signed === 0 ? [] : last5.map((c) => Math.max(0, -signed * (c.c - c.o)));
  const maxPullback = againstMoves.length ? Math.max(...againstMoves) : 0;
  const pullbackQuality = clamp(100 - (maxPullback / atr) * 85, 0, 100);

  const prevAvgRange = avg(prev5.map((c) => Math.max(0, c.h - c.l))) || avgRange20;
  const recentAvgRange = avg(last5.map((c) => Math.max(0, c.h - c.l))) || avgRange20;
  const acceleration = clamp(((recentAvgRange / Math.max(prevAvgRange || avgRange20, 0.0001)) - 1) * 60 + 50, 0, 100);

  let score =
    followThroughStrength * 0.24 +
    candleEfficiency * 0.20 +
    impulseQuality * 0.22 +
    pullbackQuality * 0.18 +
    acceleration * 0.16;

  if (result?.mtfAlignment === 'confirmed') score += 6;
  else if (result?.mtfAlignment === 'aligned') score += 3;
  else if (result?.mtfAlignment === 'conflicting') score -= 7;

  const relVol = result?.relVol20;
  if (relVol != null && relVol >= 1.1) score += 4;
  if (relVol != null && relVol < 0.65) score -= 6;

  const momentumContinuationScore = Math.round(clamp(score, 0, 100));
  const continuationQuality = qualityFromScore(momentumContinuationScore);
  const continuationProbability = Math.round(clamp(momentumContinuationScore * 0.9 + (relVol >= 1 ? 5 : 0), 0, 100));

  const isHardBlocked = hardBlocked(result);
  const positiveAdj = continuationQuality === 'strong' ? 3 : continuationQuality === 'ok' ? 1 : 0;
  const momentumContinuationAdjustment = 0;
  const momentumWatchMode = !isHardBlocked && momentumContinuationScore >= 58 && ['WAIT', 'NO_TRADE'].includes(result?.signal);

  const parts = [
    `Continuation ${qualitySv(continuationQuality)} (${momentumContinuationScore}/100)`,
    `bias ${dirSv(bias)}`,
    `follow-through ${Math.round(followThroughStrength)}/100`,
    `candle-effektivitet ${Math.round(candleEfficiency)}/100`,
  ];
  if (isHardBlocked && positiveAdj > 0) parts.push('ingen positiv boost eftersom signalen är hårt blockerad');

  return {
    momentumContinuationScore,
    continuationQuality,
    momentumBias: bias,
    momentumExplanationSv: parts.join('. ') + '.',
    momentumContinuationAdjustment,
    momentumWatchMode,
    momentumContinuationContext: {
      followThroughStrength: Math.round(followThroughStrength),
      candleEfficiency: Math.round(candleEfficiency),
      impulseQuality: Math.round(impulseQuality),
      pullbackQuality: Math.round(pullbackQuality),
      continuationProbability,
      acceleration: Math.round(acceleration),
    },
  };
}

function applyMomentumContinuation(result) {
  try {
    const ctx = calcMomentumContinuation(result);
    const baseScore = result.tradeScore ?? 0;
    const nextScore = baseScore;
    const expl = [...(result.scoreExplanationSv || [])];
    if (ctx.momentumExplanationSv && !expl.includes(ctx.momentumExplanationSv)) expl.push(ctx.momentumExplanationSv);
    return {
      ...result,
      ...ctx,
      tradeScore: nextScore,
      signalScore: nextScore,
      confidence: result.confidence ? {
        ...result.confidence,
        finalTradeScore: nextScore,
        label: confidenceLabel(nextScore, result.autoFilter?.blocked === true),
      } : result.confidence,
      scoreExplanationSv: expl,
      watchMode: result.watchMode || ctx.momentumWatchMode || false,
      watchModeReasonSv: ctx.momentumWatchMode
        ? 'Momentum continuation syns, men motorn skapar bara bevakning.'
        : result.watchModeReasonSv,
    };
  } catch (err) {
    console.warn('[MomentumContinuation] error:', err.message);
    return result;
  }
}

module.exports = { calcMomentumContinuation, applyMomentumContinuation };
