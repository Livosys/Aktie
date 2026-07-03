'use strict';

const assert = require('assert/strict');
const svc = require('./interactiveBrokersFuturesOrderTicketService');
const { deriveLimitPrice, validateLimitPrice, buildConfirmationPhrase, roundToTick, isTickAligned } = svc._internal;

let passed = 0;
async function run(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const LOCKED_SAFETY = {
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
};

function verifiedMes(overrides = {}) {
  return {
    root: 'MES',
    localSymbol: 'MESU6',
    conId: 793356217,
    contractMonth: '202609',
    exchange: 'CME',
    currency: 'USD',
    contractMonthVerified: true,
    price: 7557.25,
    priceType: 'delayed',
    hasUsablePrice: true,
    minTick: 0.25,
    ...overrides,
  };
}

function baseOpts(overrides = {}) {
  return {
    root: 'MES',
    side: 'BUY',
    quantity: 1,
    contract: verifiedMes(),
    safetyStatus: { ...LOCKED_SAFETY },
    account: 'DUQ565596',
    paperSubmitRoutesEnabled: false,
    ...overrides,
  };
}

const STRUCTURAL = ['futures_submit_routes_not_implemented', 'futures_submit_routes_disabled'];

(async () => {
  await run('price helpers: tick rounding + alignment', () => {
    assert.strictEqual(roundToTick(7557.31, 0.25), 7557.25);
    assert.strictEqual(roundToTick(7557.13, 0.25), 7557.25);
    assert.strictEqual(isTickAligned(7557.25, 0.25), true);
    assert.strictEqual(isTickAligned(7557.30, 0.25), false);
    assert.strictEqual(roundToTick(null, 0.25), null);
  });

  await run('deriveLimitPrice: BUY rests below, SELL above, clamped to max ticks', () => {
    assert.strictEqual(deriveLimitPrice({ referencePrice: 7557.25, minTick: 0.25, side: 'BUY', offsetTicks: 2 }), 7556.75);
    assert.strictEqual(deriveLimitPrice({ referencePrice: 7557.25, minTick: 0.25, side: 'SELL', offsetTicks: 2 }), 7557.75);
    assert.strictEqual(deriveLimitPrice({ referencePrice: 7557.25, minTick: 0.25, side: 'BUY', offsetTicks: 999 }), 7557.25 - svc.MAX_LIMIT_OFFSET_TICKS * 0.25);
    assert.strictEqual(deriveLimitPrice({ referencePrice: 7557.25, minTick: 0.25, side: 'BUY', offsetTicks: -5 }), 7557.25);
    assert.strictEqual(deriveLimitPrice({ referencePrice: null, minTick: 0.25, side: 'BUY' }), null);
  });

  await run('validateLimitPrice: alignment + tick tolerance + pct tolerance', () => {
    assert.deepEqual(validateLimitPrice({ limitPrice: 7557.25, referencePrice: 7557.25, minTick: 0.25 }), []);
    assert.deepEqual(validateLimitPrice({ limitPrice: 7557.30, referencePrice: 7557.25, minTick: 0.25 }), ['limit_price_not_tick_aligned']);
    assert.deepEqual(validateLimitPrice({ limitPrice: 7557.25 - 11 * 0.25, referencePrice: 7557.25, minTick: 0.25 }), ['limit_price_out_of_tolerance']);
    assert.deepEqual(validateLimitPrice({ limitPrice: null, referencePrice: 7557.25, minTick: 0.25 }), ['limit_price_missing']);
    // 0.5% of a 10.00 reference = 0.05, so 3 ticks of 0.25 blows the pct rule
    // even though it is inside the tick rule.
    assert.deepEqual(validateLimitPrice({ limitPrice: 10.75, referencePrice: 10.00, minTick: 0.25 }), ['limit_price_out_of_tolerance']);
  });

  await run('happy path MES BUY 1: ready, only structural locks remain, never submits', () => {
    const t = svc.buildOrderTicket(baseOpts());
    assert.strictEqual(t.readyForManualConfirmation, true);
    assert.deepEqual([...t.blockers].sort(), [...STRUCTURAL].sort());
    assert.strictEqual(t.wouldSubmit, false);
    assert.strictEqual(t.previewOnly, true);
    assert.strictEqual(t.readOnly, true);
    assert.strictEqual(t.ticket.limitPrice, 7557.25);
    assert.strictEqual(t.ticket.orderType, 'LMT');
    assert.strictEqual(t.ticket.quantity, 1);
    assert.strictEqual(t.ticket.account, 'DUQ565596');
    assert.strictEqual(t.submitRoutesEnabled, false);
    assert.strictEqual(t.futuresSubmitRoutesEnabled, false);
  });

  await run('manual gate: phrase required, reported-only, matches when typed exactly', () => {
    const ready = svc.buildOrderTicket(baseOpts());
    assert.strictEqual(ready.manualGate.required, true);
    assert.strictEqual(ready.manualGate.requiredConfirmationPhrase, 'PAPER BUY 1 MES LMT 7557.25');
    assert.strictEqual(ready.manualGate.confirmationMatches, false);
    const typed = svc.buildOrderTicket(baseOpts({ confirmationPhrase: 'PAPER BUY 1 MES LMT 7557.25' }));
    assert.strictEqual(typed.manualGate.confirmationMatches, true);
    assert.strictEqual(typed.wouldSubmit, false); // matching phrase still submits nothing
    const wrong = svc.buildOrderTicket(baseOpts({ confirmationPhrase: 'PAPER BUY 1 MES LMT 9999' }));
    assert.strictEqual(wrong.manualGate.confirmationMatches, false);
  });

  await run('stop rule: ES/NQ explicitly blocked, other symbols not allowed', () => {
    const es = svc.buildOrderTicket(baseOpts({ root: 'ES', contract: verifiedMes({ root: 'ES' }) }));
    assert.ok(es.blockers.includes('symbol_blocked_initial_version'));
    assert.strictEqual(es.readyForManualConfirmation, false);
    const aapl = svc.buildOrderTicket(baseOpts({ root: 'AAPL', contract: verifiedMes({ root: 'AAPL' }) }));
    assert.ok(aapl.blockers.includes('symbol_not_allowed'));
  });

  await run('stop rule: quantity must be exactly 1', () => {
    for (const q of [0, 2, -1, 1.5, null]) {
      const t = svc.buildOrderTicket(baseOpts({ quantity: q }));
      assert.ok(t.blockers.includes('quantity_not_exactly_one'), `q=${q}`);
      assert.strictEqual(t.readyForManualConfirmation, false);
    }
  });

  await run('stop rule: contract not verified blocks', () => {
    const t = svc.buildOrderTicket(baseOpts({ contract: verifiedMes({ contractMonthVerified: false }) }));
    assert.ok(t.blockers.includes('contract_not_verified'));
    assert.strictEqual(t.readyForManualConfirmation, false);
  });

  await run('stop rule: no usable/delayed price blocks', () => {
    const noPrice = svc.buildOrderTicket(baseOpts({ contract: verifiedMes({ price: null, hasUsablePrice: false, priceType: null }) }));
    assert.ok(noPrice.blockers.includes('no_usable_price'));
    const stale = svc.buildOrderTicket(baseOpts({ contract: verifiedMes({ priceType: 'frozen' }) }));
    assert.ok(stale.blockers.includes('price_type_not_allowed'));
    assert.strictEqual(stale.readyForManualConfirmation, false);
  });

  await run('stop rule: wrong account blocks', () => {
    const t = svc.buildOrderTicket(baseOpts({ account: 'U9999999' }));
    assert.ok(t.blockers.includes('account_mismatch'));
    assert.strictEqual(t.readyForManualConfirmation, false);
  });

  await run('stop rule: safety drift blocks (any flag off-lock)', () => {
    for (const drift of [
      { live_trading_enabled: true },
      { broker_enabled: true },
      { can_place_orders: true },
      { actions_allowed: true },
      { mode: 'live' },
    ]) {
      const t = svc.buildOrderTicket(baseOpts({ safetyStatus: { ...LOCKED_SAFETY, ...drift } }));
      assert.ok(t.blockers.includes('safety_state_changed'), JSON.stringify(drift));
      assert.strictEqual(t.readyForManualConfirmation, false);
    }
    const missing = svc.buildOrderTicket(baseOpts({ safetyStatus: null }));
    assert.ok(missing.blockers.includes('safety_state_changed'));
  });

  await run('stop rule: market order not allowed, side must be explicit', () => {
    const mkt = svc.buildOrderTicket(baseOpts({ orderType: 'MKT' }));
    assert.ok(mkt.blockers.includes('order_type_not_allowed'));
    const noSide = svc.buildOrderTicket(baseOpts({ side: null }));
    assert.ok(noSide.blockers.includes('side_invalid'));
    const badSide = svc.buildOrderTicket(baseOpts({ side: 'LONGISH' }));
    assert.ok(badSide.blockers.includes('side_invalid'));
  });

  await run('stop rule: explicit limit outside tolerance blocks', () => {
    const t = svc.buildOrderTicket(baseOpts({ limitPrice: 7557.25 - 20 * 0.25 }));
    assert.ok(t.blockers.includes('limit_price_out_of_tolerance'));
    assert.strictEqual(t.readyForManualConfirmation, false);
  });

  await run('structural locks always present; flag env is reported-only', () => {
    const t = svc.buildOrderTicket(baseOpts());
    assert.ok(t.blockers.includes('futures_submit_routes_not_implemented'));
    assert.ok(t.blockers.includes('futures_submit_routes_disabled'));
    assert.strictEqual(t.futuresSubmitRoutesEnabled, false);
    // Even with the reserved flag forced on, nothing submits and the
    // not-implemented lock stays.
    process.env[svc.FUTURES_SUBMIT_FLAG] = 'true';
    try {
      const on = svc.buildOrderTicket(baseOpts());
      assert.strictEqual(on.futuresSubmitRoutesEnabled, true);
      assert.ok(on.blockers.includes('futures_submit_routes_not_implemented'));
      assert.strictEqual(on.wouldSubmit, false);
    } finally {
      delete process.env[svc.FUTURES_SUBMIT_FLAG];
    }
  });

  await run('contract mismatch/missing blocks', () => {
    const missing = svc.buildOrderTicket(baseOpts({ contract: null }));
    assert.ok(missing.blockers.includes('contract_not_found'));
    const wrongRoot = svc.buildOrderTicket(baseOpts({ contract: verifiedMes({ root: 'MNQ' }) }));
    assert.ok(wrongRoot.blockers.includes('contract_not_found'));
  });

  await run('safety flags always false in payload', () => {
    const t = svc.buildOrderTicket(baseOpts());
    assert.deepEqual(t.safety, LOCKED_SAFETY);
    assert.deepEqual(svc.SAFETY, LOCKED_SAFETY);
  });

  console.log(`\ninteractiveBrokersFuturesOrderTicketService: ${passed} tests passed`);
})().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
