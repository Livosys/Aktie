'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  STRATEGY_ID,
  ORIGIN_STRATEGY_ID,
  DEFAULT_OPTIONS,
  DECISIONS,
  evaluateNativeFuturesMeanReversionVwapStrategy,
  createNativeFuturesMeanReversionVwapStrategy,
  defaultNativeFuturesMeanReversionVwapStrategy,
} = require('../nativeFuturesMeanReversionVwapStrategyService');

test('nativeFuturesMeanReversionVwapStrategyService', async (t) => {
  await t.test('STRATEGY_ID is correctly namespaced', () => {
    assert.strictEqual(STRATEGY_ID, 'native_futures_mean_reversion_vwap_v1');
  });

  await t.test('ORIGIN_STRATEGY_ID references catalog strategy', () => {
    assert.strictEqual(ORIGIN_STRATEGY_ID, 'mean_reversion_vwap');
  });

  await t.test('DEFAULT_OPTIONS has correct parameters', () => {
    assert.strictEqual(DEFAULT_OPTIONS.stopLossPct, 0.25);
    assert.strictEqual(DEFAULT_OPTIONS.takeProfitR, 1.3);
    assert.strictEqual(DEFAULT_OPTIONS.tickSize, 0.25);
  });

  await t.test('evaluate rejects missing market snapshot', () => {
    const result = evaluateNativeFuturesMeanReversionVwapStrategy(null);
    assert.strictEqual(result.decision, DECISIONS.BLOCKED);
    assert(result.blockers.includes('missing_market_snapshot'));
  });

  await t.test('evaluate rejects non-object snapshot', () => {
    const result = evaluateNativeFuturesMeanReversionVwapStrategy('not an object');
    assert.strictEqual(result.decision, DECISIONS.BLOCKED);
  });

  await t.test('evaluate returns consistent decision state', () => {
    const now = new Date();
    const snapshot = {
      symbol: 'MNQ',
      timeframe: '2m',
      timestamp: now.toISOString(),
      candles: Array(25).fill(null).map((_, i) => ({
        close: 100 + i,
        timestamp: new Date(now - (25 - i) * 2 * 60 * 1000).toISOString(),
      })),
      latestQuote: { bid: 125, ask: 125.25 },
      latestCandle: { timestamp: now.toISOString() },
      ib: { status: 'Connected' },
    };
    const result = evaluateNativeFuturesMeanReversionVwapStrategy(snapshot);
    assert(result.decision !== undefined);
  });

  await t.test('createNativeFuturesMeanReversionVwapStrategy returns valid strategy', () => {
    const strategy = createNativeFuturesMeanReversionVwapStrategy();
    assert.strictEqual(strategy.strategyId, STRATEGY_ID);
    assert(typeof strategy.evaluate === 'function');
  });

  await t.test('defaultNativeFuturesMeanReversionVwapStrategy exists', () => {
    assert(defaultNativeFuturesMeanReversionVwapStrategy);
    assert.strictEqual(defaultNativeFuturesMeanReversionVwapStrategy.strategyId, STRATEGY_ID);
  });

  await t.test('no broker submission capability', () => {
    assert(!defaultNativeFuturesMeanReversionVwapStrategy.submit);
    assert(!defaultNativeFuturesMeanReversionVwapStrategy.execute);
    assert(!defaultNativeFuturesMeanReversionVwapStrategy.broker);
  });

  await t.test('evaluate response structure', () => {
    const now = new Date();
    const snapshot = {
      symbol: 'MNQ',
      timeframe: '2m',
      timestamp: now.toISOString(),
      candles: Array(25).fill({ close: 100, timestamp: now.toISOString() }),
      latestQuote: { bid: 100, ask: 101 },
      latestCandle: { timestamp: now.toISOString() },
    };
    const result = evaluateNativeFuturesMeanReversionVwapStrategy(snapshot);
    assert(result.strategyId);
    assert(result.decision);
    assert(result.reason || result.blockers);
  });

  await t.test('options override defaults', () => {
    const customOptions = { stopLossPct: 0.3, takeProfitR: 1.5 };
    const strategy = createNativeFuturesMeanReversionVwapStrategy(customOptions);
    assert(strategy.strategyId);
  });

  await t.test('registry mapping by origin strategy ID', () => {
    const registry = require('../nativeFuturesStrategyRegistryService');
    const nativeStrat = registry.soleNativeStrategyForOrigin(ORIGIN_STRATEGY_ID);
    assert(nativeStrat !== null);
    assert.strictEqual(nativeStrat.strategyId, STRATEGY_ID);
    assert.strictEqual(nativeStrat.originStrategyId, ORIGIN_STRATEGY_ID);
  });

  await t.test('direction field exists in response', () => {
    const now = new Date();
    const snapshot = {
      symbol: 'MNQ',
      timeframe: '2m',
      timestamp: now.toISOString(),
      candles: Array(25).fill({ close: 100, timestamp: now.toISOString() }),
      latestQuote: { bid: 100, ask: 101 },
      latestCandle: { timestamp: now.toISOString() },
    };
    const result = evaluateNativeFuturesMeanReversionVwapStrategy(snapshot);
    assert(result.direction === null || result.direction === 'LONG' || result.direction === 'SHORT');
  });
});
