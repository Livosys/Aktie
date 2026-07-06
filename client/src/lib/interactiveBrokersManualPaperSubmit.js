'use strict';

const REQUIRED_FINAL_EXECUTION_COMMAND = 'KÖR FÖRSTA IB PAPER BRACKET ORDER NU';
const REQUIRED_CONFIRMATION_PHRASE = 'CONFIRM PAPER TRADE';
const REQUIRED_SECOND_CONFIRMATION_PHRASE = 'CONFIRM FIRST IB PAPER ORDER';
const REQUIRED_ARM_CONFIRMATION_PHRASE = 'ARM IB PAPER ONE SHOT';
const REQUIRED_ACCOUNT = 'DUQ565596';

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function formatUtcTimestampForIdempotency(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const iso = Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

function buildManualPaperBracketSubmitIdempotencyKey(symbol, now = new Date()) {
  const safeSymbol = safeString(symbol).toUpperCase() || 'UNKNOWN';
  return `IBPAPER-MANUAL-UI-4G2E-${safeSymbol}-${formatUtcTimestampForIdempotency(now)}`;
}

function isGlobalSafetyLocked(safety = {}) {
  return safety?.actions_allowed === false
    && safety?.can_place_orders === false
    && safety?.live_trading_enabled === false
    && safety?.broker_enabled === false;
}

function buildManualPaperBracketSubmitState({
  selectedBlueprint = null,
  selectedBlueprintSource = 'trade_blueprint',
  safeForDisplay = false,
  safeForBracketPreview = false,
  safeForArm = false,
  safeForSubmit = false,
  blueprintLoadStatus = 'idle',
  blueprintLoadError = null,
  executionStatus = null,
  paperPreflightResult = null,
  realSubmitGate = null,
  armStatus = null,
  armIdempotencyKey = '',
  lastResult = null,
  confirmationPhrase = '',
  secondConfirmationPhrase = '',
  armConfirmationPhrase = '',
  finalExecutionCommand = '',
  acknowledgePaperOnly = false,
  acknowledgeNoLiveTrading = false,
  acknowledgeOneOrderOnly = false,
  acknowledgeBracketOrder = false,
  acknowledgeNoRetry = false,
  globalSafety = {},
  isSubmitting = false,
} = {}) {
  const accountMode = safeString(selectedBlueprint?.accountMode || paperPreflightResult?.account?.accountMode || 'ib_paper');
  const account = safeString(paperPreflightResult?.account?.paperAccountId || paperPreflightResult?.account?.paperAccountIdMasked || '');
  const helperReady = paperPreflightResult?.protectiveExecutionReady === true || paperPreflightResult?.bracketSubmissionPlanReady === true;
  const bracketSubmissionPlanReady = paperPreflightResult?.bracketSubmissionPlanReady === true;
  const bracketOrderCount = Number(paperPreflightResult?.bracketOrderCount || realSubmitGate?.bracketOrderCount || 0);
  const entryOnlyBlocked = paperPreflightResult?.entryOnlyBlocked === true;
  const noOpenOrders = Number(executionStatus?.openTradeCount || 0) === 0
    && (!Array.isArray(executionStatus?.openTrades) || executionStatus.openTrades.length === 0);
  const noPositions = Number(executionStatus?.openPositionCount || 0) === 0
    && (!Array.isArray(executionStatus?.openPositions) || executionStatus.openPositions.length === 0)
    && (!Array.isArray(executionStatus?.positions) || executionStatus.positions.length === 0);
  const selectedBlueprintExists = Boolean(selectedBlueprint?.blueprintId);
  const armSnapshot = armStatus?.currentArm || armStatus || null;
  const armActive = Boolean(armStatus?.armed === true || armSnapshot?.armed === true);
  const armExpired = Boolean(armStatus?.expired === true || armSnapshot?.expiredAt);
  const armUsed = Boolean(armStatus?.used === true || armSnapshot?.used === true);
  const armBlueprintMatches = !safeString(selectedBlueprint?.blueprintId)
    || !safeString(armSnapshot?.blueprintId)
    || safeString(armSnapshot?.blueprintId) === safeString(selectedBlueprint?.blueprintId);
  const armIdempotencyMatches = !safeString(armSnapshot?.idempotencyKey)
    || !safeString(armIdempotencyKey)
    || safeString(armSnapshot?.idempotencyKey) === safeString(armIdempotencyKey);
  const safetyLocked = isGlobalSafetyLocked(globalSafety);
  const selectedBlueprintIsFallback = selectedBlueprintSource !== 'trade_blueprint';
  const selectedBlueprintBlockedReason = selectedBlueprintExists
    ? (safeForArm === true ? null : 'selected_blueprint_not_manual_ready')
    : 'no_manual_ready_trade_blueprint';
  const gateReadyPreview = accountMode === 'ib_paper'
    && safeString(account) === REQUIRED_ACCOUNT
    && selectedBlueprintExists
    && safeForSubmit === true
    && helperReady === true
    && bracketSubmissionPlanReady === true
    && bracketOrderCount === 3
    && entryOnlyBlocked === true
    && noOpenOrders
    && noPositions
    && armActive === true
    && armExpired === false
    && armUsed === false
    && armBlueprintMatches === true
    && armIdempotencyMatches === true
    && safetyLocked;
  const realSubmitGateReady = realSubmitGate?.gateReady === true || gateReadyPreview;
  const realSubmitGateOpensRealSubmit = realSubmitGate?.gateOpensRealSubmit === true;
  const finalCommandMatches = safeString(finalExecutionCommand) === REQUIRED_FINAL_EXECUTION_COMMAND;
  const phrasesReady = safeString(confirmationPhrase) === REQUIRED_CONFIRMATION_PHRASE
    && safeString(secondConfirmationPhrase) === REQUIRED_SECOND_CONFIRMATION_PHRASE
    && safeString(armConfirmationPhrase) === REQUIRED_ARM_CONFIRMATION_PHRASE;
  const acknowledgementsReady = acknowledgePaperOnly === true
    && acknowledgeNoLiveTrading === true
    && acknowledgeOneOrderOnly === true
    && acknowledgeBracketOrder === true
    && acknowledgeNoRetry === true;

  const blockers = [];
  if (accountMode !== 'ib_paper') blockers.push('account_mode_not_ib_paper');
  if (!account || (account !== REQUIRED_ACCOUNT && account !== 'DU****596')) blockers.push('real_submit_gate_account_mismatch');
  if (!selectedBlueprintExists) blockers.push('no_manual_ready_trade_blueprint');
  if (selectedBlueprintIsFallback) blockers.push('selected_blueprint_fallback_not_safe_for_submit');
  else if (selectedBlueprintBlockedReason) blockers.push(selectedBlueprintBlockedReason);
  if (safeForSubmit !== true) blockers.push('real_submit_gate_not_open');
  if (helperReady !== true) blockers.push('protective_bracket_submission_required');
  if (bracketSubmissionPlanReady !== true) blockers.push('protective_bracket_submission_required');
  if (bracketOrderCount !== 3) blockers.push('bracket_order_count_not_three');
  if (entryOnlyBlocked !== true) blockers.push('entry_only_forbidden');
  if (!armActive) blockers.push('one_shot_not_armed');
  if (armExpired) blockers.push('one_shot_arm_expired');
  if (armUsed) blockers.push('one_shot_arm_already_used');
  if (!armBlueprintMatches) blockers.push('one_shot_arm_blueprint_mismatch');
  if (!armIdempotencyMatches) blockers.push('one_shot_arm_idempotency_mismatch');
  if (lastResult?.orderSent === true || lastResult?.executed === true || lastResult?.submitted === true || lastResult?.duplicate === true) {
    blockers.push('duplicate_order_request');
  }
  if (!realSubmitGateReady) blockers.push(realSubmitGate?.blockedReason || 'real_submit_gate_not_open');
  if (!noOpenOrders) blockers.push('real_submit_gate_open_orders_present');
  if (!noPositions) blockers.push('real_submit_gate_position_present');
  if (!finalCommandMatches) blockers.push('real_submit_gate_final_command_missing');
  if (!phrasesReady) blockers.push('real_submit_gate_ack_missing');
  if (!acknowledgementsReady) blockers.push('real_submit_gate_ack_missing');
  if (!safetyLocked) blockers.push('global_safety_not_locked');
  if (isSubmitting) blockers.push('submitting');

  return {
    accountMode,
    account,
    symbol: safeString(selectedBlueprint?.symbol),
    strategyId: safeString(selectedBlueprint?.strategyId),
    side: safeString(selectedBlueprint?.side),
    quantity: Number(selectedBlueprint?.quantity || 0) || null,
    entryPrice: selectedBlueprint?.entryPrice ?? selectedBlueprint?.entryReferencePrice ?? null,
    stopLoss: selectedBlueprint?.stopLoss ?? selectedBlueprint?.stopLossPrice ?? null,
    takeProfit: selectedBlueprint?.takeProfit ?? selectedBlueprint?.takeProfit1 ?? null,
    helperReady,
    safeForBracketPreview,
    bracketSubmissionPlanReady,
    bracketOrderCount,
    entryOnlyBlocked,
    gateReadyPreview,
    realSubmitGateReady,
    realSubmitGateOpensRealSubmit,
    safetyLocked,
    finalCommandMatches,
    phrasesReady,
    acknowledgementsReady,
    noOpenOrders,
    noPositions,
    selectedBlueprintExists,
    selectedBlueprintSource,
    safeForDisplay,
    safeForBracketPreview,
    safeForArm,
    safeForSubmit,
    blueprintLoadStatus,
    blueprintLoadError,
    blockers,
    buttonDisabled: blockers.length > 0,
  };
}

function buildManualPaperBracketSubmitRequests({
  selectedBlueprint,
  confirmationPhrase = REQUIRED_CONFIRMATION_PHRASE,
  secondConfirmationPhrase = REQUIRED_SECOND_CONFIRMATION_PHRASE,
  armConfirmationPhrase = REQUIRED_ARM_CONFIRMATION_PHRASE,
  finalExecutionCommand = REQUIRED_FINAL_EXECUTION_COMMAND,
  acknowledgePaperOnly = true,
  acknowledgeNoLiveTrading = true,
  acknowledgeOneOrderOnly = true,
  acknowledgeBracketOrder = true,
  acknowledgeNoRetry = true,
  now = new Date(),
} = {}) {
  const idempotencyKey = buildManualPaperBracketSubmitIdempotencyKey(selectedBlueprint?.symbol, now);
  const blueprintId = safeString(selectedBlueprint?.blueprintId || null) || null;

  return {
    idempotencyKey,
    armBody: {
      blueprintId,
      idempotencyKey,
      confirmationPhrase,
      secondConfirmationPhrase,
      armConfirmationPhrase,
      acknowledgePaperOnly,
      acknowledgeNoLiveTrading,
      acknowledgeOneOrderOnly,
      acknowledgeBracketOrder,
      acknowledgeNoRetry,
    },
    executeBody: {
      blueprintId,
      idempotencyKey,
      confirmationPhrase,
      secondConfirmationPhrase,
      armConfirmationPhrase,
      finalExecutionCommand,
      acknowledgePaperOnly,
      acknowledgeNoLiveTrading,
      acknowledgeOneOrderOnly,
      acknowledgeBracketOrder,
      acknowledgeNoRetry,
      finalPhase: '4G-2D',
      manualUserInitiated: true,
      openRealSubmitGateForThisAttempt: true,
    },
  };
}

module.exports = {
  REQUIRED_FINAL_EXECUTION_COMMAND,
  REQUIRED_CONFIRMATION_PHRASE,
  REQUIRED_SECOND_CONFIRMATION_PHRASE,
  REQUIRED_ARM_CONFIRMATION_PHRASE,
  REQUIRED_ACCOUNT,
  formatUtcTimestampForIdempotency,
  buildManualPaperBracketSubmitIdempotencyKey,
  buildManualPaperBracketSubmitState,
  buildManualPaperBracketSubmitRequests,
};

module.exports.default = module.exports;
