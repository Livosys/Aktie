'use strict';

// `node src/services/canonical/nativeFuturesSignalContract.test.js`
// Pure contract tests: no files, no live data, no broker, no execution wiring.

const assert = require('assert');
const {
  NATIVE_FUTURES_SIGNAL_CONTRACT_VERSION,
  REQUIRED_PROVIDER,
  REQUIRED_EXCHANGE,
  REQUIRED_MARKET_TYPE,
  REQUIRED_SIGNAL_SOURCE,
  SUPPORTED_SYMBOLS,
  SUPPORTED_TIMEFRAMES,
  REQUIRED_FIELDS,
  createNativeFuturesSignal,
  validateNativeFuturesSignal,
  isNativeFuturesProductionSignal,
} = require('./nativeFuturesSignalContract');

const TEST_NOW = new Date('2026-08-13T12:00:00.000Z');

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

function baseContract(overrides = {}) {
  return {
    root: 'MNQ',
    symbol: 'MNQ',
    localSymbol: 'MNQU6',
    conId: 793356225,
    secType: 'FUT',
    exchange: 'CME',
    currency: 'USD',
    expiry: '20260918',
    lastTradeDateOrContractMonth: '20260918',
    ...overrides,
  };
}

function validInput(overrides = {}) {
  return {
    signalId: 'mnq_native_test:2026-08-13T12:00:00.000Z:LONG',
    provider: 'ibkr',
    exchange: 'CME',
    marketType: 'futures',
    signalSource: 'native_futures',
    symbol: 'MNQ',
    contract: baseContract(),
    timeframe: '1m',
    signalTimestamp: '2026-08-13T12:00:00.000Z',
    strategyId: 'mnq_globex_momentum_v1',
    strategy: {
      id: 'mnq_globex_momentum_v1',
      name: 'MNQ Globex Momentum',
      version: 'phase1-contract-test',
    },
    direction: 'LONG',
    entryPrice: 29876,
    stopLoss: 29822,
    takeProfit: 29950,
    riskReward: 1.37,
    confidence: 0.72,
    generatedAt: '2026-08-13T12:00:01.000Z',
    ...overrides,
  };
}

function validate(signal) {
  return validateNativeFuturesSignal(signal, { now: TEST_NOW });
}

console.log('nativeFuturesSignalContract');

test('createNativeFuturesSignal creates a valid MNQ native futures production signal', () => {
  const signal = createNativeFuturesSignal(validInput());
  const result = validate(signal);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.strictEqual(signal.contractVersion, NATIVE_FUTURES_SIGNAL_CONTRACT_VERSION);
  assert.strictEqual(signal.provider, REQUIRED_PROVIDER);
  assert.strictEqual(signal.exchange, REQUIRED_EXCHANGE);
  assert.strictEqual(signal.marketType, REQUIRED_MARKET_TYPE);
  assert.strictEqual(signal.signalSource, REQUIRED_SIGNAL_SOURCE);
  assert.strictEqual(signal.symbol, 'MNQ');
  assert.strictEqual(signal.contract.secType, 'FUT');
});

test('MES is supported with its own CME futures contract', () => {
  const signal = createNativeFuturesSignal(validInput({
    signalId: 'mes_native_test:2026-08-13T12:00:00.000Z:SHORT',
    symbol: 'MES',
    contract: baseContract({
      root: 'MES',
      symbol: 'MES',
      localSymbol: 'MESU6',
      conId: 724589104,
    }),
    strategyId: 'mes_globex_momentum_v1',
    strategy: { id: 'mes_globex_momentum_v1', name: 'MES Globex Momentum' },
    direction: 'SHORT',
    entryPrice: 7784,
    stopLoss: 7794,
    takeProfit: 7770,
    riskReward: 1.4,
  }));

  const result = validate(signal);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.strictEqual(signal.symbol, 'MES');
  assert.deepStrictEqual(SUPPORTED_SYMBOLS, ['MNQ', 'MES']);
});

test('all required top-level fields are enforced', () => {
  for (const field of REQUIRED_FIELDS) {
    const signal = createNativeFuturesSignal(validInput());
    signal[field] = null;
    const result = validate(signal);
    assert.strictEqual(result.ok, false, `${field} should fail`);
    assert.ok(
      result.errors.includes(`missing_required_field:${field}`),
      `${field} was not reported: ${JSON.stringify(result.errors)}`,
    );
  }
});

test('only supported futures timeframes pass the contract', () => {
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    const signal = createNativeFuturesSignal(validInput({ timeframe }));
    assert.strictEqual(validate(signal).ok, true, `${timeframe} should pass`);
  }

  const invalid = createNativeFuturesSignal(validInput({ timeframe: '1d' }));
  const result = validate(invalid);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.includes('unsupported_timeframe:1d'));
});

test('stock symbols cannot be production native futures signals', () => {
  const signal = createNativeFuturesSignal(validInput({
    symbol: 'GOOGL',
    contract: baseContract({ root: 'GOOGL', symbol: 'GOOGL', localSymbol: 'GOOGL' }),
  }));

  const result = validate(signal);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.includes('unsupported_futures_symbol:GOOGL'));
});

