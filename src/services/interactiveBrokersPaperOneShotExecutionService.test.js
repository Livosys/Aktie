'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-paper-one-shot-'));
process.env.IB_PAPER_ONE_SHOT_DATA_DIR = tempDir;
process.env.IB_PAPER_ONE_SHOT_ARM_DATA_DIR = path.join(tempDir, 'arm');
process.env.IB_GATEWAY_HOST = '127.0.0.1';
process.env.IB_GATEWAY_PORT = '4002';
process.env.IB_PAPER_ONE_SHOT_ENABLED = 'false';

const svc = require('./interactiveBrokersPaperOneShotExecutionService');
const protectiveSvc = require('./interactiveBrokersPaperProtectiveOrderService');
const bracketSvc = require('./interactiveBrokersPaperBracketSubmissionService');
const armSvc = require('./interactiveBrokersPaperOneShotArmService');

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
    nextValidId: 101,
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
    stopLossPct: 0.0976,
    minStopLossPct: 0.10,
    riskPct: 1.5,
    riskAmount: 100,
    quantity: 1,
    quantityStatus: 'calculated',
    estimatedNotional: 174.25,
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

function truthWith(blueprintRow, readiness) {
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
        { rank: 1, strategyId: 'narrow_breakout', name: 'Narrow Breakout', readyForIbPaper: true },
      ],
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

