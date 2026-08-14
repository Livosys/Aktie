'use strict';

// `node src/services/nativeFuturesScannerService.test.js`
// Phase 4 scanner tests: no strategy, no provider integration, no execution.

const assert = require('assert');
const {
  DEFAULT_SYMBOLS,
  createNativeFuturesScanner,
  defaultNativeFuturesScanner,
} = require('./nativeFuturesScannerService');

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

function candle(symbol, timestamp = '2026-08-13T12:34:00.000Z', overrides = {}) {
  return {
    symbol,
    timestamp,
    open: symbol === 'MNQ' ? 29870 : 7780,
    high: symbol === 'MNQ' ? 29885 : 7788,
    low: symbol === 'MNQ' ? 29865 : 7778,
    close: symbol === 'MNQ' ? 29880.25 : 7784,
    volume: symbol === 'MNQ' ? 1200 : 800,
    source: 'ibkr_cme_2m',
    ...overrides,
  };
}

function quote(symbol, timestamp = '2026-08-13T12:34:58.000Z', overrides = {}) {
  return {
    symbol,
    timestamp,
    bid: symbol === 'MNQ' ? 29880 : 7783.75,
    ask: symbol === 'MNQ' ? 29880.5 : 7784.25,
    last: symbol === 'MNQ' ? 29880.25 : 7784,
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

function scanner({
  symbols = ['MNQ'],
  contracts = {},
  candles = {},
  quotes = {},
  session = openSession(),
  maxCandleAgeMs = 3 * 60 * 1000,
  maxQuoteAgeMs = 15 * 1000,
} = {}) {
  return createNativeFuturesScanner({
    symbols,
    timeframe: '2m',
    maxCandleAgeMs,
    maxQuoteAgeMs,
    contractReader: ({ symbol }) => contracts[symbol] || null,
    candleReader: ({ symbol }) => candles[symbol] || [],
    quoteReader: ({ symbol }) => quotes[symbol] || null,
    sessionReader: () => session,
  });
}

function firstRow(result) {
  assert.strictEqual(result.rows.length > 0, true);
  return result.rows[0];
}

console.log('nativeFuturesScannerService');

test('default scanner monitors MNQ and MES but has no configured market data readers', () => {
  assert.deepStrictEqual(defaultNativeFuturesScanner.getMonitoredSymbols(), DEFAULT_SYMBOLS);
  const result = defaultNativeFuturesScanner.scan({ now: NOW });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.rows.length, 2);
  assert.deepStrictEqual(result.rows.map((row) => row.symbol), ['MNQ', 'MES']);
  assert.strictEqual(result.stats.invalidContracts, 2);
  assert.strictEqual(result.rows[0].latestCandle, null);
  assert.strictEqual(result.rows[0].latestQuote, null);
});

test('no market data yields explicit missing statuses without signals or candidates', () => {
  const result = scanner({
    contracts: { MNQ: contract('MNQ') },
  }).scan({ now: NOW });
  const row = firstRow(result);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(row.symbol, 'MNQ');
  assert.strictEqual(row.contractStatus, 'valid');
  assert.strictEqual(row.candleStatus, 'missing');
  assert.strictEqual(row.quoteStatus, 'missing');
  assert.strictEqual(row.status, 'missing_market_data');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'direction'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'strategyId'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'candidateId'), false);
});

test('one symbol returns contract, latest candle, latest quote, session, and timestamp', () => {
  const result = scanner({
    contracts: { MNQ: contract('MNQ') },
    candles: { MNQ: [candle('MNQ')] },
    quotes: { MNQ: quote('MNQ') },
  }).scan({ now: NOW });
  const row = firstRow(result);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(row.symbol, 'MNQ');
  assert.strictEqual(row.contract.localSymbol, 'MNQU6');
  assert.strictEqual(row.exchange, 'CME');
  assert.strictEqual(row.provider, 'ibkr');
  assert.strictEqual(row.timeframe, '2m');
  assert.strictEqual(row.latestCandle.close, 29880.25);
  assert.strictEqual(row.latestQuote.price, 29880.25);
  assert.strictEqual(row.sessionStatus, 'open');
  assert.strictEqual(row.timestamp, '2026-08-13T12:35:00.000Z');
  assert.strictEqual(row.status, 'ready');
});

