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
function directionSv(d) {
  if (d === 'bullish') return 'bullish sweep nedåt med reclaim';
  if (d === 'bearish') return 'bearish sweep uppåt med reject';
  return 'neutral';
}
function quality(score) {
  if (score >= 72) return 'strong';
  if (score >= 52) return 'ok';
  if (score >= 35) return 'weak';
  return 'none';
}
function hardBlocked(result) {
  return result?.autoFilter?.blocked === true ||
    result?.threeFingerSpread?.active === true ||
    result?.breakoutAlreadyOccurred === true;
}
function confidenceLabel(score, blocked) {
  if (blocked) return 'Blockerad';
  if (score >= 70) return 'Mycket stark';
  if (score >= 55) return 'Stark';
  if (score >= 40) return 'Bevaka';
  if (score >= 25) return 'Svag';
  return 'Blockerad';
}

function calcLiquiditySweep(result) {
  const candles = result?._candles2m || [];
  if (!Array.isArray(candles) || candles.length < 12) {
    return {
      liquiditySweepDetected: false,
      sweepDirection: 'none',
      sweepQuality: 'none',
      trapType: 'none',
      sweepExplanationSv: 'Otillräcklig candle-data för liquidity sweep.',
      liquiditySweepContext: null,
    };
  }

  const last = candles[candles.length - 1];
  const recent = candles.slice(-11, -1);
  const priorHigh = Math.max(...recent.map((c) => c.h));
  const priorLow = Math.min(...recent.map((c) => c.l));
  const range = Math.max(0.0001, last.h - last.l);
  const atr = Math.max(result?.atr14 || avg(candles.slice(-21, -1).map((c) => c.h - c.l)) || range, 0.0001);

  const sweptHigh = last.h > priorHigh && last.c < priorHigh;
  const sweptLow = last.l < priorLow && last.c > priorLow;
  const upperWick = (last.h - Math.max(last.o, last.c)) / range;
  const lowerWick = (Math.min(last.o, last.c) - last.l) / range;
  const failedBreakout = sweptHigh && upperWick >= 0.35;
  const reclaimAfterBreakdown = sweptLow && lowerWick >= 0.35;

  let sweepDirection = 'none';
  let trapType = 'none';
  let score = 0;
  const reasons = [];

  if (failedBreakout) {
    sweepDirection = 'bearish';
    trapType = 'trapped_buyers';
    score += 42;
    reasons.push('Priset tog ut recent high men stängde tillbaka under nivån.');
    if (upperWick >= 0.5) { score += 20; reasons.push('Tydlig upper wick rejection.'); }
  }

  if (reclaimAfterBreakdown) {
    sweepDirection = 'bullish';
    trapType = 'trapped_sellers';
    score += 42;
    reasons.push('Priset tog ut recent low men reclaimade nivån.');
    if (lowerWick >= 0.5) { score += 20; reasons.push('Tydlig lower wick rejection.'); }
  }

  const sweepDistance = sweptHigh ? last.h - priorHigh : sweptLow ? priorLow - last.l : 0;
  if (sweepDistance > 0) {
    score += clamp((sweepDistance / atr) * 40, 0, 18);
  }

  const closeBackInside = sweptHigh ? priorHigh - last.c : sweptLow ? last.c - priorLow : 0;
  if (closeBackInside > atr * 0.05) {
    score += 10;
    reasons.push('Stängningen kom tydligt tillbaka innanför nivån.');
  }

  if (result?.relVol20 != null && result.relVol20 >= 0.9) score += 5;
  if (result?.fakeoutRiskLevel === 'high' && score > 0) {
    score += 5;
    reasons.push('Fakeout-risk stödjer trap-scenariot.');
  }

  const sweepQualityScore = Math.round(clamp(score, 0, 100));
  const sweepQuality = quality(sweepQualityScore);
  const liquiditySweepDetected = sweepQuality !== 'none';
  const sweepExplanationSv = liquiditySweepDetected
    ? `Liquidity sweep upptäckt: ${directionSv(sweepDirection)} (${sweepQuality}, ${sweepQualityScore}/100). ${reasons.slice(0, 3).join(' ')} Liquidity sweep är intressant men backtest visar ännu inte bättre win rate.`
    : 'Ingen tydlig liquidity sweep i senaste candles.';

  return {
    liquiditySweepDetected,
    sweepDirection,
    sweepQuality,
    trapType,
    sweepExplanationSv,
    liquiditySweepContext: {
      priorHigh: round(priorHigh, 2),
      priorLow: round(priorLow, 2),
      upperWickPct: Math.round(upperWick * 100),
      lowerWickPct: Math.round(lowerWick * 100),
      failedBreakout,
      reclaimAfterBreakdown,
      sweepQualityScore,
    },
  };
}

function applyLiquiditySweep(result) {
  try {
    const ctx = calcLiquiditySweep(result);
    const shouldWatch = ctx.liquiditySweepDetected && ['strong', 'ok'].includes(ctx.sweepQuality) && !hardBlocked(result);
    const removePositiveBacktestBoost = ctx.liquiditySweepDetected && (result.momentumBacktestAdjustment ?? 0) > 0;
    const removedAdj = removePositiveBacktestBoost ? result.momentumBacktestAdjustment : 0;
    const nextScore = removePositiveBacktestBoost
      ? clamp((result.tradeScore ?? 0) - removedAdj, 0, 100)
      : result.tradeScore;
    const backtestReason = removePositiveBacktestBoost
      ? 'Backtest-stöd: Nej. Liquidity sweep är intressant men backtest visar ännu inte bättre win rate, därför tas positiv boost bort.'
      : result.momentumBacktestReasonSv;
    const expl = [...(result.scoreExplanationSv || [])];
    if (ctx.sweepExplanationSv && !expl.includes(ctx.sweepExplanationSv)) expl.push(ctx.sweepExplanationSv);
    if (backtestReason && !expl.includes(backtestReason)) expl.push(backtestReason);
    return {
      ...result,
      ...ctx,
      tradeScore: nextScore,
      signalScore: nextScore,
      confidence: result.confidence ? {
        ...result.confidence,
        finalTradeScore: nextScore,
        label: confidenceLabel(nextScore, hardBlocked(result)),
      } : result.confidence,
      momentumBacktestApplied: removePositiveBacktestBoost ? false : result.momentumBacktestApplied,
      momentumBacktestAdjustment: removePositiveBacktestBoost ? 0 : (result.momentumBacktestAdjustment ?? 0),
      momentumBacktestReasonSv: backtestReason,
      liquiditySweepWatchMode: shouldWatch,
      watchMode: result.watchMode || shouldWatch || false,
      watchModeReasonSv: shouldWatch
        ? 'Liquidity sweep skapade endast WATCH_MODE, ingen köp/sälj-signal. Liquidity sweep är intressant men backtest visar ännu inte bättre win rate.'
        : result.watchModeReasonSv,
      scoreExplanationSv: expl,
    };
  } catch (err) {
    console.warn('[LiquiditySweep] error:', err.message);
    return result;
  }
}

module.exports = { calcLiquiditySweep, applyLiquiditySweep };
