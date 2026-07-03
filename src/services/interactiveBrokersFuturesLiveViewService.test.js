'use strict';

/**
 * Mock-only tests for the Fas 3.3 futures live-view orchestrator.
 *
 * No live IB dependency: the fixtures are produced by the REAL Fas 3.1/3.2
 * services running against injected mock connectors (so the shapes can never
 * drift from the actual APIs), or the services stay env-gated OFF (default).
 * Deterministic: fixed `now`, fixed fixture data.
 */

const assert = require('assert');
const svc = require('./interactiveBrokersFuturesLiveViewService');
const { resolveFrontMonthContracts } = require('./interactiveBrokersFuturesContractDetailsService');
const { getMarketDataForContracts } = require('./interactiveBrokersFuturesMarketDataService');
const { mergeContractDetails, mergeMarketData, remainingGlobalBlockers, indexByRoot } = svc._internal;

let passed = 0;
async function run(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const NOW = new Date('2026-07-03T12:00:00Z');
const ROOTS = ['MES', 'MNQ', 'ES', 'NQ'];

// ── Mock connectors (never touch IB) ────────────────────────────────────────

// Static spec params per root so 3.1's cross-validation passes cleanly.
const SPEC_PARAMS = {
  MES: { multiplier: 5, minTick: 0.25 },
  MNQ: { multiplier: 2, minTick: 0.25 },
  ES: { multiplier: 50, minTick: 0.25 },
  NQ: { multiplier: 20, minTick: 0.25 },
};

function cdRow(root, overrides = {}) {
  return {
    conId: 730000000 + root.length,
    localSymbol: `${root}U6`,
    lastTradeDateOrContractMonth: '20260918',
    contractMonth: '202609',
    tradingClass: root,
    multiplier: SPEC_PARAMS[root].multiplier,
    minTick: SPEC_PARAMS[root].minTick,
    ...overrides,
  };
}

function cdConnector(rowsByRoot) {
  return {
    fetchContractDetails: async (spec) => rowsByRoot[spec.root] || [],
    close: async () => {},
  };
}

function mdConnector(snapshotByRoot) {
  return {
    fetchSnapshot: async (contract) => snapshotByRoot[contract.root] || null,
    close: async () => {},
  };
}

function snapshot(overrides = {}) {
  return {
    ticks: { last: 5623.25, bid: 5623.0, ask: 5623.5, close: 5610.0 },
    marketDataType: 1, // realtime
    receivedAt: NOW.toISOString(),
    ...overrides,
  };
}

// Resolver factories that run the REAL 3.1/3.2 pipelines with mocks injected.
function liveCdResolver(rowsByRoot) {
  return ({ now }) => resolveFrontMonthContracts({ enabled: true, connector: cdConnector(rowsByRoot), now });
}
function liveMdResolver(snapshotByRoot) {
  return ({ now, contracts }) => getMarketDataForContracts({ enabled: true, connector: mdConnector(snapshotByRoot), contracts, now });
}
// Gated resolvers: the real services with the gate explicitly OFF.
const gatedCdResolver = ({ now }) => resolveFrontMonthContracts({ enabled: false, now });
const gatedMdResolver = ({ now, contracts }) => getMarketDataForContracts({ enabled: false, contracts, now });

const ALL_ROWS = Object.fromEntries(ROOTS.map((r) => [r, [cdRow(r)]]));
const ALL_SNAPSHOTS = Object.fromEntries(ROOTS.map((r) => [r, snapshot()]));

const BASE_MES = {
  root: 'MES',
  isTradablePreview: false,
  preferredFirstTest: true,
  contractMonthVerified: false,
  blockers: ['contract_month_unverified', 'no_futures_market_data', 'futures_execution_not_implemented', 'submit_routes_disabled'],
};

function assertNeverTradable(out) {
  assert.strictEqual(out.counts.tradablePreview, 0);
  assert.ok(out.contracts.every((c) => c.isTradablePreview === false));
  assert.ok(out.contracts.every((c) => c.tradablePreview === false));
}

(async () => {
  // ── Unit tests of the merge internals ─────────────────────────────────────

  await run('indexByRoot maps by root, ignores junk', () => {
    const m = indexByRoot([{ root: 'MES', x: 1 }, { root: 'ES', x: 2 }, null, { nope: true }]);
    assert.strictEqual(m.MES.x, 1);
    assert.strictEqual(m.ES.x, 2);
    assert.strictEqual(Object.keys(m).length, 2);
  });

  await run('mergeContractDetails unverified keeps static + hides gated marker from merged blockers', () => {
    const out = mergeContractDetails(BASE_MES, { root: 'MES', contractMonthVerified: false, detailBlockers: ['contract_details_disabled'] });
    assert.strictEqual(out.contractMonthVerified, false);
    assert.ok(out.blockers.includes('contract_month_unverified'));
    assert.ok(!out.blockers.includes('contract_details_disabled'));
    // …but the raw detailBlockers stay fully transparent.
    assert.deepStrictEqual(out.detailBlockers, ['contract_details_disabled']);
    assert.strictEqual(out.contractDetailsSource, 'static_contract_spec');
  });

  await run('mergeContractDetails verified sets front month + clears unverified blocker', () => {
    const out = mergeContractDetails(BASE_MES, {
      root: 'MES', contractMonthVerified: true, conId: 730123456, localSymbol: 'MESU6',
      lastTradeDateOrContractMonth: '20260918', contractMonth: '202609', daysToExpiry: 77, detailBlockers: [],
    }, { source: 'ib_reqContractDetails' });
    assert.strictEqual(out.contractMonthVerified, true);
    assert.strictEqual(out.contractMonth, '202609');
    assert.strictEqual(out.localSymbol, 'MESU6');
    assert.strictEqual(out.conId, 730123456);
    assert.strictEqual(out.contractDetailsSource, 'ib_reqContractDetails');
    assert.ok(!out.blockers.includes('contract_month_unverified'));
  });

  await run('mergeContractDetails verified-but-near-expiry KEEPS contract_month_unverified', () => {
    const out = mergeContractDetails(BASE_MES, {
      root: 'MES', contractMonthVerified: true, conId: 1, localSymbol: 'MESU6',
      lastTradeDateOrContractMonth: '20260705', contractMonth: '202607', detailBlockers: ['near_expiry_roll'],
    });
    assert.strictEqual(out.contractMonthVerified, true);
    assert.ok(out.blockers.includes('contract_month_unverified'));
    assert.ok(out.blockers.includes('near_expiry_roll'));
  });

  await run('mergeMarketData usable price clears no_futures_market_data', () => {
    const out = mergeMarketData(BASE_MES, {
      root: 'MES', price: 5623.25, priceField: 'last', priceType: 'realtime',
      receivedAt: NOW.toISOString(), stalenessSeconds: 1, stale: false,
      hasUsablePrice: true, marketDataBlockers: [],
    });
    assert.strictEqual(out.price, 5623.25);
    assert.strictEqual(out.hasUsablePrice, true);
    assert.strictEqual(out.marketDataTimestamp, NOW.toISOString());
    assert.strictEqual(out.marketDataAgeMs, 1000);
    assert.ok(!out.blockers.includes('no_futures_market_data'));
  });

  await run('mergeMarketData missing data keeps blockers + null price fields', () => {
    const out = mergeMarketData(BASE_MES, undefined);
    assert.strictEqual(out.price, null);
    assert.strictEqual(out.hasUsablePrice, false);
    assert.ok(out.blockers.includes('no_futures_market_data'));
  });

  await run('remainingGlobalBlockers keeps a global blocker while ANY root still has it', () => {
    const remaining = remainingGlobalBlockers(['a', 'b', 'c'], [
      { blockers: ['a', 'b'] },
      { blockers: ['b'] },
    ]);
    // 'a' kept (one root has it), 'b' kept (all have it), 'c' dropped (no root has it).
    assert.deepStrictEqual(remaining.sort(), ['a', 'b']);
    // Root-only blockers never get promoted to global.
    assert.deepStrictEqual(remainingGlobalBlockers(['x'], [{ blockers: ['x', 'root_only'] }]), ['x']);
  });

  // ── 1. Gates OFF: no IB query, static output, Phase-1 blockers intact ─────

  await run('1. gates OFF → gated sources, static output, all Phase-1 blockers, never tradable', async () => {
    // Env gates must be OFF in this test run (default).
    assert.notStrictEqual(String(process.env.IB_FUTURES_CONTRACT_DETAILS_ENABLED).toLowerCase(), 'true');
    assert.notStrictEqual(String(process.env.IB_FUTURES_MARKETDATA_ENABLED).toLowerCase(), 'true');

    // Uses the REAL env-gated services (no resolver injection): with gates OFF
    // they return gated results without any connector — no IB query possible.
    const out = await svc.buildFuturesLiveView({ now: NOW });

    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.readOnly, true);
    assert.strictEqual(out.source, 'static_contract_spec');
    assert.strictEqual(out.contractDetails.enabled, false);
    assert.strictEqual(out.contractDetails.gated, true);
    assert.strictEqual(out.contractDetails.source, 'gated_no_ib_query');
    assert.ok(out.contractDetails.blockers.includes('contract_details_disabled'));
    assert.strictEqual(out.marketData.enabled, false);
    assert.strictEqual(out.marketData.gated, true);
    assert.strictEqual(out.marketData.source, 'gated_no_ib_query');
    assert.ok(out.marketData.blockers.includes('market_data_disabled'));
    assert.strictEqual(out.counts.total, 4);
    assert.strictEqual(out.counts.contractMonthVerified, 0);
    assert.strictEqual(out.counts.hasUsablePrice, 0);
    for (const c of out.contracts) {
      assert.ok(c.blockers.includes('contract_month_unverified'));
      assert.ok(c.blockers.includes('no_futures_market_data'));
      assert.ok(c.blockers.includes('futures_execution_not_implemented'));
      assert.ok(c.blockers.includes('submit_routes_disabled'));
      // Gated markers stay out of the merged blockers (no Phase-1 duplication)…
      assert.ok(!c.blockers.includes('contract_details_disabled'));
      assert.ok(!c.blockers.includes('market_data_disabled'));
      // …but remain transparent in the per-source blocker lists.
      assert.ok(c.detailBlockers.includes('contract_details_disabled'));
      assert.ok(c.marketDataBlockers.includes('market_data_disabled'));
      assert.strictEqual(c.localSymbol, null);
      assert.strictEqual(c.conId, null);
      assert.strictEqual(c.price, null);
    }
    assertNeverTradable(out);
  });

  // ── 2. Contract details verified, market data gated OFF ───────────────────

  await run('2. details verified + market data gated → verified month, still no price', async () => {
    const out = await svc.buildFuturesLiveView({
      now: NOW,
      contractDetailsResolver: liveCdResolver(ALL_ROWS),
      marketDataResolver: gatedMdResolver,
    });
    assert.strictEqual(out.counts.contractMonthVerified, 4);
    assert.strictEqual(out.counts.hasUsablePrice, 0);
    const mes = out.contracts.find((c) => c.root === 'MES');
    assert.strictEqual(mes.contractMonthVerified, true);
    assert.strictEqual(mes.localSymbol, 'MESU6');
    assert.ok(mes.conId != null);
    assert.strictEqual(mes.contractMonth, '202609');
    assert.ok(!mes.blockers.includes('contract_month_unverified'));
    assert.ok(mes.blockers.includes('no_futures_market_data'));
    assertNeverTradable(out);
  });

  // ── 3. Verified details + usable (realtime, fresh) market data ────────────

  await run('3. verified + usable price → price set, md blocker cleared, execution blockers stay', async () => {
    const out = await svc.buildFuturesLiveView({
      now: NOW,
      contractDetailsResolver: liveCdResolver(ALL_ROWS),
      marketDataResolver: liveMdResolver(ALL_SNAPSHOTS),
    });
    assert.strictEqual(out.source, 'live_ib_futures');
    assert.strictEqual(out.counts.hasUsablePrice, 4);
    const mes = out.contracts.find((c) => c.root === 'MES');
    assert.strictEqual(mes.price, 5623.25);
    assert.strictEqual(mes.priceType, 'realtime');
    assert.strictEqual(mes.hasUsablePrice, true);
    assert.ok(!mes.blockers.includes('no_futures_market_data'));
    assert.ok(mes.blockers.includes('futures_execution_not_implemented'));
    assert.ok(mes.blockers.includes('submit_routes_disabled'));
    assertNeverTradable(out);
  });

  // ── 4. Delayed market data: transparent, never called realtime ────────────

  await run('4. delayed data → delayed_market_data + priceType=delayed, never tradable', async () => {
    const snaps = Object.fromEntries(ROOTS.map((r) => [r, snapshot({ marketDataType: 3 })]));
    const out = await svc.buildFuturesLiveView({
      now: NOW,
      contractDetailsResolver: liveCdResolver(ALL_ROWS),
      marketDataResolver: liveMdResolver(snaps),
    });
    const mes = out.contracts.find((c) => c.root === 'MES');
    assert.strictEqual(mes.priceType, 'delayed');
    assert.notStrictEqual(mes.priceType, 'realtime');
    assert.ok(mes.blockers.includes('delayed_market_data'));
    assert.ok(mes.marketDataBlockers.includes('delayed_market_data'));
    assert.strictEqual(mes.hasUsablePrice, true); // usable but transparently delayed
    assertNeverTradable(out);
  });

  // ── 5. Stale market data blocks usability ─────────────────────────────────

  await run('5. stale data → stale_market_data + no_futures_market_data, hasUsablePrice=false', async () => {
    const staleAt = new Date(NOW.getTime() - 120 * 1000).toISOString(); // > 60s default
    const snaps = Object.fromEntries(ROOTS.map((r) => [r, snapshot({ receivedAt: staleAt })]));
    const out = await svc.buildFuturesLiveView({
      now: NOW,
      contractDetailsResolver: liveCdResolver(ALL_ROWS),
      marketDataResolver: liveMdResolver(snaps),
    });
    const mes = out.contracts.find((c) => c.root === 'MES');
    assert.strictEqual(mes.hasUsablePrice, false);
    assert.ok(mes.blockers.includes('stale_market_data'));
    assert.ok(mes.blockers.includes('no_futures_market_data'));
    assert.strictEqual(out.counts.hasUsablePrice, 0);
    assertNeverTradable(out);
  });

  // ── 6. Contract spec mismatch blocks verification ──────────────────────────

  await run('6. spec mismatch → contract_spec_mismatch, not verified, unverified blocker stays', async () => {
    const rows = { ...ALL_ROWS, MES: [cdRow('MES', { multiplier: 999 })] };
    const out = await svc.buildFuturesLiveView({
      now: NOW,
      contractDetailsResolver: liveCdResolver(rows),
      marketDataResolver: gatedMdResolver,
    });
    const mes = out.contracts.find((c) => c.root === 'MES');
    assert.strictEqual(mes.contractMonthVerified, false);
    assert.ok(mes.blockers.includes('contract_spec_mismatch'));
    assert.ok(mes.blockers.includes('contract_month_unverified'));
    assertNeverTradable(out);
  });

  // ── 7. Near expiry: flagged, verification blocker stays ───────────────────

  await run('7. near expiry → near_expiry_roll shown, contract_month_unverified stays', async () => {
    const rows = { ...ALL_ROWS, MES: [cdRow('MES', { lastTradeDateOrContractMonth: '20260705', contractMonth: '202607' })] };
    const out = await svc.buildFuturesLiveView({
      now: NOW,
      contractDetailsResolver: liveCdResolver(rows),
      marketDataResolver: gatedMdResolver,
    });
    const mes = out.contracts.find((c) => c.root === 'MES');
    assert.ok(mes.blockers.includes('near_expiry_roll'));
    assert.ok(mes.blockers.includes('contract_month_unverified')); // roll window ⇒ not clean
    assertNeverTradable(out);
  });

  // ── 8. globalBlockers semantics ────────────────────────────────────────────

  await run('8. globalBlockers drop only when ALL roots clear them; execution blockers always stay', async () => {
    // 8a. Everything gated: all four Phase-1 blockers are global.
    const gated = await svc.buildFuturesLiveView({ now: NOW, contractDetailsResolver: gatedCdResolver, marketDataResolver: gatedMdResolver });
    for (const b of ['contract_month_unverified', 'no_futures_market_data', 'futures_execution_not_implemented', 'submit_routes_disabled']) {
      assert.ok(gated.globalBlockers.includes(b), `expected global ${b}`);
    }

    // 8b. Only MES verified → global contract_month_unverified STAYS.
    const partial = await svc.buildFuturesLiveView({
      now: NOW,
      contractDetailsResolver: liveCdResolver({ MES: [cdRow('MES')] }),
      marketDataResolver: gatedMdResolver,
    });
    assert.ok(partial.globalBlockers.includes('contract_month_unverified'));
    assert.strictEqual(partial.counts.contractMonthVerified, 1);

    // 8c. All roots verified + all priced → both data blockers drop globally,
    //     execution blockers remain global.
    const full = await svc.buildFuturesLiveView({
      now: NOW,
      contractDetailsResolver: liveCdResolver(ALL_ROWS),
      marketDataResolver: liveMdResolver(ALL_SNAPSHOTS),
    });
    assert.ok(!full.globalBlockers.includes('contract_month_unverified'));
    assert.ok(!full.globalBlockers.includes('no_futures_market_data'));
    assert.ok(full.globalBlockers.includes('futures_execution_not_implemented'));
    assert.ok(full.globalBlockers.includes('submit_routes_disabled'));

    // 8d. All verified but only MES priced → global no_futures_market_data STAYS.
    const halfPriced = await svc.buildFuturesLiveView({
      now: NOW,
      contractDetailsResolver: liveCdResolver(ALL_ROWS),
      marketDataResolver: liveMdResolver({ MES: snapshot() }),
    });
    assert.ok(halfPriced.globalBlockers.includes('no_futures_market_data'));
    assert.strictEqual(halfPriced.counts.hasUsablePrice, 1);
  });

  // ── 9. Safety invariant ────────────────────────────────────────────────────

  await run('9. safety: paper_only, nothing allowed, even fully verified+priced is never tradable', async () => {
    const out = await svc.buildFuturesLiveView({
      now: NOW,
      contractDetailsResolver: liveCdResolver(ALL_ROWS),
      marketDataResolver: liveMdResolver(ALL_SNAPSHOTS),
    });
    assert.strictEqual(out.safety.mode, 'paper_only');
    assert.strictEqual(out.safety.actions_allowed, false);
    assert.strictEqual(out.safety.can_place_orders, false);
    assert.strictEqual(out.safety.live_trading_enabled, false);
    assert.strictEqual(out.safety.broker_enabled, false);
    assert.strictEqual(out.submitRoutesEnabled, false);
    assertNeverTradable(out);
  });

  console.log(`\ninteractiveBrokersFuturesLiveViewService: ${passed} tests passed`);
})().catch((err) => {
  console.error('TEST FAILURE:', err && err.stack ? err.stack : err);
  process.exit(1);
});
