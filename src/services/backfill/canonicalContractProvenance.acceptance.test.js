'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const provenance = require('./canonicalContractProvenanceService');
const planner = require('./ibHistoricalBackfillPlanner');
const store = require('../../data/marketDataStore');
const { createHistoricalPriceFeedService } = require('../historicalPriceFeedService');
const { createFuturesMarketDataService } = require('../futuresMarketDataService');

const keyA = provenance.canonicalContractKey('MNQ', {
  conId: '730283094', localSymbol: 'MNQZ5', expiry: '2025-12-19',
});
const keyB = provenance.canonicalContractKey('MNQ', {
  conId: '750150193', localSymbol: 'MNQH6', expiry: '2026-03-20',
});
assert.equal(keyA, 'MNQ:730283094:2025-12-19');
assert.notEqual(keyA, keyB);

const ready = provenance.gateBackfill({
  root: 'MNQ', conId: '730283094', localSymbol: 'MNQZ5', expiry: '2025-12-19',
  activeFrom: '2025-12-01', activeTo: '2025-12-18',
  readiness: provenance.READINESS.BACKFILL_READY,
  provenanceSource: 'IBKR_CONTRACT_DETAILS_AND_HISTORICAL_PROBE',
});
assert.equal(ready.ok, true);
assert.equal(provenance.gateBackfill({ root: 'MNQ', localSymbol: 'MNQZ5' }).ok, false);
assert.equal(provenance.classifyProbe({ timestampComplete: true, volumeComplete: true, bars: 10 }), provenance.READINESS.HISTORICAL_USABLE);
assert.equal(provenance.classifyProbe({ timestampComplete: true, volumeComplete: false, bars: 10 }), provenance.READINESS.HISTORICAL_DEGRADED);
assert.equal(provenance.provenanceQuality({ ts: '2099-01-02T17:00:00.000Z' }), provenance.PROVENANCE.MANIFEST_ONLY);
const ambiguousPlan = planner.buildPlan({
  symbols: ['MNQ'], from: '2026-08-17', to: '2026-08-17', now: '2026-08-19',
  contractsBySymbol: { MNQ: [
    { root: 'MNQ', conId: '1', localSymbol: 'MNQZ6', expiry: '2026-12-18', activeFrom: '2026-08-01', activeTo: '2026-08-31', readiness: provenance.READINESS.BACKFILL_READY, provenanceSource: 'fixture' },
    { root: 'MNQ', conId: '2', localSymbol: 'MNQH7', expiry: '2027-03-19', activeFrom: '2026-08-01', activeTo: '2026-08-31', readiness: provenance.READINESS.BACKFILL_READY, provenanceSource: 'fixture' },
  ] },
});
assert.equal(ambiguousPlan.ok, false);
assert.equal(ambiguousPlan.reason, 'ambiguous_contract_ownership');

 (async () => {
const symbol = '__PROVENANCE_CONTRACT_TEST__';
const rawDir = path.resolve(__dirname, '../../../data/market-data/ib/raw', symbol);
const candlesDir = path.resolve(__dirname, '../../../data/market-data/candles-2m', symbol);
fs.rmSync(rawDir, { recursive: true, force: true });
fs.rmSync(candlesDir, { recursive: true, force: true });
try {
  const timestamp = '2099-01-02T17:00:00.000Z';
  const makeBar = (contractKey, close) => ({
    ts: timestamp, open: close - 1, high: close + 1, low: close - 1, close,
    volume: 10, contractKey, root: 'MNQ', source: 'ib',
  });
  store.saveRawBars(symbol, '2099-01-02', [makeBar(keyA, 100)], 'ib', { contractKey: keyA });
  store.saveRawBars(symbol, '2099-01-02', [makeBar(keyA, 100)], 'ib', { contractKey: keyA });
  store.saveRawBars(symbol, '2099-01-02', [makeBar(keyB, 200)], 'ib', { contractKey: keyB });
  const all = store.loadRawBars(symbol, '2099-01-02', '2099-01-02', 'ib');
  assert.equal(all.length, 2, 'same timestamp across contracts must be preserved');
  assert.equal(store.loadRawBars(symbol, '2099-01-02', '2099-01-02', 'ib', { contractKey: keyA }).length, 1);
  assert.equal(store.loadRawBars(symbol, '2099-01-02', '2099-01-02', 'ib', { contractKey: keyA })[0].close, 100);
  assert.equal(store.loadRawBars(symbol, '2099-01-02', '2099-01-02', 'ib', { contractKey: keyB })[0].close, 200);

  const feed = createHistoricalPriceFeedService({
    store: {
      loadRawBars(_root, _start, _end, _source, options = {}) {
        if (options.contractKey === keyA) return [makeBar(keyA, 100)];
        return [makeBar(keyA, 100), makeBar(keyB, 200)];
      },
    },
  });
  const ambiguous = feed.getBarsBetweenResult('MNQ', timestamp, timestamp);
  assert.equal(ambiguous.reason, 'ambiguous_contract_ownership');
  assert.equal(feed.getBarsBetween('MNQ', timestamp, timestamp, { contractKey: keyA }).length, 1);

  const persisted = { raw: [], candles: [] };
  const captureService = createFuturesMarketDataService({
    forceEnabled: true,
    persistEnabled: true,
    adapter: {
      start: async () => true,
      stop() {},
      getQuote: () => null,
      getStatus: () => ({ connected: true, host: '127.0.0.1', port: 4002 }),
      fetchHistoricalBars: async () => ({
        ok: true,
        contract: { conId: '730283094', localSymbol: 'MNQZ5', expiry: '2025-12-19', exchange: 'CME', currency: 'USD' },
        bars: [{
          epoch: 4071047520,
          timestamp: '2099-01-02T17:00:00.000Z',
          open: 100, high: 101, low: 99, close: 100.5, volume: 10, tradeCount: 1,
        }],
      }),
    },
    marketDataStore: {
      saveRawBars(_root, _date, rows) { persisted.raw.push(...rows); return rows.length; },
      saveCandles2m(_root, _date, rows) { persisted.candles.push(...rows); return rows.length; },
      saveIbImportManifest() { return true; },
    },
  });
  const capture = await captureService.refreshRoot('MNQ', { persist: true });
  assert.equal(capture.ok, true);
  assert.equal(persisted.raw.length, 1);
  assert.equal(persisted.raw[0].contractKey, keyA);
  assert.ok(persisted.raw[0].tradingDay);
  assert.ok(persisted.raw[0].session);
} finally {
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.rmSync(candlesDir, { recursive: true, force: true });
}

console.log('canonicalContractProvenance.acceptance.test.js OK');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
