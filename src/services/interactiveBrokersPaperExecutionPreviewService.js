'use strict';

/**
 * Read-only IB Paper execution preview.
 *
 * This service intentionally does not import or call any submit function. It
 * builds a diagnostic plan from existing read-only/preflight builders only.
 */

const paperTradingTruthService = require('./paperTradingTruthService');
const interactiveBrokersTradeBlueprintService = require('./interactiveBrokersTradeBlueprintService');
const interactiveBrokersPaperPreflightService = require('./interactiveBrokersPaperPreflightService');
const interactiveBrokersPaperReadinessLoaderService = require('./interactiveBrokersPaperReadinessLoaderService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const EXPECTED_PAPER_ACCOUNT = 'DUQ565596';

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeNow(value) {
  if (value instanceof Date) return value;
  if (!value) return new Date();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function buildRequestedOrderPreview(body = {}, selectedBlueprint = null) {
  const source = body && typeof body === 'object' ? body : {};
  const symbol = safeString(source.symbol || source.ticker || selectedBlueprint?.symbol).toUpperCase() || null;
  const rawAction = safeString(source.action || source.side || selectedBlueprint?.side).toUpperCase();
  const action = ['BUY', 'SELL'].includes(rawAction) ? rawAction : null;
  const quantity = Number(source.quantity || source.shares || selectedBlueprint?.quantity || 0);
  const validQuantity = Number.isFinite(quantity) && quantity > 0;

  return {
    symbol,
    action,
    quantity: validQuantity ? quantity : null,
    symbolValid: Boolean(symbol),
    actionValid: Boolean(action),
    quantityValid: validQuantity,
    formatValid: Boolean(symbol && action && validQuantity),
    note: 'Preview only. This is not an order and is never submitted.',
  };
}

function summarizeReadOnlyApiRisk() {
  return {
    checked: false,
    likelyBlocksRealOrder: true,
    message: 'IB Gateway Read-Only API is not changed by preview. If it remains enabled, a future real IB Paper placeOrder call is expected to be rejected by IB Gateway.',
  };
}

async function buildPaperExecutionPreview(options = {}) {
  const now = normalizeNow(options.now);
  const body = options.body && typeof options.body === 'object' ? options.body : {};
  const deps = options.deps || {};
  const buildTruth = deps.buildPaperTradingTruth || paperTradingTruthService.buildPaperTradingTruth;
  const buildExecutionStatus = deps.buildExecutionStatus || paperTradingTruthService.buildExecutionStatus;
  const getTradeBlueprint = deps.getTradeBlueprint || interactiveBrokersTradeBlueprintService.getTradeBlueprint;
  const buildPreflight = deps.buildPaperExecutionPreflight || interactiveBrokersPaperPreflightService.buildPaperExecutionPreflight;
  const loadReadiness = deps.loadLiveIbPaperReadinessForPreflight || interactiveBrokersPaperReadinessLoaderService.loadLiveIbPaperReadinessForPreflight;

  const truth = options.truth || await buildTruth({ now });
  const executionStatus = options.executionStatus || truth?.ibPaper?.executionStatus || await buildExecutionStatus({
    now,
    readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || undefined,
  });
  const liveReadinessSnapshot = options.liveReadinessSnapshot || options.readiness || await loadReadiness({
    expectedAccount: EXPECTED_PAPER_ACCOUNT,
    staleReadiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || undefined,
  });
  const tradeBlueprint = options.tradeBlueprint || await getTradeBlueprint({
    now,
    readiness: liveReadinessSnapshot,
    topStrategies: truth?.topStrategies,
  });
  const selectedBlueprint = body.selectedBlueprint
    || options.selectedBlueprint
    || tradeBlueprint?.selectedBlueprint
    || tradeBlueprint?.previewBlueprint
    || (Array.isArray(tradeBlueprint?.blueprints) ? tradeBlueprint.blueprints[0] : null)
    || null;
  const confirmationPhrase = safeString(body.confirmationPhrase || body.confirmationText || body.confirmText || options.confirmationPhrase || '');
  const preflight = await buildPreflight({
    now,
    blueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
    selectedBlueprintId: body.blueprintId || body.selectedBlueprintId || selectedBlueprint?.blueprintId || null,
    confirmationPhrase,
    preflightOnly: true,
    truth,
    executionStatus,
    tradeBlueprint,
    selectedBlueprint,
    readiness: liveReadinessSnapshot,
    liveReadinessSnapshot,
  });
  const readinessVerification = preflight?.readinessVerification || preflight?.sessionVerification || {
    gatewayReachable: liveReadinessSnapshot?.gatewayReachable === true,
    ibApiVerified: liveReadinessSnapshot?.ibApiVerified === true,
    paperAccountVerified: liveReadinessSnapshot?.paperAccountVerified === true,
    sessionVerified: liveReadinessSnapshot?.sessionVerified === true,
    managedAccounts: safeArray(liveReadinessSnapshot?.managedAccounts),
    paperAccountId: liveReadinessSnapshot?.paperAccountId || null,
    nextValidId: liveReadinessSnapshot?.nextValidId ?? null,
  };
  const blockers = [...new Set([
    ...(safeArray(preflight?.blockers)),
    ...(executionStatus?.executionEnabled === true ? [] : ['ib_paper_execution_disabled']),
  ].filter(Boolean))];

  return {
    ok: true,
    mode: 'paper_only',
    routeName: 'interactive-brokers.paper-execution-preview',
    phase: 'preview_only',
    previewOnly: true,
    preflightOnly: true,
    dryRun: true,
    wouldPlaceOrder: false,
    wouldSendOrder: false,
    wouldCreateIbPaperOrder: false,
    orderSent: false,
    executed: false,
    submitted: false,
    placeOrderCalled: false,
    submitFunctionCalled: false,
    finalGateArmCreated: false,
    realSubmitAllowed: false,
    allowRealSubmit: false,
    mockOnly: true,
    safety: { ...SAFETY },
    executionEnabled: executionStatus?.executionEnabled === true,
    configEnabled: executionStatus?.config?.enabled === true,
    blockedReason: blockers[0] || preflight?.blockedReason || null,
    blockers,
    requestedOrder: buildRequestedOrderPreview(body, selectedBlueprint),
    readinessVerification,
    paperAccountId: readinessVerification?.paperAccountId || liveReadinessSnapshot?.paperAccountId || null,
    managedAccounts: safeArray(readinessVerification?.managedAccounts || liveReadinessSnapshot?.managedAccounts),
    nextValidId: readinessVerification?.nextValidId ?? liveReadinessSnapshot?.nextValidId ?? null,
    selectedBlueprint: preflight?.selectedBlueprint || selectedBlueprint || null,
    checks: safeArray(preflight?.checks),
    gatesRequiredForFutureSubmit: [
      'explicit_execute_endpoint_call',
      'manual_user_initiated',
      'open_real_submit_gate_for_this_attempt',
      'active_one_shot_arm',
      'matching_idempotency_key',
      'second_confirmation_phrase',
      'paper_only_acknowledgements',
      'bracket_submission_plan_ready',
      'allowRealSubmit_true',
      'mockOnly_false',
      'dryRun_false',
    ],
    readOnlyApiRisk: summarizeReadOnlyApiRisk(),
    preflight: {
      ok: preflight?.ok === true,
      accepted: preflight?.accepted === true,
      readyForFirstPaperOrder: preflight?.readyForFirstPaperOrder === true,
      blockedReason: preflight?.blockedReason || null,
      blockers: safeArray(preflight?.blockers),
      summary: preflight?.summary || null,
      bracketSubmissionPlanReady: preflight?.bracketSubmissionPlanReady === true,
      bracketSubmissionRealSubmitEnabled: false,
      bracketOrderCount: preflight?.bracketOrderCount || 0,
      entryOnlyBlocked: preflight?.entryOnlyBlocked === true,
      orderSent: false,
      placeOrderCalled: false,
      realSubmitAllowed: false,
    },
    userMessageSv: 'IB Paper Execution Preview är read-only. Ingen order skapas, skickas eller armeras.',
  };
}

module.exports = {
  SAFETY,
  buildPaperExecutionPreview,
  _internal: {
    safeString,
    safeArray,
    normalizeNow,
    buildRequestedOrderPreview,
    summarizeReadOnlyApiRisk,
  },
};
