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

  console.log('# paperTradingAgent override tests passed.');
}

main();
