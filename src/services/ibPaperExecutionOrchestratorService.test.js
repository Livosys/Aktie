'use strict';

const assert = require('assert');
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-paper-orchestrator-test-'));
const intentService = intentModule.createIbPaperExecutionIntentService({ dir: path.join(tmp, 'intents') });
const reservationService = reservationModule.createFuturesPaperExecutionTargetReservationService({ dir: path.join(tmp, 'reservations') });
let submitCalls = 0;
let startRuntimeCalls = 0;

const fakeAdapter = {
  startPermanentRuntime: async () => {
    startRuntimeCalls += 1;
    return { ok: true, ready: true, state: 'READY' };
  },
  connectPaperExecutionClient: async () => ({ ok: true }),
  getStatus: () => ({
    ready: true,
    state: 'READY',
    connectionState: 'READY',
    connected: true,
    host: '127.0.0.1',
    port: 4002,
    clientId: 956,
    connectedSince: '2026-07-15T22:30:00.000Z',
    nextValidIdReady: true,
    nextValidId: 9000,
    managedAccounts: [{ accountIdMasked: 'DU***596', classification: 'paper' }],
    managedAccountCount: 1,
    lastConnected: '2026-07-15T22:30:00.000Z',
    lastHeartbeat: '2026-07-15T22:30:05.000Z',
    lastReadyAt: '2026-07-15T22:30:01.000Z',
    uptimeMs: 60000,
    reconnectCount: 0,
    runtimeLifecycle: { expected: ['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'READY', 'HEARTBEAT', 'IDLE'], current: 'IDLE' },
    runtimeLifecycleState: 'IDLE',
    noLiveOrderCapability: 'paper-only',
  }),
  getAccountSummary: () => ({
    ok: true,
    generatedAt: '2026-07-15T22:30:00.000Z',
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
    gatewayReachable: true,
    status: 'verified',
    blockedReason: 'read_only_session_verified',
    paperMode: 'paper_only',
    paperModeVerified: true,
    ibApiVerified: true,
    paperAccountVerified: true,
    managedAccounts: ['DUQ565596'],
    managedAccountCount: 1,
    paperAccountId: 'DUQ565596',
    sessionVerified: true,
    nextValidId: 9000,
    connectedSince: '2026-07-15T22:30:00.000Z',
    lastHeartbeat: '2026-07-15T22:30:05.000Z',
    uptimeMs: 60000,
    reconnectCount: 0,
    runtimeLifecycle: { expected: ['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'READY', 'HEARTBEAT', 'IDLE'], current: 'IDLE' },
    runtimeLifecycleState: 'IDLE',
  }),
  markReconciled: () => {},
  verifyPaperAccount: () => ({ ok: true, accountIdMasked: 'DU***596', classification: 'paper', live_account_detected: false }),
  buildOrderRef: (executionId, leg) => `TOS-PAPER-${executionId}-${leg}`,
  createExecutionEvidence: ({ orderPlan }) => ({
    source: 'ib_paper_execution_orchestrator',
    evidenceVersion: 1,
    generatedAt: '2026-07-15T22:30:00.000Z',
    expiresAt: '2026-07-15T22:32:00.000Z',
    fingerprint: `fp-${orderPlan.entry.totalQuantity}-${orderPlan.contract.conId}`,
    signature: 'test-signature',
  }),
  buildOrderPlan: ({ executionId, contract, side, quantity, entryType, stopLossPrice, takeProfitPrice, tif, outsideRth }) => {
    const action = side === 'short' ? 'SELL' : 'BUY';
    const exit = action === 'BUY' ? 'SELL' : 'BUY';
    return {
      environment: 'paper',
      contract: {
        conId: contract.conId,
        localSymbol: contract.localSymbol,
        secType: 'FUT',
        exchange: 'CME',
        currency: 'USD',
        symbol: contract.root,
        expiry: contract.expiry,
      },
      entry: { action, totalQuantity: quantity, orderType: entryType, tif, outsideRth, transmit: false, orderRef: `TOS-PAPER-${executionId}-entry` },
      takeProfit: { action: exit, totalQuantity: quantity, orderType: 'LMT', lmtPrice: takeProfitPrice, tif: 'GTC', outsideRth, transmit: false, orderRef: `TOS-PAPER-${executionId}-takeProfit` },
      stopLoss: { action: exit, totalQuantity: quantity, orderType: 'STP', auxPrice: stopLossPrice, tif: 'GTC', outsideRth, transmit: true, orderRef: `TOS-PAPER-${executionId}-stopLoss` },
      ocaGroup: `TOSP-${executionId}`,
      transmitSequence: ['entry:false', 'takeProfit:false', 'stopLoss:true'],
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
    newEntriesAllowed: true,
    counts: { openOrders: 0, executions: 0, positions: 0 },
    discrepancies: [],
    openOrders: [],
    positions: [],
  }),
  getCachedReconciliation: () => ({
    ok: true,
    status: 'ok',
    degraded: false,
    newEntriesAllowed: true,
    counts: { openOrders: 0, executions: 0, positions: 0 },
    discrepancies: [],
    openOrders: [],
    positions: [],
  }),
};

const serverCandidate = {
  candidateId: 'cand-1',
  strategyId: 'ema_pullback_continuation',
  root: 'MNQ',
  symbol: 'MNQ',
  direction: 'long',
  signalTimestamp: '2026-07-15T22:29:30.000Z',
  quantity: 99,
  orderType: 'MKT',
  stopLossPrice: 22980,
  takeProfitPrice: 23040,
  executionAllowlist: { allowed: false },
  entryContract: { allowed: false },
};

{
  const normalizedNative = orchestratorModule.normalizeCandidate({
    candidateId: 'native-1',
    strategyId: 'mnq_globex_momentum_v1',
    symbol: 'MNQ',
    direction: 'long',
    signalStatus: 'ready',
    signalSubtype: 'GLOBEX_MOMENTUM',
    closedCandleConfirmed: true,
    signalTimestamp: '2026-07-15T22:29:30.000Z',
  });
  assert.equal(normalizedNative.signalSubtype, 'GLOBEX_MOMENTUM');
  assert.equal(normalizedNative.signalStatus, 'ready');
  assert.equal(normalizedNative.subtype, 'GLOBEX_MOMENTUM');
  assert.equal(normalizedNative.latestCandleClosed, true);
}

const service = orchestratorModule.createIbPaperExecutionOrchestratorService({
  adapter: fakeAdapter,
  intentService,
  reconciliationService: fakeReconciliation,
  executionTargetReservationService: reservationService,
  strategyRegistryService: {
    canExecuteStrategy: (strategyId) => ({
      allowed: strategyId === 'ema_pullback_continuation',
      strategyId,
      source: 'strategy_registry_execution_allowlist',
      status: strategyId === 'ema_pullback_continuation' ? 'active' : null,
      enabled: strategyId === 'ema_pullback_continuation',
      blockedReason: strategyId === 'ema_pullback_continuation' ? null : 'strategy_not_in_execution_allowlist',
    }),
  },
  entryContractService: {
    evaluatePaperEntryContract: ({ strategyId }) => ({ allowed: strategyId === 'ema_pullback_continuation', entryContractVersion: 'server_test_contract' }),
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
  scannerService: { getCandidates: () => ({ candidates: [serverCandidate] }) },
  accountSummaryService: {
    getSummary: async () => ({
      ok: true,
      generatedAt: '2026-07-15T22:30:00.000Z',
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

(async () => {
  const runtimeStart = await service.startRuntime();
  assert.equal(runtimeStart.ok, true);
  assert.equal(startRuntimeCalls, 1);
  const runtimeStatus = await service.buildExecutionStatus();
  assert.equal(runtimeStatus.executionClient.clientId, 956);
  assert.equal(runtimeStatus.executionConnected, true);
  assert.equal(runtimeStatus.nextValidIdReady, true);
  assert.equal(runtimeStatus.nextValidId, 9000);
  assert.equal(runtimeStatus.paperAccountVerified, true);
  assert.equal(runtimeStatus.reconciliation.status, 'ok');
  assert.equal(runtimeStatus.readiness.source, 'ib_paper_execution_runtime_singleton');
  assert.equal(runtimeStatus.connectedSince, '2026-07-15T22:30:00.000Z');
  assert.equal(runtimeStatus.runtimeLifecycleState, 'IDLE');
  const cachedStatus = service.getCachedExecutionStatus();
  assert.equal(cachedStatus.cached, true);
  assert.equal(cachedStatus.nextValidId, 9000);
  assert.equal(startRuntimeCalls, 1);

  const ignoredClientCandidate = await service.buildShadowExecution({
    candidate: {
      candidateId: 'client-fake',
      strategyId: 'ema_pullback_continuation',
      root: 'MNQ',
      executionAllowlist: { allowed: true },
      entryContract: { allowed: true },
      quantity: 1,
      conId: 793356225,
    },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(ignoredClientCandidate.normalizedOrder.candidateId, 'cand-1');
  assert.equal(ignoredClientCandidate.normalizedOrder.quantity, 1);
  assert.equal(ignoredClientCandidate.candidate.quantity, 1);
  assert.equal(ignoredClientCandidate.executionAllowlist.source, 'strategy_registry_execution_allowlist');
  assert.equal(ignoredClientCandidate.executionAllowlist.status, 'active');
  assert.equal(ignoredClientCandidate.entryContract.entryContractVersion, 'server_test_contract');

  const unknown = await service.buildShadowExecution({
    candidateId: 'does-not-exist',
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(unknown.status, 'READY_WAITING_FOR_SIGNAL');
  assert.equal(unknown.actualSubmit, false);

	  const first = await service.buildShadowExecution({
	    candidateId: 'cand-1',
	    now: new Date('2026-07-15T22:30:00.000Z'),
	  });
	  assert.equal(first.ok, true);
	  assert.equal(first.status, 'blocked');
	  assert(first.blockers.includes('duplicate_intent'));
  assert.equal(first.actualSubmit, false);
  assert.equal(submitCalls, 0);
  assert.equal(first.normalizedOrder.root, 'MNQ');
  assert.equal(first.normalizedOrder.quantity, 1);
  assert.equal(first.normalizedOrder.accountMasked, 'DU***596');
  assert.equal(first.normalizedOrder.executionTarget, 'ibkr_paper');

  const reservation = reservationService.getReservation('cand-1');
  assert.equal(reservation.executionTarget, 'ibkr_paper');

  const raceCandidate = { ...serverCandidate, candidateId: 'cand-race', signalTimestamp: '2026-07-15T22:29:40.000Z' };
  const raceService = orchestratorModule.createIbPaperExecutionOrchestratorService({
    adapter: fakeAdapter,
    intentService: {
      buildIdempotencyKey: intentModule.buildIdempotencyKey,
      getIntent: () => null,
      createIntent: () => ({ created: false, duplicate: true, existing: { idempotencyKey: 'race-existing' } }),
      updateStatus: () => { throw new Error('updateStatus must not run after duplicate createIntent'); },
    },
    reconciliationService: fakeReconciliation,
    executionTargetReservationService: reservationModule.createFuturesPaperExecutionTargetReservationService({ dir: path.join(tmp, 'race-reservations') }),
    strategyRegistryService: {
      canExecuteStrategy: (strategyId) => ({
        allowed: strategyId === 'ema_pullback_continuation',
        strategyId,
        source: 'strategy_registry_execution_allowlist',
        status: strategyId === 'ema_pullback_continuation' ? 'active' : null,
        enabled: strategyId === 'ema_pullback_continuation',
        blockedReason: strategyId === 'ema_pullback_continuation' ? null : 'strategy_not_in_execution_allowlist',
      }),
    },
    entryContractService: {
      evaluatePaperEntryContract: ({ strategyId }) => ({ allowed: strategyId === 'ema_pullback_continuation', entryContractVersion: 'server_test_contract' }),
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
        updatedAt: '2026-07-15T22:29:55.000Z',
        last: 23000,
        bid: 22999.75,
        ask: 23000,
        spread: 0.25,
        tickSize: 0.25,
      }),
    },
    scannerService: { getCandidates: () => ({ candidates: [raceCandidate] }) },
    accountSummaryService: {
      getSummary: async () => ({
        ok: true,
        generatedAt: '2026-07-15T22:30:00.000Z',
        account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0, unrealizedPnl: 0 },
        cacheAgeMs: 1000,
      }),
    },
  });
  const race = await raceService.buildShadowExecution({
    candidateId: 'cand-race',
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(race.status, 'blocked');
  assert.equal(race.wouldSubmit, false);
  assert.equal(race.blockedReason, 'duplicate_intent');
  assert.equal(race.executionEvidence, null);

  const noCandidateService = orchestratorModule.createIbPaperExecutionOrchestratorService({
    adapter: fakeAdapter,
    intentService: intentModule.createIbPaperExecutionIntentService({ dir: path.join(tmp, 'empty-intents') }),
    reconciliationService: fakeReconciliation,
    executionTargetReservationService: reservationModule.createFuturesPaperExecutionTargetReservationService({ dir: path.join(tmp, 'empty-reservations') }),
    scannerService: { getCandidates: () => ({ candidates: [] }) },
  });
  const noCandidate = await noCandidateService.buildShadowExecution({ now: new Date('2026-07-15T22:30:00.000Z') });
  assert.equal(noCandidate.status, 'READY_WAITING_FOR_SIGNAL');
  assert.equal(noCandidate.actualSubmit, false);

  console.log('ibPaperExecutionOrchestratorService.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
