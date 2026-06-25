'use strict';

const assert = require('assert/strict');
const svc = require('./interactiveBrokersPaperPreflightService');

function verifiedReadiness(overrides = {}) {
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
    portConfigured: true,
    clientIdConfigured: true,
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

function blueprint(overrides = {}) {
  return {
    blueprintId: 'ibpb_1234567890',
    candidateId: 'cand_1',
    createdAt: '2026-06-21T10:00:00.000Z',
    expiresAt: '2026-06-25T23:10:00.000Z',
    staleAfterSeconds: 600,
    symbol: 'AAPL',
    marketGroup: 'stocks',
    strategyId: 'vwap_failed_breakout_short',
    strategyName: 'VWAP Failed Breakout Short',
    top3Rank: 1,
    top3Source: 'paperTradingTruthService.buildTopStrategySelector',
    direction: 'short',
    side: 'SELL',
    actionLabelSv: 'Kort',
    entryType: 'limit',
    entryReferencePrice: 215.4,
    stopLoss: 215.62,
    takeProfit: 214.97,
    takeProfit1: 214.97,
    takeProfit2: 214.54,
    riskReward: 1.95,
    stopLossPct: 0.1021,
    minStopLossPct: 0.10,
    riskPct: 1.5,
    riskAmount: 100,
    quantity: 2,
    quantityStatus: 'calculated',
    estimatedNotional: 430.8,
    currency: 'USD',
    accountMode: 'ib_paper',
    orderType: 'LMT',
    timeInForce: 'DAY',
    readiness: 'manual_approval_ready',
    blueprintReady: true,
    manualApprovalReady: true,
    executionReady: false,
    blockers: ['ib_paper_execution_disabled', 'order_sending_disabled_phase_3'],
    warnings: [],
    blockedReason: 'ib_paper_execution_disabled',
    wouldCreateOrder: false,
    wouldSendOrder: false,
    requiresManualApproval: true,
    orderSendingBlocked: true,
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

function truthWith(blueprintRow, executionStatus, readiness, topStrategies) {
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
      topStrategies,
    },
    ibPaper: {
      connectionReadiness: readiness,
      readiness,
      selectedBlueprint: blueprintRow,
      tradeBlueprint: {
        ok: true,
        mode: 'trade_blueprint',
        blueprints: [blueprintRow],
        selectedBlueprint: blueprintRow,
        manualApproval: {
          requiredConfirmationPhrase: 'CONFIRM PAPER TRADE',
          confirmationEntered: false,
          approvalStatus: 'waiting_for_user',
          blockers: ['ib_paper_execution_disabled', 'order_sending_disabled_phase_3'],
          warnings: [],
        },
      },
      executionStatus,
      manualApproval: {
        requiredConfirmationPhrase: 'CONFIRM PAPER TRADE',
        confirmationEntered: false,
        approvalStatus: 'waiting_for_user',
        blockers: ['ib_paper_execution_disabled', 'order_sending_disabled_phase_3'],
        warnings: [],
      },
    },
  };
}

async function main() {
  const testNow = new Date('2026-06-21T10:30:00.000Z');
  const readiness = verifiedReadiness();
  const baseBlueprint = blueprint({
    symbol: 'GOOGL',
    strategyId: 'narrow_breakout',
    strategyName: 'Narrow Breakout',
    direction: 'short',
    marketGroup: 'mag7',
    entryReferencePrice: 367.04,
    entryPrice: 367.04,
    stopLoss: 367.41,
    takeProfit: 366.31,
    takeProfit1: 366.31,
    takeProfit2: 365.84,
    riskReward: 1.97,
    stopLossPct: 0.1008,
    riskPct: 1.5,
    riskAmount: 500,
    quantity: 40,
    quantityStatus: 'calculated',
    estimatedNotional: 14681.6,
    currency: 'USD',
    accountMode: 'ib_paper',
    orderType: 'LMT',
    timeInForce: 'DAY',
    expiresAt: '2026-06-25T23:10:00.000Z',
  });
  const executionStatus = {
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
    blockers: ['ib_paper_execution_disabled', 'order_sending_disabled_phase_3'],
    dailyQuota: { used: 0, max: 3, remaining: 3 },
    openTrades: [],
    openTradeCount: 0,
    closedTrades: [],
    closedTradeCount: 0,
    killSwitch: { active: false, reason: null, triggeredAt: null },
    selectedBlueprint: baseBlueprint,
    manualApproval: {
      requiredConfirmationPhrase: 'CONFIRM PAPER TRADE',
      confirmationEntered: false,
      approvalStatus: 'waiting_for_user',
      blockers: ['ib_paper_execution_disabled', 'order_sending_disabled_phase_3'],
      warnings: [],
    },
  };
  const truth = truthWith(
    baseBlueprint,
    executionStatus,
    readiness,
    [
      { rank: 1, strategyId: 'vwap_failed_breakout_short', name: 'VWAP Failed Breakout Short', readyForIbPaper: true },
      { rank: 2, strategyId: 'ema_pullback_continuation', name: 'EMA Pullback Continuation', readyForIbPaper: true },
      { rank: 3, strategyId: 'narrow_breakout', name: 'Narrow Breakout', readyForIbPaper: true },
    ],
  );

  const missingConfirmation = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness,
    blueprintId: baseBlueprint.blueprintId,
  });
  assert.equal(missingConfirmation.accepted, false);
  assert.equal(missingConfirmation.readyForFirstPaperOrder, false);
  assert.equal(missingConfirmation.blockedReason, 'manual_confirmation_required');
  assert.equal(missingConfirmation.orderSent, false);
  assert.equal(missingConfirmation.executed, false);

  const wrongConfirmation = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness,
    blueprintId: baseBlueprint.blueprintId,
    confirmationPhrase: 'WRONG PHRASE',
  });
  assert.equal(wrongConfirmation.accepted, false);
  assert.equal(wrongConfirmation.readyForFirstPaperOrder, false);
  assert.equal(wrongConfirmation.blockedReason, 'manual_confirmation_mismatch');
  assert.equal(wrongConfirmation.orderSent, false);
  assert.equal(wrongConfirmation.executed, false);

  const missingBlueprint = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness,
    blueprintId: 'does_not_exist',
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(missingBlueprint.accepted, true);
  assert.equal(missingBlueprint.readyForFirstPaperOrder, true);
  assert.equal(missingBlueprint.blockedReason, null);
  assert.equal(missingBlueprint.orderSent, false);
  assert.equal(missingBlueprint.executed, false);

  const accepted = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness,
    blueprintId: baseBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.mode, 'paper_only');
  assert.equal(accepted.preflightOnly, true);
  assert.equal(accepted.dryRun, true);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.readyForFirstPaperOrder, true);
  assert.equal(accepted.wouldSendOrder, false);
  assert.equal(accepted.orderSent, false);
  assert.equal(accepted.executed, false);
  assert.equal(accepted.executionReady, false);
  assert.equal(accepted.orderSendingBlocked, true);
  assert.equal(accepted.blockedReason, null);
  assert.equal(typeof accepted.bracketSubmissionPlanReady, 'boolean');
  assert.equal(accepted.bracketSubmissionRealSubmitEnabled, false);
  assert.equal(typeof accepted.bracketOrderCount, 'number');
  assert.equal(typeof accepted.entryOnlyBlocked, 'boolean');
  assert.equal(typeof accepted.userMessageSv, 'string');
  assert.equal(accepted.orderButtonLocked, true);
  assert.equal(accepted.selectedBlueprintVerification.source, 'trade_blueprint');
  assert.equal(accepted.selectedBlueprintVerification.validForPreflight, true);
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.symbol, 'GOOGL');
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.strategyId, 'narrow_breakout');
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.side, 'SELL');
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.quantity, 40);
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.entryPrice, 367.04);
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.stopLoss, 367.41);
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.takeProfit, 366.31);
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.marketGroup, 'stock');
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.assetClass, 'STK');
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.exchange, 'SMART');
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.currency, 'USD');
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.stopLossPct >= 0.10, true);
  assert.equal(accepted.selectedBlueprintVerification.selectedBlueprint.riskReward >= 1.5, true);
  assert.equal(accepted.selectedBlueprintVerification.missingFields.length, 0);
  assert.equal(Array.isArray(accepted.selectedBlueprintVerification.normalizationWarnings), true);
  assert.equal(accepted.sessionVerification.source, 'live_connection_readiness');
  assert.equal(accepted.sessionVerification.selectedAccount, 'DUQ565596');
  assert.equal(accepted.sessionVerification.paperAccountId, 'DUQ565596');
  assert.equal(accepted.sessionVerification.accountMatches, true);
  assert.equal(accepted.sessionVerification.sessionVerified, true);
  assert.equal(accepted.sessionVerification.blockers.length, 0);
  assert.equal(accepted.selectedBlueprint.blueprintId, baseBlueprint.blueprintId);
  assert.equal(accepted.account.paperAccountIdMasked, 'DU****596');
  assert.equal(accepted.account.paperAccountVerified, true);
  assert.equal(accepted.summary.totalChecks > 0, true);
  assert.equal(accepted.summary.failedHardChecks, 0);
  assert.equal(accepted.summary.readyForFirstPaperOrder, true);
  assert.ok(accepted.checks.every((row) => row.ok === true || row.severity === 'info'));

  const staleFalseReadiness = verifiedReadiness({
    source: 'stale_connection_readiness',
    gatewayReachable: false,
    ibApiVerified: false,
    paperAccountVerified: false,
    paperModeVerified: false,
    sessionVerified: false,
    paperAccountId: null,
    managedAccounts: [],
    blockedReason: 'ib_api_not_verified',
  });
  const liveWinsOverStale = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth: truthWith(baseBlueprint, executionStatus, staleFalseReadiness, truth.topStrategies.topStrategies),
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness: staleFalseReadiness,
    liveReadiness: readiness,
    blueprintId: baseBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(liveWinsOverStale.accepted, true);
  assert.equal(liveWinsOverStale.sessionVerification.source, 'live_connection_readiness');
  assert.equal(liveWinsOverStale.blockers.includes('ib_api_not_verified'), false);
  assert.equal(liveWinsOverStale.blockers.includes('paper_account_mismatch'), false);

  const liveUnavailable = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness: verifiedReadiness({ source: 'stale_connection_readiness' }),
    getConnectionReadiness: async () => { throw new Error('test_live_down'); },
    blueprintId: baseBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(liveUnavailable.accepted, false);
  assert.equal(liveUnavailable.sessionVerification.source, 'stale_truth_fallback');
  assert.equal(liveUnavailable.blockedReason, 'live_readiness_unavailable');
  assert.equal(liveUnavailable.blockers.includes('live_readiness_unavailable'), true);
  assert.equal(liveUnavailable.orderSent, false);
  assert.equal(liveUnavailable.executed, false);

  const wrongAccount = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    executionStatus,
    liveReadiness: verifiedReadiness({
      paperAccountId: 'DUOTHER',
      managedAccounts: ['DUOTHER'],
    }),
    blueprintId: baseBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(wrongAccount.accepted, false);
  assert.equal(wrongAccount.blockers.includes('paper_account_mismatch'), true);

  const fallbackFromManagedAccountsTruth = truthWith(
    baseBlueprint,
    {
      ...executionStatus,
      readiness: verifiedReadiness({
        paperAccountId: null,
        managedAccounts: ['DUQ565596'],
      }),
    },
    verifiedReadiness({
      paperAccountId: null,
      managedAccounts: ['DUQ565596'],
    }),
    [
      { rank: 1, strategyId: 'vwap_failed_breakout_short', name: 'VWAP Failed Breakout Short', readyForIbPaper: true },
      { rank: 2, strategyId: 'ema_pullback_continuation', name: 'EMA Pullback Continuation', readyForIbPaper: true },
      { rank: 3, strategyId: 'narrow_breakout', name: 'Narrow Breakout', readyForIbPaper: true },
    ],
  );
  const fallbackFromManagedAccounts = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth: fallbackFromManagedAccountsTruth,
    tradeBlueprint: fallbackFromManagedAccountsTruth.ibPaper.tradeBlueprint,
    executionStatus: fallbackFromManagedAccountsTruth.ibPaper.executionStatus,
    readiness: fallbackFromManagedAccountsTruth.ibPaper.connectionReadiness,
    blueprintId: baseBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(fallbackFromManagedAccounts.accepted, true);
  assert.equal(fallbackFromManagedAccounts.readyForFirstPaperOrder, true);
  assert.equal(fallbackFromManagedAccounts.sessionVerification.selectedAccount, 'DUQ565596');
  assert.equal(fallbackFromManagedAccounts.sessionVerification.accountMatches, true);
  assert.equal(fallbackFromManagedAccounts.summary.failedHardChecks, 0);

  const missingAccountReadiness = verifiedReadiness({
    gatewayReachable: true,
    ibApiVerified: true,
    paperAccountVerified: true,
    paperModeVerified: true,
    sessionVerified: true,
    paperAccountId: null,
    managedAccounts: [],
  });
  const missingAccountTruth = truthWith(baseBlueprint, executionStatus, missingAccountReadiness, [
    { rank: 1, strategyId: 'vwap_failed_breakout_short', name: 'VWAP Failed Breakout Short', readyForIbPaper: true },
    { rank: 2, strategyId: 'ema_pullback_continuation', name: 'EMA Pullback Continuation', readyForIbPaper: true },
    { rank: 3, strategyId: 'narrow_breakout', name: 'Narrow Breakout', readyForIbPaper: true },
  ]);
  const missingAccount = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth: missingAccountTruth,
    tradeBlueprint: missingAccountTruth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness: missingAccountReadiness,
    blueprintId: baseBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(missingAccount.accepted, false);
  assert.equal(missingAccount.blockedReason, 'selected_account_missing');
  assert.equal(missingAccount.sessionVerification.selectedAccount, null);
  assert.equal(missingAccount.sessionVerification.selectedAccountExists, false);
  assert.equal(missingAccount.sessionVerification.accountMatches, false);

  const staleTruth = truthWith(
    blueprint({ expiresAt: '2026-06-21T09:50:00.000Z' }),
    executionStatus,
    readiness,
    [
      { rank: 1, strategyId: 'vwap_failed_breakout_short', name: 'VWAP Failed Breakout Short', readyForIbPaper: true },
    ],
  );
  const stale = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth: staleTruth,
    tradeBlueprint: staleTruth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness,
    blueprintId: staleTruth.ibPaper.selectedBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.readyForFirstPaperOrder, false);
  assert.equal(stale.blockedReason, 'stale_blueprint');

  const missingQuantityTruth = truthWith(
    blueprint({ quantity: null, quantityStatus: 'blocked' }),
    executionStatus,
    readiness,
    [
      { rank: 1, strategyId: 'vwap_failed_breakout_short', name: 'VWAP Failed Breakout Short', readyForIbPaper: true },
    ],
  );
  const missingQuantity = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth: missingQuantityTruth,
    tradeBlueprint: missingQuantityTruth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness,
    blueprintId: missingQuantityTruth.ibPaper.selectedBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(missingQuantity.accepted, false);
  assert.equal(missingQuantity.blockedReason, 'selected_blueprint_quantity_missing');

  const cryptoTruth = truthWith(
    blueprint({
      symbol: 'ETHUSDT',
      strategyId: 'narrow_breakout',
      strategyName: 'Narrow Breakout',
      direction: 'short',
      marketGroup: 'crypto',
      entryReferencePrice: 3000,
      stopLoss: 3003,
      takeProfit: 2994,
      quantity: 1,
      quantityStatus: 'calculated',
      riskReward: 2,
      stopLossPct: 0.1,
    }),
    executionStatus,
    readiness,
    [
      { rank: 1, strategyId: 'vwap_failed_breakout_short', name: 'VWAP Failed Breakout Short', readyForIbPaper: true },
      { rank: 2, strategyId: 'ema_pullback_continuation', name: 'EMA Pullback Continuation', readyForIbPaper: true },
      { rank: 3, strategyId: 'narrow_breakout', name: 'Narrow Breakout', readyForIbPaper: true },
    ],
  );
  const crypto = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth: cryptoTruth,
    tradeBlueprint: cryptoTruth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness,
    blueprintId: cryptoTruth.ibPaper.selectedBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(crypto.accepted, false);
  assert.ok(crypto.blockers.includes('crypto_not_allowed_for_ib_paper_first_order'));

  const etfTruth = truthWith(
    blueprint({
      symbol: 'QQQ',
      strategyId: 'narrow_breakout',
      strategyName: 'Narrow Breakout',
      direction: 'short',
      marketGroup: 'etf',
      entryReferencePrice: 500,
      stopLoss: 500.5,
      takeProfit: 499,
      quantity: 1,
      quantityStatus: 'calculated',
      riskReward: 2,
      stopLossPct: 0.1,
    }),
    executionStatus,
    readiness,
    [
      { rank: 1, strategyId: 'vwap_failed_breakout_short', name: 'VWAP Failed Breakout Short', readyForIbPaper: true },
      { rank: 2, strategyId: 'ema_pullback_continuation', name: 'EMA Pullback Continuation', readyForIbPaper: true },
      { rank: 3, strategyId: 'narrow_breakout', name: 'Narrow Breakout', readyForIbPaper: true },
    ],
  );
  const etf = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth: etfTruth,
    tradeBlueprint: etfTruth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness,
    blueprintId: etfTruth.ibPaper.selectedBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(etf.accepted, false);
  assert.ok(etf.blockers.includes('etf_not_allowed_for_ib_paper_first_order'));

  const exactStopTruth = truthWith(
    blueprint({
      stopLossPct: 0.1,
      riskReward: 1.5,
    }),
    executionStatus,
    readiness,
    [
      { rank: 1, strategyId: 'vwap_failed_breakout_short', name: 'VWAP Failed Breakout Short', readyForIbPaper: true },
      { rank: 2, strategyId: 'ema_pullback_continuation', name: 'EMA Pullback Continuation', readyForIbPaper: true },
      { rank: 3, strategyId: 'narrow_breakout', name: 'Narrow Breakout', readyForIbPaper: true },
    ],
  );
  const exactStop = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth: exactStopTruth,
    tradeBlueprint: exactStopTruth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness,
    blueprintId: exactStopTruth.ibPaper.selectedBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(exactStop.selectedBlueprintVerification.selectedBlueprint.stopLossPct >= 0.10, true);
  assert.equal(exactStop.selectedBlueprintVerification.selectedBlueprint.riskReward >= 1.5, true);

  const notTop3Truth = truthWith(
    blueprint({ strategyId: 'some_other_strategy', top3Rank: null, readiness: 'manual_approval_ready' }),
    executionStatus,
    readiness,
    [
      { rank: 1, strategyId: 'vwap_failed_breakout_short', name: 'VWAP Failed Breakout Short', readyForIbPaper: true },
      { rank: 2, strategyId: 'ema_pullback_continuation', name: 'EMA Pullback Continuation', readyForIbPaper: true },
      { rank: 3, strategyId: 'narrow_breakout', name: 'Narrow Breakout', readyForIbPaper: true },
    ],
  );
  const notTop3 = await svc.buildPaperExecutionPreflight({
    now: testNow,
    truth: notTop3Truth,
    tradeBlueprint: notTop3Truth.ibPaper.tradeBlueprint,
    executionStatus,
    readiness,
    blueprintId: notTop3Truth.ibPaper.selectedBlueprint.blueprintId,
    confirmationPhrase: 'CONFIRM PAPER TRADE',
  });
  assert.equal(notTop3.accepted, false);
  assert.equal(notTop3.blockedReason, 'not_top_3_strategy');

  assert.equal(accepted.safety.actions_allowed, false);
  assert.equal(accepted.safety.can_place_orders, false);
  assert.equal(accepted.safety.live_trading_enabled, false);
  assert.equal(accepted.safety.broker_enabled, false);

  console.log('interactiveBrokersPaperPreflightService.test.js: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
