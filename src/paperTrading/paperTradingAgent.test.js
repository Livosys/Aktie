'use strict';

const assert = require('assert/strict');
const agent = require('./paperTradingAgent');

function main() {
  const baseRisk = {
    allowed: false,
    block_reasons: ['consecutive_losses_limit'],
    pause_trading: true,
    pause_reasons: ['consecutive_losses_limit'],
    warnings: ['near_consecutive_losses_limit'],
  };

  const unchanged = agent._internal.applyManualRiskReviewOverride(baseRisk, false);
  assert.equal(unchanged.overrideActive, false);
  assert.deepEqual(unchanged.riskEvaluation, baseRisk);

  const overridden = agent._internal.applyManualRiskReviewOverride(baseRisk, true);
  assert.equal(overridden.overrideActive, true);
  assert.equal(overridden.riskEvaluation.allowed, true);
  assert.deepEqual(overridden.riskEvaluation.block_reasons, []);
  assert.equal(overridden.riskEvaluation.pause_trading, false);
  assert.deepEqual(overridden.riskEvaluation.pause_reasons, []);

  const mixedRisk = {
    allowed: false,
    block_reasons: ['low_confidence', 'consecutive_losses_limit'],
    pause_trading: true,
    pause_reasons: ['consecutive_losses_limit'],
    warnings: ['near_consecutive_losses_limit'],
  };

  const mixedOverride = agent._internal.applyManualRiskReviewOverride(mixedRisk, true);
  assert.equal(mixedOverride.overrideActive, true);
  assert.equal(mixedOverride.riskEvaluation.allowed, false);
  assert.deepEqual(mixedOverride.riskEvaluation.block_reasons, ['low_confidence']);
  assert.equal(mixedOverride.riskEvaluation.pause_trading, false);
  assert.deepEqual(mixedOverride.riskEvaluation.pause_reasons, []);

  const nearMiss = agent._internal.buildNearMissLearningGateDecision(
    {
      allowed: false,
      mode: 'blocked',
      gateScore: 69,
      threshold: 70,
      reasons: [],
      warnings: [],
    },
    {
      status: 'watch',
      nextMoveBias: 'UP',
      signalSubtype: 'EMA_PULLBACK_UP',
      strategyId: 'trend_continuation',
      runtimeStatus: 'enabled',
    },
    {
      nearMissLearningEnabled: true,
      nearMissLearningMargin: 5,
    },
  );
  assert.equal(nearMiss.allowed, true);
  assert.equal(nearMiss.eligible, true);
  assert.equal(nearMiss.reasonCode, 'near_miss_learning_entry');

  const trade = agent._internal.buildOpenTrade({
    symbol: 'TSLA',
    marketType: 'stocks',
    price: 100,
    status: 'watch',
    nextMoveBias: 'UP',
    signalFamily: 'EMA_TREND_PULLBACK',
    signalSubtype: 'EMA_PULLBACK_UP',
    confidenceScore: 68,
    dataFreshness: 'LIVE',
    strategyId: 'trend_continuation',
    strategyName: 'Trend Continuation',
  }, {
    ...nearMiss,
    allowed: true,
    mode: 'allow',
    nearMissLearning: true,
    marketGateNearMissOverride: true,
    originalGateScore: 69,
    originalGateThreshold: 70,
    originalGateBlockedReason: null,
    gateScore: 69,
    threshold: 70,
  });
  assert.equal(trade.nearMissLearning, true);
  assert.equal(trade.marketGateNearMissOverride, true);
  assert.equal(trade.originalGateScore, 69);
  assert.equal(trade.originalGateThreshold, 70);
  assert.equal(trade.paperOnly, true);

  console.log('# paperTradingAgent override tests passed.');
}

main();
