'use strict';

const assert = require('assert');
const svc = require('./interactiveBrokersFuturesContractDetailsService');
const { parseExpiry, selectFrontMonth, crossValidateSpec, buildResolvedContract } = svc._internal;

let passed = 0;
// simple sync/async runner
async function run(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const NOW = new Date('2026-07-02T12:00:00Z');

// Static spec stand-ins matching Fas 1 (multiplier/minTick/tradingClass).
const SPEC_MES = { root: 'MES', symbol: 'MES', secType: 'FUT', exchange: 'CME', currency: 'USD', tradingClass: 'MES', multiplier: 5, minTick: 0.25, preferredFirstTest: true };

function rows({ expiries }) {
  return expiries.map((e, i) => ({
    conId: 1000 + i,
    localSymbol: `MESU${String(e).slice(2, 4)}`,
    lastTradeDateOrContractMonth: e,
    tradingClass: 'MES',
    multiplier: 5,
    minTick: 0.25,
  }));
}

(async () => {
  // 1. parseExpiry.
  await run('parseExpiry handles YYYYMMDD / YYYYMM / invalid', () => {
    assert.ok(parseExpiry('20260918') instanceof Date);
    assert.strictEqual(parseExpiry('20260918').getUTCMonth(), 8); // September
    assert.ok(parseExpiry('202609') instanceof Date);
    assert.strictEqual(parseExpiry('bogus'), null);
    assert.strictEqual(parseExpiry(''), null);
    assert.strictEqual(parseExpiry('20261399'), null); // month 13
  });

  // 1b. parseExpiry: real IB Gateway format with time + timezone appended.
  await run('parseExpiry handles IB "YYYYMMDD HH:MM:SS TZ" format', () => {
    const d = parseExpiry('20261218 08:30:00 US/Central');
    assert.ok(d instanceof Date);
    assert.strictEqual(d.getUTCFullYear(), 2026);
    assert.strictEqual(d.getUTCMonth(), 11); // December
    assert.strictEqual(d.getUTCDate(), 18);
    // Same day as the bare form.
    assert.strictEqual(d.getTime(), parseExpiry('20261218').getTime());
    // Garbage before whitespace still fails.
    assert.strictEqual(parseExpiry('bogus 08:30:00 US/Central'), null);
  });

  // 1c. selectFrontMonth parses IB time+TZ format and falls back to
  // contractMonth when lastTradeDateOrContractMonth is unparseable.
  await run('selectFrontMonth handles IB time+TZ expiries and contractMonth fallback', () => {
    const ibRows = [
      { conId: 1, localSymbol: 'MESU6', lastTradeDateOrContractMonth: '20260918 08:30:00 US/Central', tradingClass: 'MES', multiplier: 5, minTick: 0.25 },
      { conId: 2, localSymbol: 'MESZ6', lastTradeDateOrContractMonth: '20261218 08:30:00 US/Central', tradingClass: 'MES', multiplier: 5, minTick: 0.25 },
    ];
    const r = selectFrontMonth(ibRows, { now: NOW });
    assert.strictEqual(r.reason, 'front_selected');
    assert.strictEqual(r.selected.localSymbol, 'MESU6');

    const fallbackRows = [
      { conId: 3, localSymbol: 'MESH7', lastTradeDateOrContractMonth: 'unparseable-junk', contractMonth: '202703', tradingClass: 'MES', multiplier: 5, minTick: 0.25 },
    ];
    const f = selectFrontMonth(fallbackRows, { now: NOW });
    assert.strictEqual(f.reason, 'front_selected');
    assert.strictEqual(f.selected.localSymbol, 'MESH7');
  });

  // 2. selectFrontMonth picks earliest non-expired, skips expired.
  await run('selectFrontMonth picks earliest non-expired', () => {
    const r = selectFrontMonth(rows({ expiries: ['20260619', '20260918', '20261218'] }), { now: NOW });
    assert.strictEqual(r.selected.lastTradeDateOrContractMonth, '20260918');
    assert.strictEqual(r.reason, 'front_selected');
    assert.strictEqual(r.nearExpiry, false);
    assert.ok(r.daysToExpiry > 30);
  });

  // 3. no active contract -> null.
  await run('selectFrontMonth returns null when all expired', () => {
    const r = selectFrontMonth(rows({ expiries: ['20250619', '20260101'] }), { now: NOW });
    assert.strictEqual(r.selected, null);
    assert.strictEqual(r.reason, 'no_active_contract');
  });

  // 4. near-expiry roll flag.
  await run('selectFrontMonth flags near_expiry within roll guard', () => {
    const soon = '20260705'; // 3 days out from NOW
    const r = selectFrontMonth(rows({ expiries: [soon, '20260918'] }), { now: NOW, rollGuardDays: 5 });
    assert.strictEqual(r.selected.lastTradeDateOrContractMonth, soon);
    assert.strictEqual(r.nearExpiry, true);
    assert.ok(r.daysToExpiry <= 5);
  });

  // 5. crossValidateSpec detects mismatches.
  await run('crossValidateSpec detects multiplier/minTick/tradingClass mismatch', () => {
    assert.deepStrictEqual(crossValidateSpec({ multiplier: 5, minTick: 0.25, tradingClass: 'MES' }, SPEC_MES), []);
    const bad = crossValidateSpec({ multiplier: 50, minTick: 0.1, tradingClass: 'ES' }, SPEC_MES);
    assert.ok(bad.some((m) => m.startsWith('multiplier')));
    assert.ok(bad.some((m) => m.startsWith('minTick')));
    assert.ok(bad.some((m) => m.startsWith('tradingClass')));
  });

  // 6. buildResolvedContract: verified on clean resolve.
  await run('buildResolvedContract verifies clean front month', () => {
    const res = selectFrontMonth(rows({ expiries: ['20260918'] }), { now: NOW });
    const c = buildResolvedContract(SPEC_MES, res);
    assert.strictEqual(c.contractMonthVerified, true);
    assert.strictEqual(c.lastTradeDateOrContractMonth, '20260918');
    assert.strictEqual(c.localSymbol, 'MESU26');
    assert.deepStrictEqual(c.detailBlockers, []);
  });

  // 7. buildResolvedContract: spec mismatch downgrades verification.
  await run('buildResolvedContract downgrades on spec mismatch', () => {
    const badRows = [{ conId: 9, localSymbol: 'X', lastTradeDateOrContractMonth: '20260918', tradingClass: 'MES', multiplier: 999, minTick: 0.25 }];
    const c = buildResolvedContract(SPEC_MES, selectFrontMonth(badRows, { now: NOW }));
    assert.strictEqual(c.contractMonthVerified, false);
    assert.ok(c.detailBlockers.includes('contract_spec_mismatch'));
  });

  // 8. buildResolvedContract: no active -> unavailable.
  await run('buildResolvedContract marks unavailable when nothing active', () => {
    const c = buildResolvedContract(SPEC_MES, selectFrontMonth(rows({ expiries: ['20250101'] }), { now: NOW }));
    assert.strictEqual(c.contractMonthVerified, false);
    assert.ok(c.detailBlockers.includes('contract_details_unavailable'));
  });

  // 9. GATED OFF: no connector touched, everything unverified.
  await run('resolve gated OFF never calls connector', async () => {
    let called = false;
    const connector = { fetchContractDetails: async () => { called = true; return []; } };
    const out = await svc.resolveFrontMonthContracts({ enabled: false, connector, now: NOW });
    assert.strictEqual(out.enabled, false);
    assert.strictEqual(out.gated, true);
    assert.strictEqual(out.source, 'gated_no_ib_query');
    assert.strictEqual(called, false, 'connector must NOT be called when gated');
    assert.strictEqual(out.contracts.length, 4);
    for (const c of out.contracts) {
      assert.strictEqual(c.contractMonthVerified, false);
      assert.ok(c.detailBlockers.includes('contract_details_disabled'));
    }
  });

  // 10. ENABLED with mock connector: resolves all 4 roots + closes connector.
  await run('resolve enabled with mock connector resolves + closes', async () => {
    let closed = false;
    const connector = {
      fetchContractDetails: async (spec) => [
        { conId: 1, localSymbol: `${spec.root}U26`, lastTradeDateOrContractMonth: '20260918', tradingClass: spec.tradingClass, multiplier: spec.multiplier, minTick: spec.minTick },
        { conId: 2, localSymbol: `${spec.root}M26`, lastTradeDateOrContractMonth: '20260619', tradingClass: spec.tradingClass, multiplier: spec.multiplier, minTick: spec.minTick },
      ],
      close: async () => { closed = true; },
    };
    const out = await svc.resolveFrontMonthContracts({ enabled: true, connector, now: NOW });
    assert.strictEqual(out.enabled, true);
    assert.strictEqual(out.gated, false);
    assert.strictEqual(out.source, 'ib_reqContractDetails');
    assert.strictEqual(out.contracts.length, 4);
    assert.deepStrictEqual(out.contracts.map((c) => c.root), ['MES', 'MNQ', 'ES', 'NQ']);
    for (const c of out.contracts) {
      assert.strictEqual(c.contractMonthVerified, true, `${c.root} verified`);
      assert.strictEqual(c.lastTradeDateOrContractMonth, '20260918');
      assert.ok(Number.isInteger(c.conId));
      assert.deepStrictEqual(c.detailBlockers, []);
    }
    assert.strictEqual(closed, true, 'connector.close must be called');
  });

  // 11. ENABLED but a root fetch throws -> that root marked unavailable, others OK.
  await run('resolve enabled tolerates per-root fetch error', async () => {
    const connector = {
      fetchContractDetails: async (spec) => {
        if (spec.root === 'NQ') throw new Error('boom');
        return [{ conId: 1, localSymbol: `${spec.root}U26`, lastTradeDateOrContractMonth: '20260918', tradingClass: spec.tradingClass, multiplier: spec.multiplier, minTick: spec.minTick }];
      },
    };
    const out = await svc.resolveFrontMonthContracts({ enabled: true, connector, now: NOW });
    const nq = out.contracts.find((c) => c.root === 'NQ');
    assert.strictEqual(nq.contractMonthVerified, false);
    assert.ok(nq.detailBlockers.includes('contract_details_unavailable'));
    assert.ok(out.contracts.filter((c) => c.root !== 'NQ').every((c) => c.contractMonthVerified === true));
  });

  // 12. ENABLED without connector throws (safety: never silently no-op).
  await run('resolve enabled without connector throws', async () => {
    await assert.rejects(() => svc.resolveFrontMonthContracts({ enabled: true, connector: null, now: NOW }));
  });

  // 13. safety flags always false.
  await run('safety flags always false', async () => {
    const out = await svc.resolveFrontMonthContracts({ enabled: false, now: NOW });
    assert.strictEqual(out.safety.can_place_orders, false);
    assert.strictEqual(out.safety.live_trading_enabled, false);
    assert.strictEqual(out.safety.broker_enabled, false);
    assert.strictEqual(out.safety.actions_allowed, false);
  });

  console.log(`\ninteractiveBrokersFuturesContractDetailsService: ${passed} tests passed`);
})().catch((err) => {
  console.error('TEST FAILURE:', err && err.stack ? err.stack : err);
  process.exit(1);
});
