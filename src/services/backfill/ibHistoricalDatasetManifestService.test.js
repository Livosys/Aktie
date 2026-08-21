'use strict';

const assert = require('assert/strict');
const { buildIbHistoricalDatasetManifest } = require('./ibHistoricalDatasetManifestService');

const bars = [
  { ts: '2026-08-18T00:00:00.000Z', open: 1, high: 2, low: 1, close: 2, volume: 10, contractKey: 'MNQ:1:2026-09-18' },
];
const store = {
  listAvailableDates() { return { raw: ['2026-08-18'], '2m': ['2026-08-18'] }; },
  loadRawBars() { return bars; },
  loadIbImportManifest() { return { provider: 'ibkr', contract: { conId: 1, localSymbol: 'MNQU6', expiry: '20260918' }, dates: ['2026-08-18'] }; },
};

const a = buildIbHistoricalDatasetManifest({ roots: ['MNQ'], dataStore: store, now: '2026-08-19T00:00:00.000Z' });
const b = buildIbHistoricalDatasetManifest({ roots: ['MNQ'], dataStore: store, now: '2026-08-19T00:00:00.000Z' });
assert.deepEqual(a, b, 'same dataset input must produce the same manifest');
assert.equal(a.readOnly, true);
assert.equal(a.roots[0].source, 'ibkr');
assert.equal(a.roots[0].contractProvenance.status, 'complete');
assert.deepEqual(a.roots[0].coverage.calendarDates, ['2026-08-18']);
assert.equal(a.roots[0].days[0].completeness, 'partial');
console.log('ibHistoricalDatasetManifestService.test.js OK');
