'use strict';

/**
 * Regression tests for hasNativeFuturesRuntime() alias resolution
 *
 * Tests that the scanner properly resolves strategy aliases when checking
 * for native futures runtime support. This is critical for strategies like
 * narrow_state_fakeout_reversal which are known aliases for
 * narrow_fakeout_reversal_v1 in the native futures registry.
 */

const test = require('node:test');
const assert = require('node:assert');

const { defaultFuturesPaperScannerService } = require('./futuresPaperScannerService');
const nativeFuturesRegistry = require('./nativeFuturesStrategyRegistryService');

test('hasNativeFuturesRuntime: alias resolution', async (t) => {
  const statusResult = defaultFuturesPaperScannerService.getStrategyStatus();
  const strategies = statusResult.strategies || [];

  await t.test('narrow_state_fakeout_reversal (alias) resolves to native runtime', () => {
    const strategy = strategies.find(s => s.strategyId === 'narrow_state_fakeout_reversal');
    assert.ok(strategy, 'narrow_state_fakeout_reversal should appear in strategy status');
    assert.strictEqual(strategy.runtimeImplemented, true, 'alias should have runtimeImplemented=true');
    assert.strictEqual(strategy.source, 'futures_paper_allowlist', 'should be from futures paper allowlist');
    assert.ok(!strategy.blockedReason, 'alias should not be blocked (blockedReason should be falsy)');
  });

  await t.test('canonical ID also resolves', () => {
    // Both narrow_state_fakeout_reversal and narrow_fakeout_reversal_v1 map to the same native runtime
    const canonicalDescriptor = nativeFuturesRegistry.soleNativeStrategyForOrigin('narrow_fakeout_reversal_v1');
    assert.ok(canonicalDescriptor, 'canonical narrow_fakeout_reversal_v1 should have native implementation');
    assert.strictEqual(canonicalDescriptor.strategyId, 'native_futures_narrow_fakeout_reversal_v1');
  });

  await t.test('alias maps to same native implementation as canonical', () => {
    const aliasNative = nativeFuturesRegistry.soleNativeStrategyForOrigin('narrow_state_fakeout_reversal');
    const canonicalNative = nativeFuturesRegistry.soleNativeStrategyForOrigin('narrow_fakeout_reversal_v1');

    assert.ok(aliasNative, 'alias should have native implementation');
    assert.ok(canonicalNative, 'canonical should have native implementation');
    assert.strictEqual(
      aliasNative.strategyId,
      canonicalNative.strategyId,
      'alias and canonical should resolve to the same native strategy',
    );
  });

  await t.test('exactly one native runtime per strategy', () => {
    const aliasNatives = nativeFuturesRegistry.nativeStrategiesForOrigin('narrow_state_fakeout_reversal');
    assert.strictEqual(aliasNatives.length, 1, 'alias should have exactly one native implementation');

    const canonicalNatives = nativeFuturesRegistry.nativeStrategiesForOrigin('narrow_fakeout_reversal_v1');
    assert.strictEqual(canonicalNatives.length, 1, 'canonical should have exactly one native implementation');
  });

  await t.test('unknown strategy returns no runtime', () => {
    const unknown = nativeFuturesRegistry.nativeStrategiesForOrigin('unknown_strategy_xyz');
    assert.strictEqual(unknown.length, 0, 'unknown strategy should have no native implementation');
  });

  await t.test('5 enrolled futures paper strategies all have native runtime', () => {
    const enrolledIds = ['vwap_momentum_long', 'vwap_rejection_short', 'mean_reversion_vwap', 'ema_breakdown', 'narrow_state_fakeout_reversal'];
    const found = strategies.filter(s => enrolledIds.includes(s.strategyId) && s.runtimeImplemented);
    assert.strictEqual(found.length, 5, 'all 5 enrolled strategies should have native runtime');
  });

  await t.test('all 5 enrolled strategies eligible for futures paper', () => {
    const enrolledIds = ['vwap_momentum_long', 'vwap_rejection_short', 'mean_reversion_vwap', 'ema_breakdown', 'narrow_state_fakeout_reversal'];
    const found = strategies.filter(s => enrolledIds.includes(s.strategyId));

    assert.strictEqual(found.length, 5, 'all 5 should appear in status');
    for (const s of found) {
      assert.strictEqual(s.approved, true, `${s.strategyId} should be approved`);
      assert.strictEqual(s.runtimeImplemented, true, `${s.strategyId} should have runtime`);
      assert.strictEqual(s.source, 'futures_paper_allowlist', `${s.strategyId} should be from allowlist`);
    }
  });

  await t.test('no duplicate runtime ownership', () => {
    const nativeIds = new Set();
    const allNative = nativeFuturesRegistry.listNativeStrategies();

    for (const n of allNative) {
      const id = n.strategyId;
      assert.ok(!nativeIds.has(id), `duplicate native strategy ID found: ${id}`);
      nativeIds.add(id);
    }
    assert.strictEqual(nativeIds.size, allNative.length, 'no duplicate native strategy IDs');
  });
});
