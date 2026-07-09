'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('./databentoFuturesImportService');
const {
  calendarDatesInRange,
  dedupeCandlesByTimestamp,
  groupByDate,
  isValidCandle,
  mergeStats,
  fetchCandles2m,
} = svc._internal;

// In-memory candle store used to verify writes without touching disk.
function memStore() {
  const mem = new Map();
  const key = (s, d) => `${s}|${d}`;
  return {
    mem,
    saveCandles2m: (symbol, date, candles) => {
      const k = key(symbol, date);
      mem.set(k, (mem.get(k) || []).concat(candles));
    },
    countCandles: (symbol, date) => (mem.get(key(symbol, date)) || []).length,
    loadCandles: (symbol, start) => mem.get(key(symbol, start)) || [],
  };
}

// Fixture: 4 one-minute bars → two complete 2m candles (14:30, 14:32).
function fixture1mBars() {
  return [
    { t: '2026-07-01T14:30:00.000Z', o: 20000, h: 20010, l: 19990, c: 20005, v: 100 },
    { t: '2026-07-01T14:31:00.000Z', o: 20005, h: 20015, l: 20000, c: 20012, v: 120 },
    { t: '2026-07-01T14:32:00.000Z', o: 20012, h: 20020, l: 20008, c: 20018, v: 90 },
    { t: '2026-07-01T14:33:00.000Z', o: 20018, h: 20025, l: 20015, c: 20022, v: 110 },
  ];
}

