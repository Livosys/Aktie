'use strict';

/**
 * Strategy Improvement Recommendation Service
 *
 * Deterministic, read-only recommendation engine for the research loop.
 * It inspects a strategy/result/score object and returns safe suggestions
 * without creating tests, strategies, broker/order paths or scheduler work.
 */

const { calculateResearchScore, scoreBand } = require('./researchScoreService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const DEFAULT_SYMBOLS = Object.freeze(['AAPL', 'MSFT', 'NVDA']);
const DEFAULT_TIMEFRAMES = Object.freeze(['15m']);
const TARGETS = Object.freeze({
  score: 70,
  strongScore: 80,
  minTrades: 30,
  highDrawdownPct: -8,
  weakProfitFactor: 1.2,
  strongProfitFactor: 1.5,
  weakWinRate: 40,
  highWinRate: 65,
  lowDataQuality: 0.7,
});

function text(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

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

function toStringArray(value, fallback = []) {
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => text(entry, ''))
      .filter(Boolean);
    return items.length ? items : fallback.slice();
  }
  const single = text(value, '');
  return single ? [single] : fallback.slice();
}

function normalizeScoreDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const components = value.components && typeof value.components === 'object' && !Array.isArray(value.components)
    ? {
        profitFactor: num(value.components.profitFactor),
        drawdown: num(value.components.drawdown),
        winRate: num(value.components.winRate),
        sampleSize: num(value.components.sampleSize),
        stability: num(value.components.stability),
        riskReward: num(value.components.riskReward),
        dataQuality: num(value.components.dataQuality),
      }
    : null;

  return {
    reasons: Array.isArray(value.reasons) ? value.reasons.map((entry) => text(entry, '')).filter(Boolean) : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.map((entry) => text(entry, '')).filter(Boolean) : [],
    components,
  };
}

function getExplicitScore(input) {
  const explicit = num(input.aiScore ?? input.score);
  if (explicit === null) return null;
  return clamp(explicit, 0, 100);
}

function getScoreContext(input) {
  const safeInput = input && typeof input === 'object' ? input : {};
  const testResult = safeInput.testResult && typeof safeInput.testResult === 'object' && !Array.isArray(safeInput.testResult)
    ? safeInput.testResult
    : null;

  const explicitScore = getExplicitScore(safeInput);
  if (explicitScore !== null) {
    const band = text(safeInput.band, '') || scoreBand(explicitScore);
    return {
      score: explicitScore,
      band,
      scoreDetails: normalizeScoreDetails(safeInput.scoreDetails),
      testResult,
      source: 'explicit',
    };
  }

  if (testResult) {
    const computed = calculateResearchScore({
      strategyId: safeInput.strategyId || safeInput.strategy_id || safeInput.id || null,
      version: safeInput.version ?? null,
      testResult,
    });
    return {
      score: computed.score,
      band: computed.band,
      scoreDetails: {
        reasons: Array.isArray(computed.reasons) ? computed.reasons.slice() : [],
        warnings: Array.isArray(computed.warnings) ? computed.warnings.slice() : [],
        components: computed.components || null,
      },
      testResult,
      source: 'computed',
    };
  }

  return {
    score: null,
    band: text(safeInput.band, '') || null,
    scoreDetails: normalizeScoreDetails(safeInput.scoreDetails),
    testResult: null,
    source: 'missing',
  };
}

