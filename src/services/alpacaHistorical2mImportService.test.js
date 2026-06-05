'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('./alpacaHistorical2mImportService');
const marketDataStore = require('../data/marketDataStore');

const { dedupeCandlesByTimestamp, isValidCandle, mergeStats, normalizeCandleTimestamp, shouldFallbackTo1Min } = svc._internal;

(async function run() {
  const dry = await svc.runImport(
    { from: '2024-01-01', to: '2024-01-02', symbols: ['MSFT'] },
    {
      isEnabled: () => true,
      hasCredentials: () => true,
      fetchAlpacaBars: async () => { throw new Error('dry-run must not fetch'); },
      saveCandles2m: () => { throw new Error('dry-run must not write'); },
      manifestFile: '/tmp/alpaca-dry-run-should-not-write.jsonl',
    }
  );
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.executed, false);
  assert.deepStrictEqual(dry.safety, svc.SAFETY);

  assert.strictEqual(isValidCandle({ ts: '2024-01-02T14:30:00.000Z', o: 10, h: 11, l: 9, c: 10.5, v: 100 }), true);
  assert.strictEqual(isValidCandle({ ts: '2024-01-02T14:31:00.000Z', o: 10, h: 11, l: 9, c: 10.5, v: 100 }), false);
  assert.strictEqual(isValidCandle({ ts: '2024-01-02T14:30:00.000Z', o: 10, h: 9, l: 8, c: 10.5, v: 100 }), false);
  assert.strictEqual(normalizeCandleTimestamp('2024-01-02T14:30:00Z'), '2024-01-02T14:30:00.000Z');
  assert.strictEqual(normalizeCandleTimestamp('2024-01-02T14:30:00.000Z'), '2024-01-02T14:30:00.000Z');
  assert.strictEqual(normalizeCandleTimestamp(Date.parse('2024-01-02T14:30:00.000Z')), '2024-01-02T14:30:00.000Z');
  assert.strictEqual(normalizeCandleTimestamp(Date.parse('2024-01-02T14:30:00.000Z') / 1000), '2024-01-02T14:30:00.000Z');

  const deduped = dedupeCandlesByTimestamp([
    { ts: '2024-01-02T14:30:00Z', o: 10, h: 11, l: 9, c: 10, v: 100 },
    { ts: '2024-01-02T14:30:00.000Z', o: 10, h: 11, l: 9, c: 10, v: 100 },
    { ts: Date.parse('2024-01-02T14:32:00.000Z'), o: 10, h: 11, l: 9, c: 10, v: 100 },
  ]);
  assert.strictEqual(deduped.candles.length, 2);
  assert.strictEqual(deduped.duplicateCount, 1);
  assert.deepStrictEqual(deduped.candles.map((c) => c.ts), ['2024-01-02T14:30:00.000Z', '2024-01-02T14:32:00.000Z']);

  assert.deepStrictEqual(mergeStats(10, 4, 12), { candles_written: 2, duplicates_skipped: 2 });
  assert.strictEqual(shouldFallbackTo1Min(new Error('unsupported timeframe 2Min')), true);

  const writes = [];
  const loaded = {};
  const exec = await svc.runImport(
    { execute: true, from: '2024-01-02', to: '2024-01-02', symbols: ['MSFT'] },
    {
      isEnabled: () => true,
      hasCredentials: () => true,
      manifestFile: '/tmp/alpaca-import-test-manifest.jsonl',
      fetchAlpacaBars: async () => [
        { t: '2024-01-02T14:30:00.000Z', o: 10, h: 11, l: 9, c: 10.5, v: 100 },
        { t: '2024-01-02T14:32:00.000Z', o: 10.5, h: 12, l: 10, c: 11, v: 200 },
        { t: '2024-01-02T14:33:00.000Z', o: 10.5, h: 12, l: 10, c: 11, v: 200 },
      ],
      countCandles: () => 1,
      saveCandles2m: (symbol, date, candles) => {
        writes.push({ symbol, date, candles });
        loaded[date] = candles;
      },
      loadCandles: (symbol, start) => loaded[start] || [],
    }
  );
  assert.strictEqual(exec.executed, true);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].candles.length, 2);
  assert.strictEqual(writes[0].candles[0].ts, '2024-01-02T14:30:00.000Z');
  assert.strictEqual(exec.results[0].invalid_candles_filtered, 1);

  let stored = [];
  const reimport = await svc.runImport(
    { execute: true, from: '2024-01-03', to: '2024-01-03', symbols: ['MSFT'] },
    {
      isEnabled: () => true,
      hasCredentials: () => true,
      manifestFile: '/tmp/alpaca-reimport-test-manifest.jsonl',
      fetchAlpacaBars: async () => [
        { t: '2024-01-03T14:30:00Z', o: 10, h: 11, l: 9, c: 10.5, v: 100 },
        { t: '2024-01-03T14:32:00Z', o: 10.5, h: 12, l: 10, c: 11, v: 200 },
      ],
      countCandles: () => stored.length,
      saveCandles2m: (symbol, date, candles) => {
        stored = marketDataStore._internal.dedupeByTimestamp([...stored, ...candles]);
      },
      loadCandles: () => stored,
    }
  );
  const reimportAgain = await svc.runImport(
    { execute: true, from: '2024-01-03', to: '2024-01-03', symbols: ['MSFT'] },
    {
      isEnabled: () => true,
      hasCredentials: () => true,
      manifestFile: '/tmp/alpaca-reimport-test-manifest.jsonl',
      fetchAlpacaBars: async () => [
        { t: '2024-01-03T14:30:00.000Z', o: 10, h: 11, l: 9, c: 10.5, v: 100 },
        { t: '2024-01-03T14:32:00.000Z', o: 10.5, h: 12, l: 10, c: 11, v: 200 },
      ],
      countCandles: () => stored.length,
      saveCandles2m: (symbol, date, candles) => {
        stored = marketDataStore._internal.dedupeByTimestamp([...stored, ...candles]);
      },
      loadCandles: () => stored,
    }
  );
  assert.strictEqual(reimport.results[0].candles_written, 2);
  assert.strictEqual(reimportAgain.results[0].candles_written, 0);
  assert.strictEqual(reimportAgain.results[0].duplicates_skipped, 2);

  const testSymbol = '__TEST_ALPACA_DEDUP__';
  const testDir = path.resolve(__dirname, '../../data/market-data/candles-2m', testSymbol);
  fs.rmSync(testDir, { recursive: true, force: true });
  marketDataStore.saveCandles2m(testSymbol, '2099-01-02', [
    { ts: '2099-01-02T14:30:00Z', o: 10, h: 11, l: 9, c: 10, v: 100 },
    { ts: '2099-01-02T14:30:00.000Z', o: 10, h: 11, l: 9, c: 10, v: 100 },
    { ts: 4071047520000, o: 10, h: 11, l: 9, c: 10, v: 100 },
  ]);
  const loadedFromStore = marketDataStore.loadCandles(testSymbol, '2099-01-02', '2099-01-02', '2m');
  assert.strictEqual(loadedFromStore.length, 2);
  assert.deepStrictEqual(loadedFromStore.map((c) => c.ts), ['2099-01-02T14:30:00.000Z', '2099-01-02T14:32:00.000Z']);
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log('Alpaca historical 2m import tests passed.');
}()).catch((err) => {
  console.error(err);
  process.exit(1);
});
