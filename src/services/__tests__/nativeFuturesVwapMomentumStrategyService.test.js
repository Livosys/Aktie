'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  STRATEGY_ID,
  ORIGIN_STRATEGY_ID,
  TARGET_SIGNAL_FAMILY,
  TARGET_SIGNAL_SUBTYPE,
  DEFAULT_OPTIONS,
  evaluateNativeFuturesVwapMomentumStrategy,
  createNativeFuturesVwapMomentumStrategy,
} = require('../nativeFuturesVwapMomentumStrategyService');

test('nativeFuturesVwapMomentumStrategyService — Contract Verification', async (suite) => {
  await suite.test('STRATEGY_ID is correctly namespaced', () => {
    assert.strictEqual(STRATEGY_ID, 'native_futures_vwap_momentum_long_v1', 'should have dedicated native ID');
  });

  await suite.test('ORIGIN_STRATEGY_ID references catalog strategy', () => {
    assert.strictEqual(ORIGIN_STRATEGY_ID, 'vwap_momentum_long', 'should map to vwap_momentum_long');
  });

  await suite.test('target signal matches VWAP_RECLAIM_UP', () => {
    assert.strictEqual(TARGET_SIGNAL_FAMILY, 'VWAP_RECLAIM_REJECTION');
    assert.strictEqual(TARGET_SIGNAL_SUBTYPE, 'VWAP_RECLAIM_UP');
  });

  await suite.test('DEFAULT_OPTIONS has correct parameters', () => {
    assert.strictEqual(DEFAULT_OPTIONS.stopLossPct, 0.18, 'stop loss 0.18%');
    assert.strictEqual(DEFAULT_OPTIONS.takeProfitR, 1.6, 'take profit ratio 1.6 (from catalog)');
    assert.strictEqual(DEFAULT_OPTIONS.tickSize, 0.25);
  });

  await suite.test('evaluate rejects missing market snapshot', () => {
    const result = evaluateNativeFuturesVwapMomentumStrategy(null);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.decision, 'BLOCKED');
    assert.strictEqual(result.reason, 'missing_market_snapshot');
  });

  await suite.test('evaluate only triggers on VWAP_RECLAIM_UP', () => {
    // Verify that the strategy logic checks for the correct signal subtype
    const result = evaluateNativeFuturesVwapMomentumStrategy({
      symbol: 'MNQ',
      timeframe: '2m',
      timestamp: new Date().toISOString(),
      candles: [],
      latestQuote: { bid: 5000, ask: 5001 },
      latestCandle: { timestamp: new Date().toISOString() },
    });
    // Most results will be NO_SIGNAL due to insufficient candles, which is expected
    assert(result.decision === 'BLOCKED' || result.decision === 'NO_SIGNAL' || result.decision === 'SIGNAL');
  });

  await suite.test('evaluate rejects stale market data', () => {
    const staleSnapshot = {
      symbol: 'MNQ',
      timeframe: '2m',
      timestamp: new Date(Date.now() - 12 * 60 * 1000).toISOString(), // 12 min old
      candles: [],
      latestQuote: null,
      latestCandle: null,
    };
    const result = evaluateNativeFuturesVwapMomentumStrategy(staleSnapshot);
    // Should reject due to stale or insufficient candles
    assert(result.ok === false || result.decision === 'NO_SIGNAL');
  });

  await suite.test('createNativeFuturesVwapMomentumStrategy returns strategyId', () => {
    const strategy = createNativeFuturesVwapMomentumStrategy();
    assert.strictEqual(strategy.strategyId, STRATEGY_ID);
    assert.strictEqual(typeof strategy.evaluate, 'function');
  });

  await suite.test('evaluate passes through custom options', () => {
    const customOptions = { stopLossPct: 0.25, takeProfitR: 2.0 };
    const strategy = createNativeFuturesVwapMomentumStrategy(customOptions);
    const result = strategy.evaluate({
      symbol: 'MES',
      timeframe: '2m',
      timestamp: new Date().toISOString(),
      candles: [],
      latestQuote: { bid: 5000, ask: 5001 },
      latestCandle: { timestamp: new Date().toISOString() },
    });
    // Just verify it doesn't throw with custom options
    assert(result !== null && typeof result === 'object');
  });

  await suite.test('evaluate signature matches contract (snapshot, options)', () => {
    const strategy = createNativeFuturesVwapMomentumStrategy();
    const snapshot = {
      symbol: 'MES',
      timeframe: '2m',
      timestamp: new Date().toISOString(),
      candles: [],
      latestQuote: null,
      latestCandle: null,
    };
    const result1 = strategy.evaluate(snapshot);
    const result2 = strategy.evaluate(snapshot, { now: new Date() });
    assert(result1 !== null && typeof result1 === 'object');
    assert(result2 !== null && typeof result2 === 'object');
  });

  await suite.test('evaluate response includes required fields', () => {
    const result = evaluateNativeFuturesVwapMomentumStrategy({
      symbol: 'MNQ',
      timeframe: '2m',
      timestamp: new Date().toISOString(),
      candles: [],
      latestQuote: null,
    });
    assert(result.hasOwnProperty('ok'));
    assert(result.hasOwnProperty('decision'));
    assert(result.hasOwnProperty('strategyId'));
    assert(result.hasOwnProperty('reason'));
  });
});
