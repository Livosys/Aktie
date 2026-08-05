'use strict';

const assert = require('assert/strict');
const svc = require('./interactiveBrokersPreviewService');
const paperStrategyEntryContractService = require('./paperStrategyEntryContractService');

const now = '2026-07-16T14:00:00.000Z';

function candidate(overrides = {}) {
  return {
    candidateId: 'cand-1',
    root: 'MNQ',
    symbol: 'MNQ',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
    direction: 'long',
    quantity: 1,
    orderType: 'MKT',
    entryPrice: 23000,
    stopLoss: 22980,
    takeProfit: 23040,
    riskPct: 0.25,
    riskAmount: 20,
    riskReward: 2,
    createdAt: now,
    ...overrides,
  };
}

function threeLegPlan(overrides = {}) {
  return {
    environment: 'paper',
    contract: { root: 'MNQ', localSymbol: 'MNQU6', expiry: '20260918', exchange: 'CME', currency: 'USD' },
    entry: { action: 'BUY', orderType: 'MKT', totalQuantity: 1, transmit: false, orderRef: 'TOS-PAPER-entry' },
    takeProfit: { action: 'SELL', orderType: 'LMT', totalQuantity: 1, lmtPrice: 23040, transmit: false, orderRef: 'TOS-PAPER-tp' },
    stopLoss: { action: 'SELL', orderType: 'STP', totalQuantity: 1, auxPrice: 22980, transmit: true, orderRef: 'TOS-PAPER-sl' },
    transmitSequence: ['entry:false', 'takeProfit:false', 'stopLoss:true'],
    ocaGroup: 'oca-test',
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const allowedStrategies = new Set(overrides.allowedStrategies || ['ema_pullback_continuation']);
  return {
    strategyRegistryService: {
      canExecuteStrategy(strategyId) {
        return allowedStrategies.has(strategyId)
          ? { allowed: true, strategyId, source: 'strategy_registry_execution_allowlist', status: 'active', enabled: true }
          : { allowed: false, strategyId, blockedReason: 'strategy_not_in_execution_allowlist', source: 'strategy_registry_execution_allowlist' };
      },
    },
    executionRouterService: {
      routeExecutionReadiness() {
        return { allowed: true, reasonCode: null, decisionSource: 'execution_readiness_engine', source: 'canonical_execution_router' };
      },
    },
    brokerRiskService: {
      evaluateBrokerRisk() {
        return { allowed: true, blockedReason: null, checks: [{ code: 'reconciliation_ok', ok: true }] };
      },
    },
    adapter: {
      buildOrderPlan() {
        return threeLegPlan(overrides.orderPlan);
      },
    },
    quotesByRoot: {
      MNQ: { root: 'MNQ', price: 23000, localSymbol: 'MNQU6', expiry: '20260918', exchange: 'CME', currency: 'USD' },
    },
    ...overrides,
  };
}

function readiness() {
  return {
    ok: true,
    source: 'ib_paper_execution_runtime_singleton',
    status: 'verified',
    runtimeState: 'READY',
    gatewayReachable: true,
    paperModeVerified: true,
    ibApiVerified: true,
    paperAccountVerified: true,
    sessionVerified: true,
    nextValidId: 9000,
    managedAccounts: ['DUQ565596'],
    managedAccountCount: 1,
    paperAccountId: 'DUQ565596',
  };
}

function executionStatus() {
  return {
    ready: true,
    executionEnabled: false,
    paperBrokerExecutionEnabled: false,
    executionConnected: true,
    nextValidId: 9000,
    paperAccountVerified: true,
    reconciliation: { status: 'ok', degraded: false, openOrders: [], positions: [], executions: [] },
    brokerOpenOrders: [],
    brokerPositions: [],
    brokerExecutions: [],
    account: {
      ok: true,
      generatedAt: now,
      account: { classification: 'paper', accountIdMasked: 'DU***596' },
    },
  };
}

function run() {
  const preview = svc.getIbPaperOrderPreview({
    now,
    readiness: readiness(),
    executionStatus: executionStatus(),
    candidates: [
      candidate(),
      candidate({ candidateId: 'cand-disabled', strategyId: 'disabled_strategy' }),
    ],
    ...dependencies(),
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.mode, 'preview_only');
  assert.equal(preview.source, 'execution_runtime_pipeline_preview');
  assert.equal(preview.orderSendingBlocked, true);
  assert.equal(preview.wouldCreateIbPaperOrder, false);
  assert.equal(preview.summary.totalCandidates, 2);
  assert.equal(preview.summary.allowedCandidates, 1);
  assert.equal(preview.summary.blockedCandidates, 1);
  assert.deepEqual(preview.summary.pipeline, ['execution_runtime', 'strategy_registry', 'risk', 'entry_contract', 'bracket_plan']);

  const allowed = preview.allowedCandidates[0];
  assert.equal(allowed.strategyId, 'ema_pullback_continuation');
  assert.equal(allowed.allowedForIbPaperPreview, true);
  assert.equal(allowed.blueprintReady, true);
  assert.equal(allowed.executionReady, true);
  assert.equal(allowed.executionAllowlist.source, 'strategy_registry_execution_allowlist');
  assert.equal(allowed.entryContract.allowed, true);
  assert.equal(allowed.brokerRisk.allowed, true);
  assert.equal(allowed.bracket.ok, true);
  assert.equal(allowed.bracket.orderCount, 3);
  assert.deepEqual(allowed.bracket.transmitSequence, ['entry:false', 'takeProfit:false', 'stopLoss:true']);
  assert.equal(allowed.wouldCreateOrder, false);
  assert.equal(allowed.wouldSendOrder, false);
  assert.equal(allowed.orderSendingBlocked, true);

  const blocked = preview.blockedCandidates[0];
  assert.equal(blocked.allowedForIbPaperPreview, false);
  assert.equal(blocked.blockedReason, 'strategy_not_in_execution_allowlist');
  assert.ok(blocked.blockers.includes('strategy_not_in_execution_allowlist'));
  assert.equal(blocked.orderSendingBlocked, true);

  const nativePreview = svc.getIbPaperOrderPreview({
    now,
    readiness: readiness(),
    executionStatus: executionStatus(),
    candidates: [
      candidate({
        candidateId: 'cand-native-mnq',
        strategyId: 'mnq_globex_momentum_v1',
        strategyName: 'MNQ Globex Momentum',
        signalSubtype: 'GLOBEX_MOMENTUM',
        signalStatus: 'ready',
        marketType: 'futures',
        dataFreshness: 'LIVE',
        closedCandleConfirmed: true,
        signalTimestamp: now,
        createdAt: now,
      }),
    ],
    ...dependencies({
      allowedStrategies: ['mnq_globex_momentum_v1'],
      entryContractService: paperStrategyEntryContractService,
    }),
  });
  assert.equal(nativePreview.ok, true);
  assert.equal(nativePreview.summary.totalCandidates, 1);
  assert.equal(nativePreview.summary.allowedCandidates, 1);
  assert.equal(nativePreview.allowedCandidates[0].strategyId, 'mnq_globex_momentum_v1');
  assert.equal(nativePreview.allowedCandidates[0].entryContract.allowed, true);
  assert.equal(nativePreview.allowedCandidates[0].blueprintReady, true);

  const noTpBracket = svc._internal.buildOrderPreviewCandidate(candidate(), {
    now: new Date(now),
    readiness: readiness(),
    executionStatus: executionStatus(),
    ...dependencies({ orderPlan: { takeProfit: null, transmitSequence: ['entry:false', 'stopLoss:true'] } }),
  });
  assert.equal(noTpBracket.allowedForIbPaperPreview, false);
  assert.equal(noTpBracket.bracket.ok, false);
  assert.equal(noTpBracket.bracket.blocker, 'bracket_requires_entry_take_profit_stop_loss');

  const verificationBase = svc._internal.buildVerificationBase({
    host: '127.0.0.1',
    port: 4002,
    clientIdConfigured: true,
    portConfigured: true,
    checkEnabled: true,
  });
  const verification = svc._internal.buildVerificationResult(verificationBase, {
    gatewayReachable: true,
    ibApiVerified: true,
    paperAccountVerified: true,
    managedAccounts: ['DUQ565596'],
    status: 'verified',
    blockedReason: 'read_only_session_verified',
  });
  assert.equal(verification.paperModeVerified, true);
  assert.equal(verification.sessionVerified, true);
  assert.equal(verification.paperAccountVerified, true);
  assert.equal(verification.ibApiVerified, true);
  assert.equal(verification.paperAccountId, 'DUQ565596');

  console.log('interactiveBrokersPreviewService.test.js: OK');
}

run();
