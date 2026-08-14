'use strict';

// `node src/services/canonical/nativeFuturesSignalProvider.test.js`
// Phase 3 provider tests: no scanner, no strategy, no execution, no broker.

const assert = require('assert');
const fixture = require('./__fixtures__/nativeFuturesSignal.mnq.long.json');
const { createNativeFuturesSignal } = require('./nativeFuturesSignalContract');
const {
  createNativeFuturesSignalProvider,
  defaultNativeFuturesSignalProvider,
} = require('./nativeFuturesSignalProvider');

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

function mnqSignal(overrides = {}) {
  return {
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
  };
}

function mesSignal() {
  return mnqSignal({
    signalId: 'mes_native_provider:2026-08-13T12:34:00.000Z:SHORT',
    symbol: 'MES',
    root: 'MES',
    contract: {
      root: 'MES',
      symbol: 'MES',
      localSymbol: 'MESU6',
      conId: 724589104,
    },
    strategyId: 'mes_native_provider_strategy_v1',
    strategy: {
      id: 'mes_native_provider_strategy_v1',
      name: 'MES Native Provider Strategy',
      version: 'phase3-provider-test',
    },
    direction: 'SHORT',
    entryPrice: 7784,
    stopLoss: 7794,
    takeProfit: 7770,
    riskReward: 1.4,
  });
}

function providerWith(signals) {
  return createNativeFuturesSignalProvider({ signals });
}

function collect(signals) {
  return providerWith(signals).collectNativeFuturesSignals({ now: TEST_NOW });
}

function assertRejected(name, signal, expectedError) {
  test(`${name} rejected`, () => {
    const result = collect([signal]);
    assert.strictEqual(result.signals.length, 0);
    assert.strictEqual(result.rejected.length, 1);
    assert.strictEqual(result.stats.acceptedSignals, 0);
    assert.strictEqual(result.stats.rejectedSignals, 1);
    assert.ok(
      result.rejected[0].errors.some((error) => error === expectedError || error.startsWith(expectedError)),
      `${name} did not report ${expectedError}; got ${JSON.stringify(result.rejected[0].errors)}`,
    );
    assert.deepStrictEqual(providerWith([signal]).getNativeFuturesSignals({ now: TEST_NOW }), []);
  });
}

console.log('nativeFuturesSignalProvider');

test('default provider returns an empty list', () => {
  const signals = defaultNativeFuturesSignalProvider.getNativeFuturesSignals({ now: TEST_NOW });
  const result = defaultNativeFuturesSignalProvider.collectNativeFuturesSignals({ now: TEST_NOW });
  assert.deepStrictEqual(signals, []);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.signals, []);
  assert.deepStrictEqual(result.rejected, []);
  assert.deepStrictEqual(result.stats, { inputSignals: 0, acceptedSignals: 0, rejectedSignals: 0 });
});

test('provider accepts one valid native futures signal', () => {
  const result = collect([fixture]);
  assert.strictEqual(result.ok, true, JSON.stringify(result.rejected));
  assert.strictEqual(result.signals.length, 1);
  assert.strictEqual(result.rejected.length, 0);
  assert.strictEqual(result.signals[0].symbol, 'MNQ');
  assert.strictEqual(result.signals[0].provider, 'ibkr');
  assert.strictEqual(result.signals[0].marketType, 'futures');
  assert.strictEqual(result.signals[0].signalSource, 'native_futures');
});

test('getNativeFuturesSignals returns only the accepted signal array', () => {
  const provider = providerWith([fixture]);
  const signals = provider.getNativeFuturesSignals({ now: TEST_NOW });
  assert.strictEqual(Array.isArray(signals), true);
  assert.strictEqual(signals.length, 1);
  assert.strictEqual(signals[0].signalId, fixture.signalId);
});

test('provider accepts multiple valid native futures signals', () => {
  const result = collect([fixture, mesSignal()]);
  assert.strictEqual(result.ok, true, JSON.stringify(result.rejected));
  assert.strictEqual(result.signals.length, 2);
  assert.deepStrictEqual(result.signals.map((row) => row.symbol), ['MNQ', 'MES']);
  assert.deepStrictEqual(result.stats, { inputSignals: 2, acceptedSignals: 2, rejectedSignals: 0 });
});

test('provider rejects bad rows but keeps valid native futures rows', () => {
  const result = collect([fixture, mnqSignal({ marketType: 'stocks' }), mesSignal()]);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.signals.length, 2);
  assert.strictEqual(result.rejected.length, 1);
  assert.deepStrictEqual(result.signals.map((row) => row.symbol), ['MNQ', 'MES']);
  assert.ok(result.rejected[0].errors.includes('invalid_market_type:stocks'));
});

