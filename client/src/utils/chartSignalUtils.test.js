// Enhetstester för chart-signal-normalisering och symbol-mapping.
// Kräver ingen internet- eller live-marknadsdata.
// Körs direkt: node --experimental-default-type=module client/src/utils/chartSignalUtils.test.js
import assert from 'node:assert/strict';
import { normalizeSignalForChart, mapSymbolToTradingView } from './chartSignalUtils.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL', name, '→', err.message);
  }
}

const TS = '2026-05-30T12:00:00.000Z';

test('1. NVDA → NASDAQ:NVDA, stock, markerReady', () => {
  const r = normalizeSignalForChart({ symbol: 'NVDA', timestamp: TS, price: 187.42 });
  assert.equal(r.tvSymbol, 'NASDAQ:NVDA');
  assert.equal(r.marketType, 'stock');
  assert.equal(r.markerReady, true);
  assert.equal(r.price, 187.42);
});

test('2. BTCUSDT → BINANCE:BTCUSDT, crypto, markerReady', () => {
  const r = normalizeSignalForChart({ symbol: 'BTCUSDT', timestamp: TS, price: 65000 });
  assert.equal(r.tvSymbol, 'BINANCE:BTCUSDT');
  assert.equal(r.marketType, 'crypto');
  assert.equal(r.markerReady, true);
});

test('3. Symbol med exchange behålls', () => {
  const r = normalizeSignalForChart({ symbol: 'NASDAQ:AAPL', timestamp: TS, price: 200 });
  assert.equal(r.tvSymbol, 'NASDAQ:AAPL');
  assert.equal(mapSymbolToTradingView('BINANCE:BTCUSDT').tvSymbol, 'BINANCE:BTCUSDT');
});

test('4. Price/timestamp fallback (entry_price + created_at)', () => {
  const r = normalizeSignalForChart({ symbol: 'TSLA', entry_price: 200, created_at: TS });
  assert.equal(r.price, 200);
  assert.equal(r.timestamp, TS);
  assert.equal(r.markerReady, true);
  assert.equal(r.tvSymbol, 'NASDAQ:TSLA');
});

test('5. Saknat pris → markerReady=false, reason innehåller "pris"', () => {
  const r = normalizeSignalForChart({ symbol: 'NVDA', timestamp: TS });
  assert.equal(r.markerReady, false);
  assert.ok(r.markerMissingReason.includes('pris'));
});

test('6. Saknad tid → markerReady=false, reason innehåller "tid"', () => {
  const r = normalizeSignalForChart({ symbol: 'NVDA', price: 100 });
  assert.equal(r.markerReady, false);
  assert.ok(r.markerMissingReason.includes('tid'));
});

test('7. Okänd aktie → NASDAQ:XYZ, exchange antagen', () => {
  const r = normalizeSignalForChart({ symbol: 'XYZ', timestamp: TS, price: 10 });
  assert.equal(r.tvSymbol, 'NASDAQ:XYZ');
  assert.equal(r.exchangeAssumed, true);
  assert.ok(r.exchangeAssumedText.toLowerCase().includes('antagen'));
});

test('8. USDT-par utan explicit mappning → BINANCE default', () => {
  const r = normalizeSignalForChart({ ticker: 'PEPEUSDT', time: TS, last_price: 0.0001 });
  assert.equal(r.tvSymbol, 'BINANCE:PEPEUSDT');
  assert.equal(r.marketType, 'crypto');
});

test('9. Alternativa fältnamn (instrument/side/explanation/score)', () => {
  const r = normalizeSignalForChart({ instrument: 'AMD', detected_at: TS, current_price: 150, side: 'short', explanation: 'Bryter stöd', rating: 72 });
  assert.equal(r.tvSymbol, 'NASDAQ:AMD');
  assert.equal(r.direction, 'short');
  assert.equal(r.reason, 'Bryter stöd');
  assert.equal(r.score, 72);
  assert.equal(r.markerReady, true);
});

test('10. SPY → AMEX:SPY', () => {
  assert.equal(mapSymbolToTradingView('SPY').tvSymbol, 'AMEX:SPY');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
