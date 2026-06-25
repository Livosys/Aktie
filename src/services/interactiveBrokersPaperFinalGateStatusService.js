'use strict';

const interactiveBrokersPaperPreflightService = require('./interactiveBrokersPaperPreflightService');
const interactiveBrokersPaperProtectiveOrderService = require('./interactiveBrokersPaperProtectiveOrderService');
const interactiveBrokersPaperBracketSubmissionService = require('./interactiveBrokersPaperBracketSubmissionService');
const interactiveBrokersPaperOneShotArmService = require('./interactiveBrokersPaperOneShotArmService');
const interactiveBrokersTradeBlueprintService = require('./interactiveBrokersTradeBlueprintService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function resolveBlueprint(tradeBlueprint, selectedBlueprintId = null) {
  const blueprints = Array.isArray(tradeBlueprint?.blueprints) ? tradeBlueprint.blueprints : [];
  if (selectedBlueprintId) {
    return blueprints.find((row) => safeString(row?.blueprintId) === safeString(selectedBlueprintId))
      || blueprints.find((row) => safeString(row?.candidateId) === safeString(selectedBlueprintId))
      || blueprints.find((row) => safeString(row?.symbol) && safeString(row?.strategyId) && `${safeString(row.symbol)}:${safeString(row.strategyId)}` === safeString(selectedBlueprintId))
      || null;
  }
  return interactiveBrokersTradeBlueprintService._internal.selectManualReadyIbPaperBlueprint(tradeBlueprint || {})?.selectedBlueprint || null;
}

function countPositionsForSymbol(executionStatus = {}, symbol = '') {
  const safeSymbol = safeString(symbol).toUpperCase();
  const pools = [
    Array.isArray(executionStatus?.positions) ? executionStatus.positions : [],
    Array.isArray(executionStatus?.openPositions) ? executionStatus.openPositions : [],
  ];
  const matches = pools.flat().filter((row) => {
    if (!row || typeof row !== 'object') return false;
    if (!safeSymbol) return true;
    return safeString(row.symbol || row.contract?.symbol || row.localSymbol).toUpperCase() === safeSymbol;
  });
  const fallbackCount = toCount(executionStatus?.openPositionCount || 0);
  return matches.length > 0 ? matches.length : fallbackCount;
}

