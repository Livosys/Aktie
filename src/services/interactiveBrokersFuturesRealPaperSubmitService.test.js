'use strict';

const assert = require('assert/strict');
const orderTicketService = require('./interactiveBrokersFuturesOrderTicketService');
const svc = require('./interactiveBrokersFuturesRealPaperSubmitService');

let passed = 0;
async function run(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const NOW = new Date('2026-07-03T20:00:00.000Z');
const LOCKED_SAFETY = {
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
};
const GOOD_ENV = {
  IB_FUTURES_SUBMIT_ROUTES_ENABLED: 'true',
  IB_FUTURES_REAL_PAPER_SUBMIT_ENABLED: 'true',
  IB_FUTURES_FIRST_REAL_SUBMIT_SYMBOL: 'MES',
  IB_FUTURES_FIRST_REAL_SUBMIT_QTY: '1',
  IB_FUTURES_FIRST_REAL_SUBMIT_ACCOUNT: 'DUQ565596',
  IB_FUTURES_FIRST_REAL_SUBMIT_REQUIRE_REALTIME: 'true',
};

function contract(overrides = {}) {
  return {
    root: 'MES',
    localSymbol: 'MESU6',
    conId: 793356217,
    contractMonth: '202609',
    exchange: 'CME',
    currency: 'USD',
    contractMonthVerified: true,
    price: 7557.25,
    priceType: 'realtime',
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
    contract: contract(),
    safetyStatus: { ...LOCKED_SAFETY },
    account: 'DUQ565596',
    paperSubmitRoutesEnabled: false,
    now: NOW,
    ...overrides,
  });
}

function readOnlyState(overrides = {}) {
  return {
    ok: true,
    connected: true,
    sessionVerified: true,
    paperAccountVerified: true,
    account: 'DUQ565596',
    managedAccounts: ['DUQ565596'],
    orderCapable: false,
    openOrders: [],
    positions: [],
    executions: [],
    safety: { ...LOCKED_SAFETY },
    ...overrides,
  };
}

function acceptedAdapter(counter = { calls: 0 }) {
  return {
    submitFuturesPaperOrder: async ({ ticket, ticketId, allowRealSubmit, capability }) => {
      assert.strictEqual(allowRealSubmit, true);
      assert.ok(capability);
      counter.calls += 1;
      return {
        accepted: true,
        status: 'Submitted',
        placeOrderCalled: true,
        orderId: 1001,
        permId: 9001,
        orderRef: `FAS4.3:${ticketId}:MES:DUQ565596`,
        order: { action: 'BUY', totalQuantity: 1, orderType: 'LMT', lmtPrice: ticket.limitPrice, tif: 'DAY', account: 'DUQ565596', transmit: true },
      };
    },
  };
}

function timeoutAdapter(counter = { calls: 0 }) {
  return {
    submitFuturesPaperOrder: async () => {
      counter.calls += 1;
      return { accepted: false, status: 'Timeout', placeOrderCalled: true };
    },
  };
}

async function build(overrides = {}) {
  const p = overrides.preview || preview(overrides.previewOverrides || {});
  const ticketId = overrides.ticketId || 'ticket-1';
  const nonce = overrides.nonce || 'nonce-1';
  const phrase = overrides.confirmationPhrase === undefined
    ? svc.buildRealPaperConfirmationPhrase({ ticket: p.ticket, ticketId, nonce })
    : overrides.confirmationPhrase;
  return svc.buildFuturesRealPaperSubmitResponse({
    preview: p,
    currentPreview: Object.prototype.hasOwnProperty.call(overrides, 'currentPreview') ? overrides.currentPreview : p,
    confirmationPhrase: phrase,
    readOnlyState: overrides.readOnlyState || readOnlyState(),
    ticketStore: overrides.ticketStore,
    idGenerator: () => ticketId,
    nonceGenerator: () => nonce,
    env: overrides.env || GOOD_ENV,
    now: overrides.now || NOW,
    ttlMs: overrides.ttlMs,
    priceMaxAgeMs: overrides.priceMaxAgeMs,
    ticketId: overrides.ticketId,
    nonce: overrides.nonce,
    adapter: overrides.adapter || acceptedAdapter(),
    requireRealtime: overrides.requireRealtime,
  });
}

