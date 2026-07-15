'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { EventName } = require('@stoqey/ib');
const adapterModule = require('./ibPaperExecutionAdapterService');
const intentModule = require('./ibPaperExecutionIntentService');

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
    if (typeof this.beforePlaceOrder === 'function') this.beforePlaceOrder({ orderId, contract, order });
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

function baseGuard() {
  return {
    allowed: true,
    environment: 'paper',
    verifiedPaperAccount: true,
    liveAccountBlocked: true,
    checks: [{ code: 'risk_approval_passed', ok: true }],
  };
}

function baseRisk() {
  return {
    allowed: true,
    checks: [
      { code: 'quantity_exactly_one_micro', ok: true },
      { code: 'spread_within_limit', ok: true },
      { code: 'account_summary_fresh', ok: true },
    ],
  };
}

function makeIntent(intentService) {
  return intentService.createIntent({
    idempotencyKey: 'idem-1',
    executionId: 'fxp_test_1234567890',
    intent: {
      executionTarget: 'ibkr_paper',
      strategyId: 'ema_pullback_continuation',
      candidateId: 'cand-1',
      root: 'MNQ',
      conId: 793356225,
      localSymbol: 'MNQU6',
      direction: 'long',
      quantity: 1,
      orderType: 'MKT',
      signalTimestamp: '2026-07-15T22:29:30.000Z',
      paperAccountIdMasked: 'DU***596',
    },
  }).record;
}