test('Alpaca, stock market type, and TradingOS sources are rejected', () => {
  const signal = {
    ...createNativeFuturesSignal(validInput()),
    provider: 'alpaca',
    marketType: 'stocks',
    signalSource: 'trading_os_signal_adapter',
  };

  const result = validate(signal);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.includes('invalid_provider:alpaca'));
  assert.ok(result.errors.includes('invalid_market_type:stocks'));
  assert.ok(result.errors.includes('invalid_signal_source:trading_os_signal_adapter'));
  assert.ok(result.errors.some((e) => e.includes('forbidden_legacy_value:provider:alpaca')));
  assert.ok(result.errors.some((e) => e.includes('forbidden_legacy_value:marketType:stock')));
  assert.ok(result.errors.some((e) => e.includes('forbidden_legacy_value:signalSource:trading_os')));
});

test('stock/proxy legacy fields are rejected anywhere in the signal', () => {
  const signal = {
    ...createNativeFuturesSignal(validInput()),
    originalSymbol: 'AAPL',
    mapping: {
      originalMarket: 'stocks',
      mappingReason: 'nasdaq_100_or_large_cap_proxy',
    },
  };

  const result = validate(signal);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.includes('forbidden_field:originalSymbol'));
  assert.ok(result.errors.includes('forbidden_field:mapping'));
  assert.ok(result.errors.includes('forbidden_field:mapping.originalMarket'));
  assert.ok(result.errors.includes('forbidden_field:mapping.mappingReason'));
  assert.ok(result.errors.includes('unexpected_top_level_field:originalSymbol'));
  assert.ok(result.errors.includes('unexpected_top_level_field:mapping'));
});

test('contract must be an orderable CME FUT contract for the same root', () => {
  const signal = createNativeFuturesSignal(validInput({
    contract: baseContract({
      root: 'MNQ',
      symbol: 'MNQ',
      localSymbol: 'MNQU6',
      secType: 'FUT',
      exchange: 'CME',
      currency: 'USD',
    }),
  }));

  assert.strictEqual(validate(signal).ok, true);

  const wrongExchange = createNativeFuturesSignal(validInput({ contract: baseContract({ exchange: 'NYSE' }) }));
  assert.ok(validate(wrongExchange).errors.includes('contract_wrong_exchange:NYSE'));

  const continuous = createNativeFuturesSignal(validInput({ contract: baseContract({ secType: 'CONTFUT', localSymbol: 'MNQCONT' }) }));
  const continuousErrors = validate(continuous).errors;
  assert.ok(continuousErrors.includes('contract_not_fut:CONTFUT'));
  assert.ok(continuousErrors.includes('continuous_contract_not_orderable'));

  const expired = createNativeFuturesSignal(validInput({ contract: baseContract({ expiry: '20240119', lastTradeDateOrContractMonth: '20240119' }) }));
  assert.ok(validate(expired).errors.includes('contract_expired_or_invalid'));

  const mismatch = createNativeFuturesSignal(validInput({ contract: baseContract({ root: 'MES', symbol: 'MES', localSymbol: 'MESU6' }) }));
  assert.ok(validate(mismatch).errors.some((e) => e.startsWith('contract_root_mismatch:')));
});

test('direction and risk geometry must agree', () => {
  const longBad = createNativeFuturesSignal(validInput({
    direction: 'LONG',
    entryPrice: 29876,
    stopLoss: 29900,
    takeProfit: 29950,
  }));
  assert.ok(validate(longBad).errors.includes('invalid_risk_geometry:LONG'));

  const shortBad = createNativeFuturesSignal(validInput({
    direction: 'SHORT',
    entryPrice: 29876,
    stopLoss: 29820,
    takeProfit: 29950,
  }));
  assert.ok(validate(shortBad).errors.includes('invalid_risk_geometry:SHORT'));
});

test('strategy identity is mandatory and must be internally consistent', () => {
  const missing = createNativeFuturesSignal(validInput({ strategyId: null, strategy: {} }));
  const missingErrors = validate(missing).errors;
  assert.ok(missingErrors.includes('missing_required_field:strategyId'));
  assert.ok(missingErrors.includes('missing_strategy_field:id'));

  const mismatch = createNativeFuturesSignal(validInput({
    strategyId: 'mnq_globex_momentum_v1',
    strategy: { id: 'other_strategy' },
  }));
  assert.ok(validate(mismatch).errors.includes('strategy_id_mismatch:mnq_globex_momentum_v1:other_strategy'));
});

test('isNativeFuturesProductionSignal is a strict boolean helper', () => {
  assert.strictEqual(isNativeFuturesProductionSignal(createNativeFuturesSignal(validInput()), { now: TEST_NOW }), true);
  assert.strictEqual(isNativeFuturesProductionSignal(createNativeFuturesSignal(validInput({ marketType: 'stocks' })), { now: TEST_NOW }), false);
});

console.log(`\nnativeFuturesSignalContract: ${passed} tests ok`);
