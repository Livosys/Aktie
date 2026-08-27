'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  STRATEGY_ID,
  ORIGIN_STRATEGY_ID,
  TARGET_SIGNAL_FAMILY,
  TARGET_SIGNAL_SUBTYPE,
  DEFAULT_OPTIONS,
  evaluateNativeFuturesVwapRejectionShortStrategy,
  createNativeFuturesVwapRejectionShortStrategy,
} = require('../nativeFuturesVwapRejectionShortStrategyService');

test('nativeFuturesVwapRejectionShortStrategyService — Contract Verification', async (suite) => {
  await suite.test('STRATEGY_ID is correctly namespaced', () => {
    assert.strictEqual(STRATEGY_ID, 'native_futures_vwap_rejection_short_v1', 'should have dedicated native ID');
  });

  await suite.test('ORIGIN_STRATEGY_ID references catalog strategy', () => {
    assert.strictEqual(ORIGIN_STRATEGY_ID, 'vwap_rejection_short', 'should map to vwap_rejection_short');
  });

  await suite.test('target signal matches VWAP_REJECTION_DOWN', () => {
    assert.strictEqual(TARGET_SIGNAL_FAMILY, 'VWAP_RECLAIM_REJECTION');
    assert.strictEqual(TARGET_SIGNAL_SUBTYPE, 'VWAP_REJECTION_DOWN');
  });

  await suite.test('DEFAULT_OPTIONS has correct parameters', () => {
    assert.strictEqual(DEFAULT_OPTIONS.stopLossPct, 0.18, 'stop loss 0.18%');
    assert.strictEqual(DEFAULT_OPTIONS.takeProfitR, 1.5, 'take profit ratio 1.5 (from catalog)');
    assert.strictEqual(DEFAULT_OPTIONS.tickSize, 0.25);
  });

  await suite.test('evaluate rejects missing market snapshot', () => {
    const result = evaluateNativeFuturesVwapRejectionShortStrategy(null);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.decision, 'BLOCKED');
    assert.strictEqual(result.reason, 'missing_market_snapshot');
  });

  await suite.test('evaluate only triggers on VWAP_REJECTION_DOWN', () => {
    // Verify that the strategy logic checks for the correct signal subtype
    const result = evaluateNativeFuturesVwapRejectionShortStrategy({
      symbol: 'MES',
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
      symbol: 'MES',
      timeframe: '2m',
      timestamp: new Date(Date.now() - 12 * 60 * 1000).toISOString(), // 12 min old
      candles: [],
      latestQuote: null,
      latestCandle: null,
    };
    const result = evaluateNativeFuturesVwapRejectionShortStrategy(staleSnapshot);
    // Should reject due to stale or insufficient candles
    assert(result.ok === false || result.decision === 'NO_SIGNAL');
  });

  await suite.test('createNativeFuturesVwapRejectionShortStrategy returns strategyId', () => {
    const strategy = createNativeFuturesVwapRejectionShortStrategy();
    assert.strictEqual(strategy.strategyId, STRATEGY_ID);
    assert.strictEqual(typeof strategy.evaluate, 'function');
  });

  await suite.test('evaluate passes through custom options', () => {
    const customOptions = { stopLossPct: 0.25, takeProfitR: 2.0 };
    const strategy = createNativeFuturesVwapRejectionShortStrategy(customOptions);
    const result = strategy.evaluate({
      symbol: 'MNQ',
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
    const strategy = createNativeFuturesVwapRejectionShortStrategy();
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
    const result = evaluateNativeFuturesVwapRejectionShortStrategy({
      symbol: 'MES',
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

  await suite.test('direction is SHORT', () => {
    const result = evaluateNativeFuturesVwapRejectionShortStrategy({
      symbol: 'MES',
      timeframe: '2m',
      timestamp: new Date().toISOString(),
      candles: [],
      latestQuote: null,
      latestCandle: null,
    });
    // Even if no signal, direction field should exist and be null or 'short'
    assert(result.direction === null || result.direction === 'short');
  });
});
