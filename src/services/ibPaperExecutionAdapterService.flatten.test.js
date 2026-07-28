'use strict';

// `node src/services/ibPaperExecutionAdapterService.flatten.test.js`
//
// Regression: emergency-flatten byggde tidigare sitt IB-kontrakt för hand och
// utelämnade symbol och lastTradeDateOrContractMonth. Ordern kodades och sändes,
// men IB agerade inte på den — ingen fill, ingen orderStatus, ingen felkod — så
// positionen låg kvar medan skyddsbenen redan var avbrutna. Kontraktet måste
// byggas av samma källa som normala ordrar (buildOrderPlan).
//
// Fejkad IB-klient injiceras: inga riktiga ordrar, ingen gateway.

const assert = require('assert/strict');
const EventEmitter = require('events');
const { EventName } = require('@stoqey/ib');
const { Encoder } = require('@stoqey/ib/dist/core/io/encoder');

const adapterModule = require('./ibPaperExecutionAdapterService');

const ACCOUNT = 'DUQ565596';
const CON_ID = 793356225;
const RESOLVED_CONTRACT = Object.freeze({
  root: 'MNQ', conId: CON_ID, localSymbol: 'MNQU6',
  expiry: '20260918', exchange: 'CME', currency: 'USD',
});

class FakeIB extends EventEmitter {
  constructor() { super(); this.placeOrderCalls = []; this.cancelOrderCalls = []; }
  connect() {
    setImmediate(() => {
      this.emit(EventName.connected);
      this.emit(EventName.managedAccounts, ACCOUNT);
      this.emit(EventName.nextValidId, 9000);
    });
  }
  reqAccountSummary(reqId) {
    setImmediate(() => {
      this.emit(EventName.accountSummary, reqId, ACCOUNT, 'AccountType', 'INDIVIDUAL', '');
      this.emit(EventName.accountSummary, reqId, ACCOUNT, 'NetLiquidation', '100000', 'USD');
      this.emit(EventName.accountSummaryEnd, reqId);
    });
  }
  cancelAccountSummary() {}
  reqPositions() {
    setImmediate(() => {
      this.emit(EventName.position, ACCOUNT,
        { conId: CON_ID, symbol: 'MNQ', secType: 'FUT', localSymbol: 'MNQU6', currency: 'USD' },
        -1, 56039.89);
      this.emit(EventName.positionEnd);
    });
  }
  cancelPositions() {}
  reqExecutions(reqId) { setImmediate(() => this.emit(EventName.execDetailsEnd, reqId)); }
  reqOpenOrders() {}
  reqAllOpenOrders() {}
  reqAutoOpenOrders() {}
  placeOrder(orderId, contract, order) { this.placeOrderCalls.push({ orderId, contract, order }); }
  cancelOrder(orderId) { this.cancelOrderCalls.push(orderId); }
  disconnect() { this.emit(EventName.disconnected); }
}

function contractTokens(contract, order) {
  let out = null;
  const encoder = new Encoder({
    serverVersion: 187,
    sendMsg: (tokens) => { out = tokens; },
    emitError: () => {},
    emitInfo: () => {},
  });
  encoder.placeOrder(1, contract, order);
  // token 0-1 = meddelandetyp + orderId; kontraktsdelen följer därefter.
  return ((out && out[0]) || []).slice(2, 16);
}

(async () => {
  const fake = new FakeIB();
  const adapter = adapterModule.createIbPaperExecutionAdapterService({
    ibFactory: () => fake,
    flagsProvider: () => ({
      executionEnabled: true, shadowMode: false, submissionEnabled: true,
      live_trading_enabled: false, live_broker_enabled: false,
      live_order_submission_enabled: false, live_account_orders_allowed: false,
    }),
    intentService: {
      createIntent: () => ({ ok: true }),
      updateStatus: () => ({ ok: true }),
      getIntent: () => null,
    },
    connectTimeoutMs: 2000,
  });

  await adapter.connectPaperExecutionClient();
  await new Promise((resolve) => setTimeout(resolve, 250));

  const result = await adapter.flattenOwnedPosition({
    root: 'MNQ',
    reason: 'regression_test_flatten_contract',
    verifiedAccount: { ok: true, classification: 'paper', accountIdMasked: 'DU***596' },
    contract: RESOLVED_CONTRACT,
  });

  assert.equal(result.ok, true, `flatten blockerades: ${result.blocker}`);
  assert.equal(result.flattened, true);
  assert.equal(result.side, 'BUY', 'kort position ska stängas med BUY');
  assert.equal(result.quantity, 1);
  assert.equal(fake.placeOrderCalls.length, 1, 'exakt en stängande order');

  const placed = fake.placeOrderCalls[0];

  // Obligatoriska kontraktsfält måste följa med — symbol och expiry saknades förut.
  assert.equal(placed.contract.conId, CON_ID);
  assert.equal(placed.contract.symbol, 'MNQ');
  assert.equal(placed.contract.secType, 'FUT');
  assert.equal(placed.contract.exchange, 'CME');
  assert.equal(placed.contract.currency, 'USD');
  assert.equal(placed.contract.localSymbol, 'MNQU6');
  assert.equal(placed.contract.expiry, '20260918');
  assert.equal(placed.contract.lastTradeDateOrContractMonth, '20260918');

  // Kontraktsdelen på tråden måste vara identisk med den fungerande ordervägen.
  const plan = adapter.buildOrderPlan({
    executionId: 'regression', side: 'short', quantity: 1, entryType: 'MKT',
    stopLossPrice: 28100, takeProfitPrice: 27900, contract: RESOLVED_CONTRACT,
  });
  assert.deepEqual(
    contractTokens(placed.contract, placed.order),
    contractTokens(plan.contract, plan.entry),
    'flatten och entry måste koda samma kontrakt',
  );

  // Utan upplöst kontrakt får positionsraden bära symbolen — aldrig tom.
  const fake2 = new FakeIB();
  const adapter2 = adapterModule.createIbPaperExecutionAdapterService({
    ibFactory: () => fake2,
    flagsProvider: () => ({
      executionEnabled: true, shadowMode: false, submissionEnabled: true,
      live_trading_enabled: false, live_broker_enabled: false,
      live_order_submission_enabled: false, live_account_orders_allowed: false,
    }),
    intentService: { createIntent: () => ({ ok: true }), updateStatus: () => ({ ok: true }), getIntent: () => null },
    connectTimeoutMs: 2000,
  });
  await adapter2.connectPaperExecutionClient();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const fallback = await adapter2.flattenOwnedPosition({
    root: 'MNQ',
    reason: 'regression_test_flatten_without_resolved_contract',
    verifiedAccount: { ok: true, classification: 'paper', accountIdMasked: 'DU***596' },
    contract: null,
  });
  assert.equal(fallback.ok, true, `fallback blockerades: ${fallback.blocker}`);
  assert.equal(fake2.placeOrderCalls[0].contract.symbol, 'MNQ', 'symbol får aldrig vara tom');
  assert.equal(fake2.placeOrderCalls[0].contract.conId, CON_ID);

  console.log('ibPaperExecutionAdapterService.flatten.test.js passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
