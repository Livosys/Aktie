'use strict';

const assert = require('assert');
const svc = require('./interactiveBrokersFuturesContractService');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const ROOTS = ['MES', 'MNQ', 'ES', 'NQ'];

// 1. Shape + read-only envelope.
test('payload is read-only paper_only with expected account', () => {
  const out = svc.buildFuturesContracts();
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.readOnly, true);
  assert.strictEqual(out.mode, 'paper_only');
  assert.strictEqual(out.source, 'static_contract_spec');
  assert.strictEqual(out.account, 'DUQ565596');
});

// 2. Exactly the four primary CME roots, priority-sorted.
test('returns MES, MNQ, ES, NQ in priority order', () => {
  const out = svc.buildFuturesContracts();
  assert.strictEqual(out.contracts.length, 4);
  assert.deepStrictEqual(out.contracts.map((c) => c.root), ROOTS);
  assert.strictEqual(out.counts.total, 4);
});

// 3. Verified static contract parameters (constant per root).
test('static contract params match known CME specs', () => {
  const out = svc.buildFuturesContracts();
  const by = Object.fromEntries(out.contracts.map((c) => [c.root, c]));
  const expected = {
    MES: { multiplier: 5, tickValue: 1.25 },
    MNQ: { multiplier: 2, tickValue: 0.5 },
    ES: { multiplier: 50, tickValue: 12.5 },
    NQ: { multiplier: 20, tickValue: 5 },
  };
  for (const root of ROOTS) {
    const c = by[root];
    assert.strictEqual(c.secType, 'FUT', `${root} secType`);
    assert.strictEqual(c.exchange, 'CME', `${root} exchange`);
    assert.strictEqual(c.currency, 'USD', `${root} currency`);
    assert.strictEqual(c.tradingClass, root, `${root} tradingClass`);
    assert.strictEqual(c.minTick, 0.25, `${root} minTick`);
    assert.strictEqual(c.multiplier, expected[root].multiplier, `${root} multiplier`);
    assert.strictEqual(c.tickValue, expected[root].tickValue, `${root} tickValue`);
    // tickValue must equal multiplier * minTick.
    assert.strictEqual(c.tickValue, c.multiplier * c.minTick, `${root} tickValue==mult*tick`);
  }
});

// 4. Front-month / price are NEVER guessed in Phase 1.
test('expiry + localSymbol unverified, nothing tradable', () => {
  const out = svc.buildFuturesContracts();
  assert.strictEqual(out.counts.tradablePreview, 0);
  for (const c of out.contracts) {
    assert.strictEqual(c.lastTradeDateOrContractMonth, null, `${c.root} expiry`);
    assert.strictEqual(c.contractMonth, null, `${c.root} contractMonth`);
    assert.strictEqual(c.localSymbol, null, `${c.root} localSymbol`);
    assert.strictEqual(c.contractMonthVerified, false, `${c.root} contractMonthVerified`);
    assert.strictEqual(c.isTradablePreview, false, `${c.root} isTradablePreview`);
  }
});

// 5. Blockers present on every contract and globally.
test('mandatory blockers present everywhere', () => {
  const out = svc.buildFuturesContracts();
  const mandatory = ['contract_month_unverified', 'no_futures_market_data', 'futures_execution_not_implemented'];
  for (const b of mandatory) {
    assert.ok(out.globalBlockers.includes(b), `global missing ${b}`);
  }
  for (const c of out.contracts) {
    for (const b of mandatory) {
      assert.ok(c.blockers.includes(b), `${c.root} missing ${b}`);
    }
  }
});

// 6. MES + MNQ are the preferred first-test roots.
test('preferred first-test roots are the micros MES + MNQ', () => {
  const out = svc.buildFuturesContracts();
  assert.deepStrictEqual(out.counts.preferredFirstTest, ['MES', 'MNQ']);
  const by = Object.fromEntries(out.contracts.map((c) => [c.root, c]));
  assert.strictEqual(by.MES.preferredFirstTest, true);
  assert.strictEqual(by.MNQ.preferredFirstTest, true);
  assert.strictEqual(by.ES.preferredFirstTest, false);
  assert.strictEqual(by.NQ.preferredFirstTest, false);
});

// 7. Submit-route gate reflected honestly (default OFF), and shown as a blocker.
test('submit_routes_disabled blocker tracks IB_PAPER_SUBMIT_ROUTES_ENABLED', () => {
  const original = process.env.IB_PAPER_SUBMIT_ROUTES_ENABLED;
  try {
    delete process.env.IB_PAPER_SUBMIT_ROUTES_ENABLED;
    let out = svc.buildFuturesContracts();
    assert.strictEqual(out.submitRoutesEnabled, false);
    assert.ok(out.globalBlockers.includes('submit_routes_disabled'));

    process.env.IB_PAPER_SUBMIT_ROUTES_ENABLED = 'true';
    out = svc.buildFuturesContracts();
    assert.strictEqual(out.submitRoutesEnabled, true);
    assert.ok(!out.globalBlockers.includes('submit_routes_disabled'));
  } finally {
    if (original === undefined) delete process.env.IB_PAPER_SUBMIT_ROUTES_ENABLED;
    else process.env.IB_PAPER_SUBMIT_ROUTES_ENABLED = original;
  }
});

// 8. Safety flags always false.
test('safety flags are always false', () => {
  const out = svc.buildFuturesContracts();
  assert.strictEqual(out.safety.mode, 'paper_only');
  assert.strictEqual(out.safety.actions_allowed, false);
  assert.strictEqual(out.safety.can_place_orders, false);
  assert.strictEqual(out.safety.live_trading_enabled, false);
  assert.strictEqual(out.safety.broker_enabled, false);
});

console.log(`\ninteractiveBrokersFuturesContractService: ${passed} tests passed`);