test('multiple symbols return MNQ and MES market substrate', () => {
  const result = scanner({
    symbols: ['MNQ', 'MES'],
    contracts: { MNQ: contract('MNQ'), MES: contract('MES') },
    candles: { MNQ: [candle('MNQ')], MES: [candle('MES')] },
    quotes: { MNQ: quote('MNQ'), MES: quote('MES') },
  }).scan({ now: NOW });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.monitoredSymbols, ['MNQ', 'MES']);
  assert.deepStrictEqual(result.rows.map((row) => row.symbol), ['MNQ', 'MES']);
  assert.deepStrictEqual(result.stats, {
    monitoredSymbols: 2,
    ready: 2,
    invalidContracts: 0,
    missingMarketData: 0,
    staleMarketData: 0,
    closedSessions: 0,
  });
});

test('closed session is reported without creating trading decisions', () => {
  const result = scanner({
    contracts: { MNQ: contract('MNQ') },
    candles: { MNQ: [candle('MNQ')] },
    quotes: { MNQ: quote('MNQ') },
    session: closedSession(),
  }).scan({ now: NOW });
  const row = firstRow(result);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(row.sessionStatus, 'closed');
  assert.strictEqual(row.session.closedReason, 'weekend');
  assert.strictEqual(row.status, 'session_closed');
});

test('open session is reported as ready when contract and data are fresh', () => {
  const result = scanner({
    contracts: { MNQ: contract('MNQ') },
    candles: { MNQ: [candle('MNQ')] },
    quotes: { MNQ: quote('MNQ') },
    session: openSession({ sessionId: 'us_rth' }),
  }).scan({ now: NOW });
  const row = firstRow(result);
  assert.strictEqual(row.sessionStatus, 'open');
  assert.strictEqual(row.session.sessionId, 'us_rth');
  assert.strictEqual(row.status, 'ready');
});

test('old candle is marked stale', () => {
  const result = scanner({
    contracts: { MNQ: contract('MNQ') },
    candles: { MNQ: [candle('MNQ', '2026-08-13T12:20:00.000Z')] },
    quotes: { MNQ: quote('MNQ') },
  }).scan({ now: NOW });
  const row = firstRow(result);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(row.candleStatus, 'stale');
  assert.strictEqual(row.status, 'stale_market_data');
});

test('fresh candle is marked fresh', () => {
  const result = scanner({
    contracts: { MNQ: contract('MNQ') },
    candles: { MNQ: [
      candle('MNQ', '2026-08-13T12:30:00.000Z'),
      candle('MNQ', '2026-08-13T12:34:00.000Z', { close: 29881 }),
    ] },
    quotes: { MNQ: quote('MNQ') },
  }).scan({ now: NOW });
  const row = firstRow(result);
  assert.strictEqual(row.candleStatus, 'fresh');
  assert.strictEqual(row.candleAgeMs, 60 * 1000);
  assert.strictEqual(row.latestCandle.close, 29881);
  assert.strictEqual(row.status, 'ready');
});

test('closed 2m candle timestamp uses candle close time, not open time', () => {
  const result = scanner({
    contracts: { MNQ: contract('MNQ') },
    candles: { MNQ: [
      candle('MNQ', '2026-08-13T12:32:00.000Z', {
        t: '2026-08-13T12:32:00.000Z',
        timeframe: '2m',
        isClosed: true,
      }),
    ] },
    quotes: { MNQ: quote('MNQ') },
  }).scan({ now: NOW });
  const row = firstRow(result);
  assert.strictEqual(row.latestCandle.timestamp, '2026-08-13T12:34:00.000Z');
  assert.strictEqual(row.candleAgeMs, 60 * 1000);
  assert.strictEqual(row.status, 'ready');
});

test('invalid contract is rejected before market data readiness', () => {
  const result = scanner({
    contracts: {
      MNQ: contract('MNQ', {
        conId: null,
        secType: 'CONTFUT',
        exchange: 'NASDAQ',
        localSymbol: 'MNQCONT',
      }),
    },
    candles: { MNQ: [candle('MNQ')] },
    quotes: { MNQ: quote('MNQ') },
  }).scan({ now: NOW });
  const row = firstRow(result);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(row.contractStatus, 'invalid');
  assert.strictEqual(row.status, 'invalid_contract');
  assert.ok(row.contractErrors.includes('contract_conid_missing'));
  assert.ok(row.contractErrors.includes('contract_not_fut:CONTFUT'));
  assert.ok(row.contractErrors.includes('contract_wrong_exchange:NASDAQ'));
  assert.ok(row.contractErrors.includes('continuous_contract_not_orderable'));
});

console.log(`\nnativeFuturesScannerService: ${passed} tests ok`);
