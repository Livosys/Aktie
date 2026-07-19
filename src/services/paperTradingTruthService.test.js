'use strict';

const assert = require('assert/strict');

const svc = require('./paperTradingTruthService');

async function main() {
  const runtimePreview = {
    date: '2026-06-21',
    totalScanned: 4,
    selectedCount: 3,
    selectionCount: 3,
    summary: {
      allowedCandidates: 3,
      blockedCandidates: 1,
      noteSv: 'Tre kandidater är tillåtna för IB Paper-preview idag.',
      insufficientAllowedReason: null,
      previewSource: 'test',
    },
    allCandidates: [
      {
        candidateId: 'cand-1',
        canonicalStrategyId: 'narrow_breakout',
        strategyName: 'Narrow Breakout',
        symbol: 'AAPL',
        direction: 'long',
        allowedForIbPaperPreview: true,
        blockers: [],
        reasonSv: 'Godkänd för IB Paper-preview.',
        selectionRank: 90,
      },
      {
        candidateId: 'cand-2',
        canonicalStrategyId: 'trend_continuation',
        strategyName: 'Trend Continuation',
        symbol: 'MSFT',
        direction: 'long',
        allowedForIbPaperPreview: true,
        blockers: [],
        reasonSv: 'Godkänd för IB Paper-preview.',
        selectionRank: 80,
      },
      {
        candidateId: 'cand-3',
        canonicalStrategyId: 'vwap_failed_breakout_short',
        strategyName: 'VWAP Failed Breakout Short',
        symbol: 'GOOGL',
        direction: 'short',
        allowedForIbPaperPreview: true,
        blockers: [],
        reasonSv: 'Godkänd för IB Paper-preview.',
        selectionRank: 70,
      },
      {
        candidateId: 'cand-4',
        canonicalStrategyId: 'crypto_strategy',
        strategyName: 'Crypto Strategy',
        symbol: 'BTCUSDT',
        direction: 'long',
        allowedForIbPaperPreview: false,
        blockers: ['crypto_blocked'],
        reasonSv: 'Blockerad: Krypto är blockerat i denna fas.',
        selectionRank: 10,
      },
    ],
  };

  const strategyScores = {
    top_strategies: [
      { strategy_id: 'narrow_breakout', score: 91, confidence: 92 },
      { strategy_id: 'trend_continuation', score: 88, confidence: 89 },
      { strategy_id: 'vwap_failed_breakout_short', score: 86, confidence: 87 },
    ],
  };

  const topStrategies = svc.buildTopStrategySelector({
    runtimePreview,
    strategyScores,
  });

  assert.equal(topStrategies.ok, true);
  assert.equal(topStrategies.mode, 'paper_only');
  assert.equal(topStrategies.topStrategies.length, 3);
  assert.equal(topStrategies.topStrategies[0].strategyId, 'narrow_breakout');
  assert.equal(topStrategies.topStrategies[0].readyForIbPaper, true);
  assert.equal(topStrategies.topStrategies[0].source, 'learning_summary+runtime_preview');
  assert.equal(topStrategies.topStrategies[2].strategyId, 'vwap_failed_breakout_short');
  assert.equal(topStrategies.safety.live_trading_enabled, false);

  const truth = await svc.buildPaperTradingTruth({
    runtime: {
      ok: true,
      mode: 'paper_only',
      safety: { mode: 'paper_only', actions_allowed: false, can_place_orders: false, live_trading_enabled: false, broker_enabled: false },
      summary: { openCount: 0, closedCount: 2, eventCount: 5, blockedCount: 1, latestEventAt: '2026-06-21T10:00:00.000Z' },
      blockedCandidates: [{ blockedReason: 'allowlist_not_ready' }],
      dailySelectionPreview: runtimePreview,
    },
    paperStatus: {
      ok: true,
      status: 'ok',
      summary: { openCount: 0, closedCount: 2, eventCount: 5, blockedCount: 1 },
      allowlist: {
        totalApproved: 3,
        readyForPaperRuntime: 3,
        pendingRuntimeConnection: 0,
        approvedStrategyIds: ['narrow_breakout', 'trend_continuation', 'vwap_failed_breakout_short'],
        waitingForApproval: [],
      },
    },
    allowlist: {
      ok: true,
      totalApproved: 3,
      readyForPaperRuntime: 3,
      pendingRuntimeConnection: 0,
      paperRuntimeReady: true,
      runtimeConnectionStatus: 'ready',
      allowlist: [
        { id: 'narrow_breakout', name: 'Narrow Breakout', approvedForPaperTesting: true, paperRuntimeReady: true, runtimeConnectionStatus: 'ready' },
        { id: 'trend_continuation', name: 'Trend Continuation', approvedForPaperTesting: true, paperRuntimeReady: true, runtimeConnectionStatus: 'ready' },
        { id: 'vwap_failed_breakout_short', name: 'VWAP Failed Breakout Short', approvedForPaperTesting: true, paperRuntimeReady: true, runtimeConnectionStatus: 'ready' },
      ],
    },
    approvals: {
      ok: true,
      approvedCount: 3,
      approvedStrategyIds: ['narrow_breakout', 'trend_continuation', 'vwap_failed_breakout_short'],
      rejectedStrategyIds: [],
      waitingForApproval: [],
    },
    topStrategies,
    ibPaperStatus: {
      ok: true,
      dryRun: true,
      blockedReason: 'feature_flag_disabled',
      connection: { gatewayReachable: true, status: 'reachable', paperModeVerified: false },
    },
    connectionReadiness: {
      ok: true,
      dryRun: true,
      safety: { mode: 'paper_only', actions_allowed: false, can_place_orders: false, live_trading_enabled: false, broker_enabled: false },
      host: '127.0.0.1',
      port: 4002,
      status: 'reachable',
      gatewayReachable: true,
      blockedReason: 'reachable_read_only_no_orders',
      paperMode: 'unknown',
      paperModeVerified: false,
    },
    ibOrderPreview: {
      ok: true,
      candidates: runtimePreview.allCandidates.slice(0, 3),
      allowedCandidates: runtimePreview.allCandidates.slice(0, 3),
      blockedCandidates: runtimePreview.allCandidates.slice(3),
      summary: {
        totalCandidates: 4,
        totalScanned: 4,
        allowedCandidates: 3,
        blockedCandidates: 1,
        allowedVisibleCount: 3,
        blockedVisibleCount: 0,
        availableAllowedCandidates: 3,
        availableBlockedCandidates: 1,
        previewSource: 'test',
        noteSv: 'Tre kandidater är tillåtna för IB Paper-preview idag.',
        insufficientAllowedReason: null,
        blockerCounts: { crypto_blocked: 1 },
      },
    },
    ibBlueprint: {
      ok: true,
      blueprintsCount: 1,
      blueprints: [
        {
          symbol: 'AAPL',
          strategyId: 'narrow_breakout',
          strategyName: 'Narrow Breakout',
          readyForFutureIbPaper: true,
        },
      ],
    },
    ibExecution: {
      ok: true,
      executionEnabled: false,
      orderSendingBlocked: true,
      liveTradingEnabled: false,
      can_place_orders: false,
      actions_allowed: false,
      broker_enabled: false,
      blockedReason: 'ib_paper_execution_disabled',
      blockers: ['ib_paper_execution_disabled'],
      featureFlag: 'IB_PAPER_EXECUTION_ENABLED',
      readiness: { gatewayReachable: true, status: 'reachable', paperModeVerified: false },
      gatewayReachable: true,
      ibApiVerified: false,
      paperAccountVerified: false,
      dailyQuota: { used: 0, max: 3, remaining: 3 },
      openTrades: [],
      closedTrades: [],
      lastExecutionResult: null,
    },
  });

  assert.equal(truth.ok, true);
  assert.equal(truth.mode, 'paper_only');
  assert.equal(truth.safety.broker_enabled, false);
  assert.equal(truth.candidateReadiness.readyTopStrategies, 3);
  assert.equal(truth.topStrategies.topStrategies[0].strategyId, 'narrow_breakout');
  assert.equal(truth.allowlist.totalApproved, 3);
  assert.equal(truth.ibPaper.selectedBlueprint.symbol, 'AAPL');
  assert.equal(truth.ibPaper.disableReason, 'ib_paper_execution_disabled');
  assert.equal(truth.blockers.length >= 2, true);

  const execution = await svc.buildExecutionStatus({
    runtime: truth.runtime,
    paperStatus: truth.paperStatus,
    allowlist: truth.allowlist,
    approvals: truth.approvals,
    topStrategies: truth.topStrategies,
    ibPaperStatus: truth.ibPaper.status,
    ibOrderPreview: truth.ibPaper.orderPreview,
    ibBlueprint: truth.ibPaper.tradeBlueprint,
    ibExecution: truth.ibPaper.executionStatus,
  });

  assert.equal(execution.ok, true);
  assert.equal(execution.mode, 'ibkr_paper');
  assert.equal(execution.accountMode, 'ib_paper');
  assert.equal(execution.executionEnabled, false);
  assert.equal(execution.orderSendingBlocked, true);
  assert.equal(execution.selectedBlueprint.symbol, 'AAPL');
  assert.equal(execution.paperAccountVerified, false);
  assert.equal(execution.safety.actions_allowed, false);

  let runtimeStatusCalls = 0;
  const runtimeStatus = {
    ok: true,
    mode: 'ibkr_paper',
    status: 'shadow',
    source: 'ib_paper_execution_runtime_singleton',
    flags: { executionEnabled: true, shadowMode: true, submissionEnabled: false },
    paperBrokerExecutionEnabled: true,
    executionConnected: true,
    nextValidIdReady: true,
    nextValidId: 956001,
    managedAccounts: [{ accountIdMasked: 'DU***596', classification: 'paper' }],
    managedAccountCount: 1,
    paperAccountVerified: true,
    account: { ok: true, accountIdMasked: 'DU***596', classification: 'paper' },
    readiness: {
      source: 'ib_paper_execution_runtime_singleton',
      gatewayReachable: true,
      ibApiVerified: true,
      paperAccountVerified: true,
      sessionVerified: true,
      nextValidId: 956001,
      runtimeState: 'READY',
      managedAccounts: ['DUQ565596'],
      managedAccountCount: 1,
      connectedSince: '2026-07-16T14:00:00.000Z',
      lastHeartbeat: '2026-07-16T14:00:15.000Z',
      reconnectCount: 0,
    },
    runtimeState: 'READY',
    executionRuntimeState: 'READY',
    connectedSince: '2026-07-16T14:00:00.000Z',
    lastHeartbeat: '2026-07-16T14:00:15.000Z',
    reconnectCount: 0,
    runtimeLifecycleState: 'IDLE',
    reconciliation: { status: 'ok', degraded: false, newEntriesAllowed: false, discrepancies: [], counts: {} },
    brokerOpenOrders: [],
    brokerExecutions: [],
    brokerPositions: [],
    safety: { mode: 'ibkr_paper', actions_allowed: false, can_place_orders: false, live_trading_enabled: false, broker_enabled: false },
  };
  const unifiedExecution = await svc.buildExecutionStatus({
    runtime: truth.runtime,
    paperStatus: truth.paperStatus,
    allowlist: truth.allowlist,
    approvals: truth.approvals,
    topStrategies: truth.topStrategies,
    ibPaperStatus: truth.ibPaper.status,
    connectionReadiness: runtimeStatus.readiness,
    ibOrderPreview: truth.ibPaper.orderPreview,
    ibBlueprint: truth.ibPaper.tradeBlueprint,
    executionOrchestratorService: {
      buildExecutionStatus: async () => {
        runtimeStatusCalls += 1;
        return runtimeStatus;
      },
    },
  });
  assert.equal(runtimeStatusCalls, 1);
  assert.equal(unifiedExecution.source, 'ib_paper_execution_runtime_singleton');
  assert.equal(unifiedExecution.featureFlag, 'IBKR_PAPER_EXECUTION_ENABLED');
  assert.equal(unifiedExecution.executionConnected, true);
  assert.equal(unifiedExecution.nextValidIdReady, true);
  assert.equal(unifiedExecution.nextValidId, 956001);
  assert.equal(unifiedExecution.paperAccountVerified, true);
  assert.equal(unifiedExecution.runtimeState, 'READY');
  assert.equal(unifiedExecution.runtimeLifecycleState, 'IDLE');

  console.log('paperTradingTruthService.test.js: OK');
}

main();