function deriveWeaknesses(ctx, input = {}) {
  const weaknesses = new Set();
  const result = ctx.testResult || {};
  const trades = num(result.trades);
  const pf = num(result.profitFactor);
  const wr = normalizePercent(result.winRate);
  const dd = normalizePercent(result.maxDrawdownPct);
  const netProfitPct = normalizePercent(result.netProfitPct);
  const quality = normalizeRatio(result.dataQuality);

  if (!ctx.testResult) weaknesses.add('missing_test_result');
  if (ctx.testResult && (trades === null || trades < TARGETS.minTrades)) weaknesses.add('sample_size_too_small');
  if (ctx.testResult && quality !== null && quality < TARGETS.lowDataQuality) weaknesses.add('data_quality_low');
  if (ctx.testResult && quality === null && result.dataQuality !== undefined) weaknesses.add('data_quality_low');
  if (ctx.testResult && dd !== null && dd <= TARGETS.highDrawdownPct) weaknesses.add('drawdown_too_high');
  if (ctx.testResult && pf !== null && pf < TARGETS.weakProfitFactor) weaknesses.add('profit_factor_below_target');
  if (ctx.testResult && netProfitPct !== null && netProfitPct < 0) weaknesses.add('net_profit_negative');
  if (ctx.testResult && wr !== null && wr < TARGETS.weakWinRate) weaknesses.add('winrate_weak');

  const stabilitySymbols = normalizeRatio(result.stabilityAcrossSymbols);
  const stabilityTimeframes = normalizeRatio(result.stabilityAcrossTimeframes);
  const stabilityPeriods = normalizeRatio(result.stabilityAcrossPeriods);

  if (ctx.testResult && stabilitySymbols !== null && stabilitySymbols < 0.55) weaknesses.add('unstable_across_symbols');
  if (ctx.testResult && stabilityTimeframes !== null && stabilityTimeframes < 0.55) weaknesses.add('unstable_across_timeframes');
  if (ctx.testResult && stabilityPeriods !== null && stabilityPeriods < 0.55) weaknesses.add('unstable_across_periods');

  if (ctx.testResult && wr !== null && wr >= TARGETS.highWinRate && pf !== null && pf < 1) {
    weaknesses.add('risk_reward_weak');
  }

  if (ctx.score !== null && ctx.score < TARGETS.score) {
    weaknesses.add('score_below_target');
  }

  return Array.from(weaknesses);
}

