'use strict';

// IB Paper Trade Blueprint.
//
// The blueprint is now a read-only projection of the same Futures Paper
// execution pipeline used by the operational desk:
// runtime -> Strategy Registry -> Risk -> Entry Contract -> Bracket Plan.
// It does not read legacy approval stores, open sockets, submit or queue orders.

const interactiveBrokersPreviewService = require('./interactiveBrokersPreviewService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const REQUIRED_STOP_LOSS_MIN_PCT = 0.10;

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function blueprintReady(row = {}) {
  return row.blueprintReady === true || row.allowedForIbPaperPreview === true;
}

function selectReadyIbPaperBlueprint(tradeBlueprintResponse = {}) {
  const blueprints = safeArray(tradeBlueprintResponse?.blueprints);
  const selected = blueprints.find((row) => blueprintReady(row)) || null;
  if (!selected) {
    return {
      selectedBlueprint: null,
      selectedBlueprintId: null,
      selectedBlueprintSource: null,
      safeForDisplay: false,
      safeForBracketPreview: false,
      safeForArm: false,
      safeForSubmit: false,
      safetyStatus: 'blocked',
      fallback: false,
      blockedReason: 'no_execution_pipeline_ready_blueprint',
      blockers: ['no_execution_pipeline_ready_blueprint'],
      idempotencyKey: null,
    };
  }

  return {
    selectedBlueprint: selected,
    selectedBlueprintId: selected.blueprintId || null,
    selectedBlueprintSource: 'execution_runtime_pipeline',
    safeForDisplay: true,
    safeForBracketPreview: true,
    safeForArm: true,
    safeForSubmit: false,
    safetyStatus: 'pipeline_ready_read_only',
    fallback: false,
    blockedReason: null,
    blockers: [],
    idempotencyKey: null,
  };
}

function normalizeBlueprint(row = {}) {
  const blockers = safeArray(row.blockers);
  const ready = blueprintReady(row);
  return {
    ...row,
    mode: 'trade_blueprint',
    source: 'execution_runtime_pipeline',
    blueprintReady: ready,
    executionReady: ready,
    orderSendingBlocked: true,
    wouldCreateOrder: false,
    wouldSendOrder: false,
    wouldCreateIbPaperOrder: false,
    previewOnly: true,
    bracketPlanReady: row.bracket?.ok === true,
    blockedReason: ready ? null : (row.blockedReason || blockers[0] || null),
    blockers,
    safety: { ...SAFETY },
  };
}

async function getTradeBlueprint(options = {}) {
  const preview = options.executionPreview || interactiveBrokersPreviewService.getIbPaperOrderPreview({
    ...options,
    readiness: options.readiness,
    candidates: options.candidates,
    now: options.now,
  });
  const blueprints = safeArray(preview.allCandidates || preview.allowedCandidates || preview.candidates)
    .map(normalizeBlueprint);
  const selection = selectReadyIbPaperBlueprint({ blueprints });
  const selectedBlueprint = selection.selectedBlueprint;
  const blueprintReadyCount = blueprints.filter((row) => row.blueprintReady === true).length;
  const executionReadyCount = blueprints.filter((row) => row.executionReady === true).length;
  const blockedCount = blueprints.length - blueprintReadyCount;

  return {
    ok: true,
    dryRun: true,
    mode: 'trade_blueprint',
    source: 'execution_runtime_pipeline',
    executionEnabled: preview.executionEnabled === true,
    orderQueueEnabled: false,
    brokerExecutionEnabled: preview.brokerExecutionEnabled === true,
    liveTradingEnabled: false,
    orderSendingBlocked: true,
    wouldCreateOrder: false,
    requiredStopLossMinPct: REQUIRED_STOP_LOSS_MIN_PCT,
    safety: { ...SAFETY },
    readiness: preview.readiness || options.readiness || null,
    connectionReadiness: preview.readiness || options.readiness || null,
    readinessVerified: Boolean(preview.readiness?.gatewayReachable === true
      && preview.readiness?.ibApiVerified === true
      && preview.readiness?.paperAccountVerified === true),
    blueprints,
    blueprintsCount: blueprints.length,
    selectedBlueprint,
    selectedBlueprintId: selectedBlueprint?.blueprintId || null,
    selectedBlueprintSource: selectedBlueprint ? 'execution_runtime_pipeline' : null,
    selectedBlueprintSafety: selection,
    previewBlueprint: selectedBlueprint || blueprints[0] || null,
    previewBlueprintId: (selectedBlueprint || blueprints[0] || null)?.blueprintId || null,
    previewBlueprintSource: blueprints.length ? 'interactiveBrokersTradeBlueprintService.getTradeBlueprint' : null,
    summary: {
      totalCandidates: blueprints.length,
      readyCount: blueprintReadyCount,
      blockedCount,
      blueprintReadyCount,
      executionReadyCount,
      readinessVerified: Boolean(preview.readiness?.ibApiVerified === true && preview.readiness?.paperAccountVerified === true),
      candidateSource: preview.summary?.previewSource || 'futuresPaperScannerService.getCandidates',
      pipeline: ['execution_runtime', 'strategy_registry', 'risk', 'entry_contract', 'bracket_plan'],
    },
    sourceDetail: {
      candidateSource: preview.summary?.previewSource || 'futuresPaperScannerService.getCandidates',
      safety: { ...SAFETY },
    },
    note: 'Trade Blueprint is read-only and derived from the unified execution pipeline. No order is created or sent.',
  };
}

module.exports = {
  SAFETY,
  REQUIRED_STOP_LOSS_MIN_PCT,
  getTradeBlueprint,
  _internal: {
    safeString,
    safeArray,
    blueprintReady,
    selectReadyIbPaperBlueprint,
    selectManualReadyIbPaperBlueprint: selectReadyIbPaperBlueprint,
    normalizeBlueprint,
  },
};
