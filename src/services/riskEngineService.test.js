'use strict';

const assert = require('assert/strict');

const riskEngineService = require('./riskEngineService');

const baseSignal = {
  symbol: 'QQQ',
  direction: 'LONG',
  price: 500,
  stop_loss_pct: 0.5,
  target_pct: 1,
  confidence: 90,
  spread_pct: 0.01,
  liquidity_score: 90,
  volatility_score: 20,
};

const consecutiveLossAccount = {
  daily_pnl_pct: 0,
  daily_trades: 0,
  consecutive_losses: riskEngineService.DEFAULT_RISK_CONFIG.max_consecutive_losses,
};

async function main() {
  assert.equal(
    riskEngineService.DEFAULT_RISK_CONFIG.pause_after_consecutive_losses,
    true,
    'default consecutive-loss pause stays enabled',
  );

  const defaultPause = riskEngineService.shouldPauseTrading(consecutiveLossAccount);
  assert.equal(defaultPause.pause, true, 'default pause decision still blocks after max consecutive losses');
  assert.deepEqual(defaultPause.reasons, ['consecutive_losses_limit']);

  const defaultEvaluation = await riskEngineService.evaluateTradeRisk(baseSignal, consecutiveLossAccount, { persist: false });
  assert.equal(defaultEvaluation.allowed, false, 'default risk evaluation still blocks after max consecutive losses');
  assert.equal(defaultEvaluation.pause_trading, true);
  assert.ok(defaultEvaluation.block_reasons.includes('consecutive_losses_limit'));
  assert.ok(defaultEvaluation.pause_reasons.includes('consecutive_losses_limit'));
  assert.ok(defaultEvaluation.warnings.includes('near_consecutive_losses_limit'));

  const explicitOffConfig = {
    ...riskEngineService.DEFAULT_RISK_CONFIG,
    pause_after_consecutive_losses: false,
  };
  const explicitOffPause = riskEngineService.shouldPauseTrading(consecutiveLossAccount, explicitOffConfig);
  assert.equal(explicitOffPause.pause, false, 'explicit false disables only consecutive-loss pause');
  assert.deepEqual(explicitOffPause.reasons, []);

  const explicitOffEvaluation = await riskEngineService.evaluateTradeRisk(baseSignal, {
    ...consecutiveLossAccount,
    _riskConfig: explicitOffConfig,
  }, { persist: false });
  assert.equal(explicitOffEvaluation.allowed, true, 'explicit false lets otherwise clean signal pass');
  assert.equal(explicitOffEvaluation.pause_trading, false);
  assert.equal(explicitOffEvaluation.block_reasons.includes('consecutive_losses_limit'), false);
  assert.equal(explicitOffEvaluation.pause_reasons.includes('consecutive_losses_limit'), false);
  assert.equal(explicitOffEvaluation.warnings.includes('near_consecutive_losses_limit'), false);

  const dailyLossStillBlocks = await riskEngineService.evaluateTradeRisk(baseSignal, {
    ...consecutiveLossAccount,
    daily_pnl_pct: -riskEngineService.DEFAULT_RISK_CONFIG.max_daily_loss_pct,
    _riskConfig: explicitOffConfig,
  }, { persist: false });
  assert.equal(dailyLossStillBlocks.allowed, false, 'other gates remain active when consecutive-loss pause is off');
  assert.ok(dailyLossStillBlocks.block_reasons.includes('daily_loss_limit'));
  assert.ok(dailyLossStillBlocks.pause_reasons.includes('daily_loss_limit'));

  console.log('riskEngineService.test.js passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
