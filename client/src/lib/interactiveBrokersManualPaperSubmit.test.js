'use strict';

const assert = require('assert/strict');

const helper = require('./interactiveBrokersManualPaperSubmit');

const selectedBlueprint = {
  blueprintId: 'ibpb_1',
  symbol: 'GOOGL',
  strategyId: 'narrow_breakout',
  strategyName: 'Narrow Breakout',
  side: 'SELL',
  quantity: 40,
  entryPrice: 367.04,
  stopLoss: 367.41,
  takeProfit: 366.31,
  accountMode: 'ib_paper',
};

const executionStatus = {
  openTradeCount: 0,
  openTrades: [],
  openPositionCount: 0,
  openPositions: [],
  positions: [],
};

const paperPreflightResult = {
  account: { paperAccountId: 'DUQ565596', paperAccountIdMasked: 'DU****596' },
  bracketSubmissionPlanReady: true,
  bracketOrderCount: 3,
  entryOnlyBlocked: true,
  protectiveExecutionReady: true,
};

const realSubmitGate = {
  gateReady: true,
  gateOpensRealSubmit: false,
  blockedReason: 'manual_user_initiated_required',
  requiresFinalPhase: '4G-2D',
};

const armStatus = {
  armed: true,
  currentArm: {
    armed: true,
    used: false,
    expiredAt: null,
    blueprintId: selectedBlueprint.blueprintId,
    idempotencyKey: 'IBPAPER-MANUAL-UI-4G2E-GOOGL-20260621T100500Z',
  },
};

const safeBlueprintGate = {
  selectedBlueprintSource: 'trade_blueprint',
  safeForDisplay: true,
  safeForBracketPreview: true,
  safeForArm: true,
  safeForSubmit: true,
  blueprintLoadStatus: 'ok',
  blueprintLoadError: null,
};

