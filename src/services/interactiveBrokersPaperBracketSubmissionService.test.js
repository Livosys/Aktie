'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-paper-bracket-'));
process.env.IB_PAPER_ONE_SHOT_DATA_DIR = tempDir;
process.env.IB_GATEWAY_HOST = '127.0.0.1';
process.env.IB_GATEWAY_PORT = '4002';
process.env.IB_PAPER_ONE_SHOT_ENABLED = 'false';

const bracketSvc = require('./interactiveBrokersPaperBracketSubmissionService');
const protectiveSvc = require('./interactiveBrokersPaperProtectiveOrderService');
const oneShotSvc = require('./interactiveBrokersPaperOneShotExecutionService');

function readiness(overrides = {}) {
  return {
    ok: true,
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
    blockedReason: 'read_only_session_verified',
    ...overrides,
  };
}

function blueprint(overrides = {}) {
  return {
    blueprintId: 'ibpb_504c379a07ea6008',
    candidateId: 'cand_1',
    createdAt: '2026-06-21T10:00:00.000Z',
    expiresAt: '2026-06-21T10:10:00.000Z',
    staleAfterSeconds: 600,
    symbol: 'GOOGL',
    marketGroup: 'stocks',
    strategyId: 'narrow_breakout',
    strategyName: 'Narrow Breakout',
    top3Rank: 1,
    top3Source: 'paperTradingTruthService.buildTopStrategySelector',
    direction: 'short',
    side: 'SELL',
    actionLabelSv: 'Kort',
    entryType: 'limit',
    entryReferencePrice: 174.25,
    stopLoss: 174.42,
    takeProfit: 173.90,
    takeProfit1: 173.90,
    takeProfit2: 173.55,
    riskReward: 2.05,
    stopLossPct: 0.11,
    minStopLossPct: 0.10,
    riskPct: 1.5,
    riskAmount: 100,
    quantity: 40,
    quantityStatus: 'calculated',
    estimatedNotional: 6970,
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
        {
          rank: 1,
          strategyId: blueprintRow.strategyId,
          name: blueprintRow.strategyName,
          readyForIbPaper: true,
        },
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
          blockers: ['ib_paper_execution_disabled', 'order_sending_disabled_phase_3'],
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
        blockers: ['ib_paper_execution_disabled', 'order_sending_disabled_phase_3'],
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
          blockers: ['ib_paper_execution_disabled', 'order_sending_disabled_phase_3'],
          warnings: [],
        },
      },
      manualApproval: {
        requiredConfirmationPhrase: 'CONFIRM PAPER TRADE',
        confirmationEntered: true,
        approvalStatus: 'waiting_for_user',
        blockers: ['ib_paper_execution_disabled', 'order_sending_disabled_phase_3'],
        warnings: [],
      },
    },
  };
}

function preflightReady(blueprintRow, readinessState) {
  return {
    ok: true,
    mode: 'paper_only',
    preflightOnly: true,
    dryRun: true,
    accepted: true,
    readyForFirstPaperOrder: true,
    orderSent: false,
    executed: false,
    blockedReason: null,
    blockers: [],
    summary: {
      totalChecks: 57,
      passedChecks: 57,
      failedHardChecks: 0,
      warningChecks: 0,
      readyForFirstPaperOrder: true,
    },
    account: {
      paperAccountVerified: readinessState.paperAccountVerified,
      paperAccountIdMasked: 'DU****596',
      paperAccountId: readinessState.paperAccountId,
      managedAccounts: readinessState.managedAccounts,
      selectedAccountExists: true,
      selectedAccountMatchesPaper: true,
    },
    selectedBlueprint: blueprintRow,
    manualApproval: {
      requiredConfirmationPhrase: 'CONFIRM PAPER TRADE',
      confirmationEntered: true,
      approvalStatus: 'waiting_for_user',
      blockers: [],
      warnings: [],
      createdAt: blueprintRow.createdAt,
      expiresAt: blueprintRow.expiresAt,
      selectedBlueprint: blueprintRow,
    },
    checks: [
      { code: 'paper_only_mode', ok: true, severity: 'hard' },
      { code: 'gateway_reachable', ok: true, severity: 'hard' },
      { code: 'ib_api_verified', ok: true, severity: 'hard' },
      { code: 'paper_account_verified', ok: true, severity: 'hard' },
      { code: 'paper_mode_verified', ok: true, severity: 'hard' },
      { code: 'session_verified', ok: true, severity: 'hard' },
    ],
  };
}