(async function run() {
  // ── SAFETY shape ─────────────────────────────────────────────────────────────
  assert.deepStrictEqual(svc.SAFETY, {
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  });

  // ── calendarDatesInRange includes weekends (CME trades Sun–Fri) ──────────────
  // 2026-07-03 = Fri, 07-04 = Sat, 07-05 = Sun, 07-06 = Mon.
  const dates = calendarDatesInRange('2026-07-03', '2026-07-06');
  assert.deepStrictEqual(dates, ['2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06']);
  assert.deepStrictEqual(calendarDatesInRange('bad', '2026-07-06'), []);

  // ── buildPlan: disabled / missing credentials → blocking warnings, dry-run ───
  const disabledPlan = svc.buildPlan({ from: '2026-07-01', to: '2026-07-02', symbols: ['MNQ'] },
    { isEnabled: () => false, hasCredentials: () => false });
  assert.strictEqual(disabledPlan.dryRun, true);
  assert.ok(disabledPlan.warnings.includes('DATABENTO_ENABLED_not_true'));
  assert.ok(disabledPlan.warnings.includes('databento_credentials_missing'));
  assert.deepStrictEqual(disabledPlan.safety, svc.SAFETY);
  assert.strictEqual(disabledPlan.provider, 'databento');

  // enabled + creds, execute:false → dry-run with no blocking warnings
  const readyDryPlan = svc.buildPlan({ from: '2026-07-01', to: '2026-07-02', symbols: ['MNQ', 'MES'] },
    { isEnabled: () => true, hasCredentials: () => true });
  assert.strictEqual(readyDryPlan.dryRun, true);
  assert.deepStrictEqual(readyDryPlan.warnings, []);
  assert.deepStrictEqual(readyDryPlan.symbols, ['MNQ', 'MES']);

  // ── runImport dry-run must NOT fetch or write ────────────────────────────────
  const dry = await svc.runImport(
    { from: '2026-07-01', to: '2026-07-02', symbols: ['MNQ'] },
    {
      isEnabled: () => true,
      hasCredentials: () => true,
      fetchDatabentoBars: async () => { throw new Error('dry-run must not fetch'); },
      saveCandles2m: () => { throw new Error('dry-run must not write'); },
      manifestFile: path.join(os.tmpdir(), 'databento-dry-should-not-write.jsonl'),
    },
  );
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.executed, false);
  assert.deepStrictEqual(dry.safety, svc.SAFETY);

  // ── runImport with blocking warnings must NOT fetch/write even if execute:true
  const blocked = await svc.runImport(
    { execute: true, from: '2026-07-01', to: '2026-07-02', symbols: ['MNQ'] },
    {
      isEnabled: () => false, // disabled → blocking warning
      hasCredentials: () => true,
      fetchDatabentoBars: async () => { throw new Error('must not fetch when disabled'); },
      saveCandles2m: () => { throw new Error('must not write when disabled'); },
      manifestFile: path.join(os.tmpdir(), 'databento-blocked-should-not-write.jsonl'),
    },
  );
  assert.strictEqual(blocked.executed, false);
  assert.strictEqual(blocked.ok, false);

  // ── runImport execute: fetch (mocked) → aggregate 1m→2m → dedupe → write ─────
  const store = memStore();
  const manifestFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'databento-test-')), 'manifest.jsonl');
  let fetchCalls = 0;
  const exec = await svc.runImport(
    { execute: true, from: '2026-07-01', to: '2026-07-01', symbols: ['MNQ'] },
    {
      isEnabled: () => true,
      hasCredentials: () => true,
      fetchDatabentoBars: async ({ symbol }) => { fetchCalls += 1; assert.strictEqual(symbol, 'MNQ'); return fixture1mBars(); },
      saveCandles2m: store.saveCandles2m,
      countCandles: store.countCandles,
      loadCandles: store.loadCandles,
      manifestFile,
    },
  );
  assert.strictEqual(exec.executed, true);
  assert.strictEqual(exec.ok, true);
  assert.strictEqual(fetchCalls, 1);
  assert.strictEqual(exec.results.length, 1);
  const row = exec.results[0];
  assert.strictEqual(row.status, 'ok');
  assert.strictEqual(row.symbol, 'MNQ');
  // 4 one-minute bars → 2 complete 2m candles
  assert.strictEqual(store.countCandles('MNQ', '2026-07-01'), 2);
  assert.strictEqual(row.candles_written, 2);
  assert.strictEqual(row.first_timestamp, '2026-07-01T14:30:00.000Z');
  assert.strictEqual(row.last_timestamp, '2026-07-01T14:32:00.000Z');

  // manifest was appended and is valid JSONL
  const manifestLines = fs.readFileSync(manifestFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(manifestLines.length, 1);
  const manifestRow = JSON.parse(manifestLines[0]);
  assert.strictEqual(manifestRow.provider, 'databento');
  assert.strictEqual(manifestRow.symbol, 'MNQ');
  assert.deepStrictEqual(manifestRow.safety, svc.SAFETY);

  // ── fetchCandles2m aggregates and flags empty responses ──────────────────────
  const agg = await fetchCandles2m('MNQ', '2026-07-01', '2026-07-01', { fetchDatabentoBars: async () => fixture1mBars() });
  assert.strictEqual(agg.candles.length, 2);
  assert.strictEqual(agg.sourceTimeframe, 'ohlcv-1m');
  const empty = await fetchCandles2m('MNQ', '2026-07-01', '2026-07-01', { fetchDatabentoBars: async () => [] });
  assert.deepStrictEqual(empty.warnings, ['no_bars_returned']);

  // ── unit helpers ─────────────────────────────────────────────────────────────
  const { candles: deduped, duplicateCount } = dedupeCandlesByTimestamp([
    { ts: '2026-07-01T14:30:00.000Z', o: 1, h: 1, l: 1, c: 1, v: 1 },
    { ts: '2026-07-01T14:30:00.000Z', o: 2, h: 2, l: 2, c: 2, v: 2 },
    { ts: '2026-07-01T14:32:00.000Z', o: 3, h: 3, l: 3, c: 3, v: 3 },
  ]);
  assert.strictEqual(deduped.length, 2);
  assert.strictEqual(duplicateCount, 1);
  assert.strictEqual(deduped[0].o, 2); // last write wins

  const grouped = groupByDate([
    { ts: '2026-07-01T14:30:00.000Z' },
    { ts: '2026-07-01T14:32:00.000Z' },
    { ts: '2026-07-02T14:30:00.000Z' },
  ]);
  assert.deepStrictEqual(Object.keys(grouped).sort(), ['2026-07-01', '2026-07-02']);
  assert.strictEqual(grouped['2026-07-01'].length, 2);

  assert.strictEqual(isValidCandle({ ts: '2026-07-01T14:30:00.000Z', o: 10, h: 11, l: 9, c: 10.5, v: 100 }), true);
  assert.strictEqual(isValidCandle({ ts: '2026-07-01T14:31:00.000Z', o: 10, h: 11, l: 9, c: 10.5, v: 100 }), false); // odd minute
  assert.deepStrictEqual(mergeStats(0, 2, 2), { candles_written: 2, duplicates_skipped: 0 });
  assert.deepStrictEqual(mergeStats(2, 2, 2), { candles_written: 0, duplicates_skipped: 2 });

  console.log('# databentoFuturesImportService tests passed.');
}());
