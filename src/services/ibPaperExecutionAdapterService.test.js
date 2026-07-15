'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { EventName } = require('@stoqey/ib');
const adapterModule = require('./ibPaperExecutionAdapterService');

class FakeIB extends EventEmitter {
  constructor() {
    super();
    this.placeOrderCalls = [];
    this.cancelOrderCalls = [];
  }

  connect() {
    setImmediate(() => {
      this.emit(EventName.managedAccounts, 'DUQ565596');
      this.emit(EventName.nextValidId, 9000);
    });
  }

  disconnect() {
    this.emit(EventName.disconnected);
  }

  placeOrder(orderId, contract, order) {
    this.placeOrderCalls.push({ orderId, contract, order });
  }

  cancelOrder(orderId) {
    this.cancelOrderCalls.push(orderId);
  }
}

let flags = {
  executionEnabled: true,
  shadowMode: true,
  submissionEnabled: false,
  orderSubmissionMode: 'shadow',
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
};
const fake = new FakeIB();
const service = adapterModule.createIbPaperExecutionAdapterService({
  ibFactory: () => fake,
  flagsProvider: () => flags,
  connectTimeoutMs: 1000,
});

(async () => {
  assert.equal(adapterModule.normalizeIbStatus('Submitted', 1, 1), 'partially_filled');
  assert.equal(adapterModule.normalizeIbStatus('Filled', 1, 0), 'filled');
  assert.equal(adapterModule.normalizeIbStatus('Unexpected', 0, 1), 'unknown');

  const connected = await service.connectPaperExecutionClient();
  assert.equal(connected.ok, true);
  assert.equal(service.getStatus().nextValidIdReady, true);
  assert.equal(service.verifyPaperAccount('DU***596').ok, true);

  const orderPlan = service.buildOrderPlan({
    executionId: 'fxp_test_1234567890',
    contract: {
      root: 'MNQ',
      conId: 793356225,
      localSymbol: 'MNQU6',
      expiry: '20260918',
      exchange: 'CME',
      currency: 'USD',
    },
    side: 'long',
    quantity: 1,
    entryType: 'MKT',
    stopLossPrice: 22980,
    takeProfitPrice: 23040,
  });

  assert.deepEqual(orderPlan.transmitSequence, ['entry:false', 'stopLoss:false', 'takeProfit:true']);
  assert.equal(orderPlan.entry.transmit, false);
  assert.equal(orderPlan.stopLoss.transmit, false);
  assert.equal(orderPlan.takeProfit.transmit, true);
  assert.equal(orderPlan.stopLoss.ocaGroup, orderPlan.takeProfit.ocaGroup);

  const shadowRefusal = await service.submitPaperOrder({
    guardDecision: { allowed: true },
    intentRecord: { idempotencyKey: 'idem-1' },
    orderPlan,
    verifiedAccount: { ok: true, classification: 'paper', accountIdMasked: 'DU***596' },
  });
  assert.equal(shadowRefusal.submitted, false);
  assert.equal(shadowRefusal.blocker, 'shadow_mode_active_no_submit');
  assert.equal(fake.placeOrderCalls.length, 0);

  flags = {
    ...flags,
    shadowMode: false,
    submissionEnabled: true,
    orderSubmissionMode: 'paper_pilot',
  };
  const guardDecision = {
    allowed: true,
    environment: 'paper',
    verifiedPaperAccount: true,
    liveAccountBlocked: true,
  };
  const verifiedAccount = { ok: true, classification: 'paper', accountIdMasked: 'DU***596' };
  const submit = await service.submitPaperOrder({
    guardDecision,
    intentRecord: { idempotencyKey: 'idem-1', executionId: 'fxp_test_1234567890' },
    orderPlan,
    verifiedAccount,
  });
  assert.equal(submit.submitted, true);
  assert.equal(submit.parentOrderId, 9000);
  assert.equal(fake.placeOrderCalls.length, 3);
  assert.deepEqual(fake.placeOrderCalls.map((call) => call.orderId), [9000, 9001, 9002]);
  assert.deepEqual(fake.placeOrderCalls.map((call) => call.order.transmit), [false, false, true]);
  assert.equal(fake.placeOrderCalls[1].order.parentId, 9000);
  assert.equal(fake.placeOrderCalls[2].order.parentId, 9000);
  assert.equal(fake.placeOrderCalls[0].order.account, 'DUQ565596');
  assert.equal(service.getStatus().nextOrderId, 9003);

  fake.emit(EventName.orderStatus, 9000, 'Submitted', 0, 1, 0, 777, 0, 0);
  assert.equal(service.getPaperOrderStatus(9000).status, 'submitted');
  fake.emit(EventName.orderStatus, 9000, 'Submitted', 0.5, 0.5, 23000.25, 777, 0, 23000.25);
  assert.equal(service.getPaperOrderStatus(9000).status, 'partially_filled');

  const cancel = await service.cancelPaperOrder(9000);
  assert.equal(cancel.ok, true);
  assert.deepEqual(fake.cancelOrderCalls, [9000]);

  fake.emit(EventName.openOrder, 9000, orderPlan.contract, orderPlan.entry, { status: 'Submitted' });
  const modify = await service.modifyPaperOrder({
    orderId: 9000,
    orderPatch: { lmtPrice: 23001, transmit: false },
    contract: orderPlan.contract,
    guardDecision,
    verifiedAccount,
  });
  assert.equal(modify.modified, true);
  assert.equal(fake.placeOrderCalls.at(-1).orderId, 9000);
  assert.equal(fake.placeOrderCalls.at(-1).order.lmtPrice, 23001);
  assert.equal(fake.placeOrderCalls.at(-1).order.account, 'DUQ565596');

  flags = { ...flags, shadowMode: true, submissionEnabled: false, orderSubmissionMode: 'shadow' };
  const blockedCancel = await service.cancelPaperOrder(9000);
  assert.equal(blockedCancel.ok, false);
  assert.equal(blockedCancel.blocker, 'shadow_mode_active_no_cancel');

  console.log('ibPaperExecutionAdapterService.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