function assertNoSubmit(out) {
  assert.strictEqual(out.wouldSubmit, false);
  assert.strictEqual(out.submitted, false);
  assert.strictEqual(out.placeOrderCalled, false);
  assert.strictEqual(out.submitOrderCalled, false);
  assert.strictEqual(out.cancelOrderCalled, false);
  assert.strictEqual(out.realSubmitAvailable, false);
  assert.strictEqual(out.readyForRealPaperSubmit, false);
  assert.strictEqual(out.noRetry, true);
  assert.strictEqual(out.noCancel, true);
}

(async () => {
  await run('default flags off block real submit', async () => {
    let calls = 0;
    const out = await build({ env: {}, adapter: { submitFuturesPaperOrder: async () => { calls += 1; } } });
    assert.ok(out.blockers.includes('futures_real_submit_disabled'));
    assert.ok(out.blockers.includes('futures_real_submit_not_armed'));
    assert.strictEqual(calls, 0);
    assertNoSubmit(out);
  });

  await run('IB_PAPER_SUBMIT_ROUTES_ENABLED true does not open futures real submit', async () => {
    const out = await build({ env: { IB_PAPER_SUBMIT_ROUTES_ENABLED: 'true' } });
    assert.strictEqual(out.paperSubmitRoutesEnabledObserved, true);
    assert.ok(out.blockers.includes('futures_real_submit_disabled'));
    assertNoSubmit(out);
  });

  await run('missing futures submit flag blocks', async () => {
    const env = { ...GOOD_ENV, IB_FUTURES_SUBMIT_ROUTES_ENABLED: 'false' };
    const out = await build({ env });
    assert.ok(out.blockers.includes('futures_real_submit_disabled'));
    assertNoSubmit(out);
  });

  await run('missing real paper flag blocks', async () => {
    const env = { ...GOOD_ENV, IB_FUTURES_REAL_PAPER_SUBMIT_ENABLED: 'false' };
    const out = await build({ env });
    assert.ok(out.blockers.includes('futures_real_submit_not_armed'));
    assertNoSubmit(out);
  });

  await run('wrong first-real env symbol blocks', async () => {
    const out = await build({ env: { ...GOOD_ENV, IB_FUTURES_FIRST_REAL_SUBMIT_SYMBOL: 'MNQ' } });
    assert.ok(out.blockers.includes('futures_real_submit_symbol_not_mes'));
    assertNoSubmit(out);
  });

  await run('wrong first-real env account blocks', async () => {
    const out = await build({ env: { ...GOOD_ENV, IB_FUTURES_FIRST_REAL_SUBMIT_ACCOUNT: 'DUWRONG' } });
    assert.ok(out.blockers.includes('futures_real_submit_wrong_account'));
    assertNoSubmit(out);
  });

  await run('wrong first-real env qty blocks', async () => {
    const out = await build({ env: { ...GOOD_ENV, IB_FUTURES_FIRST_REAL_SUBMIT_QTY: '2' } });
    assert.ok(out.blockers.includes('futures_real_submit_qty_not_one'));
    assertNoSubmit(out);
  });

  await run('MNQ blocks real initial scope', async () => {
    const out = await build({ preview: preview({ root: 'MNQ', contract: contract({ root: 'MNQ', localSymbol: 'MNQU6', conId: 793356225 }) }) });
    assert.ok(out.blockers.includes('futures_real_submit_symbol_not_mes'));
    assertNoSubmit(out);
  });

  await run('ES/NQ blocks real initial scope', async () => {
    const es = await build({ preview: preview({ root: 'ES', contract: contract({ root: 'ES', localSymbol: 'ESU6' }) }) });
    assert.ok(es.blockers.includes('futures_real_submit_symbol_not_mes'));
    const nq = await build({ preview: preview({ root: 'NQ', contract: contract({ root: 'NQ', localSymbol: 'NQU6' }) }) });
    assert.ok(nq.blockers.includes('futures_real_submit_symbol_not_mes'));
  });

  await run('SELL blocks', async () => {
    const out = await build({ previewOverrides: { side: 'SELL' } });
    assert.ok(out.blockers.includes('futures_real_submit_side_not_buy'));
    assertNoSubmit(out);
  });

  await run('qty 2 blocks', async () => {
    const out = await build({ previewOverrides: { quantity: 2 } });
    assert.ok(out.blockers.includes('futures_real_submit_qty_not_one'));
    assertNoSubmit(out);
  });

  await run('MKT blocks', async () => {
    const out = await build({ previewOverrides: { orderType: 'MKT' } });
    assert.ok(out.blockers.includes('futures_real_submit_order_type_not_lmt'));
    assertNoSubmit(out);
  });

  await run('TIF not DAY blocks', async () => {
    const p = preview();
    p.ticket.timeInForce = 'GTC';
    const out = await build({ preview: p });
    assert.ok(out.blockers.includes('futures_real_submit_tif_not_day'));
    assertNoSubmit(out);
  });

  await run('wrong runtime account blocks', async () => {
    const out = await build({ readOnlyState: readOnlyState({ account: 'DUWRONG' }) });
    assert.ok(out.blockers.includes('futures_real_submit_wrong_account'));
  });

  await run('managed account missing blocks', async () => {
    const out = await build({ readOnlyState: readOnlyState({ managedAccounts: [] }) });
    assert.ok(out.blockers.includes('futures_real_submit_managed_account_missing'));
  });

  await run('gateway/session not verified blocks', async () => {
    const out = await build({ readOnlyState: readOnlyState({ connected: false, sessionVerified: false }) });
    assert.ok(out.blockers.includes('futures_real_submit_gateway_not_verified'));
  });

  await run('paper account not verified blocks', async () => {
    const out = await build({ readOnlyState: readOnlyState({ paperAccountVerified: false }) });
    assert.ok(out.blockers.includes('futures_real_submit_paper_account_not_verified'));
  });

  await run('openOrders present blocks', async () => {
    const out = await build({ readOnlyState: readOnlyState({ openOrders: [{ orderId: 1 }] }) });
    assert.ok(out.blockers.includes('futures_real_submit_open_orders_present'));
  });

  await run('positions present blocks', async () => {
    const out = await build({ readOnlyState: readOnlyState({ positions: [{ symbol: 'MES' }] }) });
    assert.ok(out.blockers.includes('futures_real_submit_positions_present'));
  });

  await run('executions present blocks', async () => {
    const out = await build({ readOnlyState: readOnlyState({ executions: [{ execId: 'e1' }] }) });
    assert.ok(out.blockers.includes('futures_real_submit_recent_executions_present'));
  });

  await run('orderCapable true blocks', async () => {
    const out = await build({ readOnlyState: readOnlyState({ orderCapable: true }) });
    assert.ok(out.blockers.includes('futures_real_submit_order_capable_true_unexpected'));
  });

  await run('global safety changed blocks', async () => {
    const out = await build({ readOnlyState: readOnlyState({ safety: { ...LOCKED_SAFETY, can_place_orders: true } }) });
    assert.ok(out.blockers.includes('futures_real_submit_global_safety_changed'));
  });

  await run('conId mismatch blocks', async () => {
    const out = await build({ currentPreview: preview({ contract: contract({ conId: 999 }) }) });
    assert.ok(out.blockers.includes('futures_real_submit_con_id_mismatch'));
  });

  await run('localSymbol mismatch blocks', async () => {
    const out = await build({ currentPreview: preview({ contract: contract({ localSymbol: 'MESZ6' }) }) });
    assert.ok(out.blockers.includes('futures_real_submit_local_symbol_mismatch'));
  });

  await run('contractMonth mismatch blocks', async () => {
    const out = await build({ currentPreview: preview({ contract: contract({ contractMonth: '202612' }) }) });
    assert.ok(out.blockers.includes('futures_real_submit_contract_month_mismatch'));
  });

  await run('unverified contract blocks', async () => {
    const out = await build({ previewOverrides: { contract: contract({ contractMonthVerified: false }) } });
    assert.ok(out.blockers.includes('futures_real_submit_contract_not_verified'));
  });

  await run('no usable price blocks', async () => {
    const out = await build({ previewOverrides: { contract: contract({ hasUsablePrice: false, price: null }) } });
    assert.ok(out.blockers.includes('futures_real_submit_no_usable_price'));
  });

  await run('missing minTick blocks', async () => {
    const out = await build({ previewOverrides: { contract: contract({ minTick: null }) } });
    assert.ok(out.blockers.includes('futures_real_submit_min_tick_unknown'));
  });

  await run('missing limitPrice blocks', async () => {
    const p = preview();
    p.ticket.limitPrice = null;
    const out = await build({ preview: p });
    assert.ok(out.blockers.includes('futures_real_submit_limit_price_missing'));
  });

  await run('limitPrice not tick aligned blocks', async () => {
    const p = preview();
    p.ticket.limitPrice = 7557.13;
    const out = await build({ preview: p });
    assert.ok(out.blockers.includes('futures_real_submit_limit_price_not_tick_aligned'));
  });

  await run('price stale blocks', async () => {
    const out = await build({ now: new Date('2026-07-03T20:01:00.001Z'), priceMaxAgeMs: 30_000 });
    assert.ok(out.blockers.includes('futures_real_submit_price_stale'));
  });

  await run('price tolerance blocks', async () => {
    const out = await build({ currentPreview: preview({ contract: contract({ price: 7600 }) }) });
    assert.ok(out.blockers.includes('futures_real_submit_price_out_of_tolerance'));
  });

  await run('missing currentPreview blocks before adapter', async () => {
    let calls = 0;
    const out = await build({
      currentPreview: null,
      adapter: { submitFuturesPaperOrder: async () => { calls += 1; } },
    });
    assert.strictEqual(calls, 0);
    assert.ok(out.blockers.includes('futures_real_submit_current_preview_missing'));
    assertNoSubmit(out);
  });

  await run('delayed price blocks by default', async () => {
    const out = await build({ previewOverrides: { contract: contract({ priceType: 'delayed' }) } });
    assert.ok(out.blockers.includes('futures_real_submit_delayed_data_blocked'));
    assertNoSubmit(out);
  });

  await run('missing confirmation phrase blocks', async () => {
    const out = await build({ confirmationPhrase: '' });
    assert.ok(out.blockers.includes('futures_real_submit_confirmation_missing'));
    assertNoSubmit(out);
  });

  await run('mismatch confirmation phrase blocks', async () => {
    const out = await build({ confirmationPhrase: 'REAL PAPER WRONG' });
    assert.ok(out.blockers.includes('futures_real_submit_confirmation_mismatch'));
    assertNoSubmit(out);
  });

  await run('expired ticket blocks', async () => {
    const out = await build({
      now: new Date('2026-07-03T20:00:01.000Z'),
      ticketStore: {
        get: () => ({ ticketId: 'ticket-1', nonce: 'nonce-1', createdAt: NOW.toISOString(), expiresAt: '2026-07-03T19:59:59.000Z' }),
        set: () => {},
        markConsumed: () => {},
      },
    });
    assert.ok(out.blockers.includes('futures_real_submit_ticket_expired'));
  });

  await run('duplicate ticket blocks', async () => {
    const store = svc.createMemoryTicketStore();
    const first = await build({ ticketStore: store });
    assert.strictEqual(first.submitted, true);
    const second = await build({ ticketStore: store });
    assert.ok(second.blockers.includes('futures_real_submit_duplicate_ticket'));
    assertNoSubmit(second);
  });

  await run('placeOrder mock is never called when any gate falls', async () => {
    let calls = 0;
    const out = await build({
      env: {},
      adapter: { submitFuturesPaperOrder: async () => { calls += 1; } },
    });
    assert.strictEqual(calls, 0);
    assertNoSubmit(out);
  });

  await run('all gates green with realtime calls placeOrder mock exactly once', async () => {
    const counter = { calls: 0 };
    const out = await build({ adapter: acceptedAdapter(counter) });
    assert.strictEqual(counter.calls, 1);
    assert.strictEqual(out.placeOrderCalled, true);
    assert.strictEqual(out.submitted, true);
    assert.strictEqual(out.readyForRealPaperSubmit, true);
    assert.strictEqual(out.audit.orderRef, 'FAS4.3:ticket-1:MES:DUQ565596');
    assert.strictEqual(out.audit.noRetry, true);
    assert.strictEqual(out.audit.noCancel, true);
  });

  await run('nextValidId missing blocks through adapter and does not submit', async () => {
    const out = await build({
      adapter: {
        submitFuturesPaperOrder: async () => ({
          accepted: false,
          submitted: false,
          placeOrderCalled: false,
          blocker: 'futures_real_submit_next_valid_id_missing',
        }),
      },
    });
    assert.ok(out.blockers.includes('futures_real_submit_next_valid_id_missing'));
    assertNoSubmit(out);
  });

  await run('adapter timeout returns uncertain state with no retry/cancel', async () => {
    const counter = { calls: 0 };
    const out = await build({ adapter: timeoutAdapter(counter) });
    assert.strictEqual(counter.calls, 1);
    assert.strictEqual(out.submitted, false);
    assert.strictEqual(out.placeOrderCalled, true);
    assert.ok(out.blockers.includes('futures_real_submit_uncertain_submit_state'));
    assert.strictEqual(out.noRetry, true);
    assert.strictEqual(out.noCancel, true);
  });

  await run('accepted ack is the only submitted=true path in mock', async () => {
    const out = await build();
    assert.strictEqual(out.submitted, true);
    assert.strictEqual(out.adapterResultSummary.status, 'Submitted');
  });

  await run('orderRef format is exact', async () => {
    const out = await build();
    assert.strictEqual(out.audit.orderRef, 'FAS4.3:ticket-1:MES:DUQ565596');
  });

  await run('order object summary is exact in mock accepted adapter', async () => {
    const out = await build();
    assert.strictEqual(out.adapterResultSummary.accepted, true);
    assert.strictEqual(out.audit.root, 'MES');
    assert.strictEqual(out.audit.side, 'BUY');
    assert.strictEqual(out.audit.quantity, 1);
    assert.strictEqual(out.audit.orderType, 'LMT');
    assert.strictEqual(out.audit.tif, 'DAY');
    assert.strictEqual(out.audit.account, 'DUQ565596');
  });

  await run('cancel is never reported called', async () => {
    const out = await build();
    assert.strictEqual(out.cancelOrderCalled, false);
    assert.strictEqual(out.noCancel, true);
  });

  await run('retry is never enabled', async () => {
    const out = await build();
    assert.strictEqual(out.noRetry, true);
  });

  await run('requireRealtime=false allows delayed only when explicitly injected', async () => {
    const out = await build({
      previewOverrides: { contract: contract({ priceType: 'delayed' }) },
      requireRealtime: false,
      env: { ...GOOD_ENV, IB_FUTURES_FIRST_REAL_SUBMIT_REQUIRE_REALTIME: 'false' },
    });
    assert.strictEqual(out.blockers.includes('futures_real_submit_delayed_data_blocked'), false);
    assert.strictEqual(out.submitted, true);
  });

  console.log(`\ninteractiveBrokersFuturesRealPaperSubmitService: ${passed} tests passed`);
})().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
