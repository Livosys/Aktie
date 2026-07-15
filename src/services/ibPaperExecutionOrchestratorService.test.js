'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.IBKR_PAPER_EXECUTION_ENABLED = 'true';
process.env.IBKR_PAPER_EXECUTION_SHADOW_MODE = 'true';
process.env.IBKR_PAPER_ORDER_SUBMISSION_ENABLED = 'false';
process.env.IBKR_PAPER_MAX_ORDER_EXPOSURE_USD = '100000';
process.env.IB_GATEWAY_PORT = '4002';

const orchestratorModule = require('./ibPaperExecutionOrchestratorService');
const intentModule = require('./ibPaperExecutionIntentService');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-paper-orchestrator-test-'));
const intentService = intentModule.createIbPaperExecutionIntentService({ dir: tmp });
let submitCalls = 0;

const fakeAdapter = {
  connectPaperExecutionClient: async () => ({ ok: true, nextOrderId: 101 }),
  getStatus: () => ({
    connected: true,
    host: '127.0.0.1',
    port: 4002,
    clientId: 956,
    nextValidIdReady: true,
    nextOrderId: 101,
    managedAccounts: [{ accountIdMasked: 'DU***596', classification: 'paper' }],
    noLiveOrderCapability: 'paper-only',
  }),
  verifyPaperAccount: () => ({ ok: true, accountIdMasked: 'DU***596', classification: 'paper', live_account_detected: false }),
  buildOrderRef: (executionId, leg) => `TOS-PAPER-${executionId}-${leg}`,
  buildOrderPlan: ({ executionId, contract, side, quantity, entryType, stopLossPrice, takeProfitPrice }) => {
    const action = side === 'short' ? 'SELL' : 'BUY';
    const exit = action === 'BUY' ? 'SELL' : 'BUY';
    return {
      environment: 'paper',
      contract: { conId: contract.conId, localSymbol: contract.localSymbol, secType: 'FUT', exchange: 'CME', currency: 'USD', symbol: contract.root },
      entry: { action, totalQuantity: quantity, orderType: entryType, tif: 'GTC', outsideRth: true, transmit: false, orderRef: `TOS-PAPER-${executionId}-entry` },
      stopLoss: { action: exit, totalQuantity: quantity, orderType: 'STP', auxPrice: stopLossPrice, tif: 'GTC', outsideRth: true, transmit: false, orderRef: `TOS-PAPER-${executionId}-stopLoss` },
      takeProfit: { action: exit, totalQuantity: quantity, orderType: 'LMT', lmtPrice: takeProfitPrice, tif: 'GTC', outsideRth: true, transmit: true, orderRef: `TOS-PAPER-${executionId}-takeProfit` },
      ocaGroup: `TOSP-${executionId}`,
      transmitSequence: ['entry:false', 'stopLoss:false', 'takeProfit:true'],
      protectiveModel: 'one_stop',
    };
  },
  submitPaperOrder: async () => {
    submitCalls += 1;
    return { ok: false, submitted: false, blocker: 'test_should_not_submit' };
  },
};

const fakeReconciliation = {
  reconcilePaperBroker: async () => ({
    ok: true,
    status: 'ok',
    degraded: false,
    counts: { openOrders: 0, executions: 0, positions: 0 },
    discrepancies: [],
    openOrders: [],
    positions: [],
  }),
  getCachedReconciliation: () => ({
    ok: true,
    status: 'ok',
    degraded: false,
    counts: { openOrders: 0, executions: 0, positions: 0 },
    discrepancies: [],
    openOrders: [],
    positions: [],
  }),
};

const service = orchestratorModule.createIbPaperExecutionOrchestratorService({
  adapter: fakeAdapter,
  intentService,
  reconciliationService: fakeReconciliation,
  marketDataService: {
    isEnabled: () => true,
    adapter: {
      resolveContract: async () => ({
        ok: true,
        contract: {
          root: 'MNQ',
          conId: 793356225,
          localSymbol: 'MNQU6',
          expiry: '20260918',
          exchange: 'CME',
          currency: 'USD',
          secType: 'FUT',
        },
      }),
    },
  },
  quoteSourceService: {
    getQuote: () => ({
      root: 'MNQ',
      source: 'ibkr_realtime',
      simulated: false,
      delayed: false,
      updatedAt: '2026-07-15T22:29:55.000Z',
      last: 23000,
      bid: 22999.75,
      ask: 23000,
      spread: 0.25,
      tickSize: 0.25,
      conId: 793356225,
      localSymbol: 'MNQU6',
      expiry: '20260918',
      exchange: 'CME',
      currency: 'USD',
    }),
  },
  scannerService: { getCandidates: () => ({ candidates: [] }) },
  accountSummaryService: {
    getSummary: async () => ({
      ok: true,
      account: {
        accountIdMasked: 'DU***596',
        classification: 'paper',
        currency: 'SEK',
        netLiquidation: 100000,
        realizedPnl: 0,
        unrealizedPnl: 0,
      },
      cacheAgeMs: 1000,
    }),
  },
});

const candidate = {
  candidateId: 'cand-1',
  strategyId: 'ema_pullback_continuation',
  root: 'MNQ',
  symbol: 'MNQ',
  direction: 'long',
  signalTimestamp: '2026-07-15T22:29:30.000Z',
  quantity: 1,
  orderType: 'MKT',
  stopLossPrice: 22980,
  takeProfitPrice: 23040,
  approval: { allowed: true },
  entryContract: { allowed: true },
};

(async () => {
  const first = await service.buildShadowExecution({
    candidate,
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'shadow_ready');
  assert.equal(first.wouldSubmit, true);
  assert.equal(first.actualSubmit, false);
  assert.equal(submitCalls, 0);
  assert.equal(first.normalizedOrder.root, 'MNQ');
  assert.equal(first.normalizedOrder.quantity, 1);
  assert.equal(first.normalizedOrder.accountMasked, 'DU***596');
  assert.equal(first.normalizedOrder.executionTarget, 'ibkr_paper');

  const second = await service.buildShadowExecution({
    candidate,
    now: new Date('2026-07-15T22:30:10.000Z'),
  });
  assert.equal(second.status, 'blocked');
  assert(second.blockers.includes('duplicate_intent'));
  assert.equal(submitCalls, 0);

  const noCandidate = await service.buildShadowExecution({ now: new Date('2026-07-15T22:30:00.000Z') });
  assert.equal(noCandidate.status, 'READY_WAITING_FOR_SIGNAL');
  assert.equal(noCandidate.actualSubmit, false);

  console.log('ibPaperExecutionOrchestratorService.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
