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

const NOW = new Date('2026-07-03T19:40:00.000Z');
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

function basePreview(overrides = {}) {
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

function readOnlyState(overrides = {}) {
  return {
    account: 'DUQ565596',
    orderCapable: false,
    openOrders: [],
    positions: [],
    executions: [],
    safety: { ...LOCKED_SAFETY },
    ...overrides,
  };
}

function build(overrides = {}) {
  const preview = overrides.preview || basePreview(overrides.previewOverrides || {});
  return svc.buildFuturesManualSubmitSkeleton({
    preview,
    currentPreview: overrides.currentPreview,
    confirmationPhrase: overrides.confirmationPhrase,
    readOnlyState: overrides.readOnlyState || readOnlyState(),
    ticketStore: overrides.ticketStore,
    idGenerator: overrides.idGenerator || (() => 'ticket-1'),
    nonceGenerator: overrides.nonceGenerator || (() => 'nonce-1'),
    env: overrides.env || {},
    now: overrides.now || NOW,
    ttlMs: overrides.ttlMs,
    ticketId: overrides.ticketId,
    nonce: overrides.nonce,
    submitConnector: overrides.submitConnector,
  });
}

function requiredPhrase(preview = basePreview()) {
  return preview.manualGate.requiredConfirmationPhrase;
}

function assertNeverSubmits(out) {
  assert.strictEqual(out.dryRun, true);
  assert.strictEqual(out.wouldSubmit, false);
  assert.strictEqual(out.submitted, false);
  assert.strictEqual(out.placeOrderCalled, false);
  assert.strictEqual(out.submitOrderCalled, false);
  assert.strictEqual(out.cancelOrderCalled, false);
  assert.strictEqual(out.realSubmitAvailable, false);
  assert.strictEqual(out.futuresSubmitRoutesEnabled, false);
  assert.strictEqual(out.submitRoutesEnabled, false);
  assert.strictEqual(out.readyForManualSubmit, false);
  assert.deepEqual(out.safety, LOCKED_SAFETY);
}

(async () => {
  await run('phase is FAS_4_2_MOCK_PREFLIGHT_NO_REAL_SUBMIT', () => {
    const out = build();
    assert.strictEqual(out.phase, 'FAS_4_2_MOCK_PREFLIGHT_NO_REAL_SUBMIT');
    assert.strictEqual(out.legacyPhase, 'FAS_4_1_SKELETON_NO_REAL_SUBMIT');
    assertNeverSubmits(out);
  });

  await run('no real submit fields are always false', () => {
    const out = build({ confirmationPhrase: requiredPhrase() });
    assertNeverSubmits(out);
  });

  await run('ticketId and nonce are created', () => {
    const out = build();
    assert.strictEqual(out.ticketId, 'ticket-1');
    assert.strictEqual(out.nonce, 'nonce-1');
  });

  await run('expiresAt is created from TTL', () => {
    const out = build({ ttlMs: 60_000 });
    assert.strictEqual(out.expiresAt, '2026-07-03T19:41:00.000Z');
  });

  await run('missing confirmation phrase blocks', () => {
    const out = build();
    assert.ok(out.blockers.includes('confirmation_phrase_missing'));
    assert.strictEqual(out.confirmationPhraseMatched, false);
    assertNeverSubmits(out);
  });

  await run('mismatch confirmation phrase blocks', () => {
    const out = build({ confirmationPhrase: 'PAPER BUY 1 MES LMT 1.00' });
    assert.ok(out.blockers.includes('confirmation_phrase_mismatch'));
    assert.strictEqual(out.confirmationPhraseMatched, false);
    assertNeverSubmits(out);
  });

  await run('correct phrase still has real-submit blockers', () => {
    const out = build({ confirmationPhrase: requiredPhrase() });
    assert.strictEqual(out.confirmationPhraseMatched, true);
    assert.ok(out.blockers.includes('mock_preflight_only'));
    assert.ok(out.blockers.includes('real_submit_not_implemented'));
    assert.ok(out.blockers.includes('no_real_ib_submit_in_phase_4_2'));
    assertNeverSubmits(out);
  });

  await run('forced IB_FUTURES_SUBMIT_ROUTES_ENABLED=true still no real submit', () => {
    const out = build({
      confirmationPhrase: requiredPhrase(),
      env: { IB_FUTURES_SUBMIT_ROUTES_ENABLED: 'true' },
    });
    assert.strictEqual(out.reservedFuturesSubmitFlagEnabled, true);
    assertNeverSubmits(out);
  });

  await run('same ticketId second time is duplicate blocked', () => {
    const store = svc.createMemoryTicketStore();
    const first = build({
      ticketStore: store,
      ticketId: 'ticket-dupe',
      nonce: 'nonce-dupe',
      confirmationPhrase: requiredPhrase(),
      env: { IB_FUTURES_SUBMIT_ROUTES_ENABLED: 'true' },
    });
    assert.strictEqual(first.mockPreflightReady, true);
    const second = build({
      ticketStore: store,
      ticketId: 'ticket-dupe',
      nonce: 'nonce-dupe',
      confirmationPhrase: requiredPhrase(),
      env: { IB_FUTURES_SUBMIT_ROUTES_ENABLED: 'true' },
    });
    assert.ok(second.blockers.includes('duplicate_submit_blocked'));
    assert.ok(second.blockers.includes('ticket_already_submitted'));
    assertNeverSubmits(second);
  });

  await run('expired ticket is stale', () => {
    const out = build({
      confirmationPhrase: requiredPhrase(),
      ttlMs: 1,
      now: new Date('2026-07-03T19:40:00.001Z'),
      ticketStore: {
        get: () => ({ ticketId: 'ticket-old', nonce: 'nonce-1', expiresAt: '2026-07-03T19:39:59.000Z', createdAt: '2026-07-03T19:38:59.000Z' }),
        set: () => {},
        markConsumed: () => {},
      },
      ticketId: 'ticket-old',
    });
    assert.ok(out.blockers.includes('ticket_expired'));
    assert.ok(out.blockers.includes('stale_ticket'));
    assertNeverSubmits(out);
  });

  await run('account mismatch blocks', () => {
    const out = build({ confirmationPhrase: requiredPhrase(), readOnlyState: readOnlyState({ account: 'DUWRONG' }) });
    assert.ok(out.blockers.includes('account_mismatch'));
    assertNeverSubmits(out);
  });

  await run('openOrders > 0 blocks', () => {
    const out = build({ confirmationPhrase: requiredPhrase(), readOnlyState: readOnlyState({ openOrders: [{ orderId: 1 }] }) });
    assert.ok(out.blockers.includes('open_orders_present'));
  });

  await run('positions > 0 blocks', () => {
    const out = build({ confirmationPhrase: requiredPhrase(), readOnlyState: readOnlyState({ positions: [{ symbol: 'MES' }] }) });
    assert.ok(out.blockers.includes('positions_present'));
  });

  await run('executions > 0 blocks', () => {
    const out = build({ confirmationPhrase: requiredPhrase(), readOnlyState: readOnlyState({ executions: [{ execId: 'e1' }] }) });
    assert.ok(out.blockers.includes('recent_executions_present'));
  });

  await run('orderCapable=true blocks', () => {
    const out = build({ confirmationPhrase: requiredPhrase(), readOnlyState: readOnlyState({ orderCapable: true }) });
    assert.ok(out.blockers.includes('order_capable_true_unexpected'));
  });

  await run('contract mismatch blocks', () => {
    const out = build({
      confirmationPhrase: requiredPhrase(),
      currentPreview: basePreview({ contract: verifiedMes({ conId: 999, localSymbol: 'MESZ6' }) }),
    });
    assert.ok(out.blockers.includes('contract_changed'));
    assert.ok(out.blockers.includes('con_id_mismatch'));
  });

  await run('price changed beyond tolerance blocks', () => {
    const out = build({
      confirmationPhrase: requiredPhrase(),
      currentPreview: basePreview({ contract: verifiedMes({ price: 7605.00 }) }),
    });
    assert.ok(out.blockers.includes('price_changed_beyond_tolerance'));
  });

  await run('ES remains blocked', () => {
    const out = build({ previewOverrides: { root: 'ES', contract: verifiedMes({ root: 'ES' }) } });
    assert.ok(out.blockers.includes('symbol_blocked_initial_version'));
    assertNeverSubmits(out);
  });

  await run('quantity=2 remains blocked', () => {
    const out = build({ previewOverrides: { quantity: 2 } });
    assert.ok(out.blockers.includes('quantity_not_exactly_one'));
  });

  await run('MKT remains blocked', () => {
    const out = build({ previewOverrides: { orderType: 'MKT' } });
    assert.ok(out.blockers.includes('order_type_not_allowed'));
  });

  await run('placeOrder mock dependency is never called', () => {
    let placeOrderCalls = 0;
    const out = build({
      confirmationPhrase: requiredPhrase(),
      env: { IB_FUTURES_SUBMIT_ROUTES_ENABLED: 'true' },
      submitConnector: { placeOrder: () => { placeOrderCalls += 1; } },
    });
    assert.strictEqual(placeOrderCalls, 0);
    assertNeverSubmits(out);
  });

  await run('IB_PAPER_SUBMIT_ROUTES_ENABLED true does not open futures submit', () => {
    const out = build({
      confirmationPhrase: requiredPhrase(),
      env: { IB_PAPER_SUBMIT_ROUTES_ENABLED: 'true', IB_FUTURES_SUBMIT_ROUTES_ENABLED: 'true' },
    });
    assert.strictEqual(out.paperSubmitRoutesEnabledObserved, true);
    assertNeverSubmits(out);
  });

  await run('mockPreflightReady can be true while wouldSubmit/submitted stay false', () => {
    const out = build({
      confirmationPhrase: requiredPhrase(),
      env: { IB_FUTURES_SUBMIT_ROUTES_ENABLED: 'true' },
    });
    assert.strictEqual(out.mockPreflightReady, true);
    assert.strictEqual(out.readyForMockSubmit, true);
    assertNeverSubmits(out);
  });

  console.log(`\ninteractiveBrokersFuturesManualSubmitService: ${passed} tests passed`);
})().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
