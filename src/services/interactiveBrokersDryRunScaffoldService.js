'use strict';

/**
 * IB Paper dry-run execution scaffold.
 *
 * This is a read-only planning layer that turns existing preview data into a
 * structured execution scaffold. It does not place orders, queue orders, open
 * broker connections or send anything.
 */

const interactiveBrokersPreviewService = require('./interactiveBrokersPreviewService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const STEP_DEFINITIONS = Object.freeze([
  {
    id: 'load_preview',
    labelSv: 'Läs read-only preview',
    status: 'ready',
    detailSv: 'Hämtar status, readiness och kandidatpreview utan att starta någon broker.',
  },
  {
    id: 'check_gate',
    labelSv: 'Kontrollera säkerhetsgrind',
    status: 'ready',
    detailSv: 'Verifikationen är fortfarande läsläge och kan inte slå på order, kö eller live-läge.',
  },
  {
    id: 'select_candidates',
    labelSv: 'Välj kandidater',
    status: 'ready',
    detailSv: 'Kandidater väljs endast från befintlig preview och blockeras om de inte uppfyller läsfiltret.',
  },
  {
    id: 'prepare_blueprint',
    labelSv: 'Förbered dry-run blueprint',
    status: 'blocked',
    detailSv: 'Blueprintern beskriver bara nästa säkra steg och kan inte skickas eller vidarebefordras.',
  },
]);

function buildCandidateBlueprint(candidate = {}) {
  return {
    strategyId: candidate.strategyId || null,
    strategyName: candidate.strategyName || null,
    symbol: candidate.symbol || null,
    direction: candidate.direction || 'unknown',
    marketGroup: candidate.marketGroup || null,
    allowedForIbPaperPreview: candidate.allowedForIbPaperPreview === true,
    blockers: Array.isArray(candidate.blockers) ? candidate.blockers : [],
    reasonSv: candidate.reasonSv || null,
    previewOnly: true,
    orderSendingBlocked: true,
    wouldCreateIbPaperOrder: false,
  };
}

async function buildDryRunExecutionScaffold(options = {}) {
  const orderPreview = options.orderPreview || interactiveBrokersPreviewService.getIbPaperOrderPreview({
    candidates: options.candidates,
    now: options.now,
  });
  const status = options.status || interactiveBrokersPreviewService.getIbPaperStatus();
  const readiness = options.readiness || (options.getReadiness
    ? await options.getReadiness()
    : await interactiveBrokersPreviewService.getConnectionReadiness());
  const approved = options.approvedStrategiesPreview || interactiveBrokersPreviewService.getApprovedStrategiesPreview();

  const previewCandidates = Array.isArray(orderPreview?.candidates) ? orderPreview.candidates : [];
  const allowedCandidates = Array.isArray(orderPreview?.allowedCandidates) ? orderPreview.allowedCandidates : previewCandidates.filter((row) => row.allowedForIbPaperPreview === true);
  const blockedCandidates = Array.isArray(orderPreview?.blockedCandidates) ? orderPreview.blockedCandidates : previewCandidates.filter((row) => row.allowedForIbPaperPreview !== true);

  const scaffoldSteps = STEP_DEFINITIONS.map((step) => ({
    ...step,
    executionEnabled: false,
    orderQueueEnabled: false,
    liveTradingEnabled: false,
    orderSendingBlocked: true,
    wouldCreateIbPaperOrder: false,
  }));

  const candidateState = allowedCandidates.length > 0 ? 'ready' : 'blocked';

  scaffoldSteps[1] = {
    ...scaffoldSteps[1],
    status: readiness?.gatewayReachable === true ? 'ready' : 'blocked',
    detailSv: readiness?.gatewayReachable === true
      ? 'Gatewayen svarar på en read-only kontroll. Inga order kan skickas.'
      : 'Gatewayen är inte nåbar eller inte kontrollerad; scaffolden förblir read-only.',
    blockedReason: readiness?.blockedReason || 'ib_gateway_unreachable_or_not_checked',
  };

  scaffoldSteps[2] = {
    ...scaffoldSteps[2],
    status: candidateState,
    detailSv: candidateState === 'ready'
      ? `${allowedCandidates.length} kandidater uppfyller preview-grindarna och är läsbara för en framtida dry-run.`
      : 'Inga kandidater uppfyller preview-grindarna ännu.',
    candidateCount: allowedCandidates.length,
  };

  const primaryCandidate = allowedCandidates[0] || previewCandidates[0] || null;

  return {
    ok: true,
    dryRun: true,
    mode: 'dry_run_execution_scaffold',
    phase: 'scaffold_only',
    safety: { ...SAFETY },
    status: status?.ok === true ? status : interactiveBrokersPreviewService.getIbPaperStatus(),
    readiness,
    approvedStrategiesPreview: approved,
    executionEnabled: false,
    orderQueueEnabled: false,
    liveTradingEnabled: false,
    orderSendingBlocked: true,
    wouldCreateIbPaperOrder: false,
    nextPhaseLocked: {
      paperOrderQueue: { locked: true, reason: 'scaffold_only' },
      brokerExecution: { locked: true, reason: 'scaffold_only' },
      liveTrading: { locked: true, reason: 'scaffold_only' },
      manualApprovalRequired: true,
    },
    summary: {
      totalScanned: Number(orderPreview?.summary?.totalScanned ?? previewCandidates.length ?? 0),
      allowedCount: allowedCandidates.length,
      blockedCount: blockedCandidates.length,
      approvedStrategyCount: Number(approved?.approvedStrategiesCount ?? approved?.approvedStrategies?.length ?? 0),
      selectedCount: previewCandidates.length,
      scaffoldStepCount: scaffoldSteps.length,
      previewMode: orderPreview?.mode || 'preview_only',
    },
    steps: scaffoldSteps,
    primaryCandidate: primaryCandidate ? buildCandidateBlueprint(primaryCandidate) : null,
    candidateBlueprints: previewCandidates.slice(0, 3).map(buildCandidateBlueprint),
    previewCandidates: previewCandidates.slice(0, 3).map(buildCandidateBlueprint),
    allowedCandidates: allowedCandidates.slice(0, 3).map(buildCandidateBlueprint),
    blockedCandidates: blockedCandidates.slice(0, 3).map(buildCandidateBlueprint),
    note: 'Dry-run scaffold only. No queue, no broker, no send path, no real order path.',
  };
}

module.exports = {
  SAFETY,
  STEP_DEFINITIONS,
  buildCandidateBlueprint,
  buildDryRunExecutionScaffold,
};