function buildFinalGateStatus(options = {}) {
  const now = options.now || new Date();
  const truth = options.truth || null;
  const executionStatus = options.executionStatus || truth?.ibPaper?.executionStatus || null;
  const readiness = options.readiness || truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || null;
  const tradeBlueprint = options.tradeBlueprint || truth?.ibPaper?.tradeBlueprint || null;
  const canonicalSelection = interactiveBrokersTradeBlueprintService._internal.selectManualReadyIbPaperBlueprint(tradeBlueprint || {});
  const canonicalSelectedBlueprintId = canonicalSelection?.selectedBlueprintId || null;
  const previewBlueprint = options.selectedBlueprint
    || tradeBlueprint?.previewBlueprint
    || tradeBlueprint?.selectedBlueprint
    || (Array.isArray(tradeBlueprint?.blueprints) ? tradeBlueprint.blueprints[0] : null)
    || null;
  const selectedBlueprint = options.selectedBlueprint || resolveBlueprint(tradeBlueprint, options.blueprintId || options.selectedBlueprintId || null);
  const selectedBlueprintId = canonicalSelectedBlueprintId;
  const preflight = options.preflight || interactiveBrokersPaperPreflightService.buildPaperExecutionPreflight({
    now,
    truth,
    executionStatus,
    tradeBlueprint,
    readiness,
    blueprintId: selectedBlueprintId || options.blueprintId || options.selectedBlueprintId || null,
    confirmationPhrase: options.confirmationPhrase || interactiveBrokersPaperPreflightService.REQUIRED_CONFIRMATION_PHRASE || 'CONFIRM PAPER TRADE',
    preflightOnly: true,
  });
  const protectivePreflight = options.protectivePreflight || interactiveBrokersPaperProtectiveOrderService.buildProtectivePreflightResponse({
    now,
    truth,
    executionStatus,
    tradeBlueprint,
    readiness,
    blueprintId: selectedBlueprintId || options.blueprintId || options.selectedBlueprintId || null,
    selectedBlueprint: selectedBlueprint || previewBlueprint,
  });
  const bracketPreflight = options.bracketSubmissionPlan || interactiveBrokersPaperBracketSubmissionService.buildBracketSubmissionPreflight({
    now,
    truth,
    executionStatus,
    tradeBlueprint,
    readiness,
    selectedBlueprint: selectedBlueprint || previewBlueprint,
    protectivePlan: protectivePreflight,
    nextValidId: options.nextValidId ?? readiness?.nextValidId ?? executionStatus?.readiness?.nextValidId ?? null,
  });
  const armStatus = options.armStatus || interactiveBrokersPaperOneShotArmService.getArmStatus({
    now,
    truth,
    executionStatus,
    tradeBlueprint,
    readiness,
  });
  const armSnapshot = armStatus?.currentArm || armStatus || null;
  const account = preflight?.account || protectivePreflight?.account || {
    paperAccountId: readiness?.paperAccountId || null,
    paperAccountIdMasked: readiness?.paperAccountIdMasked || null,
  };
  const paperAccountId = safeString(account?.paperAccountId);
  const paperAccountIdMasked = safeString(account?.paperAccountIdMasked);
  const armBlueprintId = safeString(armSnapshot?.blueprintId);
  const armIdempotencyKey = safeString(armSnapshot?.idempotencyKey);
  const armActive = Boolean(armSnapshot?.armed === true);
  const armExpired = Boolean(armStatus?.expired === true || armSnapshot?.expiredAt);
  const armConsumed = Boolean(armSnapshot?.used === true || armStatus?.used === true);
  const armMatchesSelectedBlueprint = !selectedBlueprintId || !armBlueprintId || armBlueprintId === selectedBlueprintId;
  const armIdempotencyMatches = !armIdempotencyKey || !safeString(options.armIdempotencyKey) || armIdempotencyKey === safeString(options.armIdempotencyKey);
  const accountMatches = !paperAccountId && !paperAccountIdMasked
    ? true
    : !safeString(armSnapshot?.paperAccountMasked)
      || safeString(armSnapshot.paperAccountMasked) === paperAccountIdMasked
      || safeString(armSnapshot.paperAccountMasked) === paperAccountId;
  const helperReady = protectivePreflight?.helperReady === true || bracketPreflight?.helperReady === true;
  const bracketSubmissionPlanReady = protectivePreflight?.bracketSubmissionPlanReady === true || bracketPreflight?.bracketSubmissionPlanReady === true;
  const bracketOrderCount = Number(protectivePreflight?.bracketOrderCount || bracketPreflight?.orderCount || 0);
  const entryOnlyBlocked = protectivePreflight?.entryOnlyBlocked === true || bracketPreflight?.entryOnlyBlocked === true;
  const openOrdersCount = toCount(executionStatus?.openTradeCount || (Array.isArray(executionStatus?.openTrades) ? executionStatus.openTrades.length : 0));
  const positionsCount = countPositionsForSymbol(executionStatus, selectedBlueprint?.symbol || '');
  const openOrdersChecked = true;
  const positionsChecked = true;
  const noOpenOrders = openOrdersCount === 0;
  const noPositions = positionsCount === 0;
  const preflightReady = preflight?.readyForFirstPaperOrder === true;
  const protectiveReady = protectivePreflight?.protectivePlanReady === true || protectivePreflight?.protectiveExecutionReady === true;
  const safetyLocked = SAFETY.actions_allowed === false
    && SAFETY.can_place_orders === false
    && SAFETY.live_trading_enabled === false
    && SAFETY.broker_enabled === false;
  const armStatusLabel = armConsumed
    ? 'consumed'
    : (armExpired
      ? 'expired'
      : (armActive
        ? (armMatchesSelectedBlueprint ? 'armed' : 'mismatch')
        : (armSnapshot?.blueprintId ? 'mismatch' : 'not_armed')));
  const armBlocker = armConsumed
    ? 'one_shot_arm_consumed'
    : (armExpired
      ? 'one_shot_arm_expired'
      : (armActive
        ? (armMatchesSelectedBlueprint ? null : 'one_shot_arm_blueprint_mismatch')
        : 'one_shot_not_armed'));
  const manualReadyBlueprintAvailable = Boolean(canonicalSelection?.selectedBlueprint);
  const armCanArm = manualReadyBlueprintAvailable === true
    && preflightReady === true
    && protectiveReady === true
    && helperReady === true
    && bracketSubmissionPlanReady === true
    && bracketOrderCount === 3
    && entryOnlyBlocked === true
    && noOpenOrders === true
    && noPositions === true
    && safetyLocked === true
    && (!armActive || armMatchesSelectedBlueprint === true);
  const submitReady = false;
  const submitBlockers = [
    !preflightReady ? (preflight?.blockedReason || 'preflight_not_ready') : null,
    !protectiveReady ? (protectivePreflight?.blockedReason || 'protective_plan_not_ready') : null,
    !helperReady ? 'protective_bracket_submission_required' : null,
    !bracketSubmissionPlanReady ? 'protective_bracket_submission_required' : null,
    bracketOrderCount !== 3 ? 'bracket_order_count_not_three' : null,
    entryOnlyBlocked !== true ? 'entry_only_forbidden' : null,
    !noOpenOrders ? 'real_submit_gate_open_orders_present' : null,
    !noPositions ? 'real_submit_gate_position_present' : null,
    !safetyLocked ? 'global_safety_not_locked' : null,
    armBlocker,
  ].filter(Boolean);
  const realSubmitGateReady = manualReadyBlueprintAvailable === true
    && preflightReady === true
    && protectiveReady === true
    && helperReady === true
    && bracketSubmissionPlanReady === true
    && bracketOrderCount === 3
    && entryOnlyBlocked === true
    && noOpenOrders === true
    && noPositions === true
    && safetyLocked === true
    && armActive === true
    && armBlocker === null
    && armMatchesSelectedBlueprint === true
    && armIdempotencyMatches === true;
  const realSubmitGateBlockedReason = armBlocker
    || (!noOpenOrders ? 'real_submit_gate_open_orders_present' : null)
    || (!noPositions ? 'real_submit_gate_position_present' : null)
    || (!armActive ? 'one_shot_not_armed' : null)
    || (!armIdempotencyMatches ? 'one_shot_arm_idempotency_mismatch' : null)
    || (!armMatchesSelectedBlueprint ? 'one_shot_arm_blueprint_mismatch' : null)
    || 'real_submit_gate_not_open';
  const oneShotArm = {
    status: armStatusLabel,
    armed: armActive,
    armId: safeString(armSnapshot?.armId) || null,
    expiresAt: armSnapshot?.expiresAt || null,
    consumedAt: armSnapshot?.usedAt || null,
    idempotencyKey: armIdempotencyKey || null,
    blueprintId: armBlueprintId || null,
    selectedBlueprintId: selectedBlueprintId || null,
    accountMatches,
    blocker: armBlocker,
    matchesSelectedBlueprint: armMatchesSelectedBlueprint,
    matchesIdempotencyKey: armIdempotencyMatches,
    expired: armExpired,
    consumed: armConsumed,
  };
  const blockers = Array.from(new Set([
    ...submitBlockers,
    ...(submitReady === true ? [] : [realSubmitGateBlockedReason]),
  ].filter(Boolean)));
  const canArm = manualReadyBlueprintAvailable === true
    && preflightReady === true
    && protectiveReady === true
    && helperReady === true
    && bracketSubmissionPlanReady === true
    && bracketOrderCount === 3
    && entryOnlyBlocked === true
    && noOpenOrders === true
    && noPositions === true
    && safetyLocked === true
    && armActive !== true;
  const nextRequiredAction = armConsumed
    ? 'Gammal arm förbrukad. Skapa en ny one-shot arm med nytt idempotencyKey.'
    : (armExpired
      ? 'Armen har gått ut. Skapa en ny one-shot arm med nytt idempotencyKey.'
      : (armActive && armMatchesSelectedBlueprint !== true
        ? 'Aktiv arm matchar inte selected blueprint. Avbryt den och skapa en ny arm.'
        : (armActive
          ? 'Armen är redo, men real submit är fortfarande låst i Fas 4G-2D.'
          : 'Skapa en ny one-shot arm när alla gate checks är gröna.')));
  return {
    ok: true,
    mode: 'paper_only',
    orderSent: false,
    executed: false,
    accepted: false,
    account: paperAccountId || paperAccountIdMasked || null,
    selectedBlueprint: selectedBlueprint ? {
      id: selectedBlueprint.blueprintId || null,
      blueprintId: selectedBlueprint.blueprintId || null,
      candidateId: selectedBlueprint.candidateId || null,
      symbol: selectedBlueprint.symbol || null,
      side: selectedBlueprint.side || null,
      quantity: selectedBlueprint.quantity ?? null,
      marketGroup: selectedBlueprint.marketGroup || null,
      strategyId: selectedBlueprint.strategyId || null,
    } : null,
    selectedBlueprintId: selectedBlueprintId || canonicalSelection?.selectedBlueprintId || null,
    selectedBlueprintSource: canonicalSelection?.selectedBlueprint ? 'trade_blueprint' : (previewBlueprint ? 'trade_blueprint' : null),
    selectedBlueprintSafety: canonicalSelection?.selectedBlueprint
      ? canonicalSelection
      : {
          selectedBlueprint: previewBlueprint || null,
          selectedBlueprintId: previewBlueprint?.blueprintId || null,
          selectedBlueprintSource: previewBlueprint ? 'trade_blueprint' : null,
          safeForDisplay: Boolean(previewBlueprint),
          safeForBracketPreview: Boolean(previewBlueprint),
          safeForArm: false,
          safeForSubmit: false,
          safetyStatus: previewBlueprint ? 'blocked' : 'blocked',
          fallback: false,
          blockedReason: previewBlueprint ? 'selected_blueprint_not_manual_ready' : 'no_manual_ready_trade_blueprint',
          blockers: previewBlueprint ? ['selected_blueprint_not_manual_ready'] : ['no_manual_ready_trade_blueprint'],
          idempotencyKey: null,
        },
    selectedBlueprintPreview: previewBlueprint,
    preflightReady,
    protectiveReady,
    bracketOrderCount,
    entryOnlyBlocked,
    realSubmitGate: {
      ready: realSubmitGateReady,
      gateReady: realSubmitGateReady,
      gateOpensRealSubmit: false,
      blockedReason: submitReady === true ? null : realSubmitGateBlockedReason,
      blockers: submitReady === true ? [] : blockers,
      requiresFinalPhase: '4G-2D',
    },
    oneShotArm,
    openOrders: {
      checked: openOrdersChecked,
      count: openOrdersCount,
      readOnly: true,
    },
    positions: {
      checked: positionsChecked,
      countForSymbol: positionsCount,
      readOnly: true,
    },
    canArm,
    submitReady,
    blockers,
    nextRequiredAction,
    safety: { ...SAFETY },
  };
}

module.exports = {
  SAFETY,
  buildFinalGateStatus,
  _internal: {
    safeString,
    toCount,
    resolveBlueprint,
    countPositionsForSymbol,
  },
};
