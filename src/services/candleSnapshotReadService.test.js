'use strict';

// Read-only test for candleSnapshotReadService. Writes ONLY to an isolated
// os.tmpdir() fixture, never to repo data. Run: node <thisfile>

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const svc = require('./candleSnapshotReadService');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err.message}`); process.exitCode = 1; }
}

// ---- build a throwaway candle store fixture ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candle-read-'));
function writeDay(day, rows) {
  const dir = path.join(root, day);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'candles-1m.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const base = Date.parse('2026-06-29T14:00:00.000Z');
writeDay('2026-06-29', [
  { symbol: 'TSLA', candleTime: new Date(base).toISOString(), open: 100, high: 101, low: 99.5, close: 100.5 },
  { symbol: 'TSLA', candleTime: new Date(base + 60000).toISOString(), open: 100.5, high: 100.6, low: 99, close: 99.2 },
  // duplicate candle (same symbol|candleTime) must be deduped
  { symbol: 'TSLA', candleTime: new Date(base).toISOString(), open: 100, high: 101, low: 99.5, close: 100.5 },
  { symbol: 'SOLUSDT', candleTime: new Date(base).toISOString(), open: 10, high: 10.1, low: 9.9, close: 10.05 },
  // malformed row (missing close) must be skipped
  { symbol: 'TSLA', candleTime: new Date(base + 120000).toISOString(), open: 99, high: 99, low: 98 },
]);

check('SAFETY is paper-only read-only', () => {
  assert.strictEqual(svc.SAFETY.read_only, true);
  assert.strictEqual(svc.SAFETY.can_place_orders, false);
  assert.strictEqual(svc.SAFETY.live_trading_enabled, false);
});

check('loadSeries dedupes, skips malformed, sorts ascending', () => {
  const { bySymbol } = svc.loadSeries({ storageRoot: root });
  const tsla = bySymbol.get('TSLA');
  assert.ok(tsla, 'TSLA series present');
  assert.strictEqual(tsla.length, 2, 'deduped to 2 valid candles (malformed skipped)');
  assert.ok(tsla[0].t < tsla[1].t, 'sorted ascending');
  assert.strictEqual(bySymbol.get('SOLUSDT').length, 1);
});

check('symbol filter restricts output', () => {
  const { bySymbol } = svc.loadSeries({ storageRoot: root, symbols: ['SOLUSDT'] });
  assert.ok(!bySymbol.has('TSLA'));
  assert.ok(bySymbol.has('SOLUSDT'));
});

check('coverageSpan reports first/last', () => {
  const { bySymbol } = svc.loadSeries({ storageRoot: root });
  const span = svc.coverageSpan(bySymbol);
  assert.strictEqual(span.firstMs, base);
  assert.strictEqual(span.lastMs, base + 60000);
});

check('sliceSeries returns in-window candles by minute', () => {
  const { bySymbol } = svc.loadSeries({ storageRoot: root });
  const slice = svc.sliceSeries(bySymbol.get('TSLA'), base, base + 60000);
  assert.strictEqual(slice.length, 2);
  const none = svc.sliceSeries(bySymbol.get('TSLA'), base + 10 * 60000, base + 20 * 60000);
  assert.strictEqual(none.length, 0);
});

check('missing storage root yields empty series, no throw', () => {
  const { bySymbol, days } = svc.loadSeries({ storageRoot: path.join(root, 'does-not-exist') });
  assert.strictEqual(bySymbol.size, 0);
  assert.strictEqual(days.length, 0);
});

// cleanup fixture
try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }

console.log(`\ncandleSnapshotReadService: ${passed} checks passed`);
