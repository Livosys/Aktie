'use strict';

const assert = require('assert');
const svc = require('./databentoDataService');

(function run() {
  // ── price scaling (int64 fixed-point ÷ 1e9) ──────────────────────────────────
  assert.strictEqual(svc.scalePrice('20000000000000'), 20000);
  assert.strictEqual(svc.scalePrice(18000250000000), 18000.25);
  assert.strictEqual(svc.scalePrice(null), null);
  assert.strictEqual(svc.scalePrice(''), null);
  assert.strictEqual(svc.scalePrice('not-a-number'), null);

  // ── ns → UTC ISO, using BigInt (ts_event exceeds Number.MAX_SAFE_INTEGER) ─────
  const ms = Date.parse('2024-01-02T14:30:00.000Z');
  const nsString = (BigInt(ms) * 1000000n).toString();
  assert.strictEqual(svc.nsToIso(nsString), '2024-01-02T14:30:00.000Z');
  assert.strictEqual(svc.nsToIso(BigInt(nsString)), '2024-01-02T14:30:00.000Z');
  assert.strictEqual(svc.nsToIso(null), null);
  assert.strictEqual(svc.nsToIso(''), null);
  // Precision: a 2024-era ns value is ~1.7e18 (> 9.0e15 safe-int) — BigInt keeps ms exact.
  assert.strictEqual(BigInt(nsString) > 9007199254740991n, true);

  // ── continuous <-> root mapping ──────────────────────────────────────────────
  assert.strictEqual(svc.rootToContinuous('MNQ'), 'MNQ.v.0');
  assert.strictEqual(svc.rootToContinuous('mes'), 'MES.v.0');
  assert.strictEqual(svc.rootToContinuous('NQ'), null); // mini, not micro — rejected
  assert.strictEqual(svc.rootToContinuous(''), null);
  assert.strictEqual(svc.continuousToRoot('MNQ.v.0'), 'MNQ');
  assert.strictEqual(svc.continuousToRoot('MES.v.0'), 'MES');
  assert.strictEqual(svc.continuousToRoot('MNQ'), 'MNQ');

  // ── record normalization → { t, o, h, l, c, v } with root symbol ─────────────
  const rec = { ts_event: nsString, open: '20000000000000', high: '20010000000000', low: '19990000000000', close: '20005000000000', volume: 100 };
  const bar = svc.normalizeDatabentoRecord(rec, 'MNQ.v.0');
  assert.strictEqual(bar.t, '2024-01-02T14:30:00.000Z');
  assert.strictEqual(bar.o, 20000);
  assert.strictEqual(bar.h, 20010);
  assert.strictEqual(bar.l, 19990);
  assert.strictEqual(bar.c, 20005);
  assert.strictEqual(bar.v, 100);
  assert.strictEqual(bar.symbol, 'MNQ'); // continuous mapped back to root
  assert.strictEqual(bar.timeframe, '1m');

  // nested header shape ({ hd: { ts_event } })
  const nested = svc.normalizeDatabentoRecord({ hd: { ts_event: nsString }, open: '1', high: '2', low: '1', close: '2', volume: 1 }, 'MES.v.0');
  assert.strictEqual(nested.t, '2024-01-02T14:30:00.000Z');
  assert.strictEqual(nested.symbol, 'MES');

  // normalizeDatabentoRecords drops records with unparseable prices / ts
  const recs = svc.normalizeDatabentoRecords([
    rec,
    { ts_event: nsString, open: 'x', high: 'x', low: 'x', close: 'x', volume: 0 },
    { open: '1', high: '1', low: '1', close: '1', volume: 0 }, // no ts_event
  ], 'MNQ.v.0');
  assert.strictEqual(recs.length, 1);

  // ── parseRecords: newline-delimited JSON, array, single object ───────────────
  assert.strictEqual(svc.parseRecords([{ a: 1 }, { a: 2 }]).length, 2);
  assert.strictEqual(svc.parseRecords('{"a":1}\n{"a":2}\n').length, 2);
  assert.strictEqual(svc.parseRecords({ a: 1 }).length, 1);
  assert.strictEqual(svc.parseRecords(null).length, 0);
  assert.strictEqual(svc.parseRecords('{"a":1}\nnot-json\n{"a":3}').length, 2);

  // ── inert gates: fetch throws BEFORE any network call ─────────────────────────
  const savedEnabled = process.env.DATABENTO_ENABLED;
  const savedKey = process.env.DATABENTO_API_KEY;

  delete process.env.DATABENTO_ENABLED;
  assert.strictEqual(svc.isEnabled(), false); // default disabled
  return Promise.resolve()
    .then(() => svc.fetchDatabentoBars({ symbol: 'MNQ', start: '2024-01-01', end: '2024-01-02' })
      .then(() => { throw new Error('should have thrown (disabled)'); })
      .catch((e) => { assert.match(e.message, /DATABENTO_ENABLED is not true/); }))
    .then(() => {
      process.env.DATABENTO_ENABLED = 'true';
      delete process.env.DATABENTO_API_KEY;
      assert.strictEqual(svc.hasCredentials(), false);
      return svc.fetchDatabentoBars({ symbol: 'MNQ', start: '2024-01-01', end: '2024-01-02' })
        .then(() => { throw new Error('should have thrown (no credentials)'); })
        .catch((e) => { assert.match(e.message, /API key missing/); });
    })
    .then(() => {
      // enabled + creds but unmapped symbol → throws before network
      process.env.DATABENTO_API_KEY = 'test-key-not-used';
      return svc.fetchDatabentoBars({ symbol: 'NQ', start: '2024-01-01', end: '2024-01-02' })
        .then(() => { throw new Error('should have thrown (no mapping)'); })
        .catch((e) => { assert.match(e.message, /continuous-contract mapping/); });
    })
    .then(() => {
      // restore env
      if (savedEnabled === undefined) delete process.env.DATABENTO_ENABLED; else process.env.DATABENTO_ENABLED = savedEnabled;
      if (savedKey === undefined) delete process.env.DATABENTO_API_KEY; else process.env.DATABENTO_API_KEY = savedKey;
      console.log('# databentoDataService tests passed.');
    });
}());
