'use strict';

// `node src/services/canonical/nativeFuturesSignalFixture.test.js`
// Phase 2 fixture verification only: no scanner, no provider, no strategy,
// no execution, no broker, no files written.

const assert = require('assert');
const fixture = require('./__fixtures__/nativeFuturesSignal.mnq.long.json');
const {
  createNativeFuturesSignal,
  validateNativeFuturesSignal,
  isNativeFuturesProductionSignal,
} = require('./nativeFuturesSignalContract');

const TEST_NOW = new Date('2026-08-13T12:35:00.000Z');

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

function create(overrides = {}) {
  return createNativeFuturesSignal({
    ...fixture,
    ...overrides,
    contract: {
      ...fixture.contract,
      ...(overrides.contract || {}),
    },
    strategy: {
      ...fixture.strategy,
      ...(overrides.strategy || {}),
    },
  });
}

function validate(signal) {
  return validateNativeFuturesSignal(signal, { now: TEST_NOW });
}

function assertRejectedInput(name, overrides, expectedError) {
  test(`${name} rejected`, () => {
    const signal = create(overrides);
    const result = validate(signal);
    assert.strictEqual(result.ok, false, `${name} should be rejected`);
    assert.ok(
      result.errors.some((error) => error === expectedError || error.startsWith(expectedError)),
      `${name} did not report ${expectedError}; got ${JSON.stringify(result.errors)}`,
    );
    assert.strictEqual(isNativeFuturesProductionSignal(signal, { now: TEST_NOW }), false);
  });
}

function assertRejectedField(name, mutate, expectedError) {
  test(`${name} rejected`, () => {
    const signal = create();
    mutate(signal);
    const result = validate(signal);
    assert.strictEqual(result.ok, false, `${name} should be rejected`);
    assert.ok(
      result.errors.some((error) => error === expectedError || error.startsWith(expectedError)),
      `${name} did not report ${expectedError}; got ${JSON.stringify(result.errors)}`,
    );
    assert.strictEqual(isNativeFuturesProductionSignal(signal, { now: TEST_NOW }), false);
  });
}

console.log('nativeFuturesSignalFixture');

test('fixture is a complete MNQ LONG native futures signal', () => {
  assert.strictEqual(fixture.symbol, 'MNQ');
  assert.strictEqual(fixture.direction, 'LONG');
  assert.strictEqual(fixture.provider, 'ibkr');
  assert.strictEqual(fixture.exchange, 'CME');
  assert.strictEqual(fixture.marketType, 'futures');
  assert.strictEqual(fixture.signalSource, 'native_futures');
  assert.strictEqual(fixture.timeframe, '2m');
  assert.strictEqual(fixture.contract.secType, 'FUT');
  assert.strictEqual(fixture.contract.localSymbol, 'MNQU6');
  assert.ok(fixture.stopLoss < fixture.entryPrice);
  assert.ok(fixture.entryPrice < fixture.takeProfit);
  assert.strictEqual(fixture.riskReward, 2);
});

test('fixture passes create -> validate -> isNativeFuturesProductionSignal', () => {
  const signal = createNativeFuturesSignal(fixture);
  const result = validate(signal);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.strictEqual(isNativeFuturesProductionSignal(signal, { now: TEST_NOW }), true);
});

test('raw fixture is already contract-valid before normalization', () => {
  const result = validate(fixture);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
});

assertRejectedInput('marketType=stocks', { marketType: 'stocks' }, 'invalid_market_type:stocks');
assertRejectedInput('provider=alpaca', { provider: 'alpaca' }, 'invalid_provider:alpaca');
assertRejectedInput('exchange=NASDAQ', { exchange: 'NASDAQ', contract: { exchange: 'NASDAQ' } }, 'invalid_exchange:NASDAQ');
assertRejectedInput('symbol=AAPL', { symbol: 'AAPL', root: 'AAPL', contract: { root: 'AAPL', symbol: 'AAPL', localSymbol: 'AAPL' } }, 'unsupported_futures_symbol:AAPL');
assertRejectedInput('symbol=GOOGL', { symbol: 'GOOGL', root: 'GOOGL', contract: { root: 'GOOGL', symbol: 'GOOGL', localSymbol: 'GOOGL' } }, 'unsupported_futures_symbol:GOOGL');
assertRejectedInput('TradingOS source', { signalSource: 'TradingOS' }, 'invalid_signal_source:TradingOS');

assertRejectedField('originalMarket', (signal) => { signal.originalMarket = 'stocks'; }, 'forbidden_field:originalMarket');
assertRejectedField('originalSymbol', (signal) => { signal.originalSymbol = 'AAPL'; }, 'forbidden_field:originalSymbol');
assertRejectedField('mappingReason', (signal) => { signal.mappingReason = 'nasdaq_100_or_large_cap_proxy'; }, 'forbidden_field:mappingReason');
assertRejectedField('DecisionMonitor value', (signal) => { signal.strategy.decisionMonitor = 'DecisionMonitor'; }, 'forbidden_field:strategy.decisionMonitor');
assertRejectedField('stockFeedStatus', (signal) => { signal.stockFeedStatus = { status: 'MARKET_CLOSED' }; }, 'forbidden_field:stockFeedStatus');
assertRejectedField('proxyMapping', (signal) => { signal.strategy.proxyMapping = { from: 'GOOGL', to: 'MNQ' }; }, 'forbidden_field:strategy.proxyMapping');

console.log(`\nnativeFuturesSignalFixture: ${passed} tests ok`);