function makeOrderPlan(service, quantity = 1) {
  return service.buildOrderPlan({
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
    quantity,
    entryType: 'MKT',
    stopLossPrice: 22980,
    takeProfitPrice: 23040,
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-paper-adapter-test-'));
  const intentService = intentModule.createIbPaperExecutionIntentService({ dir: tmp });
  const fake = new FakeIB();
  const service = adapterModule.createIbPaperExecutionAdapterService({
    ibFactory: () => fake,
    flagsProvider: () => flags,
    intentService,
    connectTimeoutMs: 1000,
  });

  assert.equal(adapterModule.normalizeIbStatus('Submitted', 1, 1), 'partially_filled');
  assert.equal(adapterModule.normalizeIbStatus('Filled', 1, 0), 'filled');
  assert.equal(adapterModule.normalizeIbStatus('Unexpected', 0, 1), 'unknown');

  const connected = await service.connectPaperExecutionClient();
  assert.equal(connected.ok, true);
  assert.equal(service.getStatus().nextValidIdReady, true);
  assert.equal(Object.prototype.hasOwnProperty.call(service.getStatus(), 'nextOrderId'), false);
  assert.equal(service.verifyPaperAccount('DU***596').ok, true);

  const orderPlan = makeOrderPlan(service);
  assert.deepEqual(orderPlan.transmitSequence, ['entry:false', 'takeProfit:false', 'stopLoss:true']);
  assert.equal(orderPlan.entry.transmit, false);
  assert.equal(orderPlan.takeProfit.transmit, false);
  assert.equal(orderPlan.stopLoss.transmit, true);
  assert.equal(orderPlan.stopLoss.ocaGroup, orderPlan.takeProfit.ocaGroup);

  flags = { ...flags, shadowMode: false, submissionEnabled: true, orderSubmissionMode: 'paper_pilot' };
  const verifiedAccount = { ok: true, classification: 'paper', accountIdMasked: 'DU***596' };
  const guardDecision = baseGuard();
  const brokerRisk = baseRisk();
  const approval = { allowed: true, strategyId: 'ema_pullback_continuation', source: 'test' };
  const entryContract = { allowed: true, entryContractVersion: 'test' };
  const reconciliation = { status: 'ok', degraded: false, counts: { openOrders: 0, positions: 0, executions: 0 } };
  const intentRecord = makeIntent(intentService);

  const fabricated = await service.submitPaperOrder({
    guardDecision,
    intentRecord,
    orderPlan,
    verifiedAccount,
    brokerRisk,
    approval,
    entryContract,
    reconciliation,
  });
  assert.equal(fabricated.submitted, false);
  assert.equal(fabricated.blocker, 'execution_evidence_missing');
  assert.equal(fake.placeOrderCalls.length, 0);

  const evidence = service.createExecutionEvidence({
    guardDecision,
    intentRecord,
    orderPlan,
    brokerRisk,
    approval,
    entryContract,
    reconciliation,
    verifiedAccount,
    now: new Date('2026-07-15T22:30:00.000Z'),
  });

  const tamperedPlan = {
    ...orderPlan,
    entry: { ...orderPlan.entry, totalQuantity: 1 },
    contract: { ...orderPlan.contract, conId: 123 },
  };
  const tampered = await service.submitPaperOrder({
    guardDecision,
    intentRecord,
    orderPlan: tamperedPlan,
    verifiedAccount,
    executionEvidence: evidence,
    brokerRisk,
    approval,
    entryContract,
    reconciliation,
    now: new Date('2026-07-15T22:30:01.000Z'),
  });
  assert.equal(tampered.submitted, false);
  assert.equal(tampered.blocker, 'execution_evidence_fingerprint_mismatch');

  const expired = await service.submitPaperOrder({
    guardDecision,
    intentRecord,
    orderPlan,
    verifiedAccount,
    executionEvidence: { ...evidence, expiresAt: '2026-07-15T22:29:59.000Z' },
    brokerRisk,
    approval,
    entryContract,
    reconciliation,
    now: new Date('2026-07-15T22:30:01.000Z'),
  });
  assert.equal(expired.submitted, false);
  assert.equal(expired.blocker, 'execution_evidence_expired');

  const fractionalPlan = makeOrderPlan(service, 0.1);
  const fractionalIntent = intentService.createIntent({
    idempotencyKey: 'idem-fractional',
    executionId: 'fxp_fractional',
    intent: { ...intentRecord, idempotencyKey: 'idem-fractional', executionId: 'fxp_fractional', quantity: 0.1 },
  }).record;
  const fractionalEvidence = service.createExecutionEvidence({
    guardDecision,
    intentRecord: fractionalIntent,
    orderPlan: fractionalPlan,
    brokerRisk,
    approval,
    entryContract,
    reconciliation,
    verifiedAccount,
  });
  const fractional = await service.submitPaperOrder({
    guardDecision,
    intentRecord: fractionalIntent,
    orderPlan: fractionalPlan,
    verifiedAccount,
    executionEvidence: fractionalEvidence,
    brokerRisk,
    approval,
    entryContract,
    reconciliation,
  });
  assert.equal(fractional.submitted, false);
  assert.equal(fractional.blocker, 'quantity_must_be_exactly_one');

  flags = { ...flags, submissionEnabled: false, orderSubmissionMode: 'armed_but_submission_off' };
  const disabled = await service.submitPaperOrder({
    guardDecision,
    intentRecord,
    orderPlan,
    verifiedAccount,
    executionEvidence: evidence,
    brokerRisk,
    approval,
    entryContract,
    reconciliation,
  });
  assert.equal(disabled.blocker, 'paper_order_submission_disabled');
  flags = { ...flags, submissionEnabled: true, live_order_submission_enabled: true };
  const liveFlag = await service.submitPaperOrder({
    guardDecision,
    intentRecord,
    orderPlan,
    verifiedAccount,
    executionEvidence: evidence,
    brokerRisk,
    approval,
    entryContract,
    reconciliation,
  });
	  assert.equal(liveFlag.blocker, 'live_feature_flag_enabled');
	  flags = { ...flags, live_order_submission_enabled: false };

	  const fakePersistFail = new FakeIB();
	  const servicePersistFail = adapterModule.createIbPaperExecutionAdapterService({
	    ibFactory: () => fakePersistFail,
	    flagsProvider: () => flags,
	    intentService: {
	      updateStatus: () => ({ ok: false, error: 'disk_full' }),
	      listIntents: () => [],
	      getIntent: () => null,
	    },
	    connectTimeoutMs: 1000,
	  });
	  await servicePersistFail.connectPaperExecutionClient();
	  const persistFailPlan = makeOrderPlan(servicePersistFail);
	  const persistFailIntent = {
	    ...intentRecord,
	    idempotencyKey: 'idem-persist-fail',
	    executionId: 'fxp_persist_fail',
	    executionTarget: 'ibkr_paper',
	  };
	  const persistFailEvidence = servicePersistFail.createExecutionEvidence({
	    guardDecision,
	    intentRecord: persistFailIntent,
	    orderPlan: persistFailPlan,
	    brokerRisk,
	    approval,
	    entryContract,
	    reconciliation,
	    verifiedAccount,
	  });
	  const persistFail = await servicePersistFail.submitPaperOrder({
	    guardDecision,
	    intentRecord: persistFailIntent,
	    orderPlan: persistFailPlan,
	    verifiedAccount,
	    executionEvidence: persistFailEvidence,
	    brokerRisk,
	    approval,
	    entryContract,
	    reconciliation,
	  });
	  assert.equal(persistFail.submitted, false);
	  assert.equal(persistFail.blocker, 'submit_started_persist_failed');
	  assert.equal(fakePersistFail.placeOrderCalls.length, 0);

	  fake.beforePlaceOrder = () => {
    assert.equal(intentService.getIntent('idem-1').status, 'submit_started');
  };
  const submit = await service.submitPaperOrder({
    guardDecision,
    intentRecord,
    orderPlan,
    verifiedAccount,
    executionEvidence: evidence,
    brokerRisk,
    approval,
    entryContract,
    reconciliation,
    now: new Date('2026-07-15T22:30:02.000Z'),
  });
  assert.equal(submit.submitted, true);
  assert.equal(submit.parentOrderId, 9000);
  assert.equal(intentService.getIntent('idem-1').status, 'submit_started');
  assert.deepEqual(intentService.getIntent('idem-1').expectedOrderIds, [9000, 9001, 9002]);
  assert.equal(fake.placeOrderCalls.length, 3);
  assert.deepEqual(fake.placeOrderCalls.map((call) => call.orderId), [9000, 9001, 9002]);
  assert.deepEqual(fake.placeOrderCalls.map((call) => call.order.transmit), [false, false, true]);
  assert.equal(fake.placeOrderCalls[1].order.orderRef.endsWith('-takeProfit'), true);
  assert.equal(fake.placeOrderCalls[2].order.orderRef.endsWith('-stopLoss'), true);
  assert.equal(fake.placeOrderCalls[1].order.parentId, 9000);
  assert.equal(fake.placeOrderCalls[2].order.parentId, 9000);
  assert.equal(fake.placeOrderCalls[0].order.account, 'DUQ565596');
  fake.beforePlaceOrder = null;

  fake.emit(EventName.orderStatus, 9000, 'Submitted', 0, 1, 0, 777, 0, 0);
  assert.equal(service.getPaperOrderStatus(9000).status, 'submitted');
  fake.emit(EventName.orderStatus, 9000, 'Submitted', 0.5, 0.5, 23000.25, 777, 0, 23000.25);
  assert.equal(service.getPaperOrderStatus(9000).status, 'partially_filled');

  const arbitraryCancel = await service.cancelPaperOrder({
    orderId: 9999,
    verifiedAccount,
    reason: 'test_arbitrary',
  });
  assert.equal(arbitraryCancel.ok, false);
  assert.equal(arbitraryCancel.blocker, 'order_not_owned_by_ibkr_paper_execution');

  fake.emit(EventName.openOrder, 9000, orderPlan.contract, orderPlan.entry, { status: 'Submitted' });
  const cancel = await service.cancelPaperOrder({
    orderId: 9000,
    idempotencyKey: 'idem-1',
    verifiedAccount,
    reason: 'test_cancel_owned_order',
    audit: { test: true },
  });
  assert.equal(cancel.ok, true);
  assert.deepEqual(fake.cancelOrderCalls, [9000]);

  const stopOrder = { ...orderPlan.stopLoss, parentId: 9000, account: 'DUQ565596' };
  fake.emit(EventName.openOrder, 9002, orderPlan.contract, stopOrder, { status: 'Submitted' });
  const unsafeModify = await service.modifyPaperOrder({
    orderId: 9002,
    idempotencyKey: 'idem-1',
    orderPatch: { auxPrice: 22975, quantity: 2 },
    contract: orderPlan.contract,
    guardDecision,
    verifiedAccount,
    reason: 'unsafe_modify',
  });
  assert.equal(unsafeModify.modified, false);
  assert.equal(unsafeModify.blocker, 'modify_patch_field_not_allowed');

  flags = { ...flags, live_order_submission_enabled: true };
  const liveFlagModify = await service.modifyPaperOrder({
    orderId: 9002,
    idempotencyKey: 'idem-1',
    orderPatch: { auxPrice: 22975 },
    contract: orderPlan.contract,
    guardDecision,
    verifiedAccount,
    reason: 'live_flag_modify_block',
  });
  assert.equal(liveFlagModify.modified, false);
  assert.equal(liveFlagModify.blocker, 'live_feature_flag_enabled');
  flags = { ...flags, live_order_submission_enabled: false };

  const wrongContractModify = await service.modifyPaperOrder({
    orderId: 9002,
    idempotencyKey: 'idem-1',
    orderPatch: { auxPrice: 22975 },
    contract: { ...orderPlan.contract, conId: 123 },
    guardDecision,
    verifiedAccount,
    reason: 'wrong_contract_modify_block',
  });
  assert.equal(wrongContractModify.modified, false);
  assert.equal(wrongContractModify.blocker, 'order_contract_mismatch');

  const modify = await service.modifyPaperOrder({
    orderId: 9002,
    idempotencyKey: 'idem-1',
    orderPatch: { auxPrice: 22975 },
    contract: orderPlan.contract,
    guardDecision,
    verifiedAccount,
    reason: 'move_stop_in_test',
  });
  assert.equal(modify.modified, true);
  assert.equal(fake.placeOrderCalls.at(-1).orderId, 9002);
  assert.equal(fake.placeOrderCalls.at(-1).order.auxPrice, 22975);
  assert.equal(fake.placeOrderCalls.at(-1).order.account, 'DUQ565596');

  flags = { ...flags, shadowMode: true, submissionEnabled: false, orderSubmissionMode: 'shadow' };
  const blockedCancel = await service.cancelPaperOrder({
    orderId: 9000,
    idempotencyKey: 'idem-1',
    verifiedAccount,
    reason: 'blocked_shadow',
  });
  assert.equal(blockedCancel.ok, false);
  assert.equal(blockedCancel.blocker, 'shadow_mode_active_no_cancel');

  console.log('ibPaperExecutionAdapterService.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
