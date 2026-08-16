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
  constructor(accountId = 'DUQ565596') {
    super();
    this.accountId = accountId;
    this.placeOrderCalls = [];
    this.cancelOrderCalls = [];
  }

	  connect() {
	    setImmediate(() => {
	      this.emit(EventName.connected);
	      this.emit(EventName.managedAccounts, this.accountId);
	      this.emit(EventName.nextValidId, 9000);
	    });
	  }

	  reqAccountSummary(reqId) {
	    setImmediate(() => {
	      this.emit(EventName.accountSummary, reqId, this.accountId, 'AccountType', 'INDIVIDUAL', '');
	      this.emit(EventName.accountSummary, reqId, this.accountId, 'NetLiquidation', '100000', 'USD');
	      this.emit(EventName.accountSummary, reqId, this.accountId, 'TotalCashValue', '100000', 'USD');
	      this.emit(EventName.accountSummaryEnd, reqId);
	    });
	  }

	  cancelAccountSummary() {}

	  reqPositions() {
	    setImmediate(() => {
	      this.emit(EventName.positionEnd);
	    });
	  }

	  cancelPositions() {}

	  reqExecutions(reqId) {
	    setImmediate(() => {
	      this.emit(EventName.execDetailsEnd, reqId);
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
    executionTarget: 'ibkr_paper',
    environment: 'paper',
    verifiedPaperAccount: true,
    liveAccountBlocked: true,
    checks: [{ code: 'risk_approval_passed', ok: true }],
  };
}

function baseLiveGuard() {
  return {
    allowed: true,
    executionTarget: 'ibkr_live',
    environment: 'live',
    verifiedLiveAccount: true,
    paperAccountBlocked: true,
    checks: [{ code: 'risk_approval_passed', ok: true }],
  };
}

function baseRisk() {
  return {
    allowed: true,
    checks: [
      { code: 'quantity_exactly_one_micro', ok: true },
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

function makeLiveIntent(intentService) {
  return intentService.createIntent({
    idempotencyKey: 'idem-live-1',
    executionId: 'fxp_live_1234567890',
    intent: {
      executionTarget: 'ibkr_live',
      strategyId: 'native_futures_momentum_v1',
      candidateId: 'cand-live-1',
      root: 'MNQ',
      conId: 793356225,
      localSymbol: 'MNQU6',
      direction: 'long',
      quantity: 1,
      orderType: 'MKT',
      signalTimestamp: '2026-07-15T22:29:30.000Z',
      liveAccountIdMasked: 'U1***567',
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-paper-adapter-test-'));
  const intentService = intentModule.createIbPaperExecutionIntentService({ dir: tmp });
  const fake = new FakeIB();
  let factoryCalls = 0;
  const service = adapterModule.createIbPaperExecutionAdapterService({
    ibFactory: () => {
      factoryCalls += 1;
      return fake;
    },
    flagsProvider: () => flags,
    intentService,
    connectTimeoutMs: 1000,
  });

  assert.equal(adapterModule.normalizeIbStatus('Submitted', 1, 1), 'partially_filled');
  assert.equal(adapterModule.normalizeIbStatus('Filled', 1, 0), 'filled');
  assert.equal(adapterModule.normalizeIbStatus('Unexpected', 0, 1), 'unknown');

  const connected = await service.connectPaperExecutionClient();
  assert.equal(connected.ok, true);
  const readyStatus = service.getStatus();
  assert.equal(readyStatus.connectionState, 'READY');
  assert.equal(readyStatus.ready, true);
  assert.equal(readyStatus.nextValidIdReady, true);
  assert.equal(readyStatus.nextValidId, 9000);
  assert.equal(readyStatus.managedAccountCount, 1);
  assert.equal(readyStatus.accountSummary.ok, true);
  assert.equal(Boolean(readyStatus.connectedSince), true);
  assert.equal(Number.isFinite(readyStatus.uptimeMs), false);
  assert.equal(readyStatus.runtimeLifecycle.expected.includes('HEARTBEAT'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(readyStatus, 'nextOrderId'), false);
  const readinessSnapshot = service.getConnectionReadinessSnapshot();
  assert.equal(readinessSnapshot.source, 'ib_paper_execution_runtime_singleton');
  assert.equal(readinessSnapshot.sessionVerified, true);
  assert.equal(readinessSnapshot.nextValidId, 9000);
  assert.equal(readinessSnapshot.connectedSince, readyStatus.connectedSince);
  const alreadyConnected = await service.connectPaperExecutionClient();
  assert.equal(alreadyConnected.alreadyConnected, true);
  assert.equal(factoryCalls, 1);
  assert.equal(service.verifyPaperAccount('DU***596').ok, true);

  const runtimeClients = [];
  const runtimeService = adapterModule.createIbPaperExecutionAdapterService({
    ibFactory: () => {
      const client = new FakeIB();
      runtimeClients.push(client);
      return client;
    },
    flagsProvider: () => flags,
    intentService,
    connectTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    heartbeatMs: 50,
    reconnectBaseDelayMs: 10,
    reconnectMaxDelayMs: 50,
  });
  const runtimeStart = await runtimeService.startPermanentRuntime();
  assert.equal(runtimeStart.ready, true);
  assert.equal(runtimeService.getStatus().connectionState, 'READY');
  assert.equal(runtimeService.getStatus().runtimeLifecycleState, 'READY');
  await wait(70);
  assert.equal(runtimeService.getStatus().lastHeartbeat != null, true);
  assert.equal(runtimeService.getStatus().runtimeLifecycleState, 'IDLE');
  assert.equal(runtimeService.getStatus().recentEvents.some((row) => row.type === 'startExecutionClient'), true);
  assert.equal(runtimeService.getStatus().recentEvents.some((row) => row.type === 'new IBApi client'), true);
  assert.equal(runtimeService.getStatus().recentEvents.some((row) => row.type === 'connect(host,4002,956)'), true);
  assert.equal(runtimeService.getStatus().recentEvents.some((row) => row.type === 'READY'), true);
  runtimeClients[0].emit(EventName.disconnected);
  assert.equal(runtimeService.getStatus().connectionState, 'RECONNECTING');
  await wait(40);
  assert.equal(runtimeClients.length, 2);
  assert.equal(runtimeService.getStatus().connectionState, 'READY');
  assert.equal(runtimeService.getStatus().reconnectCount >= 1, true);
  assert.equal(runtimeService.getStatus().nextValidId, 9000);
  runtimeService.disconnect();

  const orderPlan = makeOrderPlan(service);
  assert.deepEqual(orderPlan.transmitSequence, ['entry:false', 'takeProfit:false', 'stopLoss:true']);
  assert.equal(orderPlan.entry.transmit, false);
  assert.equal(orderPlan.takeProfit.transmit, false);
  assert.equal(orderPlan.stopLoss.transmit, true);
  assert.equal(orderPlan.stopLoss.ocaGroup, orderPlan.takeProfit.ocaGroup);
  const roundedTickPlan = service.buildOrderPlan({
    executionId: 'fxp_tick_rounding',
    contract: {
      root: 'MNQ',
      conId: 793356225,
      localSymbol: 'MNQU6',
      expiry: '20260918',
      exchange: 'CME',
      currency: 'USD',
    },
    side: 'short',
    quantity: 1,
    entryType: 'MKT',
    stopLossPrice: 28782.59,
    takeProfitPrice: 28524.32,
  });
  assert.equal(roundedTickPlan.stopLoss.auxPrice, 28782.5);
  assert.equal(roundedTickPlan.takeProfit.lmtPrice, 28524.25);

  flags = { ...flags, shadowMode: false, submissionEnabled: true, orderSubmissionMode: 'paper_pilot' };
  const verifiedAccount = { ok: true, classification: 'paper', accountIdMasked: 'DU***596' };
  const guardDecision = baseGuard();
  const brokerRisk = baseRisk();
  const executionAllowlist = {
    allowed: true,
    strategyId: 'ema_pullback_continuation',
    source: 'test',
  };
  const entryContract = { allowed: true, entryContractVersion: 'test' };
  const reconciliation = { status: 'ok', degraded: false, counts: { openOrders: 0, positions: 0, executions: 0 } };
  const intentRecord = makeIntent(intentService);

	  const fabricated = await service.submitPaperOrder({
	    guardDecision,
	    intentRecord,
	    orderPlan,
	    verifiedAccount,
    brokerRisk,
    executionAllowlist,
    entryContract,
    reconciliation,
  });
	  assert.equal(fabricated.submitted, false);
	  assert.equal(fabricated.blocker, 'execution_evidence_missing');
	  assert.equal(fake.placeOrderCalls.length, 0);

  const blockedPolicyMetadata = await service.submitPaperOrder({
    guardDecision,
    intentRecord,
    orderPlan,
    verifiedAccount,
    brokerRisk,
    executionAllowlist: { allowed: false, blockedReason: 'strategy_not_in_execution_allowlist' },
    entryContract: { allowed: false, blockedReason: 'entry_contract_not_approved' },
    reconciliation,
  });
  assert.equal(blockedPolicyMetadata.submitted, false);
  assert.equal(blockedPolicyMetadata.blocker, 'execution_evidence_missing');
  assert.equal(fake.placeOrderCalls.length, 0);

	  const evidence = service.createExecutionEvidence({
    guardDecision,
    intentRecord,
    orderPlan,
    brokerRisk,
    executionAllowlist,
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
    executionAllowlist,
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
    executionAllowlist,
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
    executionAllowlist,
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
    executionAllowlist,
    entryContract,
    reconciliation,
  });
  assert.equal(fractional.submitted, false);
  assert.equal(fractional.blocker, 'quantity_must_be_exactly_one');

  const invalidTakeProfitPlan = {
    ...orderPlan,
    takeProfit: { ...orderPlan.takeProfit, lmtPrice: 'not-a-price' },
  };
  const invalidTakeProfitIntent = intentService.createIntent({
    idempotencyKey: 'idem-invalid-take-profit',
    executionId: 'fxp_invalid_take_profit',
    intent: { ...intentRecord, idempotencyKey: 'idem-invalid-take-profit', executionId: 'fxp_invalid_take_profit' },
  }).record;
  const invalidTakeProfitEvidence = service.createExecutionEvidence({
    guardDecision,
    intentRecord: invalidTakeProfitIntent,
    orderPlan: invalidTakeProfitPlan,
    brokerRisk,
    executionAllowlist,
    entryContract,
    reconciliation,
    verifiedAccount,
  });
  const invalidTakeProfit = await service.submitPaperOrder({
    guardDecision,
    intentRecord: invalidTakeProfitIntent,
    orderPlan: invalidTakeProfitPlan,
    verifiedAccount,
    executionEvidence: invalidTakeProfitEvidence,
    brokerRisk,
    executionAllowlist,
    entryContract,
    reconciliation,
  });
  assert.equal(invalidTakeProfit.submitted, false);
  assert.equal(invalidTakeProfit.blocker, 'take_profit_invalid');
  assert.equal(fake.placeOrderCalls.length, 0);

  const stopOnlyFake = new FakeIB();
  const stopOnlyIntentService = intentModule.createIbPaperExecutionIntentService({
    dir: fs.mkdtempSync(path.join(tmp, 'stop-only-')),
  });
  const stopOnlyService = adapterModule.createIbPaperExecutionAdapterService({
    ibFactory: () => stopOnlyFake,
    flagsProvider: () => flags,
    intentService: stopOnlyIntentService,
    connectTimeoutMs: 1000,
  });
  await stopOnlyService.connectPaperExecutionClient();
  const noTakeProfitPlan = stopOnlyService.buildOrderPlan({
    executionId: 'fxp_no_take_profit',
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
  });
  assert.equal(noTakeProfitPlan.takeProfit, null);
  assert.deepEqual(noTakeProfitPlan.transmitSequence, ['entry:false', 'stopLoss:true']);
  const noTakeProfitIntent = stopOnlyIntentService.createIntent({
    idempotencyKey: 'idem-no-take-profit',
    executionId: 'fxp_no_take_profit',
    intent: { ...intentRecord, idempotencyKey: 'idem-no-take-profit', executionId: 'fxp_no_take_profit' },
  }).record;
  const noTakeProfitEvidence = stopOnlyService.createExecutionEvidence({
    guardDecision,
    intentRecord: noTakeProfitIntent,
    orderPlan: noTakeProfitPlan,
    brokerRisk,
    executionAllowlist,
    entryContract,
    reconciliation,
    verifiedAccount,
  });
  const noTakeProfit = await stopOnlyService.submitPaperOrder({
    guardDecision,
    intentRecord: noTakeProfitIntent,
    orderPlan: noTakeProfitPlan,
    verifiedAccount,
    executionEvidence: noTakeProfitEvidence,
    brokerRisk,
    executionAllowlist,
    entryContract,
    reconciliation,
  });
  assert.equal(noTakeProfit.submitted, true);
  assert.equal(noTakeProfit.parentOrderId, 9000);
  assert.deepEqual(stopOnlyFake.placeOrderCalls.map((call) => call.orderId), [9000, 9001]);
  assert.deepEqual(stopOnlyFake.placeOrderCalls.map((call) => call.order.transmit), [false, true]);
  assert.equal(stopOnlyFake.placeOrderCalls[0].order.orderRef.endsWith('-entry'), true);
  assert.equal(stopOnlyFake.placeOrderCalls[1].order.orderRef.endsWith('-stopLoss'), true);
  const noTakeProfitStored = stopOnlyIntentService.getIntent('idem-no-take-profit');
  assert.deepEqual(noTakeProfitStored.expectedOrderIds, [9000, 9001]);
  assert.deepEqual(noTakeProfitStored.orderRefs.map((ref) => ref.split('-').pop()), ['entry', 'stopLoss']);
  assert.deepEqual(noTakeProfitStored.expectedBracketLegs.map((leg) => leg.leg), ['entry', 'stopLoss']);
  assert.equal(fake.placeOrderCalls.length, 0);

  flags = { ...flags, submissionEnabled: false, orderSubmissionMode: 'armed_but_submission_off' };
  const disabled = await service.submitPaperOrder({
    guardDecision,
    intentRecord,
    orderPlan,
    verifiedAccount,
    executionEvidence: evidence,
    brokerRisk,
    executionAllowlist,
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
    executionAllowlist,
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
			    executionAllowlist,
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
			    executionAllowlist,
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
    executionAllowlist,
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

  const liveIntentService = intentModule.createIbPaperExecutionIntentService({
    dir: fs.mkdtempSync(path.join(tmp, 'live-target-')),
  });
  const liveFake = new FakeIB('U1234567');
  const liveFlags = {
    executionEnabled: true,
    shadowMode: false,
    submissionEnabled: true,
    orderSubmissionMode: 'live_pilot',
    live_trading_enabled: true,
    live_broker_enabled: true,
    live_order_submission_enabled: true,
    live_account_orders_allowed: true,
  };
  const liveService = adapterModule.createIbPaperExecutionAdapterService({
    executionTarget: 'ibkr_live',
    port: 4001,
    clientId: 966,
    ibFactory: () => liveFake,
    flagsProvider: () => liveFlags,
    intentService: liveIntentService,
    connectTimeoutMs: 1000,
  });
  const liveConnected = await liveService.connectPaperExecutionClient();
  assert.equal(liveConnected.ok, true);
  assert.equal(liveService.config.executionTarget, 'ibkr_live');
  assert.equal(liveService.config.expectedEnvironment, 'live');
  assert.equal(liveService.getStatus().executionTarget, 'ibkr_live');
  assert.equal(liveService.getStatus().environment, 'live');
  assert.equal(liveService.getConnectionReadinessSnapshot().liveModeVerified, true);
  assert.equal(liveService.verifyLiveAccount('U1***567').ok, true);
  assert.equal(liveService.verifyPaperAccount('DU***596').ok, false);

  const livePlan = liveService.buildOrderPlan({
    executionId: 'fxp_live_1234567890',
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
  assert.equal(livePlan.executionTarget, 'ibkr_live');
  assert.equal(livePlan.environment, 'live');
  assert.equal(livePlan.entry.orderRef.startsWith('TOS-LIVE-'), true);
  const liveIntent = makeLiveIntent(liveIntentService);
  const liveVerifiedAccount = { ok: true, classification: 'live_or_unknown', accountIdMasked: 'U1***567' };
  const liveGuard = baseLiveGuard();
  const liveEvidence = liveService.createExecutionEvidence({
    guardDecision: liveGuard,
    intentRecord: liveIntent,
    orderPlan: livePlan,
    brokerRisk,
    executionAllowlist,
    entryContract,
    reconciliation,
    verifiedAccount: liveVerifiedAccount,
  });
  const liveSubmit = await liveService.submitOrder({
    guardDecision: liveGuard,
    intentRecord: liveIntent,
    orderPlan: livePlan,
    verifiedAccount: liveVerifiedAccount,
    executionEvidence: liveEvidence,
    brokerRisk,
    executionAllowlist,
    entryContract,
    reconciliation,
  });
  assert.equal(liveSubmit.submitted, true);
  assert.equal(liveSubmit.executionTarget, 'ibkr_live');
  assert.equal(liveSubmit.environment, 'live');
  assert.deepEqual(liveFake.placeOrderCalls.map((call) => call.orderId), [9000, 9001, 9002]);
  assert.equal(liveFake.placeOrderCalls[0].order.account, 'U1234567');
  assert.equal(liveFake.placeOrderCalls.every((call) => call.order.orderRef.startsWith('TOS-LIVE-')), true);

  const readOnlyRejectIntent = intentService.createIntent({
    idempotencyKey: 'idem-readonly-reject',
    executionId: 'fxp_readonly_reject',
    intent: {
      ...intentRecord,
      idempotencyKey: 'idem-readonly-reject',
      executionId: 'fxp_readonly_reject',
      executionTarget: 'ibkr_paper',
    },
  }).record;
  const readOnlyRejectPlan = service.buildOrderPlan({
    executionId: 'fxp_readonly_reject',
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
  const readOnlyRejectEvidence = service.createExecutionEvidence({
    guardDecision,
    intentRecord: readOnlyRejectIntent,
    orderPlan: readOnlyRejectPlan,
    brokerRisk,
    executionAllowlist,
    entryContract,
    reconciliation,
    verifiedAccount,
  });
  const readOnlyRejectSubmit = await service.submitPaperOrder({
    guardDecision,
    intentRecord: readOnlyRejectIntent,
    orderPlan: readOnlyRejectPlan,
    verifiedAccount,
    executionEvidence: readOnlyRejectEvidence,
    brokerRisk,
    executionAllowlist,
    entryContract,
    reconciliation,
  });
  assert.equal(readOnlyRejectSubmit.submitted, true);
  fake.emit(EventName.error, new Error("Error validating request.-'bC' : cause - The API interface is currently in Read-Only mode."), 321, 9003);
  const rejectedIntent = intentService.getIntent('idem-readonly-reject');
  assert.equal(rejectedIntent.status, 'rejected');
  assert.equal(rejectedIntent.blocker, 'ibkr_order_rejected');
  assert.equal(rejectedIntent.ibErrorCode, 321);
  assert.equal(rejectedIntent.rejectedOrderId, 9003);

  fake.emit(EventName.orderStatus, 9000, 'Submitted', 0, 1, 0, 777, 0, 0);
  assert.equal(service.getPaperOrderStatus(9000).status, 'submitted');
  fake.emit(EventName.orderStatus, 9000, 'Submitted', 0.5, 0.5, 23000.25, 777, 0, 23000.25);
  assert.equal(service.getPaperOrderStatus(9000).status, 'partially_filled');
  fake.emit(EventName.orderStatus, 9000, 'Filled', 1, 0, 23000.25, 777, 0, 23000.25);
  assert.equal(intentService.getIntent('idem-1').entryFilledOrderId, 9000);
  assert.equal(intentService.getIntent('idem-1').entryFilledPrice, 23000.25);
  assert.equal(intentService.getIntent('idem-1').entryAvgFillPrice, 23000.25);
  assert.equal(intentService.getIntent('idem-1').entryLastFillPrice, 23000.25);
  fake.emit(EventName.execDetails, 1, orderPlan.contract, {
    execId: 'exec-entry-1',
    orderId: 9000,
    side: 'BOT',
    shares: 1,
    price: 23000.25,
    orderRef: orderPlan.entry.orderRef,
    time: '20260715 22:30:03',
  });
  assert.equal(intentService.getIntent('idem-1').entryExecId, 'exec-entry-1');
  assert.equal(intentService.getIntent('idem-1').entrySide, 'BOT');
  assert.equal(intentService.getIntent('idem-1').entryQuantity, 1);
  fake.emit(EventName.commissionReport, { execId: 'exec-entry-1', commission: 1.22, currency: 'USD' });
  assert.equal(intentService.getIntent('idem-1').entryCommission, 1.22);
  assert.equal(intentService.getIntent('idem-1').entryCommissionCurrency, 'USD');
  fake.emit(EventName.orderStatus, 9001, 'Filled', 1, 0, 23040, 778, 0, 23040);
  assert.equal(intentService.getIntent('idem-1').status, 'filled');
  assert.equal(intentService.getIntent('idem-1').filledLeg, 'takeProfit');
  assert.equal(intentService.getIntent('idem-1').filledOrderId, 9001);
  assert.equal(intentService.getIntent('idem-1').filledPrice, 23040);
  fake.emit(EventName.execDetails, 2, orderPlan.contract, {
    execId: 'exec-exit-1',
    orderId: 9001,
    side: 'SLD',
    shares: 1,
    price: 23040,
    orderRef: orderPlan.takeProfit.orderRef,
    time: '20260715 22:35:00',
  });
  assert.equal(intentService.getIntent('idem-1').filledExecId, 'exec-exit-1');
  assert.equal(intentService.getIntent('idem-1').filledSide, 'SLD');
  assert.equal(intentService.getIntent('idem-1').filledQuantity, 1);
  fake.emit(EventName.commissionReport, { execId: 'exec-exit-1', commission: 1.22, currency: 'USD', realizedPNL: 79.5 });
  assert.equal(intentService.getIntent('idem-1').filledCommission, 1.22);
  assert.equal(intentService.getIntent('idem-1').filledCommissionCurrency, 'USD');
  assert.equal(intentService.getIntent('idem-1').filledRealizedPNL, 79.5);

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

  // --- Nödstängningens '-flatten'-ben ---------------------------------------
  // Regression: fyllningsvägen kände tidigare bara igen entry/takeProfit/stopLoss.
  // En flatten som FYLLDES föll ur alla grenar och behöll status 'submitted' för
  // alltid, vilket degraderade reconciliation permanent och blockerade varje ny
  // entry. En flatten som AVBRÖTS terminaliserades däremot korrekt — det var just
  // den asymmetrin som dolde felet.
  // Speglar nödstängningens riktiga flöde: createIntent följt av updateStatus,
  // vilket är vägen expectedOrderIds/orderRefs faktiskt hamnar på posten.
  intentService.createIntent({
    idempotencyKey: 'flatten:793356225:emergency_flatten_fill',
    executionId: 'emergency_flatten_fill',
    intent: {
      executionId: 'emergency_flatten_fill',
      idempotencyKey: 'flatten:793356225:emergency_flatten_fill',
      orderRef: 'TOS-PAPER-emergency_flatten_fill-flatten',
      root: 'MNQ',
      direction: 'short',
      executionTarget: 'ibkr_paper',
      kind: 'emergency_flatten',
      status: 'submit_started',
      paperAccountIdMasked: 'DU***596',
      expectedOrderIds: [9500],
      orderRefs: ['TOS-PAPER-emergency_flatten_fill-flatten'],
    },
  });
  intentService.updateStatus('flatten:793356225:emergency_flatten_fill', 'submitted', {
    submittedAt: new Date().toISOString(),
    expectedOrderIds: [9500],
    orderRefs: ['TOS-PAPER-emergency_flatten_fill-flatten'],
    side: 'BUY',
    quantity: 1,
  });
  fake.emit(EventName.orderStatus, 9500, 'Filled', 1, 0, 28638.75, 900, 0, 28638.75);
  const flattenFilled = intentService.getIntent('flatten:793356225:emergency_flatten_fill');
  assert.equal(flattenFilled.status, 'filled');
  assert.equal(flattenFilled.filledLeg, 'flatten');
  assert.equal(flattenFilled.filledOrderId, 9500);
  assert.equal(flattenFilled.filledPrice, 28638.75);

  fake.emit(EventName.execDetails, 3, { conId: 793356225, localSymbol: 'MNQU6' }, {
    execId: 'exec-flatten-1',
    orderId: 9500,
    side: 'SLD',
    shares: 1,
    price: 28638.75,
    orderRef: 'TOS-PAPER-emergency_flatten_fill-flatten',
    time: '20260731 09:11:15',
  });
  const flattenExec = intentService.getIntent('flatten:793356225:emergency_flatten_fill');
  assert.equal(flattenExec.filledExecId, 'exec-flatten-1');
  assert.equal(flattenExec.filledSide, 'SLD');
  assert.equal(flattenExec.filledQuantity, 1);

  // Avbrottsvägen ska vara oförändrad: den är ben-agnostisk och ska fortsatt ge
  // 'cancelled' för en flatten, trots att legFromOrderRef nu returnerar 'flatten'.
  intentService.createIntent({
    idempotencyKey: 'flatten:793356225:emergency_flatten_cancel',
    executionId: 'emergency_flatten_cancel',
    intent: {
      executionId: 'emergency_flatten_cancel',
      idempotencyKey: 'flatten:793356225:emergency_flatten_cancel',
      orderRef: 'TOS-PAPER-emergency_flatten_cancel-flatten',
      root: 'MNQ',
      direction: 'short',
      executionTarget: 'ibkr_paper',
      kind: 'emergency_flatten',
      status: 'submit_started',
      paperAccountIdMasked: 'DU***596',
      expectedOrderIds: [9501],
      orderRefs: ['TOS-PAPER-emergency_flatten_cancel-flatten'],
    },
  });
  intentService.updateStatus('flatten:793356225:emergency_flatten_cancel', 'submitted', {
    submittedAt: new Date().toISOString(),
    expectedOrderIds: [9501],
    orderRefs: ['TOS-PAPER-emergency_flatten_cancel-flatten'],
    side: 'BUY',
    quantity: 1,
  });
  fake.emit(EventName.error, new Error('Order Cancelled - reason:'), 202, 9501);
  const flattenCancelled = intentService.getIntent('flatten:793356225:emergency_flatten_cancel');
  assert.equal(flattenCancelled.status, 'cancelled');

  console.log('ibPaperExecutionAdapterService.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
