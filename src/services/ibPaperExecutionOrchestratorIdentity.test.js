'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.IBKR_PAPER_EXECUTION_ENABLED = 'true';
process.env.IBKR_PAPER_EXECUTION_SHADOW_MODE = 'true';
process.env.IBKR_PAPER_ORDER_SUBMISSION_ENABLED = 'false';
process.env.IB_GATEWAY_PORT = '4002';

const orchestratorModule = require('./ibPaperExecutionOrchestratorService');
const intentModule = require('./ibPaperExecutionIntentService');
const reservationModule = require('./futuresPaperExecutionTargetReservationService');
const configService = require('./ibPaperExecutionConfigService');

configService.readKillSwitch = () => ({ pauseNewEntries: false, reason: null, updatedAt: null });

function createAdapter(nowIso) {
  return {
    getStatus: () => ({
      ok: true,
      ready: true,
      state: 'READY',
      connectionState: 'READY',
      connected: true,
      port: 4002,
      nextValidIdReady: true,
      nextValidId: 9000,
      managedAccounts: [{ accountIdMasked: 'DU***596', classification: 'paper' }],
      managedAccountCount: 1,
      connectedSince: nowIso,
      lastHeartbeat: nowIso,
      runtimeLifecycleState: 'IDLE',
    }),
    getAccountSummary: () => ({
      ok: true,
      generatedAt: new Date().toISOString(),
      account: {
        accountIdMasked: 'DU***596',
        classification: 'paper',
        currency: 'SEK',
        netLiquidation: 100000,
        realizedPnl: 0,
        unrealizedPnl: 0,
      },
      cacheAgeMs: 0,
    }),
    getConnectionReadinessSnapshot: () => ({
      ok: true,
      source: 'ib_paper_execution_runtime_singleton',
      runtimeState: 'READY',
      status: 'verified',
      paperModeVerified: true,
      ibApiVerified: true,
      paperAccountVerified: true,
      managedAccounts: ['DU***596'],
      managedAccountCount: 1,
      sessionVerified: true,
      nextValidId: 9000,
      connectedSince: nowIso,
      lastHeartbeat: nowIso,
      runtimeLifecycleState: 'IDLE',
    }),
    verifyPaperAccount: () => ({
      ok: true,
      accountIdMasked: 'DU***596',
      classification: 'paper',
      live_account_detected: false,
    }),
    markReconciled: () => {},
    buildOrderRef: (executionId, leg) => `TOS-PAPER-${executionId}-${leg}`,
    buildOrderPlan: ({ executionId, contract, side, quantity, entryType, stopLossPrice, takeProfitPrice, tif, outsideRth }) => {
      const action = side === 'short' ? 'SELL' : 'BUY';
      const exit = action === 'BUY' ? 'SELL' : 'BUY';
      return {
        environment: 'paper',
        contract,
        entry: { action, totalQuantity: quantity, orderType: entryType, tif, outsideRth, transmit: false, orderRef: `TOS-PAPER-${executionId}-entry` },
        stopLoss: { action: exit, totalQuantity: quantity, orderType: 'STP', auxPrice: stopLossPrice, tif: 'GTC', outsideRth, transmit: true, orderRef: `TOS-PAPER-${executionId}-stopLoss` },
        takeProfit: { action: exit, totalQuantity: quantity, orderType: 'LMT', lmtPrice: takeProfitPrice, tif: 'GTC', outsideRth, transmit: false, orderRef: `TOS-PAPER-${executionId}-takeProfit` },
        ocaGroup: `TOSP-${executionId}`,
        transmitSequence: ['entry:false', 'takeProfit:false', 'stopLoss:true'],
        protectiveModel: 'one_stop',
      };
    },
    createExecutionEvidence: () => ({
      source: 'ib_paper_execution_orchestrator',
      evidenceVersion: 1,
      generatedAt: nowIso,
      expiresAt: '2026-08-06T14:28:00.000Z',
      fingerprint: 'identity-propagation-fingerprint',
      signature: 'test-signature',
    }),
    submitPaperOrder: async () => {
      throw new Error('identity test must not submit orders');
    },
  };
}

