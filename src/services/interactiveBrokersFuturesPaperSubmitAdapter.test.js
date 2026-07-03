'use strict';

const assert = require('assert/strict');
const adapter = require('./interactiveBrokersFuturesPaperSubmitAdapter');

let passed = 0;
async function run(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const ticket = {
  localSymbol: 'MESU6',
  conId: 793356217,
  contractMonth: '202609',
  exchange: 'CME',
  currency: 'USD',
  limitPrice: 7557.25,
};

(async () => {
  await run('buildFuturesContract builds exact futures contract shell', () => {
    assert.deepEqual(adapter.buildFuturesContract(ticket), {
      secType: 'FUT',
      symbol: 'MES',
      localSymbol: 'MESU6',
      conId: 793356217,
      exchange: 'CME',
      currency: 'USD',
      lastTradeDateOrContractMonth: '202609',
    });
  });

  await run('buildFuturesLimitOrder builds exact first-test order', () => {
    assert.deepEqual(adapter.buildFuturesLimitOrder({ ticket, ticketId: 'ticket-1' }), {
      action: 'BUY',
      totalQuantity: 1,
      orderType: 'LMT',
      lmtPrice: 7557.25,
      tif: 'DAY',
      account: 'DUQ565596',
      transmit: true,
      orderRef: 'FAS4.3:ticket-1:MES:DUQ565596',
    });
  });

  await run('submitFuturesPaperOrder is hard-disabled unless allowRealSubmit=true', async () => {
    let calls = 0;
    const out = await adapter.submitFuturesPaperOrder({
      ticket,
      ticketId: 'ticket-1',
      ibClient: { placeOrder: () => { calls += 1; } },
      nextValidIdProvider: () => 1001,
    });
    assert.strictEqual(calls, 0);
    assert.strictEqual(out.placeOrderCalled, false);
    assert.strictEqual(out.blocker, 'futures_real_submit_disabled');
  });

  await run('missing placeOrder blocks without call', async () => {
    const capability = Symbol('test-capability');
    const guarded = adapter.createFuturesPaperSubmitAdapter({ capability });
    const out = await guarded.submitFuturesPaperOrder({
      ticket,
      ticketId: 'ticket-1',
      allowRealSubmit: true,
      capability,
      ibClient: {},
      nextValidIdProvider: () => 1001,
    });
    assert.strictEqual(out.placeOrderCalled, false);
    assert.strictEqual(out.blocker, 'futures_real_submit_place_order_not_available');
  });

  await run('allowRealSubmit without capability blocks before placeOrder', async () => {
    let calls = 0;
    const out = await adapter.submitFuturesPaperOrder({
      ticket,
      ticketId: 'ticket-1',
      allowRealSubmit: true,
      ibClient: { placeOrder: () => { calls += 1; } },
      nextValidIdProvider: () => 1001,
    });
    assert.strictEqual(calls, 0);
    assert.strictEqual(out.placeOrderCalled, false);
    assert.strictEqual(out.submitted, false);
    assert.strictEqual(out.blocker, 'futures_real_submit_adapter_capability_missing');
  });

  await run('allowRealSubmit with wrong capability blocks before placeOrder', async () => {
    let calls = 0;
    const out = await adapter.submitFuturesPaperOrder({
      ticket,
      ticketId: 'ticket-1',
      allowRealSubmit: true,
      capability: Symbol('wrong'),
      ibClient: { placeOrder: () => { calls += 1; } },
      nextValidIdProvider: () => 1001,
    });
    assert.strictEqual(calls, 0);
    assert.strictEqual(out.placeOrderCalled, false);
    assert.strictEqual(out.submitted, false);
    assert.strictEqual(out.blocker, 'futures_real_submit_adapter_capability_missing');
  });

  await run('missing nextValidId blocks before placeOrder', async () => {
    let calls = 0;
    const capability = Symbol('test-capability');
    const guarded = adapter.createFuturesPaperSubmitAdapter({ capability });
    const out = await guarded.submitFuturesPaperOrder({
      ticket,
      ticketId: 'ticket-1',
      allowRealSubmit: true,
      capability,
      ibClient: { placeOrder: () => { calls += 1; } },
    });
    assert.strictEqual(calls, 0);
    assert.strictEqual(out.blocker, 'futures_real_submit_next_valid_id_missing');
  });

  await run('all adapter prerequisites call placeOrder exactly once', async () => {
    let calls = 0;
    const capability = Symbol('test-capability');
    const guarded = adapter.createFuturesPaperSubmitAdapter({ capability });
    const out = await guarded.submitFuturesPaperOrder({
      ticket,
      ticketId: 'ticket-1',
      allowRealSubmit: true,
      capability,
      nextValidIdProvider: () => 1001,
      ibClient: {
        placeOrder: (orderId, contract, order) => {
          calls += 1;
          assert.strictEqual(orderId, 1001);
          assert.strictEqual(contract.localSymbol, 'MESU6');
          assert.strictEqual(order.orderRef, 'FAS4.3:ticket-1:MES:DUQ565596');
          return { accepted: true, status: 'Submitted', permId: 55 };
        },
      },
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(out.placeOrderCalled, true);
    assert.strictEqual(out.submitted, true);
  });

  console.log(`\ninteractiveBrokersFuturesPaperSubmitAdapter: ${passed} tests passed`);
})().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
