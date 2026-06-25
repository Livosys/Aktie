'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-paper-final-gate-'));
process.env.IB_PAPER_ONE_SHOT_ARM_DATA_DIR = tempDir;
process.env.DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
process.env.DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Realmadrid25932593';

const svc = require('./interactiveBrokersPaperFinalGateStatusService');

function readiness(overrides = {}) {
  return {
    ok: true,
    source: 'live_connection_readiness',
    loadedAt: '2026-06-22T00:00:00.000Z',
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

function blueprint(overrides = {}) {
  return {
    blueprintId: 'ibpb_73e1ef93313d48c5',
    candidateId: 'GOOGL:narrow_breakout',
    createdAt: '2026-06-22T00:00:00.000Z',
    expiresAt: '2026-06-22T00:10:00.000Z',
    staleAfterSeconds: 600,
    symbol: 'GOOGL',
    marketGroup: 'stock',
    assetClass: 'STK',
    secType: 'STK',
    exchange: 'SMART',
    primaryExchange: 'NASDAQ',
    strategyId: 'narrow_breakout',
    strategyName: 'Narrow Breakout',
    top3Rank: 2,
    top3Source: 'paperTradingTruthService.buildTopStrategySelector',
    direction: 'short',
    currentPrice: 367.04,
    side: 'SELL',
    actionLabelSv: 'Kort',
    entryType: 'limit',
    entryReferencePrice: 367.04,
    entryPrice: 367.04,
    stopLoss: 367.41,
    stopLossPrice: 367.41,
    stopLossPct: 0.1008,
    minStopLossPct: 0.1,
    stopLossDistancePct: 0.1008,
    takeProfit: 366.31,
    takeProfit1: 366.31,
    takeProfit2: 365.57,
    riskReward: 1.97,
    riskRewardRatio: 1.97,
    requiredStopLossMinPct: 0.1,
    riskPct: 0.5,
    riskAmount: 500,
    riskAmountCurrency: 'SEK',
    quantity: 40,
    quantityStatus: 'calculated',
    estimatedNotional: 14681.6,
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

function truthWith(blueprintRow, readinessState, executionOverrides = {}) {
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
        openPositions: [],
        openPositionCount: 0,
        positions: [],
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
        ...executionOverrides,
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
    checks: [],
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
    protectiveExecutionReady: true,
    helperReady: true,
    bracketSubmissionPlanReady: true,
    bracketSubmissionRealSubmitEnabled: false,
    bracketOrderCount: 3,
    entryOnlyBlocked: true,
    blockedReason: 'real_submit_audit_only',
    blockers: [],
    warnings: [],
    summary: {
      totalChecks: 32,
      passedChecks: 32,
      failedHardChecks: 0,
      warningChecks: 0,
      protectivePathAvailable: true,
      protectivePlanReady: true,
      blockedReason: 'real_submit_audit_only',
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
      symbol: blueprintRow.symbol,
      marketGroup: blueprintRow.marketGroup,
      strategyId: blueprintRow.strategyId,
      strategyName: blueprintRow.strategyName,
      direction: blueprintRow.direction,
      side: blueprintRow.side,
      quantity: blueprintRow.quantity,
      entry: { role: 'entry', action: 'SELL', quantity: 40, transmit: false },
      stopLoss: { role: 'stop_loss', action: 'BUY', quantity: 40, transmit: false, stopPrice: 367.41 },
      takeProfit: { role: 'take_profit', action: 'BUY', quantity: 40, transmit: true, limitPrice: 366.31 },
      transmitSequence: ['entry:false', 'stopLoss:false', 'takeProfit:true'],
      parentChildPlanExists: true,
      orderModelVerified: true,
    },
    selectedBlueprint: blueprintRow,
    selectedBlueprintVerification: {
      symbol: blueprintRow.symbol,
      side: blueprintRow.side,
      quantity: blueprintRow.quantity,
      marketGroup: blueprintRow.marketGroup,
      assetClass: blueprintRow.assetClass,
      secType: blueprintRow.secType,
      currency: blueprintRow.currency,
      exchange: blueprintRow.exchange,
      primaryExchange: blueprintRow.primaryExchange,
      stopLossPct: blueprintRow.stopLossPct,
      riskReward: blueprintRow.riskReward,
      blockers: [],
    },
    contractVerified: true,
    orderModelVerified: true,
  };
}

function armStatusFor(blueprintRow, idempotencyKey, overrides = {}) {
  return {
    ok: true,
    mode: 'paper_only',
    armed: true,
    armId: `arm_${blueprintRow.blueprintId}`,
    createdAt: '2026-06-22T00:03:00.000Z',
    expiresAt: '2026-06-22T00:08:00.000Z',
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
  const baseBlueprint = blueprint();
  const baseTruth = truthWith(baseBlueprint, readinessState);
  const preflight = preflightReady(baseBlueprint, readinessState);
  const protective = protectiveReady(baseBlueprint, readinessState);

  const noArm = svc.buildFinalGateStatus({
    now: new Date('2026-06-22T00:05:00.000Z'),
    truth: baseTruth,
    executionStatus: baseTruth.ibPaper.executionStatus,
    tradeBlueprint: baseTruth.ibPaper.tradeBlueprint,
    selectedBlueprint: baseBlueprint,
    preflight,
    protectivePreflight: protective,
    bracketSubmissionPlan: protective,
    armStatus: {
      ok: true,
      mode: 'paper_only',
      armed: false,
      currentArm: null,
      blockedReason: 'one_shot_arm_not_armed',
      nextRequiredAction: 'Ingen aktiv arm finns.',
    },
    readiness: readinessState,
  });
  assert.equal(noArm.ok, true);
  assert.equal(noArm.submitReady, false);
  assert.equal(noArm.realSubmitGate.gateOpensRealSubmit, false);
  assert.equal(noArm.realSubmitGate.blockedReason, 'one_shot_not_armed');
  assert.equal(noArm.oneShotArm.status, 'not_armed');
  assert.equal(noArm.canArm, true);
  assert.equal(noArm.orderSent, false);
  assert.equal(noArm.executed, false);

  const consumed = svc.buildFinalGateStatus({
    now: new Date('2026-06-22T00:05:00.000Z'),
    truth: baseTruth,
    executionStatus: baseTruth.ibPaper.executionStatus,
    tradeBlueprint: baseTruth.ibPaper.tradeBlueprint,
    selectedBlueprint: baseBlueprint,
    preflight,
    protectivePreflight: protective,
    bracketSubmissionPlan: protective,
    armStatus: armStatusFor(baseBlueprint, 'IBPAPER-BRACKET-4G2-GOOGL-2026-06-21T19-18-37-167Z', {
      armed: false,
      used: true,
      usedAt: '2026-06-21T19:22:48.170Z',
      disarmedAt: '2026-06-21T19:22:48.170Z',
      blockedReason: 'one_shot_arm_consumed',
    }),
    readiness: readinessState,
  });
  assert.equal(consumed.submitReady, false);
  assert.equal(consumed.oneShotArm.status, 'consumed');
  assert.equal(consumed.oneShotArm.blocker, 'one_shot_arm_consumed');
  assert.equal(consumed.oneShotArm.consumedAt, '2026-06-21T19:22:48.170Z');
  assert.equal(consumed.canArm, true);

  const expired = svc.buildFinalGateStatus({
    now: new Date('2026-06-22T00:05:00.000Z'),
    truth: baseTruth,
    executionStatus: baseTruth.ibPaper.executionStatus,
    tradeBlueprint: baseTruth.ibPaper.tradeBlueprint,
    selectedBlueprint: baseBlueprint,
    preflight,
    protectivePreflight: protective,
    bracketSubmissionPlan: protective,
    armStatus: armStatusFor(baseBlueprint, 'expired-key', {
      armed: false,
      used: false,
      expiredAt: '2026-06-22T00:04:00.000Z',
      blockedReason: 'one_shot_arm_expired',
    }),
    readiness: readinessState,
  });
  assert.equal(expired.submitReady, false);
  assert.equal(expired.oneShotArm.status, 'expired');
  assert.equal(expired.oneShotArm.blocker, 'one_shot_arm_expired');

  const mismatchBlueprint = blueprint({
    blueprintId: 'ibpb_other',
    candidateId: 'cand_other',
  });
  const mismatch = svc.buildFinalGateStatus({
    now: new Date('2026-06-22T00:05:00.000Z'),
    truth: truthWith(mismatchBlueprint, readinessState),
    executionStatus: baseTruth.ibPaper.executionStatus,
    tradeBlueprint: truthWith(mismatchBlueprint, readinessState).ibPaper.tradeBlueprint,
    selectedBlueprint: mismatchBlueprint,
    preflight: preflightReady(mismatchBlueprint, readinessState),
    protectivePreflight: protectiveReady(mismatchBlueprint, readinessState),
    bracketSubmissionPlan: protectiveReady(mismatchBlueprint, readinessState),
    armStatus: armStatusFor(baseBlueprint, 'arm-mismatch', {
      blueprintId: baseBlueprint.blueprintId,
    }),
    readiness: readinessState,
  });
  assert.equal(mismatch.submitReady, false);
  assert.equal(mismatch.oneShotArm.status, 'mismatch');
  assert.equal(mismatch.oneShotArm.blocker, 'one_shot_arm_blueprint_mismatch');
  assert.equal(mismatch.oneShotArm.blueprintId, baseBlueprint.blueprintId);
  assert.equal(mismatch.selectedBlueprintId, mismatchBlueprint.blueprintId);

  const cleanNewArmEligible = svc.buildFinalGateStatus({
    now: new Date('2026-06-22T00:05:00.000Z'),
    truth: baseTruth,
    executionStatus: baseTruth.ibPaper.executionStatus,
    tradeBlueprint: baseTruth.ibPaper.tradeBlueprint,
    selectedBlueprint: baseBlueprint,
    preflight,
    protectivePreflight: protective,
    bracketSubmissionPlan: protective,
    armStatus: {
      ok: true,
      mode: 'paper_only',
      armed: false,
      currentArm: null,
      blockedReason: 'one_shot_arm_not_armed',
      nextRequiredAction: 'Ingen aktiv arm finns.',
    },
    readiness: readinessState,
  });
  assert.equal(cleanNewArmEligible.canArm, true);
  assert.equal(cleanNewArmEligible.submitReady, false);
  assert.equal(cleanNewArmEligible.nextRequiredAction, 'Skapa en ny one-shot arm när alla gate checks är gröna.');

  const openOrders = svc.buildFinalGateStatus({
    now: new Date('2026-06-22T00:05:00.000Z'),
    truth: truthWith(baseBlueprint, readinessState, {
      openTrades: [{ orderId: 1, symbol: 'GOOGL' }],
      openTradeCount: 1,
    }),
    executionStatus: {
      ...baseTruth.ibPaper.executionStatus,
      openTrades: [{ orderId: 1, symbol: 'GOOGL' }],
      openTradeCount: 1,
    },
    tradeBlueprint: baseTruth.ibPaper.tradeBlueprint,
    selectedBlueprint: baseBlueprint,
    preflight,
    protectivePreflight: protective,
    bracketSubmissionPlan: protective,
    armStatus: armStatusFor(baseBlueprint, 'arm-open-orders'),
    readiness: readinessState,
  });
  assert.equal(openOrders.submitReady, false);
  assert(openOrders.blockers.includes('real_submit_gate_open_orders_present'));

  const positionConflict = svc.buildFinalGateStatus({
    now: new Date('2026-06-22T00:05:00.000Z'),
    truth: truthWith(baseBlueprint, readinessState, {
      openPositions: [{ symbol: 'GOOGL', position: 40 }],
      openPositionCount: 1,
    }),
    executionStatus: {
      ...baseTruth.ibPaper.executionStatus,
      openPositions: [{ symbol: 'GOOGL', position: 40 }],
      openPositionCount: 1,
    },
    tradeBlueprint: baseTruth.ibPaper.tradeBlueprint,
    selectedBlueprint: baseBlueprint,
    preflight,
    protectivePreflight: protective,
    bracketSubmissionPlan: protective,
    armStatus: armStatusFor(baseBlueprint, 'arm-position'),
    readiness: readinessState,
  });
  assert.equal(positionConflict.submitReady, false);
  assert(positionConflict.blockers.includes('real_submit_gate_position_present'));

  assert.equal(noArm.orderSent, false);
  assert.equal(noArm.executed, false);
  assert.equal(noArm.safety.actions_allowed, false);
  assert.equal(noArm.safety.can_place_orders, false);
  assert.equal(noArm.safety.live_trading_enabled, false);
  assert.equal(noArm.safety.broker_enabled, false);

  console.log('interactiveBrokersPaperFinalGateStatusService.test.js: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
