'use strict';

const assert = require('assert/strict');

const svc = require('./interactiveBrokersPaperProtectiveOrderService');

function readiness(overrides = {}) {
  return {
    ok: true,
    source: 'live_connection_readiness',
    loadedAt: '2026-06-21T10:00:00.000Z',
    liveReadinessLoaded: true,
    staleTruthUsed: false,
    dryRun: true,
    status: 'verified',
    gatewayReachable: true,
    host: '127.0.0.1',
    port: 4002,
    paperPortConfigured: true,
    paperMode: 'paper_only',
    paperModeVerified: true,
    ibApiVerified: true,
    paperAccountVerified: true,
    paperAccountId: 'DUQ565596',
    managedAccounts: ['DUQ565596'],
    managedAccountCount: 1,
    sessionVerified: true,
    nextValidId: 101,
    blockedReason: 'read_only_session_verified',
    ...overrides,
  };
}

function truthWith(blueprintRow, readinessState) {
  return {
    ok: true,
    mode: 'paper_only',
    safety: {
      mode: 'paper_only',
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
      broker_enabled: false,
    },
    topStrategies: {
      ok: true,
      mode: 'paper_only',
      topStrategies: [
        { rank: 1, strategyId: blueprintRow.strategyId, name: blueprintRow.strategyName, readyForIbPaper: true },
      ],
    },
    ibPaper: {
      connectionReadiness: readinessState,
      readiness: readinessState,
      selectedBlueprint: blueprintRow,
      tradeBlueprint: {
        ok: true,
        mode: 'trade_blueprint',
        blueprints: [blueprintRow],
        selectedBlueprint: blueprintRow,
        manualApproval: {
          requiredConfirmationPhrase: 'CONFIRM PAPER TRADE',
          confirmationEntered: true,
          approvalStatus: 'waiting_for_user',
          blockers: [],
          warnings: [],
        },
      },
      executionStatus: {
        ok: true,
        mode: 'paper_only',
        executionEnabled: false,
        orderSendingBlocked: true,
        liveTradingEnabled: false,
        can_place_orders: false,
        actions_allowed: false,
        broker_enabled: false,
        gatewayReachable: true,
        ibApiVerified: true,
        paperAccountVerified: true,
        paperModeVerified: true,
        sessionVerified: true,
        blockedReason: 'ib_paper_execution_disabled',
        blockers: ['ib_paper_execution_disabled'],
        dailyQuota: { used: 0, max: 3, remaining: 3 },
        openTrades: [],
        openTradeCount: 0,
        closedTrades: [],
        closedTradeCount: 0,
        killSwitch: { active: false, reason: null, triggeredAt: null },
        selectedBlueprint: blueprintRow,
        manualApproval: {
          requiredConfirmationPhrase: 'CONFIRM PAPER TRADE',
          confirmationEntered: true,
          approvalStatus: 'waiting_for_user',
          blockers: ['ib_paper_execution_disabled'],
          warnings: [],
        },
      },
      manualApproval: {
        requiredConfirmationPhrase: 'CONFIRM PAPER TRADE',
        confirmationEntered: true,
        approvalStatus: 'waiting_for_user',
        blockers: ['ib_paper_execution_disabled'],
        warnings: [],
      },
    },
  };
}

function longBlueprint(overrides = {}) {
  return {
    blueprintId: 'ibpb_long_1',
    candidateId: 'cand_long_1',
    createdAt: '2026-06-21T10:00:00.000Z',
    expiresAt: '2026-06-21T10:10:00.000Z',
    staleAfterSeconds: 600,
    symbol: 'AAPL',
    marketGroup: 'stocks',
    strategyId: 'narrow_breakout',
    strategyName: 'Narrow Breakout',
    top3Rank: 1,
    top3Source: 'paperTradingTruthService.buildTopStrategySelector',
    direction: 'long',
    side: 'BUY',
    actionLabelSv: 'Lång',
    entryType: 'limit',
    entryReferencePrice: 100,
    stopLoss: 99,
    takeProfit: 102,
    takeProfit1: 102,
    takeProfit2: 104,
    riskReward: 2,
    stopLossPct: 1,
    minStopLossPct: 0.1,
    riskPct: 1,
    riskAmount: 100,
    quantity: 10,
    quantityStatus: 'calculated',
    estimatedNotional: 1000,
    currency: 'USD',
    accountMode: 'ib_paper',
    orderType: 'LMT',
    timeInForce: 'DAY',
    blueprintReady: true,
    manualApprovalReady: true,
    executionReady: false,
    readiness: 'manual_approval_ready',
    readyForFutureIbPaper: true,
    wouldCreateOrder: false,
    wouldSendOrder: false,
    orderSendingBlocked: true,
    requiresManualApproval: true,
    safety: {
      mode: 'paper_only',
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
      broker_enabled: false,
    },
    ...overrides,
  };
}