function buildSuggestedChanges(weaknesses, ctx = {}) {
  const changes = [];
  const add = (type, name, why) => {
    changes.push({ type, name, why });
  };

  if (weaknesses.includes('drawdown_too_high')) {
    add('trend_filter', 'Rising SMA200', 'Avoid counter-trend trades and reduce drawdown.');
    add('stop_invalidation', 'Tighter invalidation', 'Exit sooner when the setup loses trend confirmation.');
    add('session_filter', 'Session filter', 'Skip weaker trading windows that tend to increase drawdown.');
  }

  if (weaknesses.includes('profit_factor_below_target')) {
    add('momentum_filter', 'RSI > 50', 'Reduce weak entries and improve trade quality.');
    add('volume_filter', 'Relative volume filter', 'Prefer entries with stronger participation.');
    add('exit_rule', 'Earlier exit on trend loss', 'Cut small winners/losers before they become larger losses.');
  }

  if (weaknesses.includes('risk_reward_weak')) {
    add('exit_rule', 'Wider upside / smaller downside balance', 'Avoid small-profit, large-loss profiles.');
    add('stop_invalidation', 'Hard invalidation', 'Limit downside when the trade thesis breaks.');
  }

  if (weaknesses.includes('sample_size_too_small')) {
    add('sample_expansion', 'Longer lookback and more symbols', 'Collect more examples before judging the setup.');
  }

  if (weaknesses.includes('data_quality_low')) {
    add('data_quality_check', 'Verify source data', 'Check missing fields, timestamps and symbol coverage before tuning the strategy.');
  }

  if (weaknesses.includes('winrate_weak') && !weaknesses.includes('risk_reward_weak')) {
    add('keep_and_validate', 'Keep current entry logic', 'The trade expectancy may still be valid even with a lower winrate.');
    add('sample_expansion', 'Broader sample validation', 'Validate the setup across more symbols and periods.');
  }

  if (ctx.score !== null && ctx.score >= TARGETS.strongScore) {
    add('keep_and_validate', 'Keep current structure', 'Validate the strong score over a broader sample before promotion.');
    add('sample_expansion', 'Broader sample validation', 'Confirm the setup over more symbols and timeframes.');
  } else if (ctx.score !== null && ctx.score >= TARGETS.score) {
    add('keep_and_validate', 'Keep current structure', 'The result is promising; validate it over a wider sample.');
    add('sample_expansion', 'Broader sample validation', 'Verify the setup across additional symbols and periods.');
  }

  const seen = new Set();
  return changes.filter((entry) => {
    const key = `${entry.type}|${entry.name}|${entry.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildNextTestPlan(input = {}, weaknesses = [], ctx = {}) {
  const symbols = toStringArray(input.symbols, DEFAULT_SYMBOLS);
  const timeframes = toStringArray(input.timeframe || input.timeframes, DEFAULT_TIMEFRAMES);
  const lookbackDays = weaknesses.includes('sample_size_too_small') ? 365 : 180;
  const reasonParts = [];

  if (weaknesses.includes('sample_size_too_small')) {
    reasonParts.push('Expand the sample before making a stronger decision.');
  }
  if (weaknesses.includes('drawdown_too_high')) {
    reasonParts.push('Validate whether trend and stop filters reduce drawdown.');
  }
  if (weaknesses.includes('profit_factor_below_target')) {
    reasonParts.push('Validate whether entry and exit filters improve profit factor.');
  }
  if (weaknesses.includes('data_quality_low')) {
    reasonParts.push('Confirm data quality before tuning the strategy.');
  }
  if (!reasonParts.length) {
    reasonParts.push('Validate the current improvement on a broader replay sample.');
  }

  if (ctx.score !== null && ctx.score >= TARGETS.score && !weaknesses.length) {
    reasonParts.push('Validate the promising result on a slightly broader sample before promotion.');
  }

  return {
    type: 'replay',
    dryRun: true,
    execution: false,
    broker: false,
    orders: false,
    symbols,
    timeframes,
    lookbackDays,
    reason: reasonParts.join(' '),
  };
}

function buildReason(weaknesses, ctx = {}) {
  if (!ctx.testResult) {
    return 'No test result is available yet. Run a replay/backtest first.';
  }

  const phrases = [];
  if (weaknesses.includes('drawdown_too_high')) phrases.push('Drawdown is too high');
  if (weaknesses.includes('profit_factor_below_target')) phrases.push('Profit factor is below target');
  if (weaknesses.includes('net_profit_negative')) phrases.push('Net profit is negative');
  if (weaknesses.includes('sample_size_too_small')) phrases.push('Sample size is too small');
  if (weaknesses.includes('data_quality_low')) phrases.push('Data quality is low');
  if (weaknesses.includes('risk_reward_weak')) phrases.push('Risk/reward profile is weak');
  if (weaknesses.includes('winrate_weak') && !phrases.length) phrases.push('Winrate is weak but the expectancy may still be valid');

  if (ctx.score !== null && ctx.score >= TARGETS.strongScore) {
    return 'Strong score. Validate over a broader sample before promotion.';
  }
  if (ctx.score !== null && ctx.score >= TARGETS.score && !phrases.length) {
    return 'Promising result. Validate over a broader sample before promotion.';
  }
  if (phrases.length) {
    return `${phrases.join(' and ')}.`;
  }
  return 'Review the result and validate the current setup with a safe replay plan.';
}

function determineActionAndPriority(weaknesses, ctx = {}) {
  const score = ctx.score;
  const hasTestResult = Boolean(ctx.testResult);
  const sampleTooSmall = weaknesses.includes('sample_size_too_small');
  const dataQualityLow = weaknesses.includes('data_quality_low');
  const drawdownHigh = weaknesses.includes('drawdown_too_high');
  const pfLow = weaknesses.includes('profit_factor_below_target');
  const netProfitNegative = weaknesses.includes('net_profit_negative');
  const winrateWeak = weaknesses.includes('winrate_weak');
  const riskRewardWeak = weaknesses.includes('risk_reward_weak');

  if (!hasTestResult) {
    return {
      recommendedAction: 'wait_for_test',
      priority: 'medium',
      blockedReason: 'missing_test_result',
      confidence: 20,
    };
  }

  if (dataQualityLow) {
    return {
      recommendedAction: 'collect_more_data',
      priority: 'medium',
      blockedReason: 'data_quality_low',
      confidence: 35,
    };
  }

  if (sampleTooSmall) {
    return {
      recommendedAction: 'collect_more_data',
      priority: 'medium',
      blockedReason: 'sample_size_too_small',
      confidence: 40,
    };
  }

  if (score !== null && score >= TARGETS.strongScore) {
    return {
      recommendedAction: 'promote_candidate',
      priority: 'low',
      blockedReason: null,
      confidence: 90,
    };
  }

  if (score !== null && score >= TARGETS.score) {
    return {
      recommendedAction: (drawdownHigh || pfLow || winrateWeak || riskRewardWeak) ? 'retest' : 'promote_candidate',
      priority: (drawdownHigh || pfLow || winrateWeak || riskRewardWeak) ? 'medium' : 'low',
      blockedReason: null,
      confidence: 78,
    };
  }

  if (winrateWeak && !riskRewardWeak && !drawdownHigh && !pfLow) {
    return {
      recommendedAction: 'retest',
      priority: 'medium',
      blockedReason: null,
      confidence: 48,
    };
  }

  if (netProfitNegative && (drawdownHigh || pfLow || riskRewardWeak || (score !== null && score < 30))) {
    return {
      recommendedAction: 'reject',
      priority: 'high',
      blockedReason: 'strategy_is_too_weak',
      confidence: 32,
    };
  }

  if (netProfitNegative) {
    return {
      recommendedAction: 'improve',
      priority: 'high',
      blockedReason: 'net_profit_negative',
      confidence: 42,
    };
  }

  if (drawdownHigh || pfLow || riskRewardWeak) {
    return {
      recommendedAction: 'improve',
      priority: 'high',
      blockedReason: null,
      confidence: 52,
    };
  }

  if (score !== null && score < 40) {
    return {
      recommendedAction: 'reject',
      priority: 'high',
      blockedReason: 'score_below_threshold',
      confidence: 28,
    };
  }

  return {
    recommendedAction: 'improve',
    priority: 'medium',
    blockedReason: null,
    confidence: 50,
  };
}

function buildImprovementRecommendation(input = {}) {
  const safeInput = input && typeof input === 'object' ? input : {};
  const ctx = getScoreContext(safeInput);
  const weaknesses = deriveWeaknesses(ctx, safeInput);
  const action = determineActionAndPriority(weaknesses, ctx);
  const reason = buildReason(weaknesses, ctx);
  const suggestedChanges = buildSuggestedChanges(weaknesses, ctx);
  const nextTestPlan = buildNextTestPlan(safeInput, weaknesses, ctx);
  const scoreDetails = ctx.scoreDetails || null;

  const confidenceBase = action.confidence;
  const completenessBonus = ctx.testResult ? 10 : -10;
  const scoreBonus = ctx.score === null ? 0 : Math.max(-10, Math.min(15, Math.round((ctx.score - 50) / 5)));
  const qualityBonus = (() => {
    const result = ctx.testResult || {};
    const quality = normalizeRatio(result.dataQuality);
    if (quality === null) return 0;
    if (quality >= 0.85) return 6;
    if (quality >= 0.7) return 4;
    if (quality >= 0.5) return -4;
    return -8;
  })();
  const stabilityBonus = (() => {
    const result = ctx.testResult || {};
    const values = [
      normalizeRatio(result.stabilityAcrossSymbols),
      normalizeRatio(result.stabilityAcrossTimeframes),
      normalizeRatio(result.stabilityAcrossPeriods),
    ].filter((value) => value !== null);
    if (!values.length) return 0;
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (avg >= 0.8) return 4;
    if (avg >= 0.65) return 2;
    if (avg >= 0.5) return -2;
    return -5;
  })();

  const confidence = Math.round(clamp(
    confidenceBase + completenessBonus + scoreBonus + qualityBonus + stabilityBonus,
    0,
    100,
  ));

  return {
    recommendedAction: action.recommendedAction,
    priority: action.priority,
    reason,
    weaknesses,
    suggestedChanges,
    nextTestPlan,
    safety: SAFETY,
    confidence,
    blockedReason: action.blockedReason || null,
    strategyId: text(safeInput.strategyId || safeInput.strategy_id || safeInput.id, null),
    name: text(safeInput.name, null),
    version: num(safeInput.version),
    status: text(safeInput.status, null),
    decision: text(safeInput.decision, null),
    aiScore: ctx.score,
    band: ctx.band || (ctx.score !== null ? scoreBand(ctx.score) : null),
    scoreDetails,
  };
}

function createStrategyImprovementRecommendationService() {
  return {
    buildImprovementRecommendation,
  };
}

const defaultStrategyImprovementRecommendationService = createStrategyImprovementRecommendationService();

module.exports = {
  DEFAULT_SYMBOLS,
  DEFAULT_TIMEFRAMES,
  SAFETY,
  TARGETS,
  buildImprovementRecommendation,
  createStrategyImprovementRecommendationService,
  defaultStrategyImprovementRecommendationService,
  _internal: {
    text,
    num,
    clamp,
    normalizePercent,
    normalizeRatio,
    toStringArray,
    normalizeScoreDetails,
    getExplicitScore,
    getScoreContext,
    deriveWeaknesses,
    buildSuggestedChanges,
    buildNextTestPlan,
    buildReason,
    determineActionAndPriority,
  },
};