function armStatusFor(blueprintRow, idempotencyKey, overrides = {}) {
  return {
    ok: true,
    mode: 'paper_only',
    armed: true,
    armId: `arm_${blueprintRow.blueprintId}`,
    createdAt: '2026-06-21T10:04:00.000Z',
    expiresAt: '2026-06-21T10:09:00.000Z',
    ttlSeconds: 300,
    blueprintId: blueprintRow.blueprintId,
    candidateId: blueprintRow.candidateId,
    symbol: blueprintRow.symbol,
    strategyId: blueprintRow.strategyId,
    side: blueprintRow.side,
    quantity: blueprintRow.quantity,
    idempotencyKey,
    paperAccountMasked: 'DU****596',
    preflightSnapshot: { readyForFirstPaperOrder: true, totalChecks: 57, failedHardChecks: 0 },
    protectiveSnapshot: { protectivePathAvailable: true, protectivePlanReady: true, orderModelVerified: true },
    used: false,
    usedAt: null,
    disarmedAt: null,
    expiredAt: null,
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

async function main() {
  const readinessState = readiness();

  const shortBlueprint = blueprint();
  const shortTruth = truthWith(shortBlueprint, readinessState);
  const shortProtective = protectiveSvc.buildProtectivePreflightResponse({
    now: new Date('2026-06-21T10:05:00.000Z'),
    truth: shortTruth,
    executionStatus: shortTruth.ibPaper.executionStatus,
    tradeBlueprint: shortTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: shortBlueprint,
  });
  const shortBracket = bracketSvc.buildBracketSubmissionPlan({
    now: new Date('2026-06-21T10:05:00.000Z'),
    truth: shortTruth,
    executionStatus: shortTruth.ibPaper.executionStatus,
    tradeBlueprint: shortTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: shortBlueprint,
    protectivePlan: shortProtective,
    nextValidId: 101,
  });
  assert.equal(shortBracket.protectivePathAvailable, true);
  assert.equal(shortBracket.protectivePlanReady, true);
  assert.equal(shortBracket.protectiveExecutionReady, false);
  assert.equal(shortBracket.bracketSubmissionPlanReady, true);
  assert.equal(shortBracket.blockedReason, 'real_submit_not_enabled_for_this_attempt');
  assert.equal(shortBracket.orderCount, 3);
  assert.equal(shortBracket.entryOnlyBlocked, true);
  assert.equal(shortBracket.submissionPlan.entry.orderId, 101);
  assert.equal(shortBracket.submissionPlan.stopLoss.parentId, 101);
  assert.equal(shortBracket.submissionPlan.takeProfit.parentId, 101);
  assert.deepEqual(shortBracket.submissionPlan.transmitSequence, ['entry:false', 'stopLoss:false', 'takeProfit:true']);
  assert.equal(shortBracket.submissionPlan.entry.action, 'SELL');
  assert.equal(shortBracket.submissionPlan.stopLoss.action, 'BUY');
  assert.equal(shortBracket.submissionPlan.takeProfit.action, 'BUY');
  assert.equal(shortBracket.submissionPlan.entry.quantity, 40);
  assert.equal(shortBracket.submissionPlan.stopLoss.quantity, 40);
  assert.equal(shortBracket.submissionPlan.takeProfit.quantity, 40);
  assert.equal(shortBracket.safety.actions_allowed, false);
  assert.equal(shortBracket.safety.can_place_orders, false);
  assert.equal(shortBracket.safety.live_trading_enabled, false);
  assert.equal(shortBracket.safety.broker_enabled, false);

  const shortMockCalls = [];
  const shortMock = await bracketSvc.submitBracketOrderGroup({
    selectedBlueprint: shortBlueprint,
    submissionPlan: shortBracket.submissionPlan,
    ibClient: {
      placeOrder(orderId, contract, order) {
        shortMockCalls.push({
          orderId,
          contract,
          order,
        });
      },
    },
    simulateMockCalls: true,
    mockOnly: true,
    dryRun: true,
    allowRealSubmit: false,
    executionAttemptId: 'mock_short_1',
    idempotencyKey: 'mock_short_1',
    accountMode: 'ib_paper',
  });
  assert.equal(shortMock.helperReady, true);
  assert.equal(shortMock.orderCount, 3);
  assert.equal(shortMock.orderSent, false);
  assert.equal(shortMock.executed, false);
  assert.equal(shortMock.blockedReason, 'real_submit_audit_only');
  assert.equal(shortMock.userMessageSv, '3-leg bracket-helper är redo: Entry + Stop Loss + Take Profit. Riktig IB Paper-submit är fortfarande låst i auditläge.');
  assert.equal(shortMock.orderButtonLocked, true);
  assert.equal(shortMock.mockPlaceOrderCalls.length, 3);
  assert.equal(shortMock.mockProtectiveOrdersSubmitted, true);
  assert.equal(shortMock.mockOrderSent, true);
  assert.equal(shortMock.realSubmitEnabled, false);
  assert.equal(shortMock.contract.symbol, 'GOOGL');
  assert.equal(shortMockCalls.length, 3);
  assert.deepEqual(shortMockCalls.map((row) => row.orderId), [101, 102, 103]);
  assert.deepEqual(shortMockCalls.map((row) => row.order.transmit), [false, false, true]);
  assert.equal(shortMockCalls[1].order.parentId, 101);
  assert.equal(shortMockCalls[2].order.parentId, 101);
  assert.equal(shortMockCalls[0].order.action, 'SELL');
  assert.equal(shortMockCalls[1].order.action, 'BUY');
  assert.equal(shortMockCalls[2].order.action, 'BUY');

  const helperMissing = await bracketSvc.submitBracketOrderGroup({
    now: new Date('2026-06-21T10:05:30.000Z'),
    truth: shortTruth,
    executionStatus: shortTruth.ibPaper.executionStatus,
    tradeBlueprint: shortTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: shortBlueprint,
    submissionPlan: null,
    simulateMockCalls: true,
    mockOnly: true,
    dryRun: true,
    allowRealSubmit: false,
    executionAttemptId: 'mock_helper_missing',
    idempotencyKey: 'mock_helper_missing',
    accountMode: 'ib_paper',
  });
  assert.equal(helperMissing.ok, false);
  assert.equal(helperMissing.blockedReason, 'protective_bracket_submission_required');
  assert.equal(helperMissing.userMessageSv, 'Kan inte skicka order: komplett bracket-/skyddsorder saknas.');
  assert.equal(helperMissing.orderButtonLocked, true);

  const longBlueprint = blueprint({
    blueprintId: 'ibpb_long_1',
    candidateId: 'cand_long',
    symbol: 'AAPL',
    strategyId: 'vwap_failed_breakout_long',
    strategyName: 'VWAP Failed Breakout Long',
    direction: 'long',
    side: 'BUY',
    entryReferencePrice: 200,
    stopLoss: 198,
    takeProfit: 203,
    takeProfit1: 203,
    stopLossPct: 1.0,
    riskReward: 2.1,
    quantity: 10,
  });
  const longTruth = truthWith(longBlueprint, readinessState);
  const longProtective = protectiveSvc.buildProtectivePreflightResponse({
    now: new Date('2026-06-21T10:06:00.000Z'),
    truth: longTruth,
    executionStatus: longTruth.ibPaper.executionStatus,
    tradeBlueprint: longTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint,
  });
  const longBracket = bracketSvc.buildBracketSubmissionPlan({
    now: new Date('2026-06-21T10:06:00.000Z'),
    truth: longTruth,
    executionStatus: longTruth.ibPaper.executionStatus,
    tradeBlueprint: longTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: longBlueprint,
    protectivePlan: longProtective,
    nextValidId: 201,
  });
  assert.equal(longBracket.orderCount, 3);
  assert.equal(longBracket.submissionPlan.entry.action, 'BUY');
  assert.equal(longBracket.submissionPlan.stopLoss.action, 'SELL');
  assert.equal(longBracket.submissionPlan.takeProfit.action, 'SELL');
  assert.deepEqual(longBracket.submissionPlan.transmitSequence, ['entry:false', 'stopLoss:false', 'takeProfit:true']);

  const longMockCalls = [];
  const longMock = await bracketSvc.submitBracketOrderGroup({
    selectedBlueprint: longBlueprint,
    submissionPlan: longBracket.submissionPlan,
    ibClient: {
      placeOrder(orderId, contract, order) {
        longMockCalls.push({ orderId, contract, order });
      },
    },
    simulateMockCalls: true,
    mockOnly: true,
    dryRun: true,
    allowRealSubmit: false,
    executionAttemptId: 'mock_long_1',
    idempotencyKey: 'mock_long_1',
    accountMode: 'ib_paper',
  });
  assert.equal(longMock.helperReady, true);
  assert.equal(longMock.mockPlaceOrderCalls.length, 3);
  assert.equal(longMock.mockProtectiveOrdersSubmitted, true);
  assert.equal(longMock.mockOrderSent, true);
  assert.equal(longMockCalls.length, 3);
  assert.deepEqual(longMockCalls.map((row) => row.orderId), [201, 202, 203]);
  assert.deepEqual(longMockCalls.map((row) => row.order.transmit), [false, false, true]);
  assert.equal(longMockCalls[1].order.parentId, 201);
  assert.equal(longMockCalls[2].order.parentId, 201);
  assert.equal(longMockCalls[0].order.action, 'BUY');
  assert.equal(longMockCalls[1].order.action, 'SELL');
  assert.equal(longMockCalls[2].order.action, 'SELL');

  const missingStop = bracketSvc.buildBracketSubmissionPlan({
    now: new Date('2026-06-21T10:05:00.000Z'),
    truth: shortTruth,
    executionStatus: shortTruth.ibPaper.executionStatus,
    tradeBlueprint: shortTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: blueprint({ stopLoss: null }),
    protectivePlan: shortProtective,
    nextValidId: 102,
  });
  assert.equal(missingStop.bracketSubmissionPlanReady, false);
  assert.equal(missingStop.blockedReason, 'selected_blueprint_stop_loss_missing');
  assert.equal(missingStop.orderCount, 0);
  assert.equal(missingStop.orderSent, false);
  assert.equal(missingStop.executed, false);

  const missingTakeProfit = bracketSvc.buildBracketSubmissionPlan({
    now: new Date('2026-06-21T10:05:00.000Z'),
    truth: shortTruth,
    executionStatus: shortTruth.ibPaper.executionStatus,
    tradeBlueprint: shortTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: blueprint({ takeProfit: null, takeProfit1: null }),
    protectivePlan: shortProtective,
    nextValidId: 103,
  });
  assert.equal(missingTakeProfit.bracketSubmissionPlanReady, false);
  assert.equal(missingTakeProfit.blockedReason, 'selected_blueprint_take_profit_missing');
  assert.equal(missingTakeProfit.orderCount, 0);

  const missingNextValid = bracketSvc.buildBracketSubmissionPlan({
    now: new Date('2026-06-21T10:05:00.000Z'),
    truth: shortTruth,
    executionStatus: shortTruth.ibPaper.executionStatus,
    tradeBlueprint: shortTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: shortBlueprint,
    protectivePlan: shortProtective,
    nextValidId: null,
  });
  assert.equal(missingNextValid.bracketSubmissionPlanReady, false);
  assert.equal(missingNextValid.blockedReason, 'ib_next_valid_id_unavailable');
  assert.equal(missingNextValid.orderCount, 0);

  const quantityMismatch = bracketSvc.buildBracketSubmissionPlan({
    now: new Date('2026-06-21T10:05:00.000Z'),
    truth: shortTruth,
    executionStatus: shortTruth.ibPaper.executionStatus,
    tradeBlueprint: shortTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: shortBlueprint,
    protectivePlan: shortProtective,
    nextValidId: 104,
    forceQuantityMismatch: true,
  });
  assert.equal(quantityMismatch.bracketSubmissionPlanReady, false);
  assert.equal(quantityMismatch.orderCount, 0);
  assert.ok(['quantity_mismatch', 'protective_plan_not_ready'].includes(quantityMismatch.blockedReason));

  const entryOnly = bracketSvc.buildBracketSubmissionPlan({
    now: new Date('2026-06-21T10:05:00.000Z'),
    truth: shortTruth,
    executionStatus: shortTruth.ibPaper.executionStatus,
    tradeBlueprint: shortTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: shortBlueprint,
    protectivePlan: shortProtective,
    nextValidId: 105,
    forceEntryOnly: true,
  });
  assert.equal(entryOnly.bracketSubmissionPlanReady, false);
  assert.equal(entryOnly.orderCount, 1);
  assert.equal(entryOnly.blockedReason, 'entry_only_forbidden');
  assert.equal(entryOnly.entryOnlyBlocked, true);

  const entryOnlyCalls = [];
  const entryOnlyHelper = await bracketSvc.submitBracketOrderGroup({
    selectedBlueprint: shortBlueprint,
    submissionPlan: entryOnly.submissionPlan,
    ibClient: {
      placeOrder(orderId, contract, order) {
        entryOnlyCalls.push({ orderId, contract, order });
      },
    },
    simulateMockCalls: true,
    mockOnly: true,
    dryRun: true,
    allowRealSubmit: false,
    executionAttemptId: 'mock_entry_only',
    idempotencyKey: 'mock_entry_only',
    accountMode: 'ib_paper',
  });
  assert.equal(entryOnlyHelper.ok, false);
  assert.equal(entryOnlyHelper.orderSent, false);
  assert.equal(entryOnlyHelper.executed, false);
  assert.equal(entryOnlyHelper.blockedReason, 'protective_bracket_submission_required');
  assert.equal(entryOnlyCalls.length, 0);

  const missingExecutionAttemptCalls = [];
  const missingExecutionAttempt = await bracketSvc.submitBracketOrderGroup({
    selectedBlueprint: shortBlueprint,
    submissionPlan: shortBracket.submissionPlan,
    ibClient: {
      placeOrder(orderId, contract, order) {
        missingExecutionAttemptCalls.push({ orderId, contract, order });
      },
    },
    simulateMockCalls: true,
    mockOnly: true,
    dryRun: true,
    allowRealSubmit: false,
    executionAttemptId: '',
    idempotencyKey: 'mock_missing_execution_attempt',
    accountMode: 'ib_paper',
  });
  assert.equal(missingExecutionAttempt.ok, false);
  assert.equal(missingExecutionAttempt.orderSent, false);
  assert.equal(missingExecutionAttempt.executed, false);
  assert.equal(missingExecutionAttempt.blockedReason, 'protective_bracket_submission_required');
  assert.equal(missingExecutionAttemptCalls.length, 0);

  const missingIdempotencyCalls = [];
  const missingIdempotency = await bracketSvc.submitBracketOrderGroup({
    selectedBlueprint: shortBlueprint,
    submissionPlan: shortBracket.submissionPlan,
    ibClient: {
      placeOrder(orderId, contract, order) {
        missingIdempotencyCalls.push({ orderId, contract, order });
      },
    },
    simulateMockCalls: true,
    mockOnly: true,
    dryRun: true,
    allowRealSubmit: false,
    executionAttemptId: 'mock_missing_idempotency',
    idempotencyKey: '',
    accountMode: 'ib_paper',
  });
  assert.equal(missingIdempotency.ok, false);
  assert.equal(missingIdempotency.orderSent, false);
  assert.equal(missingIdempotency.executed, false);
  assert.equal(missingIdempotency.blockedReason, 'protective_bracket_submission_required');
  assert.equal(missingIdempotencyCalls.length, 0);

  const wrongTransmitPlan = {
    ...shortBracket.submissionPlan,
    takeProfit: {
      ...shortBracket.submissionPlan.takeProfit,
      transmit: false,
    },
  };
  const wrongTransmitHelper = await bracketSvc.submitBracketOrderGroup({
    selectedBlueprint: shortBlueprint,
    submissionPlan: wrongTransmitPlan,
    ibClient: {
      placeOrder() {
        throw new Error('placeOrder should not be called for wrong transmit sequence');
      },
    },
    simulateMockCalls: true,
    mockOnly: true,
    dryRun: true,
    allowRealSubmit: false,
    executionAttemptId: 'mock_wrong_transmit',
    idempotencyKey: 'mock_wrong_transmit',
    accountMode: 'ib_paper',
  });
  assert.equal(wrongTransmitHelper.ok, false);
  assert.equal(wrongTransmitHelper.orderSent, false);
  assert.equal(wrongTransmitHelper.executed, false);
  assert.equal(wrongTransmitHelper.blockedReason, 'protective_bracket_submission_required');

  const wrongParentPlan = {
    ...shortBracket.submissionPlan,
    stopLoss: {
      ...shortBracket.submissionPlan.stopLoss,
      parentId: 999,
    },
  };
  const wrongParentHelper = await bracketSvc.submitBracketOrderGroup({
    selectedBlueprint: shortBlueprint,
    submissionPlan: wrongParentPlan,
    ibClient: {
      placeOrder() {
        throw new Error('placeOrder should not be called for wrong parentId');
      },
    },
    simulateMockCalls: true,
    mockOnly: true,
    dryRun: true,
    allowRealSubmit: false,
    executionAttemptId: 'mock_wrong_parent',
    idempotencyKey: 'mock_wrong_parent',
    accountMode: 'ib_paper',
  });
  assert.equal(wrongParentHelper.ok, false);
  assert.equal(wrongParentHelper.orderSent, false);
  assert.equal(wrongParentHelper.executed, false);
  assert.equal(wrongParentHelper.blockedReason, 'protective_bracket_submission_required');

  let failCall2Count = 0;
  const failCall2 = await bracketSvc.submitBracketOrderGroup({
    selectedBlueprint: shortBlueprint,
    submissionPlan: shortBracket.submissionPlan,
    ibClient: {
      placeOrder(orderId) {
        failCall2Count += 1;
        if (failCall2Count === 2) throw new Error('mock failure on call 2');
        return { orderId };
      },
    },
    simulateMockCalls: true,
    mockOnly: true,
    dryRun: true,
    allowRealSubmit: false,
    executionAttemptId: 'mock_fail_2',
    idempotencyKey: 'mock_fail_2',
    accountMode: 'ib_paper',
  });
  assert.equal(failCall2.ok, false);
  assert.equal(failCall2.orderSent, false);
  assert.equal(failCall2.executed, false);
  assert.equal(failCall2.blockedReason, 'real_submit_audit_only');
  assert.equal(failCall2.mockPlaceOrderCalls.length, 2);

  let failCall3Count = 0;
  const failCall3 = await bracketSvc.submitBracketOrderGroup({
    selectedBlueprint: shortBlueprint,
    submissionPlan: shortBracket.submissionPlan,
    ibClient: {
      placeOrder(orderId) {
        failCall3Count += 1;
        if (failCall3Count === 3) throw new Error('mock failure on call 3');
        return { orderId };
      },
    },
    simulateMockCalls: true,
    mockOnly: true,
    dryRun: true,
    allowRealSubmit: false,
    executionAttemptId: 'mock_fail_3',
    idempotencyKey: 'mock_fail_3',
    accountMode: 'ib_paper',
  });
  assert.equal(failCall3.ok, false);
  assert.equal(failCall3.orderSent, false);
  assert.equal(failCall3.executed, false);
  assert.equal(failCall3.blockedReason, 'real_submit_audit_only');
  assert.equal(failCall3.mockPlaceOrderCalls.length, 3);

  const protectiveMissing = await oneShotSvc.buildPaperOneShotExecution({
    now: new Date('2026-06-21T10:05:00.000Z'),
    truth: shortTruth,
    executionStatus: shortTruth.ibPaper.executionStatus,
    tradeBlueprint: shortTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight: preflightReady(shortBlueprint, readinessState),
    protectivePlan: { ...shortProtective, protectivePlanReady: false, protectiveExecutionReady: false, blockedReason: 'protective_plan_not_ready' },
    armStatus: armStatusFor(shortBlueprint, 'shot-1'),
    blueprintId: shortBlueprint.blueprintId,
    idempotencyKey: 'shot-1',
    executionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
    body: {
      blueprintId: shortBlueprint.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
    },
  });
  assert.equal(protectiveMissing.accepted, false);
  assert.equal(protectiveMissing.orderSent, false);
  assert.equal(protectiveMissing.executed, false);
  assert.equal(protectiveMissing.blockedReason, 'protective_bracket_submission_required');

  const realDisabled = await oneShotSvc.buildPaperOneShotExecution({
    now: new Date('2026-06-21T10:05:00.000Z'),
    truth: shortTruth,
    executionStatus: shortTruth.ibPaper.executionStatus,
    tradeBlueprint: shortTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight: preflightReady(shortBlueprint, readinessState),
    protectivePlan: { ...shortProtective, protectiveExecutionReady: true, blockedReason: null },
    armStatus: armStatusFor(shortBlueprint, 'shot-2'),
    blueprintId: shortBlueprint.blueprintId,
    idempotencyKey: 'shot-2',
    nextValidId: 101,
    executionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
    body: {
      blueprintId: shortBlueprint.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
    },
  });
  assert.equal(realDisabled.accepted, false);
  assert.equal(realDisabled.readyForOneShotExecution, false);
  assert.equal(realDisabled.orderSent, false);
  assert.equal(realDisabled.executed, false);
  assert.equal(realDisabled.bracketSubmissionPlanReady, true);
  assert.equal(realDisabled.bracketSubmissionRealSubmitEnabled, false);
  assert.equal(realDisabled.bracketOrderCount, 3);
  assert.equal(realDisabled.blockedReason, 'manual_user_initiated_required');
  assert.equal(realDisabled.userMessageSv, '3-leg bracket-helper är redo: Entry + Stop Loss + Take Profit. Riktig IB Paper-submit är fortfarande låst i auditläge.');
  assert.equal(realDisabled.orderButtonLocked, true);
  assert.equal(realDisabled.safety.actions_allowed, false);
  assert.equal(realDisabled.safety.can_place_orders, false);
  assert.equal(realDisabled.safety.live_trading_enabled, false);
  assert.equal(realDisabled.safety.broker_enabled, false);

  console.log('interactiveBrokersPaperBracketSubmissionService.test.js: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
