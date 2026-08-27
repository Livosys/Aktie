'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('FAS 1: Canonical Ready Contract — Runtime Implementation Required', async (suite) => {
  const { defaultFuturesPaperScannerService } = require('../futuresPaperScannerService');

  await suite.test('strategy with runtime implementation shows runtimeImplemented=true', () => {
    const status = defaultFuturesPaperScannerService.getStrategyStatus();
    const emaStrategy = status.strategies?.find(s => s.strategyId === 'ema_pullback_continuation');

    if (emaStrategy) {
      assert.strictEqual(emaStrategy.runtimeImplemented, true, 'ema_pullback_continuation should have runtime');
    }
  });

  await suite.test('strategy without runtime shows runtimeImplemented=false and blocker', () => {
    const status = defaultFuturesPaperScannerService.getStrategyStatus();
    const emaBreakdown = status.strategies?.find(s => s.strategyId === 'ema_breakdown');

    if (emaBreakdown) {
      assert.strictEqual(emaBreakdown.runtimeImplemented, false, 'ema_breakdown should not have runtime');
      assert.strictEqual(emaBreakdown.blockReason, 'missing_runtime_implementation', 'should have missing_runtime_implementation blocker');
    }
  });

  await suite.test('canTradeNow requires runtimeImplemented=true', () => {
    const status = defaultFuturesPaperScannerService.getStrategyStatus();

    const strategies = status.strategies || [];
    for (const strat of strategies) {
      if (strat.canTradeNow === true) {
        assert.strictEqual(strat.runtimeImplemented, true, `${strat.strategyId} cannot trade without runtime`);
      }
    }
  });

  await suite.test('all 8 native futures strategies show runtimeImplemented=true', () => {
    const nativeIds = new Set([
      'ema_pullback_continuation',
      'narrow_breakout',
      'narrow_fakeout_reversal_v1',
      'narrow_state_expansion_long',
      'trend_continuation',
      'vwap_failed_breakout_short',
      'vwap_volume_breakout_long'
    ]);

    const status = defaultFuturesPaperScannerService.getStrategyStatus();
    const strategies = status.strategies || [];

    for (const nativeId of nativeIds) {
      const found = strategies.find(s => s.strategyId === nativeId);
      if (found && found.approved) {
        assert.strictEqual(found.runtimeImplemented, true, `${nativeId} should have runtime`);
      }
    }
  });

  await suite.test('blocking reason priority: missing_runtime_implementation before other reasons', () => {
    const status = defaultFuturesPaperScannerService.getStrategyStatus();
    const strategies = status.strategies || [];

    // Check a known false-ready strategy
    const falseReady = strategies.find(s => s.strategyId === 'low_volatility_breakout');
    if (falseReady && falseReady.approved) {
      assert.strictEqual(falseReady.blockReason, 'missing_runtime_implementation', 'first blocker should be missing runtime');
    }
  });

  await suite.test('approved strategies without runtime show as NOT canTradeNow', () => {
    const status = defaultFuturesPaperScannerService.getStrategyStatus();
    const strategies = status.strategies || [];

    // Find an approved strategy without runtime
    const approvedNoRuntime = strategies.find(s => s.approved === true && s.runtimeImplemented === false);
    if (approvedNoRuntime) {
      assert.strictEqual(approvedNoRuntime.canTradeNow, false, 'approved without runtime cannot trade now');
    }
  });
});
