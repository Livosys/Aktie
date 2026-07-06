'use strict';

const assert = require('assert/strict');

const {
  SAFETY,
  DEFAULT_SYMBOLS,
  DEFAULT_TIMEFRAMES,
  buildImprovementRecommendation,
} = require('./strategyImprovementRecommendationService');

function assertSafety(safety) {
  assert.deepEqual(safety, SAFETY);
}

{
  const result = buildImprovementRecommendation({
    strategyId: 'missing_test_result',
    name: 'Missing Test Result',
  });

  assert.equal(result.recommendedAction, 'wait_for_test');
  assert.equal(result.priority, 'medium');
  assert.equal(result.blockedReason, 'missing_test_result');
  assert.ok(result.reason.includes('No test result is available yet'));
  assert.deepEqual(result.weaknesses, ['missing_test_result']);
  assert.deepEqual(result.suggestedChanges, []);
  assert.equal(result.nextTestPlan.type, 'replay');
  assert.equal(result.nextTestPlan.dryRun, true);
  assert.equal(result.nextTestPlan.execution, false);
  assert.equal(result.nextTestPlan.broker, false);
  assert.equal(result.nextTestPlan.orders, false);
  assert.deepEqual(result.nextTestPlan.symbols, DEFAULT_SYMBOLS);
  assert.deepEqual(result.nextTestPlan.timeframes, DEFAULT_TIMEFRAMES);
  assert.equal(result.nextTestPlan.lookbackDays, 180);
  assertSafety(result.safety);
}

{
  const result = buildImprovementRecommendation({
    strategyId: 'high_drawdown',
    aiScore: 58,
    testResult: {
      profitFactor: 1.3,
      winRate: 42,
      maxDrawdownPct: -12,
      trades: 80,
      avgTradePct: 0.12,
      bestTradePct: 1.9,
      worstTradePct: -1.2,
      dataQuality: 0.9,
    },
  });

  assert.equal(result.recommendedAction, 'improve');
  assert.equal(result.priority, 'high');
  assert.equal(result.blockedReason, null);
  assert.ok(result.weaknesses.includes('drawdown_too_high'));
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'trend_filter'), true);
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'stop_invalidation'), true);
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'session_filter'), true);
  assertSafety(result.safety);
}

{
  const result = buildImprovementRecommendation({
    strategyId: 'weak_pf',
    aiScore: 47,
    testResult: {
      profitFactor: 0.9,
      winRate: 55,
      maxDrawdownPct: -4,
      trades: 70,
      avgTradePct: 0.08,
      bestTradePct: 1.2,
      worstTradePct: -1.0,
      dataQuality: 0.88,
    },
  });

  assert.equal(result.recommendedAction, 'improve');
  assert.equal(result.priority, 'high');
  assert.ok(result.weaknesses.includes('profit_factor_below_target'));
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'momentum_filter'), true);
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'volume_filter'), true);
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'exit_rule'), true);
  assertSafety(result.safety);
}

{
  const result = buildImprovementRecommendation({
    strategyId: 'high_wr_bad_pf',
    aiScore: 41,
    testResult: {
      profitFactor: 0.8,
      winRate: 80,
      maxDrawdownPct: -3,
      trades: 120,
      avgTradePct: 0.03,
      bestTradePct: 1,
      worstTradePct: -1.3,
      dataQuality: 0.82,
    },
  });

  assert.equal(result.recommendedAction, 'improve');
  assert.ok(result.weaknesses.includes('risk_reward_weak'));
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'exit_rule'), true);
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'stop_invalidation'), true);
  assert.equal(result.reason.includes('Risk/reward profile is weak'), true);
  assertSafety(result.safety);
}

{
  const result = buildImprovementRecommendation({
    strategyId: 'low_wr_good_pf',
    aiScore: 64,
    testResult: {
      profitFactor: 1.8,
      winRate: 35,
      maxDrawdownPct: -2.5,
      trades: 90,
      avgTradePct: 0.17,
      bestTradePct: 2.2,
      worstTradePct: -0.7,
      dataQuality: 0.9,
    },
  });

  assert.notEqual(result.recommendedAction, 'reject');
  assert.equal(result.recommendedAction, 'retest');
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'keep_and_validate'), true);
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'sample_expansion'), true);
  assert.equal(result.weaknesses.includes('winrate_weak'), true);
  assertSafety(result.safety);
}

{
  const result = buildImprovementRecommendation({
    strategyId: 'strong_candidate',
    aiScore: 82,
    testResult: {
      profitFactor: 2.1,
      winRate: 57,
      maxDrawdownPct: -2,
      trades: 140,
      avgTradePct: 0.22,
      bestTradePct: 2.8,
      worstTradePct: -0.8,
      dataQuality: 0.91,
    },
  });

  assert.equal(result.recommendedAction, 'promote_candidate');
  assert.equal(result.priority, 'low');
  assert.ok(result.reason.includes('Strong score'));
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'keep_and_validate'), true);
  assertSafety(result.safety);
}

{
  const result = buildImprovementRecommendation({
    strategyId: 'few_trades',
    testResult: {
      profitFactor: 1.5,
      winRate: 48,
      maxDrawdownPct: -3,
      trades: 10,
      avgTradePct: 0.1,
      bestTradePct: 1.1,
      worstTradePct: -0.6,
      dataQuality: 0.84,
    },
  });

  assert.equal(result.recommendedAction, 'collect_more_data');
  assert.equal(result.blockedReason, 'sample_size_too_small');
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'sample_expansion'), true);
  assert.equal(result.nextTestPlan.lookbackDays, 365);
  assert.equal(result.nextTestPlan.reason.includes('Expand the sample'), true);
  assertSafety(result.safety);
}

{
  const result = buildImprovementRecommendation({
    strategyId: 'low_quality',
    testResult: {
      profitFactor: 1.4,
      winRate: 52,
      maxDrawdownPct: -4,
      trades: 60,
      avgTradePct: 0.12,
      bestTradePct: 1.3,
      worstTradePct: -0.9,
      dataQuality: 0.4,
    },
  });

  assert.equal(result.recommendedAction, 'collect_more_data');
  assert.equal(result.blockedReason, 'data_quality_low');
  assert.equal(result.suggestedChanges.some((entry) => entry.type === 'data_quality_check'), true);
  assertSafety(result.safety);
}

console.log('strategyImprovementRecommendationService.test.js: OK');