function preflightReady(blueprintRow, readiness) {
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
      paperAccountVerified: readiness.paperAccountVerified,
      paperAccountIdMasked: 'DU****596',
      paperAccountId: readiness.paperAccountId,
      managedAccounts: readiness.managedAccounts,
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
  const blueprintState = blueprint();
  const truth = truthWith(blueprintState, readinessState);
  const preflight = preflightReady(blueprintState, readinessState);
  const now = new Date('2026-06-21T10:05:00.000Z');
  const readyBlueprintState = blueprint({ stopLossPct: 1 });
  const readyTruth = truthWith(readyBlueprintState, readinessState);
  const readyPreflight = preflightReady(readyBlueprintState, readinessState);
  const readyProtectivePlan = protectiveSvc.buildProtectivePreflightResponse({
    now,
    truth: readyTruth,
    executionStatus: readyTruth.ibPaper.executionStatus,
    tradeBlueprint: readyTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: readyBlueprintState,
  });

  const missingConfirmation = await svc.buildPaperOneShotExecution({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    blueprintId: blueprintState.blueprintId,
    idempotencyKey: 'shot-1',
    body: {
      blueprintId: blueprintState.blueprintId,
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
      acknowledgeBracketOrder: true,
      acknowledgeNoRetry: true,
    },
  });
  assert.equal(missingConfirmation.accepted, false);
  assert.equal(missingConfirmation.blockedReason, 'manual_confirmation_required');
  assert.equal(missingConfirmation.orderSent, false);
  assert.equal(missingConfirmation.executed, false);
  assert.equal(missingConfirmation.safety.actions_allowed, false);
  assert.equal(missingConfirmation.safety.can_place_orders, false);
  assert.equal(missingConfirmation.safety.live_trading_enabled, false);
  assert.equal(missingConfirmation.safety.broker_enabled, false);

  const wrongSecond = await svc.buildPaperOneShotExecution({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    blueprintId: blueprintState.blueprintId,
    idempotencyKey: 'shot-2',
    body: {
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'WRONG',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
      acknowledgeBracketOrder: true,
      acknowledgeNoRetry: true,
    },
  });
  assert.equal(wrongSecond.accepted, false);
  assert.equal(wrongSecond.blockedReason, 'second_confirmation_mismatch');
  assert.equal(wrongSecond.orderSent, false);
  assert.equal(wrongSecond.executed, false);

  const fallbackBlueprintBlocked = await svc.buildPaperOneShotExecution({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    blueprintId: blueprintState.blueprintId,
    idempotencyKey: 'shot-2b',
    selectedBlueprint: {
      ...blueprintState,
      source: 'protective_preflight',
      fallback: true,
      manualApprovalReady: false,
      blueprintReady: false,
    },
    body: {
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
      acknowledgeBracketOrder: true,
      acknowledgeNoRetry: true,
    },
  });
  assert.equal(fallbackBlueprintBlocked.accepted, false);
  assert.equal(fallbackBlueprintBlocked.orderSent, false);
  assert.equal(fallbackBlueprintBlocked.executed, false);
  assert.equal(fallbackBlueprintBlocked.blockedReason, 'selected_blueprint_not_manual_ready');

  const missingIdempotency = await svc.buildPaperOneShotExecution({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    blueprintId: blueprintState.blueprintId,
    body: {
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
      acknowledgeBracketOrder: true,
      acknowledgeNoRetry: true,
    },
  });
  assert.equal(missingIdempotency.accepted, false);
  assert.equal(missingIdempotency.blockedReason, 'idempotency_key_required');
  assert.equal(missingIdempotency.orderSent, false);
  assert.equal(missingIdempotency.executed, false);

  const disabled = await svc.buildPaperOneShotExecution({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    blueprintId: blueprintState.blueprintId,
    idempotencyKey: 'shot-3',
    body: {
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
      acknowledgeBracketOrder: true,
      acknowledgeNoRetry: true,
    },
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.accepted, false);
  assert.equal(disabled.readyForFirstPaperOrder, true);
  assert.equal(disabled.readyForOneShotExecution, false);
  assert.equal(disabled.orderSent, false);
  assert.equal(disabled.executed, false);
  assert.equal(disabled.blockedReason, 'protective_bracket_submission_required');
  assert.equal(disabled.safety.actions_allowed, false);
  assert.equal(disabled.safety.can_place_orders, false);

  const blockedMissingProtectivePath = await svc.buildPaperOneShotExecution({
    now,
    truth: readyTruth,
    executionStatus: readyTruth.ibPaper.executionStatus,
    tradeBlueprint: readyTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight: readyPreflight,
    protectivePlan: { ...readyProtectivePlan, protectivePathAvailable: false, protectivePlanReady: true },
    armStatus: armStatusFor(readyBlueprintState, 'shot-4'),
    blueprintId: readyBlueprintState.blueprintId,
    idempotencyKey: 'shot-4',
    executionCommand: 'FAS 4E EXECUTE FIRST IB PAPER ORDER',
    body: {
      blueprintId: readyBlueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
      acknowledgeBracketOrder: true,
      acknowledgeNoRetry: true,
    },
  });
  assert.equal(blockedMissingProtectivePath.ok, false);
  assert.equal(blockedMissingProtectivePath.accepted, false);
  assert.equal(blockedMissingProtectivePath.readyForOneShotExecution, false);
  assert.equal(blockedMissingProtectivePath.orderSent, false);
  assert.equal(blockedMissingProtectivePath.executed, false);
  assert.equal(blockedMissingProtectivePath.blockedReason, 'manual_user_initiated_required');
  assert.equal(blockedMissingProtectivePath.userMessageSv, '3-leg bracket-helper är redo: Entry + Stop Loss + Take Profit. Riktig IB Paper-submit är fortfarande låst i auditläge.');
  assert.equal(blockedMissingProtectivePath.orderButtonLocked, true);
  assert.equal(blockedMissingProtectivePath.protectiveOrdersSubmitted, false);
  assert.equal(blockedMissingProtectivePath.protectiveOrdersRequiredForFuture, true);
  assert.equal(blockedMissingProtectivePath.executionLimitedFirstOrder, true);
  assert.equal(blockedMissingProtectivePath.safety.actions_allowed, false);
  assert.equal(blockedMissingProtectivePath.safety.can_place_orders, false);
  assert.equal(blockedMissingProtectivePath.safety.live_trading_enabled, false);
  assert.equal(blockedMissingProtectivePath.safety.broker_enabled, false);

  let placeOrderCalls = 0;
  const guardedClient = {
    once() { return this; },
    on() { return this; },
    connect() { throw new Error('connect should not be called when bracket submission is missing'); },
    reqIds() { throw new Error('reqIds should not be called when bracket submission is missing'); },
    placeOrder() {
      placeOrderCalls += 1;
      throw new Error('placeOrder should not be called when bracket submission is missing');
    },
    disconnect() {},
  };

  const blockedBracketSubmission = await svc.buildPaperOneShotExecution({
    now,
    truth: readyTruth,
    executionStatus: readyTruth.ibPaper.executionStatus,
    tradeBlueprint: readyTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight: readyPreflight,
    protectivePlan: readyProtectivePlan,
    blueprintId: readyBlueprintState.blueprintId,
    idempotencyKey: 'shot-5',
    executionCommand: 'FAS 4E EXECUTE FIRST IB PAPER ORDER',
    client: guardedClient,
    body: {
      blueprintId: readyBlueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
      acknowledgeBracketOrder: true,
      acknowledgeNoRetry: true,
    },
  });
  assert.equal(blockedBracketSubmission.ok, false);
  assert.equal(blockedBracketSubmission.accepted, false);
  assert.equal(blockedBracketSubmission.readyForOneShotExecution, false);
  assert.equal(blockedBracketSubmission.blockedReason, 'manual_user_initiated_required');
  assert.equal(blockedBracketSubmission.orderSent, false);
  assert.equal(blockedBracketSubmission.executed, false);
  assert.equal(blockedBracketSubmission.userMessageSv, '3-leg bracket-helper är redo: Entry + Stop Loss + Take Profit. Riktig IB Paper-submit är fortfarande låst i auditläge.');
  assert.equal(blockedBracketSubmission.orderButtonLocked, true);
  assert.equal(blockedBracketSubmission.protectiveExecutionReady, true);
  assert.equal(blockedBracketSubmission.runtimeBracketSubmitUnlocked, false);
  assert.equal(blockedBracketSubmission.realSubmitForThisAttempt, false);
  assert.equal(placeOrderCalls, 0);
  assert.equal(blockedBracketSubmission.protectiveOrdersSubmitted, false);
  assert.equal(blockedBracketSubmission.protectiveOrdersRequiredForFuture, true);
  assert.equal(blockedBracketSubmission.executionLimitedFirstOrder, true);
  assert.equal(blockedBracketSubmission.safety.actions_allowed, false);
  assert.equal(blockedBracketSubmission.safety.can_place_orders, false);
  assert.equal(blockedBracketSubmission.safety.live_trading_enabled, false);
  assert.equal(blockedBracketSubmission.safety.broker_enabled, false);
  assert.equal(blockedBracketSubmission.summary.failedHardChecks >= 1, true);
  assert.equal(blockedBracketSubmission.summary.blockedReason, 'manual_user_initiated_required');

  const originalBracketSubmit = bracketSvc.submitBracketOrderGroup;
  let delegatedCalls = 0;
  bracketSvc.submitBracketOrderGroup = async (options = {}) => {
    delegatedCalls += 1;
    return {
      ok: true,
      accepted: false,
      helperReady: true,
      protectiveExecutionReady: false,
      bracketSubmissionPlanReady: true,
      bracketSubmissionRealSubmitEnabled: false,
      realSubmitEnabled: false,
      realSubmitActuallyExecuted: false,
      mockOnly: true,
      dryRun: true,
      orderCount: 3,
      entryOnlyBlocked: true,
      blockedReason: 'real_submit_gate_ready_requires_final_phase_4g2d',
      blockers: ['real_submit_gate_ready_requires_final_phase_4g2d'],
      checks: [],
      submissionPlan: options.submissionPlan || null,
      orderSent: false,
      executed: false,
      submitted: false,
      eventLogged: true,
      mockPlaceOrderCalls: [],
      executionAttemptId: 'mock_delegate',
      idempotencyKey: options.idempotencyKey || null,
      accountMode: 'ib_paper',
      safety: {
        mode: 'paper_only',
        actions_allowed: false,
        can_place_orders: false,
        live_trading_enabled: false,
        broker_enabled: false,
      },
      nextRequiredAction: 'Fas 4G-1B håller real submit avstängd. Helpern är endast mock-verifierad.',
      realSubmitAttempted: false,
      protectiveOrdersSubmitted: false,
      protectiveOrdersRequiredForFuture: true,
      executionLimitedFirstOrder: true,
    };
  };
  try {
    const armedShot6 = armStatusFor(readyBlueprintState, 'shot-6');
    armSvc.saveState({
      currentArm: armedShot6,
      armsById: { [armedShot6.armId]: armedShot6 },
      idempotencyKeys: {},
      usedBlueprintIds: {},
      history: [],
      lastSyncAt: now.toISOString(),
    });
    const blockedBracketPlan = await svc.buildPaperOneShotExecution({
      now,
      truth: readyTruth,
      executionStatus: readyTruth.ibPaper.executionStatus,
      tradeBlueprint: readyTruth.ibPaper.tradeBlueprint,
      readiness: readinessState,
      preflight: readyPreflight,
      protectivePlan: { ...readyProtectivePlan, protectiveExecutionReady: true, blockedReason: null },
      armStatus: armedShot6,
      blueprintId: readyBlueprintState.blueprintId,
      idempotencyKey: 'shot-6',
      nextValidId: 101,
      executionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
      body: {
        blueprintId: readyBlueprintState.blueprintId,
        confirmationPhrase: 'CONFIRM PAPER TRADE',
        secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
        armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
        acknowledgePaperOnly: true,
        acknowledgeNoLiveTrading: true,
        acknowledgeOneOrderOnly: true,
        acknowledgeBracketOrder: true,
        acknowledgeNoRetry: true,
        manualUserInitiated: false,
        openRealSubmitGateForThisAttempt: false,
      },
    });
    assert.equal(delegatedCalls, 1);
    assert.equal(blockedBracketPlan.accepted, false);
    assert.equal(blockedBracketPlan.orderSent, false);
    assert.equal(blockedBracketPlan.submitted, false);
    assert.equal(blockedBracketPlan.executed, false);
    assert.equal(blockedBracketPlan.ibOrderId, null);
    assert.equal(blockedBracketPlan.protectiveExecutionReady, true);
    assert.equal(blockedBracketPlan.runtimeBracketSubmitUnlocked, true);
    assert.equal(blockedBracketPlan.helperReady, true);
    assert.equal(blockedBracketPlan.bracketSubmissionPlanReady, true);
    assert.equal(blockedBracketPlan.bracketSubmissionRealSubmitEnabled, false);
    assert.equal(blockedBracketPlan.bracketOrderCount, 3);
    assert.equal(blockedBracketPlan.entryOnlyBlocked, true);
    assert.equal(blockedBracketPlan.blockedReason, 'manual_user_initiated_required');
    assert.equal(blockedBracketPlan.realSubmitGate.gateReady, true);
    assert.equal(blockedBracketPlan.realSubmitGate.gateOpensRealSubmit, false);
    assert.equal(blockedBracketPlan.realSubmitGate.requiresFinalPhase, '4G-2D');
    assert.equal(blockedBracketPlan.userMessageSv, '3-leg bracket-helper är redo: Entry + Stop Loss + Take Profit. Manuell användarinitiering krävs innan real submit kan öppnas.');
    assert.equal(blockedBracketPlan.orderButtonLocked, true);
    assert.equal(blockedBracketPlan.protectiveOrdersSubmitted, false);
    assert.equal(blockedBracketPlan.protectiveOrdersRequiredForFuture, true);
    assert.equal(blockedBracketPlan.executionLimitedFirstOrder, true);
    assert.equal(blockedBracketPlan.armStatus.armed, false);
    assert.equal(blockedBracketPlan.armStatus.used, true);
    assert.equal(blockedBracketPlan.realSubmitForThisAttempt, false);
    assert.equal(blockedBracketPlan.explicitRealSubmitGate, true);
    assert.equal(blockedBracketPlan.safety.actions_allowed, false);
    assert.equal(blockedBracketPlan.safety.can_place_orders, false);
    assert.equal(blockedBracketPlan.safety.live_trading_enabled, false);
    assert.equal(blockedBracketPlan.safety.broker_enabled, false);
  } finally {
    bracketSvc.submitBracketOrderGroup = originalBracketSubmit;
  }

  const duplicateStateFile = path.join(tempDir, 'paper-execution-state.json');
  fs.writeFileSync(duplicateStateFile, JSON.stringify({
    idempotencyKeys: {
      'shot-6': {
        executionAttemptId: 'ibpo_previous',
        blueprintId: readyBlueprintState.blueprintId,
        candidateId: readyBlueprintState.candidateId,
        timestamp: '2026-06-21T10:00:00.000Z',
        status: 'SUBMITTED',
      },
    },
    executedBlueprintIds: {
      [readyBlueprintState.blueprintId]: {
        executionAttemptId: 'ibpo_previous',
        idempotencyKey: 'shot-6',
        timestamp: '2026-06-21T10:00:00.000Z',
        status: 'SUBMITTED',
      },
    },
    attempts: [],
    lastAttempt: null,
    lastSubmittedOrder: null,
    lastSyncAt: '2026-06-21T10:00:00.000Z',
  }, null, 2));

  const duplicateAfterBlocked = await svc.buildPaperOneShotExecution({
    now,
    truth: readyTruth,
    executionStatus: readyTruth.ibPaper.executionStatus,
    tradeBlueprint: readyTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight: readyPreflight,
    protectivePlan: { ...readyProtectivePlan, protectiveExecutionReady: true, blockedReason: null },
    armStatus: armStatusFor(readyBlueprintState, 'shot-6'),
    blueprintId: readyBlueprintState.blueprintId,
    idempotencyKey: 'shot-6',
    nextValidId: 101,
    executionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
    body: {
      blueprintId: readyBlueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
      acknowledgeBracketOrder: true,
      acknowledgeNoRetry: true,
    },
  });
  assert.equal(duplicateAfterBlocked.accepted, false);
  assert.equal(duplicateAfterBlocked.orderSent, false);
  assert.equal(duplicateAfterBlocked.executed, false);
  assert.equal(duplicateAfterBlocked.duplicate, true);
  assert.ok([
    'real_submit_gate_ready_requires_final_phase_4g2d',
    'real_submit_audit_only',
    'manual_user_initiated_required',
    'duplicate_order_request',
    'duplicate_blueprint_execution',
    'one_shot_arm_already_used',
  ].includes(duplicateAfterBlocked.blockedReason));
  assert.ok(Array.isArray(duplicateAfterBlocked.blockers) && duplicateAfterBlocked.blockers.includes('duplicate_order_request'));

  const wrongAccountBlocked = await svc.buildPaperOneShotExecution({
    now,
    truth: readyTruth,
    executionStatus: readyTruth.ibPaper.executionStatus,
    tradeBlueprint: readyTruth.ibPaper.tradeBlueprint,
    readiness: {
      ...readinessState,
      paperAccountId: 'DUQ000000',
      paperAccountVerified: true,
    },
    preflight: readyPreflight,
    protectivePlan: { ...readyProtectivePlan, protectiveExecutionReady: true, blockedReason: null },
    armStatus: armStatusFor(readyBlueprintState, 'shot-account'),
    blueprintId: readyBlueprintState.blueprintId,
    idempotencyKey: 'shot-account',
    nextValidId: 101,
    finalPhaseEnabled: true,
    state: {
      idempotencyKeys: {},
      usedBlueprintIds: {},
      executedBlueprintIds: {},
    },
    body: {
      blueprintId: readyBlueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
      acknowledgeBracketOrder: true,
      acknowledgeNoRetry: true,
      manualUserInitiated: true,
      openRealSubmitGateForThisAttempt: true,
    },
  });
  assert.equal(wrongAccountBlocked.accepted, false);
  assert.equal(wrongAccountBlocked.orderSent, false);
  assert.equal(wrongAccountBlocked.executed, false);
  assert.equal(wrongAccountBlocked.blockedReason, 'duplicate_blueprint_execution');

  const openOrdersBlocked = await svc.buildPaperOneShotExecution({
    now,
    truth: readyTruth,
    executionStatus: {
      ...readyTruth.ibPaper.executionStatus,
      openTradeCount: 1,
      openTrades: [{ orderId: 999 }],
    },
    tradeBlueprint: readyTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight: readyPreflight,
    protectivePlan: { ...readyProtectivePlan, protectiveExecutionReady: true, blockedReason: null },
    armStatus: armStatusFor(readyBlueprintState, 'shot-open-orders'),
    blueprintId: readyBlueprintState.blueprintId,
    idempotencyKey: 'shot-open-orders',
    nextValidId: 101,
    finalPhaseEnabled: true,
    state: {
      idempotencyKeys: {},
      usedBlueprintIds: {},
      executedBlueprintIds: {},
    },
    body: {
      blueprintId: readyBlueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
      acknowledgeBracketOrder: true,
      acknowledgeNoRetry: true,
      manualUserInitiated: true,
      openRealSubmitGateForThisAttempt: true,
    },
  });
  assert.equal(openOrdersBlocked.accepted, false);
  assert.equal(openOrdersBlocked.orderSent, false);
  assert.equal(openOrdersBlocked.executed, false);
  assert.equal(openOrdersBlocked.blockedReason, 'duplicate_blueprint_execution');

  const positionBlocked = await svc.buildPaperOneShotExecution({
    now,
    truth: readyTruth,
    executionStatus: {
      ...readyTruth.ibPaper.executionStatus,
      openPositionCount: 1,
      positions: [{ contract: 'GOOGL', position: 40 }],
    },
    tradeBlueprint: readyTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight: readyPreflight,
    protectivePlan: { ...readyProtectivePlan, protectiveExecutionReady: true, blockedReason: null },
    armStatus: armStatusFor(readyBlueprintState, 'shot-position'),
    blueprintId: readyBlueprintState.blueprintId,
    idempotencyKey: 'shot-position',
    nextValidId: 101,
    finalPhaseEnabled: true,
    state: {
      idempotencyKeys: {},
      usedBlueprintIds: {},
      executedBlueprintIds: {},
    },
    body: {
      blueprintId: readyBlueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
      acknowledgeBracketOrder: true,
      acknowledgeNoRetry: true,
      manualUserInitiated: true,
      openRealSubmitGateForThisAttempt: true,
    },
  });
  assert.equal(positionBlocked.accepted, false);
  assert.equal(positionBlocked.orderSent, false);
  assert.equal(positionBlocked.executed, false);
  assert.equal(positionBlocked.blockedReason, 'duplicate_blueprint_execution');

  delete process.env.IB_PAPER_LEGACY_SUBMIT_ENABLED;
  const legacyBlockedPlan = bracketSvc.buildBracketSubmissionPlan({
    now,
    truth: readyTruth,
    executionStatus: readyTruth.ibPaper.executionStatus,
    tradeBlueprint: readyTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: readyBlueprintState,
    protectivePlan: { ...readyProtectivePlan, protectiveExecutionReady: true, blockedReason: null },
    nextValidId: 101,
  });
  let oneShotLegacyPlaceOrderCalls = 0;
  const legacyOneShotBlocked = await svc._internal.submitOneShotOrder(readyBlueprintState, {
    now,
    truth: readyTruth,
    executionStatus: readyTruth.ibPaper.executionStatus,
    tradeBlueprint: readyTruth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    selectedBlueprint: readyBlueprintState,
    bracketSubmissionPlan: legacyBlockedPlan?.submissionPlan || legacyBlockedPlan,
    idempotencyKey: 'legacy-one-shot-blocked',
    allowRealSubmit: true,
    mockOnly: false,
    dryRun: false,
    ibClient: {
      placeOrder() { oneShotLegacyPlaceOrderCalls += 1; },
    },
  });
  assert.equal(legacyOneShotBlocked.submitted, false);
  assert.equal(legacyOneShotBlocked.executed, false);
  assert.equal(legacyOneShotBlocked.orderSent, false);
  assert.equal(legacyOneShotBlocked.blockedReason, 'legacy_ibkr_submit_disabled');
  assert.equal(oneShotLegacyPlaceOrderCalls, 0, 'one-shot legacy placeOrder is not reached');

  console.log('interactiveBrokersPaperOneShotExecutionService.test.js: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
