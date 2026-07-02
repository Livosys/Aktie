'use strict';

const assert = require('assert');
const svc = require('./interactiveBrokersFuturesMarketDataService');
const { pickPrice, classifyDataType, assessStaleness, buildMarketDataResult } = svc._internal;

let passed = 0;
async function run(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const NOW = new Date('2026-07-02T15:00:00Z');
const FRESH = new Date('2026-07-02T14:59:50Z').toISOString(); // 10s ago
const STALE = new Date('2026-07-02T14:57:00Z').toISOString(); // 180s ago

function verifiedContract(root = 'MES') {
  return { root, symbol: root, conId: 700 + root.length, localSymbol: `${root}U26`, contractMonthVerified: true, secType: 'FUT', exchange: 'CME', currency: 'USD' };
}

(async () => {
  // 1. pickPrice priority.
  await run('pickPrice prefers last, then mid, then close', () => {
    assert.strictEqual(pickPrice({ last: 5600.25, bid: 5600, ask: 5600.5, close: 5599 }).priceField, 'last');
    const mid = pickPrice({ bid: 5600, ask: 5600.5, close: 5599 });
    assert.strictEqual(mid.priceField, 'mid');
    assert.strictEqual(mid.price, 5600.25);
    assert.strictEqual(pickPrice({ close: 5599 }).priceField, 'close');
    assert.strictEqual(pickPrice({}).price, null);
  });

  // 2. classifyDataType.
  await run('classifyDataType maps IB codes', () => {
    assert.strictEqual(classifyDataType(1), 'realtime');
    assert.strictEqual(classifyDataType(2), 'frozen');
    assert.strictEqual(classifyDataType(3), 'delayed');
    assert.strictEqual(classifyDataType(4), 'delayed_frozen');
    assert.strictEqual(classifyDataType(99), 'unknown');
  });

  // 3. assessStaleness.
  await run('assessStaleness computes seconds since receipt', () => {
    const fresh = assessStaleness(FRESH, NOW, 60);
    assert.strictEqual(fresh.stale, false);
    assert.ok(fresh.stalenessSeconds <= 15);
    const stale = assessStaleness(STALE, NOW, 60);
    assert.strictEqual(stale.stale, true);
    assert.ok(stale.stalenessSeconds >= 120);
    assert.strictEqual(assessStaleness(null, NOW, 60).stale, true);
  });

  // 4. realtime fresh price -> usable, no blockers.
  await run('buildMarketDataResult: realtime fresh price is usable', () => {
    const r = buildMarketDataResult(verifiedContract(), { ticks: { last: 5600.25 }, marketDataType: 1, receivedAt: FRESH }, { now: NOW });
    assert.strictEqual(r.price, 5600.25);
    assert.strictEqual(r.priceType, 'realtime');
    assert.strictEqual(r.hasUsablePrice, true);
    assert.deepStrictEqual(r.marketDataBlockers, []);
  });

  // 5. delayed price -> usable but flagged delayed, NOT no_futures_market_data.
  await run('buildMarketDataResult: delayed price flagged but usable', () => {
    const r = buildMarketDataResult(verifiedContract(), { ticks: { last: 20500 }, marketDataType: 3, receivedAt: FRESH }, { now: NOW });
    assert.strictEqual(r.priceType, 'delayed');
    assert.strictEqual(r.hasUsablePrice, true);
    assert.ok(r.marketDataBlockers.includes('delayed_market_data'));
    assert.ok(!r.marketDataBlockers.includes('no_futures_market_data'));
  });

  // 6. stale price -> blocked.
  await run('buildMarketDataResult: stale price is blocked', () => {
    const r = buildMarketDataResult(verifiedContract(), { ticks: { last: 5600 }, marketDataType: 1, receivedAt: STALE }, { now: NOW, maxStalenessSeconds: 60 });
    assert.strictEqual(r.hasUsablePrice, false);
    assert.ok(r.marketDataBlockers.includes('stale_market_data'));
    assert.ok(r.marketDataBlockers.includes('no_futures_market_data'));
  });

  // 7. no price -> no_futures_market_data.
  await run('buildMarketDataResult: no price stays blocked', () => {
    const r = buildMarketDataResult(verifiedContract(), { ticks: {}, marketDataType: 1, receivedAt: FRESH }, { now: NOW });
    assert.strictEqual(r.price, null);
    assert.ok(r.marketDataBlockers.includes('no_futures_market_data'));
  });

  // 8. unverified contract -> never priced.
  await run('buildMarketDataResult: unverified contract not priced', () => {
    const r = buildMarketDataResult({ root: 'MES', conId: null, contractMonthVerified: false }, { ticks: { last: 1 }, marketDataType: 1, receivedAt: FRESH }, { now: NOW });
    assert.strictEqual(r.price, null);
    assert.ok(r.marketDataBlockers.includes('no_verified_contract'));
    assert.ok(r.marketDataBlockers.includes('no_futures_market_data'));
  });

  // 9. GATED OFF: connector never called.
  await run('getMarketData gated OFF never calls connector', async () => {
    let called = false;
    const connector = { fetchSnapshot: async () => { called = true; return {}; } };
    const out = await svc.getMarketDataForContracts({ enabled: false, connector, contracts: [verifiedContract()], now: NOW });
    assert.strictEqual(out.gated, true);
    assert.strictEqual(out.source, 'gated_no_ib_query');
    assert.strictEqual(called, false);
    assert.ok(out.prices[0].marketDataBlockers.includes('market_data_disabled'));
  });

  // 10. ENABLED with mock: resolves + closes.
  await run('getMarketData enabled resolves + closes connector', async () => {
    let closed = false;
    const connector = {
      fetchSnapshot: async (c) => ({ ticks: { last: c.root === 'MES' ? 5600.25 : 20500 }, marketDataType: 3, receivedAt: FRESH }),
      close: async () => { closed = true; },
    };
    const out = await svc.getMarketDataForContracts({ enabled: true, connector, contracts: [verifiedContract('MES'), verifiedContract('MNQ')], now: NOW });
    assert.strictEqual(out.enabled, true);
    assert.strictEqual(out.source, 'ib_reqMktData');
    assert.strictEqual(out.prices.length, 2);
    assert.strictEqual(out.prices[0].price, 5600.25);
    assert.strictEqual(out.prices[0].priceType, 'delayed');
    assert.strictEqual(out.prices[0].hasUsablePrice, true);
    assert.strictEqual(closed, true);
  });

  // 11. ENABLED: unverified contract in list is skipped (no fetch).
  await run('getMarketData skips unverified contract without fetching', async () => {
    let fetches = 0;
    const connector = { fetchSnapshot: async (c) => { fetches += 1; return { ticks: { last: 1 }, marketDataType: 1, receivedAt: FRESH }; } };
    const unverified = { root: 'ES', conId: null, contractMonthVerified: false };
    const out = await svc.getMarketDataForContracts({ enabled: true, connector, contracts: [verifiedContract('MES'), unverified], now: NOW });
    assert.strictEqual(fetches, 1, 'only the verified contract is fetched');
    const es = out.prices.find((p) => p.root === 'ES');
    assert.ok(es.marketDataBlockers.includes('no_verified_contract'));
  });

  // 12. ENABLED: per-contract fetch error tolerated.
  await run('getMarketData tolerates per-contract fetch error', async () => {
    const connector = {
      fetchSnapshot: async (c) => { if (c.root === 'MNQ') throw new Error('md boom'); return { ticks: { last: 5600 }, marketDataType: 1, receivedAt: FRESH }; },
    };
    const out = await svc.getMarketDataForContracts({ enabled: true, connector, contracts: [verifiedContract('MES'), verifiedContract('MNQ')], now: NOW });
    const mnq = out.prices.find((p) => p.root === 'MNQ');
    assert.ok(mnq.marketDataBlockers.includes('market_data_unavailable'));
    assert.strictEqual(out.prices.find((p) => p.root === 'MES').hasUsablePrice, true);
  });

  // 13. ENABLED without connector throws.
  await run('getMarketData enabled without connector throws', async () => {
    await assert.rejects(() => svc.getMarketDataForContracts({ enabled: true, connector: null, contracts: [verifiedContract()], now: NOW }));
  });

  // 14. safety flags always false.
  await run('safety flags always false', async () => {
    const out = await svc.getMarketDataForContracts({ enabled: false, contracts: [], now: NOW });
    assert.strictEqual(out.safety.can_place_orders, false);
    assert.strictEqual(out.safety.live_trading_enabled, false);
    assert.strictEqual(out.safety.broker_enabled, false);
    assert.strictEqual(out.safety.actions_allowed, false);
  });

  console.log(`\ninteractiveBrokersFuturesMarketDataService: ${passed} tests passed`);
})().catch((err) => {
  console.error('TEST FAILURE:', err && err.stack ? err.stack : err);
  process.exit(1);
});