test('buildShadowExecution propagates lifecycle identity through guard, evidence, order and intent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-orchestrator-identity-'));
  const nowIso = '2026-08-06T14:26:00.000Z';
  const candidate = {
    lifecycleId: 'life-orch-1',
    candidateId: 'cand-orch-1',
    signalId: 'sig-orch-1',
    strategyId: 'ema_pullback_continuation',
    root: 'MNQ',
    symbol: 'MNQ',
    direction: 'long',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 29595,
    takeProfitPrice: 29612,
    signalTimestamp: nowIso,
    timestamp: nowIso,
    createdAt: nowIso,
    status: 'READY_WAITING_FOR_SIGNAL',
  };
  const service = orchestratorModule.createIbPaperExecutionOrchestratorService({
    adapter: createAdapter(nowIso),
    intentService: intentModule.createIbPaperExecutionIntentService({ dir: path.join(tmp, 'intents') }),
    executionTargetReservationService: reservationModule.createFuturesPaperExecutionTargetReservationService({ dir: path.join(tmp, 'reservations') }),
    reconciliationService: {
      reconcilePaperBroker: async () => ({
        ok: true,
        status: 'ok',
        degraded: false,
        newEntriesAllowed: true,
        counts: { openOrders: 0, executions: 0, positions: 0 },
        discrepancies: [],
        openOrders: [],
        executions: [],
        positions: [],
        orderStatuses: [],
        intents: [],
      }),
      getCachedReconciliation: () => ({
        ok: true,
        status: 'ok',
        degraded: false,
        newEntriesAllowed: true,
        counts: { openOrders: 0, executions: 0, positions: 0 },
        discrepancies: [],
        openOrders: [],
        executions: [],
        positions: [],
        orderStatuses: [],
        intents: [],
      }),
    },
    strategyRegistryService: {
      canExecuteStrategy: (strategyId) => ({
        allowed: true,
        strategyId,
        source: 'strategy_registry_execution_allowlist',
        status: 'active',
        enabled: true,
        blockedReason: null,
      }),
    },
    executionRouterService: {
      routeExecutionReadiness: () => ({
        allowed: true,
        reasonCode: null,
        entryContractVersion: 'identity-test-entry-contract',
      }),
    },
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
        stale: false,
        updatedAt: nowIso,
        last: 29600,
        bid: 29599.75,
        ask: 29600,
        spread: 0.25,
        tickSize: 0.25,
        conId: 793356225,
        localSymbol: 'MNQU6',
        expiry: '20260918',
        exchange: 'CME',
        currency: 'USD',
      }),
    },
    scannerService: { getCandidates: () => ({ candidates: [candidate] }) },
  });

  const result = await service.buildShadowExecution({
    candidateId: 'cand-orch-1',
    now: new Date(nowIso),
    actualSubmit: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'shadow_ready');
  assert.equal(result.lifecycleId, 'life-orch-1');
  assert.equal(result.signalId, 'sig-orch-1');
  assert.equal(result.guard.lifecycleId, 'life-orch-1');
  assert.equal(result.guard.candidateId, 'cand-orch-1');
  assert.equal(result.guard.signalId, 'sig-orch-1');
  assert.equal(result.intent.lifecycleId, 'life-orch-1');
  assert.equal(result.intent.candidateId, 'cand-orch-1');
  assert.equal(result.intent.signalId, 'sig-orch-1');
  assert.equal(result.normalizedOrder.lifecycleId, 'life-orch-1');
  assert.equal(result.normalizedOrder.candidateId, 'cand-orch-1');
  assert.equal(result.normalizedOrder.signalId, 'sig-orch-1');
  assert.equal(result.orderPlan.lifecycleId, 'life-orch-1');
  assert.equal(result.orderPlan.candidateId, 'cand-orch-1');
  assert.equal(result.orderPlan.signalId, 'sig-orch-1');
  assert.equal(result.executionEvidence.lifecycleId, 'life-orch-1');
  assert.equal(result.executionEvidence.candidateId, 'cand-orch-1');
  assert.equal(result.executionEvidence.signalId, 'sig-orch-1');
  assert.equal(result.executionEvidence.executionId, result.normalizedOrder.executionId);
  assert.equal(result.executionEvidence.idempotencyKey, result.normalizedOrder.idempotencyKey);

  // FAS 36: tradeId präglas av orchestratorn (canonical owner) och ska bäras
  // oförändrad av varje nedströmsobjekt. Härledningen är deterministisk ur
  // executionId — ett omkört exekveringsförsök måste ge samma trade-rot.
  const expectedTradeId = `futures_trade_${result.normalizedOrder.executionId.replace(/^fxp_/, '')}`;
  assert.equal(result.intent.tradeId, expectedTradeId);
  assert.equal(result.guard.tradeId, expectedTradeId);
  assert.equal(result.orderPlan.tradeId, expectedTradeId);
  assert.equal(result.executionEvidence.tradeId, expectedTradeId);
});
