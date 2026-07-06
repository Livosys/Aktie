'use strict';

/**
 * Research Score Service
 *
 * Deterministic score engine for AI Research Loop results. Pure calculation:
 * no file IO, no network calls, no scheduler, no broker/order/risk mutation.
 */

const COMPONENT_MAX = Object.freeze({
  profitFactor: 25,
  drawdown: 20,
  winRate: 15,
  sampleSize: 10,
  stability: 20,
  riskReward: 10,
  dataQuality: 0,
});

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  const n = num(value);
  if (n === null) return min;
  return Math.max(min, Math.min(max, n));
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function normalizePercent(value) {
  const n = num(value);
  if (n === null) return null;
  return Math.abs(n) <= 1 ? n * 100 : n;
}

function normalizeRatio(value) {
  const n = num(value);
  if (n === null) return null;
  if (n > 1) return clamp(n, 0, 100) / 100;
  return clamp(n, 0, 1);
}

function scoreBand(score) {
  const n = clamp(score, 0, 100);
  if (n >= 80) return 'strong_candidate';
  if (n >= 70) return 'promising';
  if (n >= 60) return 'watchlist';
  if (n >= 40) return 'needs_improvement';
  return 'weak';
}

function scoreProfitFactor(value) {
  const pf = num(value);
  if (pf === null || pf <= 0) return 0;
  if (pf < 1) return round(pf * 5, 1);
  if (pf < 1.25) return round(5 + ((pf - 1) / 0.25) * 5, 1);
  if (pf < 1.5) return round(10 + ((pf - 1.25) / 0.25) * 5, 1);
  if (pf < 2) return round(15 + ((pf - 1.5) / 0.5) * 7, 1);
  if (pf < 3) return round(22 + ((pf - 2) / 1) * 3, 1);
  return COMPONENT_MAX.profitFactor;
}

function scoreDrawdown(value) {
  const dd = normalizePercent(value);
  if (dd === null) return 0;
  const absDd = Math.abs(dd);
  if (absDd <= 2) return 20;
  if (absDd <= 5) return round(17 + ((5 - absDd) / 3) * 3, 1);
  if (absDd <= 10) return round(11 + ((10 - absDd) / 5) * 6, 1);
  if (absDd <= 20) return round(3 + ((20 - absDd) / 10) * 8, 1);
  if (absDd <= 35) return round(((35 - absDd) / 15) * 3, 1);
  return 0;
}

function scoreWinRate(value) {
  const wr = normalizePercent(value);
  if (wr === null) return 0;
  if (wr <= 20) return round((Math.max(wr, 0) / 20) * 2, 1);
  if (wr <= 35) return round(2 + ((wr - 20) / 15) * 4, 1);
  if (wr <= 50) return round(6 + ((wr - 35) / 15) * 5, 1);
  if (wr <= 65) return round(11 + ((wr - 50) / 15) * 3, 1);
  if (wr <= 80) return round(14 + ((wr - 65) / 15) * 1, 1);
  return COMPONENT_MAX.winRate;
}

function scoreSampleSize(value) {
  const trades = num(value);
  if (trades === null || trades <= 0) return 0;
  if (trades < 20) return round((trades / 20) * 3, 1);
  if (trades < 50) return round(3 + ((trades - 20) / 30) * 3, 1);
  if (trades < 100) return round(6 + ((trades - 50) / 50) * 2, 1);
  if (trades < 200) return round(8 + ((trades - 100) / 100) * 2, 1);
  return COMPONENT_MAX.sampleSize;
}

function scoreStability(result = {}) {
  const symbols = normalizeRatio(result.stabilityAcrossSymbols);
  const timeframes = normalizeRatio(result.stabilityAcrossTimeframes);
  const periods = normalizeRatio(result.stabilityAcrossPeriods);
  const quality = normalizeRatio(result.dataQuality);
  const provided = [symbols, timeframes, periods, quality].filter((v) => v !== null);
  if (!provided.length) return 12;

  const safeSymbols = symbols ?? 0.6;
  const safeTimeframes = timeframes ?? 0.6;
  const safePeriods = periods ?? 0.6;
  const safeQuality = quality ?? 0.7;

  return round((
    safeSymbols * 5 +
    safeTimeframes * 5 +
    safePeriods * 6 +
    safeQuality * 4
  ), 1);
}