function shortBlueprint(overrides = {}) {
  return {
    ...longBlueprint({
      blueprintId: 'ibpb_short_1',
      candidateId: 'cand_short_1',
      symbol: 'GOOGL',
      direction: 'short',
      side: 'SELL',
      entryReferencePrice: 200,
      stopLoss: 202,
      takeProfit: 196,
      takeProfit1: 196,
      takeProfit2: 194,
      strategyId: 'vwap_failed_breakout_short',
      strategyName: 'VWAP Failed Breakout Short',
      top3Rank: 2,
      ...overrides,
    }),
  };
}

async function main() {
  const readinessState = readiness();
  const truthLong = truthWith(longBlueprint(), readinessState);
  const now = new Date('2026-06-21T10:05:00.000Z');

  const longPlan = svc.buildProtectiveOrderPlan({
    now,
    truth: truthLong,
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthLong.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint(),
  });
  assert.equal(longPlan.protectivePathAvailable, true);
  assert.equal(longPlan.protectivePlanReady, true);
  assert.equal(longPlan.protectiveExecutionReady, true);
  assert.equal(longPlan.blockedReason, 'real_submit_audit_only');
  assert.equal(longPlan.plan.entry.action, 'BUY');
  assert.equal(longPlan.plan.stopLoss.action, 'SELL');
  assert.equal(longPlan.plan.takeProfit.action, 'SELL');
  assert.equal(longPlan.plan.stopLoss.stopPrice, 99);
  assert.equal(longPlan.plan.takeProfit.limitPrice, 102);
  assert.deepEqual(longPlan.plan.transmitSequence, ['entry:false', 'stopLoss:false', 'takeProfit:true']);
  assert.equal(longPlan.plan.parentChildPlanExists, true);
  assert.equal(longPlan.orderModelVerified, true);
  assert.equal(longPlan.safety.actions_allowed, false);
  assert.equal(longPlan.safety.can_place_orders, false);
  assert.equal(longPlan.safety.live_trading_enabled, false);
  assert.equal(longPlan.safety.broker_enabled, false);

  const shortPlan = svc.buildProtectiveOrderPlan({
    now,
    truth: truthWith(shortBlueprint(), readinessState),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthWith(shortBlueprint(), readinessState).ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: shortBlueprint(),
  });
  assert.equal(shortPlan.protectivePathAvailable, true);
  assert.equal(shortPlan.plan.entry.action, 'SELL');
  assert.equal(shortPlan.plan.stopLoss.action, 'BUY');
  assert.equal(shortPlan.plan.takeProfit.action, 'BUY');
  assert.equal(shortPlan.plan.stopLoss.stopPrice, 202);
  assert.equal(shortPlan.plan.takeProfit.limitPrice, 196);

  const googlMissingMarketGroup = shortBlueprint({
    entryReferencePrice: 367.04,
    entryPrice: 367.04,
    stopLoss: 367.41,
    takeProfit: 366.31,
    takeProfit1: 366.31,
    quantity: 40,
    marketGroup: null,
    stopLossPct: null,
    riskReward: null,
  });
  const googlPlan = svc.buildProtectivePreflightResponse({
    now,
    truth: truthWith(googlMissingMarketGroup, readinessState),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthWith(googlMissingMarketGroup, readinessState).ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: googlMissingMarketGroup,
  });
  assert.equal(googlPlan.accepted, true);
  assert.equal(googlPlan.helperReady, true);
  assert.equal(googlPlan.protectivePlanReady, true);
  assert.equal(googlPlan.bracketSubmissionPlanReady, true);
  assert.equal(googlPlan.bracketOrderCount, 3);
  assert.equal(googlPlan.entryOnlyBlocked, true);
  assert.equal(googlPlan.orderSent, false);
  assert.equal(googlPlan.executed, false);
  assert.equal(googlPlan.blockedReason, null);
  assert.deepEqual(googlPlan.blockers, []);
  assert.equal(googlPlan.selectedBlueprintVerification.symbol, 'GOOGL');
  assert.equal(googlPlan.selectedBlueprintVerification.side, 'SELL');
  assert.equal(googlPlan.selectedBlueprintVerification.quantity, 40);
  assert.equal(googlPlan.selectedBlueprintVerification.marketGroup, 'stock');
  assert.equal(googlPlan.selectedBlueprintVerification.assetClass, 'STK');
  assert.equal(googlPlan.selectedBlueprintVerification.secType, 'STK');
  assert.equal(googlPlan.selectedBlueprintVerification.currency, 'USD');
  assert.equal(googlPlan.selectedBlueprintVerification.exchange, 'SMART');
  assert.equal(googlPlan.selectedBlueprintVerification.primaryExchange, 'NASDAQ');
  assert.equal(googlPlan.selectedBlueprintVerification.stopLossPct, 0.1008);
  assert.equal(googlPlan.selectedBlueprintVerification.riskReward, 1.97);
  assert.equal(googlPlan.transmitSequence, 'entry:false → stopLoss:false → takeProfit:true');
  assert.equal(googlPlan.parentChild, true);

  const cryptoPlan = svc.buildProtectivePreflightResponse({
    now,
    truth: truthWith(shortBlueprint({ symbol: 'BTCUSDT', marketGroup: null }), readinessState),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthWith(shortBlueprint({ symbol: 'BTCUSDT', marketGroup: null }), readinessState).ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: shortBlueprint({ symbol: 'BTCUSDT', marketGroup: null }),
  });
  assert.equal(cryptoPlan.accepted, false);
  assert.ok(cryptoPlan.blockers.includes('crypto_not_allowed_for_ib_paper_first_order'));
  assert.ok(!cryptoPlan.blockers.includes('unsupported_market'));

  const etfPlan = svc.buildProtectivePreflightResponse({
    now,
    truth: truthWith(shortBlueprint({ symbol: 'QQQ', marketGroup: null }), readinessState),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthWith(shortBlueprint({ symbol: 'QQQ', marketGroup: null }), readinessState).ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: shortBlueprint({ symbol: 'QQQ', marketGroup: null }),
  });
  assert.equal(etfPlan.accepted, false);
  assert.ok(etfPlan.blockers.includes('etf_not_allowed_for_ib_paper_first_order'));
  assert.ok(!etfPlan.blockers.includes('unsupported_market'));

  const missingStop = svc.buildProtectiveOrderPlan({
    now,
    truth: truthWith(longBlueprint({ stopLoss: null }), readinessState),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthWith(longBlueprint({ stopLoss: null }), readinessState).ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint({ stopLoss: null }),
  });
  assert.equal(missingStop.protectivePlanReady, false);
  assert.equal(missingStop.blockedReason, 'selected_blueprint_stop_loss_missing');

  const missingTakeProfit = svc.buildProtectiveOrderPlan({
    now,
    truth: truthWith(longBlueprint({ takeProfit: null, takeProfit1: null }), readinessState),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthWith(longBlueprint({ takeProfit: null, takeProfit1: null }), readinessState).ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint({ takeProfit: null, takeProfit1: null }),
  });
  assert.equal(missingTakeProfit.protectivePlanReady, false);
  assert.equal(missingTakeProfit.blockedReason, 'selected_blueprint_take_profit_missing');

  const invalidStopSide = svc.buildProtectiveOrderPlan({
    now,
    truth: truthWith(longBlueprint({ stopLoss: 101 }), readinessState),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthWith(longBlueprint({ stopLoss: 101 }), readinessState).ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint({ stopLoss: 101 }),
  });
  assert.equal(invalidStopSide.protectivePlanReady, false);
  assert.equal(invalidStopSide.blockedReason, 'invalid_stop_loss_side');

  const invalidTakeProfitSide = svc.buildProtectiveOrderPlan({
    now,
    truth: truthWith(longBlueprint({ takeProfit: 98, takeProfit1: 98 }), readinessState),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthWith(longBlueprint({ takeProfit: 98, takeProfit1: 98 }), readinessState).ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint({ takeProfit: 98, takeProfit1: 98 }),
  });
  assert.equal(invalidTakeProfitSide.protectivePlanReady, false);
  assert.equal(invalidTakeProfitSide.blockedReason, 'invalid_take_profit_side');

  const missingQuantity = svc.buildProtectiveOrderPlan({
    now,
    truth: truthWith(longBlueprint({ quantity: 0, quantityStatus: 'missing_risk_config' }), readinessState),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthWith(longBlueprint({ quantity: 0, quantityStatus: 'missing_risk_config' }), readinessState).ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint({ quantity: 0, quantityStatus: 'missing_risk_config' }),
  });
  assert.equal(missingQuantity.protectivePlanReady, false);
  assert.equal(missingQuantity.blockedReason, 'selected_blueprint_quantity_missing');

  const unsupportedMarket = svc.buildProtectiveOrderPlan({
    now,
    truth: truthWith(longBlueprint({ marketGroup: 'unknown_group' }), readinessState),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthWith(longBlueprint({ marketGroup: 'unknown_group' }), readinessState).ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint({ marketGroup: 'unknown_group' }),
  });
  assert.equal(unsupportedMarket.protectivePlanReady, false);
  assert.equal(unsupportedMarket.blockedReason, 'selected_blueprint_unsupported_market_group');

  const unverifiedModel = svc.buildProtectiveOrderPlan({
    now,
    truth: truthLong,
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthLong.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint(),
    forceOrderModelVerified: false,
  });
  assert.equal(unverifiedModel.protectivePlanReady, false);
  assert.equal(unverifiedModel.blockedReason, 'ib_order_model_unverified');

  const preflight = svc.buildProtectivePreflightResponse({
    now,
    truth: truthLong,
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthLong.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint(),
  });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.preflightOnly, true);
  assert.equal(preflight.dryRun, true);
  assert.equal(preflight.orderSent, false);
  assert.equal(preflight.executed, false);
  assert.equal(preflight.protectivePathAvailable, true);
  assert.equal(preflight.protectivePlanReady, true);
  assert.equal(preflight.protectiveExecutionReady, true);
  assert.equal(preflight.blockedReason, null);
  assert.equal(preflight.helperReady, true);
  assert.equal(preflight.bracketSubmissionPlanReady, true);
  assert.equal(preflight.bracketSubmissionRealSubmitEnabled, false);
  assert.equal(preflight.bracketOrderCount, 3);
  assert.equal(preflight.entryOnlyBlocked, true);
  assert.equal(preflight.transmitSequence, 'entry:false → stopLoss:false → takeProfit:true');
  assert.equal(preflight.parentChild, true);
  assert.equal(preflight.accountId, 'DUQ565596');
  assert.equal(preflight.readinessVerification.source, 'live_connection_readiness');
  assert.equal(preflight.readinessVerification.sessionVerified, true);
  assert.equal(preflight.readinessVerification.ibApiVerified, true);
  assert.equal(preflight.readinessVerification.paperAccountVerified, true);
  assert.equal(preflight.readinessVerification.paperAccountId, 'DUQ565596');
  assert.equal(preflight.readinessVerification.selectedAccount, 'DUQ565596');
  assert.equal(preflight.readinessVerification.accountMatches, true);
  assert.equal(preflight.userMessageSv, '3-leg bracket-helper är redo: Entry + Stop Loss + Take Profit. Riktig IB Paper-submit är fortfarande låst i auditläge.');
  assert.equal(preflight.orderButtonLocked, true);
  assert.equal(preflight.safety.actions_allowed, false);
  assert.equal(preflight.safety.can_place_orders, false);
  assert.equal(preflight.safety.live_trading_enabled, false);
  assert.equal(preflight.safety.broker_enabled, false);

  const preflightDerivedBlueprint = shortBlueprint();
  const preflightDerivedSnapshot = readiness({
    source: 'preflight_session_snapshot_verified',
    sourceDetail: 'derived_from_verified_session',
    loadedAt: '2026-06-21T10:04:30.000Z',
    liveReadinessLoaded: false,
    staleTruthUsed: true,
    gatewayReachable: false,
    ibApiVerified: false,
    paperAccountVerified: false,
    paperModeVerified: false,
    sessionVerified: true,
    paperAccountId: 'DUQ565596',
    selectedAccount: 'DUQ565596',
    accountMatches: true,
    managedAccounts: ['DUQ565596'],
  });
  const preflightDerived = svc.buildProtectivePreflightResponse({
    now,
    truth: truthWith(preflightDerivedBlueprint, preflightDerivedSnapshot),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthWith(preflightDerivedBlueprint, preflightDerivedSnapshot).ibPaper.tradeBlueprint,
    readiness: preflightDerivedSnapshot,
    selectedBlueprint: preflightDerivedBlueprint,
  });
  assert.equal(preflightDerived.accepted, true);
  assert.equal(preflightDerived.readinessVerification.source, 'preflight_session_snapshot_verified');
  assert.equal(preflightDerived.readinessVerification.sourceDetail, 'derived_from_verified_session');
  assert.equal(preflightDerived.readinessVerification.ibApiVerified, true);
  assert.equal(preflightDerived.readinessVerification.paperAccountVerified, true);
  assert.equal(preflightDerived.readinessVerification.sessionVerified, true);
  assert.equal(preflightDerived.blockedReason, null);
  assert.equal(preflightDerived.blockers.includes('ib_api_not_verified'), false);

  const staleFalse = readiness({
    source: 'stale_connection_readiness',
    gatewayReachable: false,
    ibApiVerified: false,
    paperAccountVerified: false,
    paperModeVerified: false,
    sessionVerified: false,
    paperAccountId: null,
    managedAccounts: [],
  });
  const liveVerifiedStaleFalse = svc.buildProtectivePreflightResponse({
    now,
    truth: truthWith(longBlueprint(), staleFalse),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthLong.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint(),
  });
  assert.equal(liveVerifiedStaleFalse.protectivePlanReady, true);
  assert.equal(liveVerifiedStaleFalse.bracketSubmissionPlanReady, true);
  assert.equal(liveVerifiedStaleFalse.bracketOrderCount, 3);
  assert.equal(liveVerifiedStaleFalse.entryOnlyBlocked, true);
  assert.equal(liveVerifiedStaleFalse.blockers.includes('ib_api_not_verified'), false);

  const liveUnavailableReadiness = readiness({
    source: 'stale_truth_fallback',
    ok: false,
    liveReadinessLoaded: false,
    staleTruthUsed: true,
    blockedReason: 'live_readiness_unavailable',
    blockers: ['live_readiness_unavailable'],
    error: 'test_live_down',
  });
  const liveUnavailable = svc.buildProtectivePreflightResponse({
    now,
    truth: truthWith(longBlueprint(), liveUnavailableReadiness),
    executionStatus: truthLong.ibPaper.executionStatus,
    tradeBlueprint: truthLong.ibPaper.tradeBlueprint,
    readiness: liveUnavailableReadiness,
    selectedBlueprint: longBlueprint(),
  });
  assert.equal(liveUnavailable.protectivePlanReady, false);
  assert.equal(liveUnavailable.blockedReason, 'live_readiness_unavailable');
  assert.equal(liveUnavailable.readinessVerification.source, 'stale_truth_fallback');

  console.log('interactiveBrokersPaperProtectiveOrderService.test.js: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
