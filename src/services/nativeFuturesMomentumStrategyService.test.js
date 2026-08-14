'use strict';

// `node src/services/nativeFuturesMomentumStrategyService.test.js`
// Phase 5 strategy tests: no runtime wiring, no provider integration.

const assert = require('assert');
const fs = require('fs');
const {
  createNativeFuturesScanner,
} = require('./nativeFuturesScannerService');
const {
  DECISIONS,
  DIRECTIONS,
  STRATEGY_ID,
  STRATEGY_VERSION,
  createNativeFuturesMomentumStrategy,
  evaluateNativeFuturesMomentumStrategy,
} = require('./nativeFuturesMomentumStrategyService');

const NOW = new Date('2026-08-13T12:35:00.000Z');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n         ${err && err.stack || err}`);
    process.exitCode = 1;
  }
}

function contract(symbol, overrides = {}) {
  const upper = String(symbol).toUpperCase();
  return {
    root: upper,
    symbol: upper,
    localSymbol: `${upper}U6`,
    conId: upper === 'MNQ' ? 793356225 : 724589104,
    secType: 'FUT',
    exchange: 'CME',
    currency: 'USD',
    expiry: '20260918',
    lastTradeDateOrContractMonth: '20260918',
    ...overrides,
  };
}

function candle(symbol, overrides = {}) {
  return {
    symbol,
    timestamp: '2026-08-13T12:34:00.000Z',
    open: symbol === 'MNQ' ? 29870 : 7780,
    high: symbol === 'MNQ' ? 29890 : 7790,
    low: symbol === 'MNQ' ? 29868 : 7778,
    close: symbol === 'MNQ' ? 29886 : 7786,
    volume: symbol === 'MNQ' ? 1200 : 800,
    source: 'ibkr_cme_2m',
    ...overrides,
  };
}

function quote(symbol, overrides = {}) {
  return {
    symbol,
    timestamp: '2026-08-13T12:34:58.000Z',
    bid: symbol === 'MNQ' ? 29886 : 7785.75,
    ask: symbol === 'MNQ' ? 29886.5 : 7786.25,
    last: symbol === 'MNQ' ? 29886.25 : 7786,
    source: 'ibkr_realtime',
    ...overrides,
  };
}

function openSession(overrides = {}) {
  return {
    isOpen: true,
    isMarketOpen: true,
    session: 'Globex',
    sessionId: 'us_rth',
    sessionLabel: 'US RTH',
    exchangeTimezone: 'America/Chicago',
    closedReason: null,
    ...overrides,
  };
}

function closedSession(overrides = {}) {
  return {
    isOpen: false,
    isMarketOpen: false,
    session: 'Globex',
    sessionId: 'market_closed',
    sessionLabel: 'Market Closed',
    exchangeTimezone: 'America/Chicago',
    closedReason: 'weekend',
    ...overrides,
  };
}

function snapshotRow({
  symbol = 'MNQ',
  contractOverride = {},
  candleOverride = {},
  quoteOverride = {},
  session = openSession(),
  maxCandleAgeMs = 3 * 60 * 1000,
  maxQuoteAgeMs = 15 * 1000,
} = {}) {
  const scanner = createNativeFuturesScanner({
    symbols: [symbol],
    timeframe: '2m',
    maxCandleAgeMs,
    maxQuoteAgeMs,
    contractReader: () => contract(symbol, contractOverride),
    candleReader: () => [candle(symbol, candleOverride)],
    quoteReader: () => quote(symbol, quoteOverride),
    sessionReader: () => session,
  });
  const result = scanner.scan({ now: NOW });
  assert.strictEqual(result.rows.length, 1);
  return result.rows[0];
}

function assertPureDecision(decision) {
  for (const field of [
    'candidateId',
    'executionId',
    'intentId',
    'brokerPayload',
    'order',
    'orderId',
  ]) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, field), false);
  }
}

console.log('nativeFuturesMomentumStrategyService');

test('no setup returns NO_SIGNAL', () => {
  const decision = evaluateNativeFuturesMomentumStrategy(snapshotRow({
    candleOverride: {
      open: 29880,
      high: 29883,
      low: 29878,
      close: 29881,
    },
    quoteOverride: {
      bid: 29880.75,
      ask: 29881.25,
      last: 29881,
    },
  }), { now: NOW });

  assert.strictEqual(decision.ok, true);
  assert.strictEqual(decision.decision, DECISIONS.NO_SIGNAL);
  assert.strictEqual(decision.reason, 'momentum_threshold_not_met');
  assert.strictEqual(decision.direction, null);
  assert.strictEqual(decision.strategyId, STRATEGY_ID);
  assert.strictEqual(decision.strategyVersion, STRATEGY_VERSION);
  assertPureDecision(decision);
});

test('bullish setup returns SIGNAL LONG', () => {
  const decision = evaluateNativeFuturesMomentumStrategy(snapshotRow(), { now: NOW });

  assert.strictEqual(decision.ok, true);
  assert.strictEqual(decision.decision, DECISIONS.SIGNAL);
  assert.strictEqual(decision.direction, DIRECTIONS.LONG);
  assert.strictEqual(decision.reason, 'bullish_native_futures_momentum');
  assert.strictEqual(decision.entryPrice, 29886.25);
  assert.ok(decision.stopLoss < decision.entryPrice);
  assert.ok(decision.takeProfit > decision.entryPrice);
  assert.strictEqual(decision.riskReward, 2);
  assert.strictEqual(decision.signalTimestamp, '2026-08-13T12:34:00.000Z');
  assertPureDecision(decision);
});

test('bearish setup returns SIGNAL SHORT', () => {
  const decision = evaluateNativeFuturesMomentumStrategy(snapshotRow({
    candleOverride: {
      open: 29890,
      high: 29892,
      low: 29865,
      close: 29870,
    },
    quoteOverride: {
      bid: 29869.5,
      ask: 29870,
      last: 29869.75,
    },
  }), { now: NOW });

  assert.strictEqual(decision.ok, true);
  assert.strictEqual(decision.decision, DECISIONS.SIGNAL);
  assert.strictEqual(decision.direction, DIRECTIONS.SHORT);
  assert.strictEqual(decision.reason, 'bearish_native_futures_momentum');
  assert.strictEqual(decision.entryPrice, 29869.75);
  assert.ok(decision.takeProfit < decision.entryPrice);
  assert.ok(decision.stopLoss > decision.entryPrice);
  assert.strictEqual(decision.riskReward, 2);
  assertPureDecision(decision);
});

test('closed session returns BLOCKED', () => {
  const decision = evaluateNativeFuturesMomentumStrategy(snapshotRow({
    session: closedSession(),
  }), { now: NOW });

  assert.strictEqual(decision.ok, false);
  assert.strictEqual(decision.decision, DECISIONS.BLOCKED);
  assert.strictEqual(decision.reason, 'session_closed');
  assert.ok(decision.blockers.includes('session_closed'));
  assertPureDecision(decision);
});

test('stale candle returns BLOCKED', () => {
  const decision = evaluateNativeFuturesMomentumStrategy(snapshotRow({
    candleOverride: {
      timestamp: '2026-08-13T12:20:00.000Z',
    },
  }), { now: NOW });

  assert.strictEqual(decision.ok, false);
  assert.strictEqual(decision.decision, DECISIONS.BLOCKED);
  assert.strictEqual(decision.reason, 'stale_candle');
  assert.ok(decision.blockers.includes('stale_candle'));
  assertPureDecision(decision);
});

test('invalid quote returns BLOCKED', () => {
  const decision = evaluateNativeFuturesMomentumStrategy(snapshotRow({
    quoteOverride: {
      bid: null,
      ask: null,
      last: null,
      price: null,
    },
  }), { now: NOW });

  assert.strictEqual(decision.ok, false);
  assert.strictEqual(decision.decision, DECISIONS.BLOCKED);
  assert.strictEqual(decision.reason, 'invalid_quote');
  assert.ok(decision.blockers.includes('invalid_quote'));
  assertPureDecision(decision);
});

test('invalid contract returns BLOCKED', () => {
  const decision = evaluateNativeFuturesMomentumStrategy(snapshotRow({
    contractOverride: {
      conId: null,
      secType: 'CONTFUT',
      exchange: 'NASDAQ',
      localSymbol: 'MNQCONT',
    },
  }), { now: NOW });

  assert.strictEqual(decision.ok, false);
  assert.strictEqual(decision.decision, DECISIONS.BLOCKED);
  assert.strictEqual(decision.reason, 'invalid_contract');
  assert.ok(decision.blockers.includes('invalid_contract'));
  assertPureDecision(decision);
});

test('factory returns a reusable evaluator with the same pure output contract', () => {
  const strategy = createNativeFuturesMomentumStrategy({ minBodyPoints: 12 });
  const decision = strategy.evaluate(snapshotRow(), { now: NOW });

  assert.strictEqual(strategy.strategyId, STRATEGY_ID);
  assert.strictEqual(strategy.strategyVersion, STRATEGY_VERSION);
  assert.strictEqual(decision.decision, DECISIONS.SIGNAL);
  assert.strictEqual(decision.strategyId, STRATEGY_ID);
  assertPureDecision(decision);
});

test('strategy implementation has no legacy or runtime bridge references', () => {
  const source = fs.readFileSync(require.resolve('./nativeFuturesMomentumStrategyService'), 'utf8');
  for (const forbidden of [
    'TradingOS',
    'DecisionMonitor',
    'Stock Scanner',
    'Stock Signals',
    'Candidate',
    'Execution',
    'Broker',
    'Alpaca',
  ]) {
    assert.strictEqual(source.includes(forbidden), false, `${forbidden} must not appear in strategy source`);
  }
});

console.log(`\nnativeFuturesMomentumStrategyService: ${passed} tests ok`);