function scoreRiskReward(result = {}) {
  const avg = normalizePercent(result.avgTradePct);
  const best = normalizePercent(result.bestTradePct);
  const worst = normalizePercent(result.worstTradePct);

  if (avg === null && best === null && worst === null) return 5;

  let score = 0;
  if (avg !== null) {
    if (avg <= -0.25) score += 0;
    else if (avg < 0) score += 1;
    else if (avg < 0.1) score += 2;
    else if (avg < 0.25) score += 3;
    else score += 4;
  } else {
    score += 2;
  }

  if (best !== null && worst !== null && worst < 0) {
    const ratio = best / Math.abs(worst);
    if (ratio >= 2) score += 4;
    else if (ratio >= 1.25) score += 3;
    else if (ratio >= 0.8) score += 2;
    else score += 1;
  } else if (best !== null && best > 0) {
    score += 3;
  } else {
    score += 2;
  }

  const pf = num(result.profitFactor);
  if (pf !== null && pf >= 1.5) score += 2;
  else if (pf !== null && pf < 1) score -= 2;
  else score += 1;

  return round(clamp(score, 0, COMPONENT_MAX.riskReward), 1);
}

function buildReasons(input, components) {
  const result = input.testResult || {};
  const reasons = [];
  const pf = num(result.profitFactor);
  const dd = normalizePercent(result.maxDrawdownPct);
  const trades = num(result.trades);
  const stability = components.stability;

  if (pf !== null && pf >= 1.75) reasons.push('Strong profit factor');
  else if (pf !== null && pf >= 1.25) reasons.push('Positive profit factor');
  if (dd !== null && Math.abs(dd) <= 5) reasons.push('Controlled drawdown');
  if (trades !== null && trades >= 50) reasons.push('Enough trades');
  if (stability >= 14) reasons.push('Stable enough across available dimensions');
  if (components.riskReward >= 7) reasons.push('Positive risk/reward profile');

  return reasons;
}

function buildWarnings(input, components) {
  const result = input.testResult || {};
  const warnings = [];
  const pf = num(result.profitFactor);
  const wr = normalizePercent(result.winRate);
  const dd = normalizePercent(result.maxDrawdownPct);
  const trades = num(result.trades);
  const quality = normalizeRatio(result.dataQuality);

  if (!result || Object.keys(result).length === 0) warnings.push('Missing test result data');
  if (pf === null) warnings.push('Profit factor missing');
  else if (pf < 1) warnings.push('Profit factor below breakeven');
  if (wr === null) warnings.push('Winrate missing');
  else if (wr < 40) warnings.push('Winrate can be improved');
  if (dd === null) warnings.push('Max drawdown missing');
  else if (Math.abs(dd) >= 15) warnings.push('Drawdown is high');
  if (trades === null) warnings.push('Trade count missing');
  else if (trades < 30) warnings.push('Sample size is small');
  if (quality !== null && quality < 0.6) warnings.push('Data quality is weak');
  if (components.stability < 10) warnings.push('Stability needs improvement');

  return warnings;
}

function calculateResearchScore(input = {}) {
  const safeInput = input && typeof input === 'object' ? input : {};
  const result = safeInput.testResult && typeof safeInput.testResult === 'object'
    ? safeInput.testResult
    : {};

  const components = {
    profitFactor: scoreProfitFactor(result.profitFactor),
    drawdown: scoreDrawdown(result.maxDrawdownPct),
    winRate: scoreWinRate(result.winRate),
    sampleSize: scoreSampleSize(result.trades),
    stability: scoreStability(result),
    riskReward: scoreRiskReward(result),
    dataQuality: normalizeRatio(result.dataQuality) === null ? null : round(normalizeRatio(result.dataQuality) * 100, 1),
  };

  const score = Math.round(clamp(
    components.profitFactor +
    components.drawdown +
    components.winRate +
    components.sampleSize +
    components.stability +
    components.riskReward,
    0,
    100,
  ));

  return {
    strategyId: safeInput.strategyId || safeInput.strategy_id || null,
    version: safeInput.version ?? null,
    score,
    band: scoreBand(score),
    reasons: buildReasons(safeInput, components),
    warnings: buildWarnings(safeInput, components),
    components,
    safety: SAFETY,
  };
}

module.exports = {
  COMPONENT_MAX,
  SAFETY,
  calculateResearchScore,
  scoreBand,
  _internal: {
    num,
    normalizePercent,
    normalizeRatio,
    scoreProfitFactor,
    scoreDrawdown,
    scoreWinRate,
    scoreSampleSize,
    scoreStability,
    scoreRiskReward,
  },
};
