'use strict';

const assert = require('assert/strict');
const orderTicketService = require('./interactiveBrokersFuturesOrderTicketService');
const svc = require('./interactiveBrokersFuturesManualSubmitService');

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

function preview(overrides = {}) {
  return orderTicketService.buildOrderTicket({
    root: 'MES',
    side: 'BUY',
    quantity: 1,
    orderType: 'LMT',
    contract: verifiedMes(),
    safetyStatus: { ...LOCKED_SAFETY },
    account: 'DUQ565596',
    paperSubmitRoutesEnabled: false,
    ...overrides,
  });
}

function skeleton(overrides = {}) {
  return svc.buildFuturesManualSubmitSkeleton({
    preview: preview(overrides.preview || {}),
    confirmationPhrase: overrides.confirmationPhrase,
    env: overrides.env || {},
  });
}

function assertNeverSubmits(out) {
  assert.strictEqual(out.dryRun, true);
  assert.strictEqual(out.wouldSubmit, false);
  assert.strictEqual(out.submitted, false);
  assert.strictEqual(out.placeOrderCalled, false);
  assert.strictEqual(out.submitOrderCalled, false);
  assert.strictEqual(out.cancelOrderCalled, false);
  assert.strictEqual(out.futuresSubmitRoutesEnabled, false);
  assert.strictEqual(out.submitRoutesEnabled, false);
  assert.strictEqual(out.readyForManualSubmit, false);
  assert.deepEqual(out.safety, LOCKED_SAFETY);
}

(async () => {
  await run('flag off -> submitted=false, wouldSubmit=false, placeOrderCalled=false', () => {
    const out = skeleton();
    assertNeverSubmits(out);
    assert.ok(out.blockers.includes('futures_submit_routes_disabled'));
    assert.ok(out.blockers.includes('futures_submit_skeleton_only'));
    assert.ok(out.blockers.includes('real_submit_not_implemented'));
  });

  await run('confirmation missing -> confirmation_phrase_missing', () => {
    const out = skeleton();
    assert.ok(out.blockers.includes('confirmation_phrase_missing'));
    assert.strictEqual(out.confirmationPhraseProvided, false);
    assert.strictEqual(out.confirmationPhraseMatched, false);
    assertNeverSubmits(out);
  });

  await run('confirmation mismatch -> confirmation_phrase_mismatch', () => {
    const out = skeleton({ confirmationPhrase: 'PAPER BUY 1 MES LMT 1.00' });
    assert.ok(out.blockers.includes('confirmation_phrase_mismatch'));
    assert.strictEqual(out.confirmationPhraseProvided, true);
    assert.strictEqual(out.confirmationPhraseMatched, false);
    assertNeverSubmits(out);
  });

  await run('correct phrase but flag off -> still no submit', () => {
    const p = preview();
    const out = svc.buildFuturesManualSubmitSkeleton({
      preview: p,
      confirmationPhrase: p.manualGate.requiredConfirmationPhrase,
      env: {},
    });
    assert.strictEqual(out.confirmationPhraseMatched, true);
    assert.ok(out.blockers.includes('futures_submit_routes_disabled'));
    assertNeverSubmits(out);
  });

  await run('correct phrase and forced futures flag true -> still no submit in FAS 4.1', () => {
    const p = preview();
    const out = svc.buildFuturesManualSubmitSkeleton({
      preview: p,
      confirmationPhrase: p.manualGate.requiredConfirmationPhrase,
      env: { IB_FUTURES_SUBMIT_ROUTES_ENABLED: 'true' },
    });
    assert.strictEqual(out.reservedFuturesSubmitFlagEnabled, true);
    assert.strictEqual(out.confirmationPhraseMatched, true);
    assert.ok(out.blockers.includes('futures_submit_skeleton_only'));
    assert.ok(out.blockers.includes('real_submit_not_implemented'));
    assertNeverSubmits(out);
  });

  await run('ES -> symbol_blocked_initial_version', () => {
    const out = skeleton({ preview: { root: 'ES', contract: verifiedMes({ root: 'ES' }) } });
    assert.ok(out.blockers.includes('symbol_blocked_initial_version'));
    assertNeverSubmits(out);
  });

  await run('quantity=2 -> quantity_not_exactly_one', () => {
    const out = skeleton({ preview: { quantity: 2 } });
    assert.ok(out.blockers.includes('quantity_not_exactly_one'));
    assertNeverSubmits(out);
  });

  await run('MKT -> order_type_not_allowed', () => {
    const out = skeleton({ preview: { orderType: 'MKT' } });
    assert.ok(out.blockers.includes('order_type_not_allowed'));
    assertNeverSubmits(out);
  });

  await run('preview not ready -> no submit', () => {
    const out = skeleton({ preview: { contract: verifiedMes({ contractMonthVerified: false }) } });
    assert.ok(out.blockers.includes('contract_not_verified'));
    assert.strictEqual(out.preview.readyForManualConfirmation, false);
    assertNeverSubmits(out);
  });

  await run('connector/mock placeOrder is never called', () => {
    let placeOrderCalls = 0;
    const p = preview();
    const out = svc.buildFuturesManualSubmitSkeleton({
      preview: p,
      confirmationPhrase: p.manualGate.requiredConfirmationPhrase,
      env: { IB_FUTURES_SUBMIT_ROUTES_ENABLED: 'true' },
      submitConnector: { placeOrder: () => { placeOrderCalls += 1; } },
    });
    assert.strictEqual(placeOrderCalls, 0);
    assertNeverSubmits(out);
  });

  await run('IB_PAPER_SUBMIT_ROUTES_ENABLED true/false never opens futures submit', () => {
    const p = preview();
    for (const value of ['true', 'false', undefined]) {
      const env = { IB_FUTURES_SUBMIT_ROUTES_ENABLED: 'true' };
      if (value !== undefined) env.IB_PAPER_SUBMIT_ROUTES_ENABLED = value;
      const out = svc.buildFuturesManualSubmitSkeleton({
        preview: p,
        confirmationPhrase: p.manualGate.requiredConfirmationPhrase,
        env,
      });
      assert.strictEqual(out.paperSubmitRoutesEnabledObserved, value === 'true');
      assertNeverSubmits(out);
    }
  });

  await run('response contains phase FAS_4_1_SKELETON_NO_REAL_SUBMIT', () => {
    const out = skeleton();
    assert.strictEqual(out.phase, 'FAS_4_1_SKELETON_NO_REAL_SUBMIT');
    assertNeverSubmits(out);
  });

  console.log(`\ninteractiveBrokersFuturesManualSubmitService: ${passed} tests passed`);
})().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
