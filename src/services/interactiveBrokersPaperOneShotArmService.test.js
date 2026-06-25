'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DASHBOARD_USER = 'admin';
process.env.DASHBOARD_PASSWORD = 'Realmadrid25932593';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-paper-arm-'));
process.env.IB_PAPER_ONE_SHOT_ARM_DATA_DIR = tempDir;

const svc = require('./interactiveBrokersPaperOneShotArmService');

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
    blueprintId: 'ibpb_arm_1',
    candidateId: 'cand_arm_1',
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

function protectiveReady(blueprintRow, readinessState) {
  return {
    ok: true,
    mode: 'paper_only',
    preflightOnly: true,
    dryRun: true,
    accepted: true,
    protectivePathAvailable: true,
    protectivePlanReady: true,
    blockedReason: null,
    blockers: [],
    warnings: [],
    summary: {
      totalChecks: 32,
      passedChecks: 32,
      failedHardChecks: 0,
      warningChecks: 0,
      protectivePathAvailable: true,
      protectivePlanReady: true,
      blockedReason: null,
    },
    account: {
      paperAccountVerified: readinessState.paperAccountVerified,
      paperAccountIdMasked: 'DU****596',
      paperAccountId: readinessState.paperAccountId,
      managedAccounts: readinessState.managedAccounts,
      selectedAccountExists: true,
      selectedAccountMatchesPaper: true,
    },
    plan: {
      blueprintId: blueprintRow.blueprintId,
      candidateId: blueprintRow.candidateId,
      createdAt: blueprintRow.createdAt,
      expiresAt: blueprintRow.expiresAt,
      staleAfterSeconds: 600,
      symbol: blueprintRow.symbol,
      marketGroup: blueprintRow.marketGroup,
      strategyId: blueprintRow.strategyId,
      strategyName: blueprintRow.strategyName,
      direction: blueprintRow.direction,
      side: blueprintRow.side,
      quantity: blueprintRow.quantity,
      orderType: blueprintRow.orderType,
      timeInForce: blueprintRow.timeInForce,
      entry: { role: 'entry', orderType: 'LMT', action: 'BUY', quantity: 10, transmit: false },
      stopLoss: { role: 'stop_loss', orderType: 'STP', action: 'SELL', quantity: 10, stopPrice: 99, transmit: false },
      takeProfit: { role: 'take_profit', orderType: 'LMT', action: 'SELL', quantity: 10, limitPrice: 102, transmit: true },
      transmitSequence: ['entry:false', 'stopLoss:false', 'takeProfit:true'],
      parentChildPlanExists: true,
      protectiveOrdersSubmitted: false,
      dryRun: true,
      willSubmit: false,
      orderModelVerified: true,
      safety: {
        mode: 'paper_only',
        actions_allowed: false,
        can_place_orders: false,
        live_trading_enabled: false,
        broker_enabled: false,
      },
    },
    checks: [
      { code: 'paper_only_mode', ok: true, severity: 'hard' },
      { code: 'order_model_verified', ok: true, severity: 'hard' },
    ],
    orderModelVerified: true,
    contractVerified: true,
  };
}

function authReq(overrides = {}) {
  return {
    headers: {
      authorization: `Basic ${Buffer.from(`${process.env.DASHBOARD_USER}:${process.env.DASHBOARD_PASSWORD}`).toString('base64')}`,
    },
    ...overrides,
  };
}

function authRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function main() {
  const readinessState = readiness();
  const blueprintState = blueprint();
  const truth = truthWith(blueprintState, readinessState);
  const preflight = preflightReady(blueprintState, readinessState);
  const protectivePlan = protectiveReady(blueprintState, readinessState);
  const now = new Date('2026-06-21T10:05:00.000Z');

  const unauthReq = { headers: {} };
  const unauthRes = authRes();
  assert.equal(svc.requireDashboardAuth(unauthReq, unauthRes), false);
  assert.equal(unauthRes.statusCode, 401);

  const status = svc.getArmStatus({ now });
  assert.equal(status.armed, false);
  assert.equal(status.blockedReason, 'one_shot_arm_not_armed');

  const blockedMissingConfirmation = svc.armOneShot({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    protectivePlan,
    blueprintId: blueprintState.blueprintId,
    idempotencyKey: 'arm-1',
    body: {
      blueprintId: blueprintState.blueprintId,
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
    },
  });
  assert.equal(blockedMissingConfirmation.armed, false);
  assert.equal(blockedMissingConfirmation.accepted, false);
  assert.equal(blockedMissingConfirmation.orderSent, false);
  assert.equal(blockedMissingConfirmation.executed, false);
  assert.equal(blockedMissingConfirmation.blockedReason, 'manual_confirmation_required');

  const wrongArmPhrase = svc.armOneShot({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    protectivePlan,
    blueprintId: blueprintState.blueprintId,
    idempotencyKey: 'arm-2',
    body: {
      blueprintId: blueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'WRONG',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
    },
  });
  assert.equal(wrongArmPhrase.armed, false);
  assert.equal(wrongArmPhrase.blockedReason, 'arm_confirmation_mismatch');

  const fallbackRejected = svc.armOneShot({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    protectivePlan,
    selectedBlueprint: {
      ...blueprintState,
      source: 'protective_preflight',
      fallback: true,
      manualApprovalReady: false,
    },
    blueprintId: blueprintState.blueprintId,
    idempotencyKey: 'arm-fallback',
    body: {
      blueprintId: blueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
    },
  });
  assert.equal(fallbackRejected.accepted, false);
  assert.equal(fallbackRejected.armed, false);
  assert.equal(fallbackRejected.blockedReason, 'selected_blueprint_not_safe_for_arm');

  const notTop3Rejected = svc.armOneShot({
    now,
    truth: truthWith(blueprint({ top3Rank: 4, manualApprovalReady: false }), readinessState),
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    protectivePlan,
    selectedBlueprint: {
      ...blueprint({ top3Rank: 4, manualApprovalReady: false }),
      source: 'trade_blueprint',
    },
    blueprintId: 'ibpb_arm_1',
    idempotencyKey: 'arm-not-top3',
    body: {
      blueprintId: 'ibpb_arm_1',
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
    },
  });
  assert.equal(notTop3Rejected.accepted, false);
  assert.equal(notTop3Rejected.armed, false);
  assert.equal(notTop3Rejected.blockedReason, 'selected_blueprint_not_safe_for_arm');

  const ttlClamped = svc.armOneShot({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    protectivePlan,
    blueprintId: blueprintState.blueprintId,
    ttlSeconds: 999,
    idempotencyKey: 'arm-3',
    body: {
      blueprintId: blueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
    },
  });
  assert.equal(ttlClamped.armed, true);
  assert.equal(ttlClamped.ttlSeconds, 300);
  assert.equal(ttlClamped.ttlClamped, true);
  assert.equal(ttlClamped.orderSent, false);
  assert.equal(ttlClamped.executed, false);
  assert.equal(ttlClamped.safety.actions_allowed, false);
  assert.equal(ttlClamped.safety.can_place_orders, false);
  assert.equal(ttlClamped.safety.live_trading_enabled, false);
  assert.equal(ttlClamped.safety.broker_enabled, false);

  const statusArmed = svc.getArmStatus({ now });
  assert.equal(statusArmed.armed, true);
  assert.equal(statusArmed.armId, ttlClamped.armId);

  const disarmed = svc.disarmOneShot({ now, armId: ttlClamped.armId, reason: 'manual_cancel' });
  assert.equal(disarmed.armed, false);
  assert.equal(disarmed.disarmed, true);
  assert.equal(disarmed.orderSent, false);
  assert.equal(disarmed.executed, false);

  const expiredNow = new Date('2026-06-21T10:20:01.000Z');
  const rearmed = svc.armOneShot({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    protectivePlan,
    blueprintId: blueprintState.blueprintId,
    idempotencyKey: 'arm-4',
    body: {
      blueprintId: blueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
    },
  });
  const expired = svc.getArmStatus({ now: expiredNow });
  assert.equal(expired.armed, false);
  assert.equal(expired.expired, true);
  assert.equal(expired.blockedReason, 'one_shot_arm_expired');

  const consumedPrep = svc.armOneShot({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    protectivePlan,
    blueprintId: blueprintState.blueprintId,
    idempotencyKey: 'arm-5',
    body: {
      blueprintId: blueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
    },
  });
  const consumed = svc.consumeArm({ now, armId: consumedPrep.armId, blueprintId: blueprintState.blueprintId, idempotencyKey: 'arm-5' });
  assert.equal(consumed.accepted, true);
  assert.equal(consumed.consumed, true);
  assert.equal(consumed.armed, false);
  assert.equal(consumed.currentArm.used, true);
  assert.equal(consumed.currentArm.disarmedAt !== null, true);
  assert.equal(consumed.orderSent, false);
  assert.equal(consumed.executed, false);

  const duplicateIdempotency = svc.armOneShot({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    protectivePlan,
    blueprintId: blueprintState.blueprintId,
    idempotencyKey: 'arm-5',
    body: {
      blueprintId: blueprintState.blueprintId,
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
    },
  });
  assert.equal(duplicateIdempotency.armed, false);
  assert.equal(duplicateIdempotency.blockedReason, 'duplicate_order_request');

  const mismatch = svc.armOneShot({
    now,
    truth,
    executionStatus: truth.ibPaper.executionStatus,
    tradeBlueprint: truth.ibPaper.tradeBlueprint,
    readiness: readinessState,
    preflight,
    protectivePlan,
    blueprintId: 'other-blueprint',
    idempotencyKey: 'arm-6',
    body: {
      blueprintId: 'other-blueprint',
      confirmationPhrase: 'CONFIRM PAPER TRADE',
      secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
      armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
      acknowledgePaperOnly: true,
      acknowledgeNoLiveTrading: true,
      acknowledgeOneOrderOnly: true,
    },
  });
  assert.equal(mismatch.armed, false);
  assert.equal(mismatch.blockedReason, 'selected_blueprint_not_safe_for_arm');

  const res = authRes();
  assert.equal(svc.requireDashboardAuth(authReq(), res), true);

  console.log('interactiveBrokersPaperOneShotArmService.test.js: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
