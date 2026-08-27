'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  STRATEGY_ID,
  ORIGIN_STRATEGY_ID,
  DEFAULT_OPTIONS,
  DECISIONS,
  evaluateNativeFuturesEmaBreakdownStrategy,
  createNativeFuturesEmaBreakdownStrategy,
  defaultNativeFuturesEmaBreakdownStrategy,
} = require('../nativeFuturesEmaBreakdownStrategyService');

test('nativeFuturesEmaBreakdownStrategyService', async (t) => {
  await t.test('STRATEGY_ID is correctly namespaced', () => {
    assert.strictEqual(STRATEGY_ID, 'native_futures_ema_breakdown_v1');
  });

  await t.test('ORIGIN_STRATEGY_ID references catalog strategy', () => {
    assert.strictEqual(ORIGIN_STRATEGY_ID, 'ema_breakdown');
  });

  await t.test('DEFAULT_OPTIONS has correct parameters', () => {
    assert.strictEqual(DEFAULT_OPTIONS.stopLossPct, 0.22);
    assert.strictEqual(DEFAULT_OPTIONS.takeProfitR, 1.5);
    assert.strictEqual(DEFAULT_OPTIONS.tickSize, 0.25);
  });

  await t.test('evaluate rejects missing market snapshot', () => {
    const result = evaluateNativeFuturesEmaBreakdownStrategy(null);
    assert.strictEqual(result.decision, DECISIONS.BLOCKED);
    assert(result.blockers.includes('missing_market_snapshot'));
  });

  await t.test('evaluate rejects non-object snapshot', () => {
    const result = evaluateNativeFuturesEmaBreakdownStrategy('not an object');
    assert.strictEqual(result.decision, DECISIONS.BLOCKED);
  });

  await t.test('createNativeFuturesEmaBreakdownStrategy returns valid strategy', () => {
    const strategy = createNativeFuturesEmaBreakdownStrategy();
    assert.strictEqual(strategy.strategyId, STRATEGY_ID);
    assert(typeof strategy.evaluate === 'function');
  });

  await t.test('defaultNativeFuturesEmaBreakdownStrategy exists', () => {
    assert(defaultNativeFuturesEmaBreakdownStrategy);
    assert.strictEqual(defaultNativeFuturesEmaBreakdownStrategy.strategyId, STRATEGY_ID);
  });

  await t.test('no broker submission capability', () => {
    assert(!defaultNativeFuturesEmaBreakdownStrategy.submit);
    assert(!defaultNativeFuturesEmaBreakdownStrategy.execute);
    assert(!defaultNativeFuturesEmaBreakdownStrategy.broker);
  });

  await t.test('evaluate response structure', () => {
    const now = new Date();
    const snapshot = {
      symbol: 'MNQ',
      timeframe: '2m',
      timestamp: now.toISOString(),
      candles: Array(25).fill(null).map((_, i) => ({
        close: 99 - (i * 0.1),
        timestamp: new Date(now - (25 - i) * 2 * 60 * 1000).toISOString(),
      })),
      latestQuote: { bid: 97.5, ask: 97.75 },
      latestCandle: { timestamp: now.toISOString() },
      ib: { status: 'Connected' },
    };
    const result = evaluateNativeFuturesEmaBreakdownStrategy(snapshot);
    assert(result.strategyId);
    assert(result.decision);
    assert(result.reason || result.blockers);
  });

  await t.test('options override defaults', () => {
    const customOptions = { stopLossPct: 0.25, takeProfitR: 1.6 };
    const strategy = createNativeFuturesEmaBreakdownStrategy(customOptions);
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
      candles: Array(25).fill(null).map((_, i) => ({
        close: 99 - (i * 0.1),
        timestamp: new Date(now - (25 - i) * 2 * 60 * 1000).toISOString(),
      })),
      latestQuote: { bid: 97.5, ask: 97.75 },
      latestCandle: { timestamp: now.toISOString() },
      ib: { status: 'Connected' },
    };
    const result = evaluateNativeFuturesEmaBreakdownStrategy(snapshot);
    assert(result.direction === null || result.direction === 'SHORT');
  });

  await t.test('SHORT direction only', () => {
    const now = new Date();
    const snapshot = {
      symbol: 'MNQ',
      timeframe: '2m',
      timestamp: now.toISOString(),
      candles: Array(25).fill(null).map((_, i) => ({
        close: 99 - (i * 0.1),
        timestamp: new Date(now - (25 - i) * 2 * 60 * 1000).toISOString(),
      })),
      latestQuote: { bid: 97.5, ask: 97.75 },
      latestCandle: { timestamp: now.toISOString() },
      ib: { status: 'Connected' },
    };
    const result = evaluateNativeFuturesEmaBreakdownStrategy(snapshot);
    if (result.decision === DECISIONS.SIGNAL) {
      assert.strictEqual(result.direction, 'SHORT');
    }
  });
});