test('provider can read signals from an injected signalReader', () => {
  const provider = createNativeFuturesSignalProvider({
    signalReader: () => ({ signals: [fixture] }),
  });
  const result = provider.collectNativeFuturesSignals({ now: TEST_NOW });
  assert.strictEqual(result.ok, true, JSON.stringify(result.rejected));
  assert.strictEqual(result.signals.length, 1);
});

test('default provider can create a native signal from scanner market data', () => {
  const priceFeedService = {
    getCandles: (symbol) => {
      if (symbol !== 'MNQ') return { candles: [], contract: null };
      return {
        candles: [{
          symbol: 'MNQ',
          timestamp: '2026-08-13T12:34:00.000Z',
          open: 29870,
          high: 29890,
          low: 29868,
          close: 29886,
          volume: 1200,
          source: 'ib_historical',
        }],
        contract: {
          root: 'MNQ',
          symbol: 'MNQ',
          localSymbol: 'MNQU6',
          conId: 793356225,
          secType: 'FUT',
          exchange: 'CME',
          currency: 'USD',
          expiry: '20260918',
          lastTradeDateOrContractMonth: '20260918',
        },
      };
    },
    getQuote: (symbol) => {
      if (symbol !== 'MNQ') return null;
      return {
        root: 'MNQ',
        symbol: 'MNQ',
        timestamp: '2026-08-13T12:34:58.000Z',
        bid: 29886,
        ask: 29886.5,
        last: 29886.25,
        source: 'ibkr_realtime',
      };
    },
  };

  const result = defaultNativeFuturesSignalProvider.collectNativeFuturesSignals({
    now: TEST_NOW,
    priceFeedService,
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result.rejected));
  assert.strictEqual(result.signals.length, 1);
  assert.strictEqual(result.signals[0].signalSource, 'native_futures');
  assert.strictEqual(result.signals[0].provider, 'ibkr');
  assert.strictEqual(result.signals[0].exchange, 'CME');
  assert.strictEqual(result.signals[0].symbol, 'MNQ');
  assert.strictEqual(result.signals[0].strategyId, 'native_futures_momentum_v1');
});

test('provider reports signal reader errors without throwing', () => {
  const provider = createNativeFuturesSignalProvider({
    signalReader: () => { throw new Error('reader_failed'); },
  });
  const result = provider.collectNativeFuturesSignals({ now: TEST_NOW });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.signals.length, 0);
  assert.strictEqual(result.rejected[0].reason, 'signal_reader_error');
  assert.deepStrictEqual(provider.getNativeFuturesSignals({ now: TEST_NOW }), []);
});

assertRejected('wrong marketType=stocks', mnqSignal({ marketType: 'stocks' }), 'invalid_market_type:stocks');
assertRejected('wrong marketType=crypto', mnqSignal({ marketType: 'crypto' }), 'invalid_market_type:crypto');
assertRejected('wrong provider=alpaca', mnqSignal({ provider: 'alpaca' }), 'invalid_provider:alpaca');
assertRejected('wrong exchange=NASDAQ', mnqSignal({ exchange: 'NASDAQ', contract: { exchange: 'NASDAQ' } }), 'invalid_exchange:NASDAQ');
assertRejected('wrong symbol=AAPL', mnqSignal({ symbol: 'AAPL', root: 'AAPL', contract: { root: 'AAPL', symbol: 'AAPL', localSymbol: 'AAPL' } }), 'unsupported_futures_symbol:AAPL');
assertRejected('wrong symbol=GOOGL', mnqSignal({ symbol: 'GOOGL', root: 'GOOGL', contract: { root: 'GOOGL', symbol: 'GOOGL', localSymbol: 'GOOGL' } }), 'unsupported_futures_symbol:GOOGL');

assertRejected('stock proxy signal', {
  ...mnqSignal(),
  originalSymbol: 'GOOGL',
  originalMarket: 'stocks',
  mappingReason: 'nasdaq_100_or_large_cap_proxy',
  proxyMapping: { from: 'GOOGL', to: 'MNQ' },
}, 'forbidden_field:originalSymbol');

assertRejected('TradingOS signal', {
  ...mnqSignal(),
  signalSource: 'trading_os_signal_adapter',
}, 'invalid_signal_source:trading_os_signal_adapter');

assertRejected('DecisionMonitor signal', {
  ...mnqSignal(),
  decisionMonitor: { source: 'DecisionMonitor' },
}, 'forbidden_field:decisionMonitor');

assertRejected('legacy canonical signal', {
  ...createNativeFuturesSignal(mnqSignal()),
  canonicalVersion: 'canonical-signal-v1',
  producerType: 'tradingos_decision_monitor',
}, 'unexpected_top_level_field:canonicalVersion');

console.log(`\nnativeFuturesSignalProvider: ${passed} tests ok`);