const good = helper.buildManualPaperBracketSubmitState({
  ...safeBlueprintGate,
  selectedBlueprint,
  executionStatus,
  paperPreflightResult,
  realSubmitGate,
  armStatus,
  armIdempotencyKey: 'IBPAPER-MANUAL-UI-4G2E-GOOGL-20260621T100500Z',
  confirmationPhrase: 'CONFIRM PAPER TRADE',
  secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
  armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
  finalExecutionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
  acknowledgePaperOnly: true,
  acknowledgeNoLiveTrading: true,
  acknowledgeOneOrderOnly: true,
  acknowledgeBracketOrder: true,
  acknowledgeNoRetry: true,
  globalSafety: {
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
});

assert.equal(good.buttonDisabled, false);
assert.equal(good.helperReady, true);
assert.equal(good.bracketOrderCount, 3);
assert.equal(good.finalCommandMatches, true);
assert.equal(good.acknowledgementsReady, true);
assert.equal(good.noOpenOrders, true);
assert.equal(good.noPositions, true);

const fallbackBlocked = helper.buildManualPaperBracketSubmitState({
  selectedBlueprintSource: 'protective_preflight',
  safeForDisplay: true,
  safeForBracketPreview: true,
  safeForArm: false,
  safeForSubmit: false,
  blueprintLoadStatus: 'timeout',
  blueprintLoadError: 'timeout_after_6500ms',
  selectedBlueprint,
  executionStatus,
  paperPreflightResult,
  realSubmitGate,
  armStatus,
  confirmationPhrase: 'CONFIRM PAPER TRADE',
  secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
  armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
  finalExecutionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
  acknowledgePaperOnly: true,
  acknowledgeNoLiveTrading: true,
  acknowledgeOneOrderOnly: true,
  acknowledgeBracketOrder: true,
  acknowledgeNoRetry: true,
  globalSafety: {
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
});

assert.equal(fallbackBlocked.buttonDisabled, true);
assert(fallbackBlocked.blockers.includes('selected_blueprint_fallback_not_safe_for_submit'));

const helperMissing = helper.buildManualPaperBracketSubmitState({
  ...safeBlueprintGate,
  selectedBlueprint,
  executionStatus,
  paperPreflightResult: { ...paperPreflightResult, bracketSubmissionPlanReady: false },
  realSubmitGate,
  armStatus,
  confirmationPhrase: 'CONFIRM PAPER TRADE',
  secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
  armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
  finalExecutionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
  acknowledgePaperOnly: true,
  acknowledgeNoLiveTrading: true,
  acknowledgeOneOrderOnly: true,
  acknowledgeBracketOrder: true,
  acknowledgeNoRetry: true,
  globalSafety: {
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
});

assert.equal(helperMissing.buttonDisabled, true);
assert(helperMissing.blockers.includes('protective_bracket_submission_required'));

const badOrderCount = helper.buildManualPaperBracketSubmitState({
  ...safeBlueprintGate,
  selectedBlueprint,
  executionStatus,
  paperPreflightResult: { ...paperPreflightResult, bracketOrderCount: 2 },
  realSubmitGate,
  armStatus,
  confirmationPhrase: 'CONFIRM PAPER TRADE',
  secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
  armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
  finalExecutionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
  acknowledgePaperOnly: true,
  acknowledgeNoLiveTrading: true,
  acknowledgeOneOrderOnly: true,
  acknowledgeBracketOrder: true,
  acknowledgeNoRetry: true,
  globalSafety: {
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
});

assert.equal(badOrderCount.buttonDisabled, true);
assert(badOrderCount.blockers.includes('bracket_order_count_not_three'));

const badAccount = helper.buildManualPaperBracketSubmitState({
  ...safeBlueprintGate,
  selectedBlueprint,
  executionStatus,
  paperPreflightResult: {
    ...paperPreflightResult,
    account: { paperAccountId: 'DUQ000000', paperAccountIdMasked: 'DU****000' },
  },
  realSubmitGate,
  armStatus,
  confirmationPhrase: 'CONFIRM PAPER TRADE',
  secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
  armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
  finalExecutionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
  acknowledgePaperOnly: true,
  acknowledgeNoLiveTrading: true,
  acknowledgeOneOrderOnly: true,
  acknowledgeBracketOrder: true,
  acknowledgeNoRetry: true,
  globalSafety: {
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
});

assert.equal(badAccount.buttonDisabled, true);
assert(badAccount.blockers.includes('real_submit_gate_account_mismatch'));

const badCommand = helper.buildManualPaperBracketSubmitState({
  ...safeBlueprintGate,
  selectedBlueprint,
  executionStatus,
  paperPreflightResult,
  realSubmitGate,
  armStatus,
  confirmationPhrase: 'CONFIRM PAPER TRADE',
  secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
  armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
  finalExecutionCommand: 'WRONG',
  acknowledgePaperOnly: true,
  acknowledgeNoLiveTrading: true,
  acknowledgeOneOrderOnly: true,
  acknowledgeBracketOrder: true,
  acknowledgeNoRetry: true,
  globalSafety: {
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
});

assert.equal(badCommand.buttonDisabled, true);
assert(badCommand.blockers.includes('real_submit_gate_final_command_missing'));

const badAck = helper.buildManualPaperBracketSubmitState({
  ...safeBlueprintGate,
  selectedBlueprint,
  executionStatus,
  paperPreflightResult,
  realSubmitGate,
  armStatus,
  confirmationPhrase: 'CONFIRM PAPER TRADE',
  secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
  armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
  finalExecutionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
  acknowledgePaperOnly: true,
  acknowledgeNoLiveTrading: true,
  acknowledgeOneOrderOnly: true,
  acknowledgeBracketOrder: true,
  acknowledgeNoRetry: false,
  globalSafety: {
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
});

assert.equal(badAck.buttonDisabled, true);
assert(badAck.blockers.includes('real_submit_gate_ack_missing'));

const duplicateResult = helper.buildManualPaperBracketSubmitState({
  ...safeBlueprintGate,
  selectedBlueprint,
  executionStatus,
  paperPreflightResult,
  realSubmitGate,
  armStatus,
  lastResult: { orderSent: true },
  confirmationPhrase: 'CONFIRM PAPER TRADE',
  secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
  armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
  finalExecutionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
  acknowledgePaperOnly: true,
  acknowledgeNoLiveTrading: true,
  acknowledgeOneOrderOnly: true,
  acknowledgeBracketOrder: true,
  acknowledgeNoRetry: true,
  globalSafety: {
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
});

assert.equal(duplicateResult.buttonDisabled, true);
assert(duplicateResult.blockers.includes('duplicate_order_request'));

const armIdMismatch = helper.buildManualPaperBracketSubmitState({
  ...safeBlueprintGate,
  selectedBlueprint,
  executionStatus,
  paperPreflightResult,
  realSubmitGate,
  armStatus,
  armIdempotencyKey: 'WRONG-ARM-IDEMPOTENCY',
  confirmationPhrase: 'CONFIRM PAPER TRADE',
  secondConfirmationPhrase: 'CONFIRM FIRST IB PAPER ORDER',
  armConfirmationPhrase: 'ARM IB PAPER ONE SHOT',
  finalExecutionCommand: 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
  acknowledgePaperOnly: true,
  acknowledgeNoLiveTrading: true,
  acknowledgeOneOrderOnly: true,
  acknowledgeBracketOrder: true,
  acknowledgeNoRetry: true,
  globalSafety: {
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
});

assert.equal(armIdMismatch.buttonDisabled, true);
assert(armIdMismatch.blockers.includes('one_shot_arm_idempotency_mismatch'));

const generated = helper.buildManualPaperBracketSubmitRequests({ selectedBlueprint, now: new Date('2026-06-21T10:05:00.000Z') });
assert.equal(generated.armBody.idempotencyKey, generated.executeBody.idempotencyKey);
assert.equal(generated.executeBody.manualUserInitiated, true);
assert.equal(generated.executeBody.openRealSubmitGateForThisAttempt, true);
assert.equal(generated.executeBody.finalPhase, '4G-2D');

console.log('interactiveBrokersManualPaperSubmit.test.js passed');
