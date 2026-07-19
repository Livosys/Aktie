'use strict';

const paperTradingRuntimeService = require('./paperTradingRuntimeService');
const paperTradingStatusService = require('./paperTradingStatusService');
const paperAllowlistService = require('./paperAllowlistService');
const automationApprovalService = require('./automationApprovalService');
const strategyScoreService = require('./strategyScoreService');
const interactiveBrokersPreviewService = require('./interactiveBrokersPreviewService');
const interactiveBrokersTradeBlueprintService = require('./interactiveBrokersTradeBlueprintService');
const ibPaperExecutionOrchestratorService = require('./ibPaperExecutionOrchestratorService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const TOP_LIMIT = 3;

function safeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isRuntimeReady(execution = {}, readiness = null) {
  const source = readiness || execution.readiness || execution.connectionReadiness || execution.runtimeReadiness || {};
  return (execution.executionConnected === true || source.gatewayReachable === true)
    && (execution.nextValidIdReady === true || source.ibApiVerified === true)
    && (execution.paperAccountVerified === true || source.paperAccountVerified === true);
}

async function buildRuntimeExecutionStatus(options = {}) {
  const orchestrator = options.executionOrchestratorService
    || ibPaperExecutionOrchestratorService.defaultIbPaperExecutionOrchestratorService;
  if (!orchestrator || typeof orchestrator.buildExecutionStatus !== 'function') {
    return {
      ok: false,
      mode: 'ibkr_paper',
      accountMode: 'ib_paper',
      executionEnabled: false,
      orderSendingBlocked: true,
      liveTradingEnabled: false,
      can_place_orders: false,
      actions_allowed: false,
      broker_enabled: false,
      blockedReason: 'execution_runtime_unavailable',
      blockers: ['execution_runtime_unavailable'],
      source: 'ib_paper_execution_runtime_singleton',
      safety: { ...SAFETY },
    };
  }
  const status = await orchestrator.buildExecutionStatus({ force: options.forceExecutionStatus === true });
  const readiness = status.readiness || status.connectionReadiness || status.runtimeReadiness || null;
  const executionEnabled = status.paperBrokerExecutionEnabled === true || status.flags?.executionEnabled === true;
  const blockedReason = status.reconciliation?.blockedReason
    || status.account?.blocker
    || (executionEnabled ? null : 'ibkr_paper_execution_disabled');
  const blockers = [
    blockedReason,
    ...(Array.isArray(status.reconciliation?.discrepancies)
      ? status.reconciliation.discrepancies.map((row) => row?.type || row?.blocker).filter(Boolean)
      : []),
  ].filter(Boolean);

  return {
    ...status,
    mode: status.mode || 'ibkr_paper',
    accountMode: 'ib_paper',
    source: 'ib_paper_execution_runtime_singleton',
    featureFlag: 'IBKR_PAPER_EXECUTION_ENABLED',
    enabled: executionEnabled,
    executionEnabled,
    orderSendingBlocked: true,
    liveTradingEnabled: false,
    can_place_orders: false,
    actions_allowed: false,
    broker_enabled: false,
    blockedReason,
    blockers,
    readiness,
    gatewayReachable: readiness?.gatewayReachable === true || status.executionConnected === true,
    ibApiVerified: readiness?.ibApiVerified === true || status.nextValidIdReady === true,
    paperAccountVerified: status.paperAccountVerified === true || readiness?.paperAccountVerified === true,
    accountVerified: status.paperAccountVerified === true || readiness?.paperAccountVerified === true,
    dailyQuota: status.dailyQuota || { used: 0, max: 3, remaining: 3 },
    openTrades: status.brokerOpenOrders || [],
    openTradeCount: Array.isArray(status.brokerOpenOrders) ? status.brokerOpenOrders.length : 0,
    closedTrades: status.brokerExecutions || [],
    closedTradeCount: Array.isArray(status.brokerExecutions) ? status.brokerExecutions.length : 0,
    lastExecutionResult: null,
    safety: { ...SAFETY, ...(status.safety || {}) },
  };
}

function buildTopStrategySelector(options = {}) {
  const runtimePreview = options.runtimePreview
    || paperTradingRuntimeService._internal.buildDailySelectionPreview({
      selectionCount: TOP_LIMIT,
      now: options.now,
      files: options.files,
    });
  const scores = options.strategyScores || strategyScoreService.defaultStrategyScoreService.getStrategyScores();
  const runtimeCandidates = safeArray(runtimePreview?.allCandidates).length
    ? safeArray(runtimePreview.allCandidates)
    : safeArray(runtimePreview?.candidates);
  const runtimeById = new Map();
  for (const row of runtimeCandidates) {
    const key = safeString(row?.canonicalStrategyId || row?.strategyId);
    if (!key) continue;
    runtimeById.set(key, row);
  }
  const scoreRows = safeArray(scores?.top_strategies);
  const scoreById = new Map(scoreRows.map((row) => [safeString(row?.strategy_id), row]).filter(([id]) => Boolean(id)));

  const ordered = [];
  const seen = new Set();

  function pushFromRuntime(row, sourceLabel) {
    const strategyId = safeString(row?.canonicalStrategyId || row?.strategyId);
    if (!strategyId || seen.has(strategyId)) return;
    const score = scoreById.get(strategyId) || null;
    const blockers = safeArray(row?.blockers);
    ordered.push({
      rank: ordered.length + 1,
      strategyId,
      name: safeString(row?.strategyName || score?.strategy_id || strategyId) || strategyId,
      source: sourceLabel || (score ? 'learning_summary+runtime_preview' : 'runtime_preview'),
      reason: score
        ? `Learning-summary score ${score.score}/100, confidence ${score.confidence}/100. Runtime preview: ${safeString(row?.reasonSv || row?.reason || 'klar')}`
        : safeString(row?.reasonSv || row?.reason || 'Runtime preview säger att strategin är klar för läsning.'),
      readyForIbPaper: row?.allowedForIbPaperPreview === true,
      blockers,
      candidateId: row?.candidateId || null,
      symbol: row?.symbol || null,
      direction: row?.direction || 'unknown',
      score: score?.score ?? row?.score ?? null,
      confidence: score?.confidence ?? row?.confidence ?? null,
      approvalStatus: row?.approvalStatus || null,
      marketGroup: row?.marketGroup || null,
      latestActivityAt: row?.latestActivityAt || null,
      safety: { ...SAFETY },
    });
    seen.add(strategyId);
  }

  for (const scoreRow of scoreRows) {
    if (ordered.length >= TOP_LIMIT) break;
    const runtimeRow = runtimeById.get(safeString(scoreRow?.strategy_id));
    if (!runtimeRow) continue;
    pushFromRuntime(runtimeRow, 'learning_summary+runtime_preview');
  }

  if (ordered.length < TOP_LIMIT) {
    const fallbackRows = [...runtimeCandidates].sort((a, b) => {
      const ai = Number(a?.selectionRank || 0);
      const bi = Number(b?.selectionRank || 0);
      if (bi !== ai) return bi - ai;
      return safeString(a?.canonicalStrategyId || a?.strategyId).localeCompare(safeString(b?.canonicalStrategyId || b?.strategyId));
    });
    for (const row of fallbackRows) {
      if (ordered.length >= TOP_LIMIT) break;
      pushFromRuntime(row, 'runtime_preview');
    }
  }

  return {
    ok: true,
    mode: 'paper_only',
    selectionCount: TOP_LIMIT,
    selectedCount: ordered.length,
    source: {
      strategyScoreSource: 'strategyScoreService.getStrategyScores',
      runtimePreviewSource: 'paperTradingRuntimeService._internal.buildDailySelectionPreview',
      safety: { ...SAFETY },
    },
    summary: {
      totalScanned: Number(runtimePreview?.totalScanned ?? runtimeCandidates.length ?? 0),
      allowedCandidates: Number(runtimePreview?.summary?.allowedCandidates ?? 0),
      blockedCandidates: Number(runtimePreview?.summary?.blockedCandidates ?? 0),
      selectionCount: TOP_LIMIT,
      selectedCount: ordered.length,
      availableStrategies: Number(scoreRows.length),
      previewDate: runtimePreview?.date || null,
      previewSource: runtimePreview?.summary?.previewSource || 'paperTradingRuntimeService._internal.buildDailySelectionPreview',
      note: runtimePreview?.summary?.noteSv || runtimePreview?.explanation || null,
      insufficientAllowedReason: runtimePreview?.summary?.insufficientAllowedReason || null,
    },
    topStrategies: ordered.slice(0, TOP_LIMIT),
    safety: { ...SAFETY },
  };
}

async function buildPaperTradingTruth(options = {}) {
  const issues = [];

  let runtime = null;
  try {
    runtime = options.runtime || paperTradingRuntimeService.buildPaperTradingRuntime({
      limit: options.limit || 50,
      files: options.files,
    });
  } catch (err) {
    issues.push({ source: 'paperTradingRuntimeService.buildPaperTradingRuntime', error: err.message || String(err) });
    runtime = { ok: false, status: 'error', summary: { openCount: 0, closedCount: 0, eventCount: 0, blockedCount: 0, returnedCount: 0 }, dailySelectionPreview: { candidates: [] }, safety: { ...SAFETY } };
  }

  let paperStatus = null;
  try {
    paperStatus = options.paperStatus || paperTradingStatusService.buildSupervisorPaperSummary({ files: options.files });
  } catch (err) {
    issues.push({ source: 'paperTradingStatusService.buildSupervisorPaperSummary', error: err.message || String(err) });
    paperStatus = {
      status: 'error',
      summary: { openCount: 0, closedCount: 0, eventCount: 0, blockedCount: 0 },
      allowlist: {
        totalApproved: 0,
        readyForPaperRuntime: 0,
        pendingRuntimeConnection: 0,
        approvedStrategyIds: [],
        waitingForApproval: [],
      },
      safety: { ...SAFETY },
    };
  }

  let allowlist = null;
  try {
    allowlist = options.allowlist || paperAllowlistService.getPaperAllowlistStatus();
  } catch (err) {
    issues.push({ source: 'paperAllowlistService.getPaperAllowlistStatus', error: err.message || String(err) });
    allowlist = {
      ok: false,
      totalApproved: 0,
      readyForPaperRuntime: 0,
      pendingRuntimeConnection: 0,
      paperRuntimeReady: false,
      runtimeConnectionStatus: 'unknown',
      allowlist: [],
      note: 'allowlist_unavailable',
      safety: { ...SAFETY },
    };
  }

  let approvals = null;
  try {
    approvals = options.approvals || automationApprovalService.getAutomationApprovals();
  } catch (err) {
    issues.push({ source: 'automationApprovalService.getAutomationApprovals', error: err.message || String(err) });
    approvals = {
      ok: false,
      approvedCount: 0,
      approvedStrategyIds: [],
      rejectedStrategyIds: [],
      waitingForApproval: [],
      safety: { ...SAFETY },
    };
  }

  let topStrategies = null;
  try {
    topStrategies = options.topStrategies || buildTopStrategySelector({
      now: options.now,
      files: options.files,
      runtimePreview: runtime?.dailySelectionPreview,
      strategyScores: options.strategyScores,
    });
  } catch (err) {
    issues.push({ source: 'paperTradingTruthService.buildTopStrategySelector', error: err.message || String(err) });
    topStrategies = {
      ok: false,
      mode: 'paper_only',
      selectionCount: TOP_LIMIT,
      selectedCount: 0,
      topStrategies: [],
      summary: {
        totalScanned: 0,
        allowedCandidates: 0,
        blockedCandidates: 0,
        selectionCount: TOP_LIMIT,
        selectedCount: 0,
        availableStrategies: 0,
        previewDate: null,
        previewSource: 'error',
        note: 'top_strategy_selector_unavailable',
        insufficientAllowedReason: 'top_strategy_selector_unavailable',
      },
      safety: { ...SAFETY },
    };
  }

  let ibPaperStatus = null;
  try {
    ibPaperStatus = options.ibPaperStatus || interactiveBrokersPreviewService.getIbPaperStatus();
  } catch (err) {
    issues.push({ source: 'interactiveBrokersPreviewService.getIbPaperStatus', error: err.message || String(err) });
    ibPaperStatus = {
      ok: false,
      dryRun: true,
      safety: { ...SAFETY },
      orderSendingBlocked: true,
      orderQueueBlocked: true,
      executionBlocked: true,
      wouldCreateIbPaperOrder: false,
      blockedReason: 'ib_status_unavailable',
      approvedStrategies: [],
      approvedStrategiesCount: 0,
      approvedStrategiesSource: { available: false, status: 'degraded' },
      internalPaperTradingUnaffected: true,
      connection: { gatewayReachable: false, status: 'error', blockedReason: 'ib_status_unavailable' },
    };
  }

  let connectionReadiness = null;
  try {
    connectionReadiness = options.connectionReadiness || await interactiveBrokersPreviewService.getConnectionReadiness();
  } catch (err) {
    issues.push({ source: 'interactiveBrokersPreviewService.getConnectionReadiness', error: err.message || String(err) });
    connectionReadiness = {
      ok: false,
      dryRun: true,
      safety: { ...SAFETY },
      host: '127.0.0.1',
      port: 4002,
      status: 'error',
      gatewayReachable: false,
      blockedReason: 'ib_gateway_unreachable',
    };
  }

  let ibOrderPreview = null;
  try {
    ibOrderPreview = options.ibOrderPreview || interactiveBrokersPreviewService.getIbPaperOrderPreview({
      now: options.now,
      files: options.files,
    });
  } catch (err) {
    issues.push({ source: 'interactiveBrokersPreviewService.getIbPaperOrderPreview', error: err.message || String(err) });
    ibOrderPreview = {
      ok: false,
      mode: 'preview_only',
      candidates: [],
      allowedCandidates: [],
      blockedCandidates: [],
      allCandidates: [],
      summary: {
        totalCandidates: 0,
        totalScanned: 0,
        allowedCandidates: 0,
        blockedCandidates: 0,
        allowedVisibleCount: 0,
        blockedVisibleCount: 0,
        availableAllowedCandidates: 0,
        availableBlockedCandidates: 0,
        previewSource: 'error',
        noteSv: 'order_preview_unavailable',
        insufficientAllowedReason: 'order_preview_unavailable',
      },
      safety: { ...SAFETY },
    };
  }

  let ibBlueprint = null;
  try {
    ibBlueprint = options.ibBlueprint || await interactiveBrokersTradeBlueprintService.getTradeBlueprint({
      now: options.now,
      readiness: connectionReadiness,
      orderPreview: ibOrderPreview,
      topStrategies,
      marketResults: options.marketResults,
      riskConfig: options.riskConfig,
    });
  } catch (err) {
    issues.push({ source: 'interactiveBrokersTradeBlueprintService.getTradeBlueprint', error: err.message || String(err) });
    ibBlueprint = {
      ok: false,
      dryRun: true,
      mode: 'trade_blueprint',
      executionEnabled: false,
      orderQueueEnabled: false,
      brokerExecutionEnabled: false,
      liveTradingEnabled: false,
      orderSendingBlocked: true,
      wouldCreateOrder: false,
      requiredStopLossMinPct: 0.10,
      safety: { ...SAFETY },
      blueprints: [],
      blueprintsCount: 0,
      summary: { totalCandidates: 0, readyCount: 0, blockedCount: 0, approvedStrategyCount: 0, allowedCandidateCount: 0, priceSource: 'error', candidateSource: 'error' },
      source: { candidateSource: 'error', priceSource: 'error', safety: { ...SAFETY } },
      note: 'trade_blueprint_unavailable',
    };
  }

  let ibExecution = null;
  try {
    ibExecution = options.ibExecution || await buildRuntimeExecutionStatus({
      forceExecutionStatus: options.forceExecutionStatus === true,
      executionOrchestratorService: options.executionOrchestratorService,
    });
  } catch (err) {
    issues.push({ source: 'ibPaperExecutionOrchestratorService.buildExecutionStatus', error: err.message || String(err) });
    ibExecution = {
      ok: false,
      dryRun: true,
      mode: 'ibkr_paper',
      executionEnabled: false,
      orderSendingBlocked: true,
      liveTradingEnabled: false,
      can_place_orders: false,
      actions_allowed: false,
      broker_enabled: false,
      blockedReason: 'execution_runtime_unavailable',
      blockers: ['execution_runtime_unavailable'],
      safety: { ...SAFETY },
      dailyQuota: { used: 0, max: 3, remaining: 3 },
      openTrades: [],
      openTradeCount: 0,
      closedTrades: [],
      closedTradeCount: 0,
      lastExecutionResult: null,
      featureFlag: 'IBKR_PAPER_EXECUTION_ENABLED',
      readiness: connectionReadiness || ibPaperStatus.connection || { gatewayReachable: false, status: 'error', blockedReason: 'ib_execution_unavailable' },
    };
  }

  const blueprintRows = safeArray(ibBlueprint?.blueprints);
  const selectedBlueprint = ibBlueprint?.selectedBlueprint
    || blueprintRows.find((row) => row?.manualApprovalReady === true)
    || blueprintRows.find((row) => row?.blueprintReady === true)
    || blueprintRows[0]
    || null;
  const topStrategyList = safeArray(topStrategies?.topStrategies);
  const runtimeCandidates = safeArray(runtime?.dailySelectionPreview?.candidates);
  const approvedStrategyIds = safeArray(allowlist?.allowlist).map((row) => row.id).filter(Boolean);
  const runtimeBlockers = safeArray(runtime?.blockedCandidates);
  const blockerCounts = new Map();
  for (const row of runtimeBlockers) {
    const reason = safeString(row?.blockedReason || row?.reasonSv || row?.reason || 'blocked');
    blockerCounts.set(reason, (blockerCounts.get(reason) || 0) + 1);
  }
  const blockerSummary = [...blockerCounts.entries()].map(([reason, count]) => ({ reason, count }));
  const paperReadyTop3 = topStrategyList.filter((row) => row?.readyForIbPaper === true);
  const runtimeEmpty = Number(runtime?.summary?.openCount || 0) === 0
    && Number(runtime?.summary?.closedCount || 0) === 0
    && Number(runtime?.summary?.eventCount || 0) === 0
    && Number(runtime?.summary?.blockedCount || 0) === 0
    && runtimeCandidates.length === 0;

  const blockers = [];
  if (!approvedStrategyIds.length) blockers.push({ code: 'no_approved_strategies', source: 'allowlist', reason: 'Inga godkända strategier finns i allowlisten just nu.' });
  if (!paperReadyTop3.length) blockers.push({ code: 'top_3_not_ready', source: 'top_strategy_selector', reason: 'Top 3 selector har inga redo kandidater ännu.' });
  if (runtimeEmpty) blockers.push({ code: 'runtime_empty', source: 'paper_runtime', reason: 'Paper runtime har ännu inga records i detta fönster.' });
  if (ibPaperStatus?.blockedReason) blockers.push({ code: String(ibPaperStatus.blockedReason), source: 'ib_status', reason: 'IB Paper status är fortfarande läsläge eller blockerat.' });
  if (ibExecution?.blockedReason) blockers.push({ code: String(ibExecution.blockedReason), source: 'ib_execution', reason: 'IB execution är fortfarande blockerat.' });

  return {
    ok: true,
    mode: 'paper_only',
    generatedAt: new Date().toISOString(),
    safety: { ...SAFETY },
    issues,
    runtime,
    paperStatus,
    allowlist,
    approvals,
    topStrategies,
    candidateReadiness: {
      totalScanned: Number(runtime?.dailySelectionPreview?.totalScanned ?? runtimeCandidates.length ?? 0),
      allowedCandidates: Number(runtime?.dailySelectionPreview?.summary?.allowedCandidates ?? 0),
      blockedCandidates: Number(runtime?.dailySelectionPreview?.summary?.blockedCandidates ?? 0),
      selectedCount: Number(runtime?.dailySelectionPreview?.selectedCount ?? 0),
      selectionCount: Number(runtime?.dailySelectionPreview?.selectionCount ?? TOP_LIMIT),
      readyTopStrategies: paperReadyTop3.length,
      topStrategyIds: topStrategyList.map((row) => row.strategyId),
      blockers: blockerSummary,
      reason: runtime?.dailySelectionPreview?.summary?.noteSv || runtime?.dailySelectionPreview?.explanation || 'Read-only preview.',
      insufficientAllowedReason: runtime?.dailySelectionPreview?.summary?.insufficientAllowedReason || null,
      runtimeEmpty,
    },
    blockers,
    ibPaper: {
      status: {
        ...ibPaperStatus,
        connection: connectionReadiness || ibPaperStatus.connection,
      },
      connectionReadiness,
      orderPreview: ibOrderPreview,
      tradeBlueprint: ibBlueprint,
      executionStatus: ibExecution,
      selectedBlueprint,
      selectedBlueprintSource: selectedBlueprint ? 'interactiveBrokersTradeBlueprintService.getTradeBlueprint' : null,
      accountMode: 'ib_paper',
      manualApprovalRequired: true,
      manualApproval: ibBlueprint?.manualApproval || {
        requiredConfirmationPhrase: 'CONFIRM PAPER TRADE',
        confirmationEntered: false,
        approvalStatus: selectedBlueprint
          ? (selectedBlueprint.executionReady === true
            ? 'ready_for_future_execution'
            : (selectedBlueprint.manualApprovalReady === true ? 'waiting_for_user' : 'blocked'))
          : 'not_available',
        blockers: selectedBlueprint?.blockers || [],
        warnings: selectedBlueprint?.warnings || [],
        createdAt: selectedBlueprint?.createdAt || null,
        expiresAt: selectedBlueprint?.expiresAt || null,
        pendingBlueprints: safeArray(ibBlueprint?.blueprints).filter((row) => row?.blueprintReady === true),
        selectedBlueprint,
        safety: { ...SAFETY },
      },
      noLiveTradingBadge: true,
      safety: { ...SAFETY },
      topStrategies: topStrategyList,
      readiness: ibExecution?.readiness || connectionReadiness || ibPaperStatus?.connection || null,
      disableReason: ibExecution?.blockedReason || (isRuntimeReady(ibExecution, connectionReadiness) ? null : (connectionReadiness?.gatewayReachable === true ? 'ib_api_not_verified' : ibPaperStatus?.blockedReason || 'paper_only')),
    },
    summary: {
      runtimeOpenCount: Number(runtime?.summary?.openCount || 0),
      runtimeClosedCount: Number(runtime?.summary?.closedCount || 0),
      runtimeEventCount: Number(runtime?.summary?.eventCount || 0),
      allowlistApprovedCount: Number(allowlist?.totalApproved || 0),
      allowlistReadyCount: Number(allowlist?.readyForPaperRuntime || 0),
      topStrategiesCount: topStrategyList.length,
      ibReadyCount: paperReadyTop3.length,
      ibBlueprintCount: Number(ibBlueprint?.blueprintsCount ?? 0),
    },
  };
}

async function buildExecutionStatus(options = {}) {
  const truth = await buildPaperTradingTruth(options);
  const execution = truth.ibPaper.executionStatus || {};
  const selectedBlueprint = truth.ibPaper.selectedBlueprint || null;
  const readiness = execution.readiness || execution.connectionReadiness || execution.runtimeReadiness || truth.ibPaper.readiness || null;
  const executionEnabled = execution.executionEnabled === true
    || execution.paperBrokerExecutionEnabled === true
    || execution.flags?.executionEnabled === true;
  const runtimeReady = isRuntimeReady(execution, readiness);
  const blockedReason = execution.blockedReason || truth.ibPaper.disableReason || (executionEnabled ? null : 'ibkr_paper_execution_disabled');
  return {
    ...execution,
    ok: true,
    mode: execution.mode || 'ibkr_paper',
    accountMode: 'ib_paper',
    featureFlag: execution.featureFlag || 'IBKR_PAPER_EXECUTION_ENABLED',
    enabled: executionEnabled,
    executionEnabled,
    orderSendingBlocked: execution.orderSendingBlocked !== false,
    liveTradingEnabled: false,
    can_place_orders: false,
    actions_allowed: false,
    broker_enabled: false,
    safety: { ...SAFETY },
    blockedReason,
    disableReason: blockedReason,
    blockers: safeArray(execution.blockers),
    readiness,
    gatewayReachable: execution.gatewayReachable === true || readiness?.gatewayReachable === true || execution.executionConnected === true,
    ibApiVerified: execution.ibApiVerified === true || readiness?.ibApiVerified === true || execution.nextValidIdReady === true,
    paperAccountVerified: execution.paperAccountVerified === true || readiness?.paperAccountVerified === true,
    executionConnected: execution.executionConnected === true || readiness?.gatewayReachable === true,
    nextValidIdReady: execution.nextValidIdReady === true || readiness?.ibApiVerified === true,
    nextValidId: execution.nextValidId ?? readiness?.nextValidId ?? null,
    managedAccounts: execution.managedAccounts || readiness?.managedAccounts || [],
    managedAccountCount: execution.managedAccountCount ?? readiness?.managedAccountCount ?? 0,
    runtimeState: execution.runtimeState || execution.executionRuntimeState || readiness?.runtimeState || null,
    executionRuntimeState: execution.executionRuntimeState || execution.runtimeState || readiness?.runtimeState || null,
    connectedSince: execution.connectedSince || readiness?.connectedSince || null,
    lastHeartbeat: execution.lastHeartbeat || readiness?.lastHeartbeat || null,
    lastReconnect: execution.lastReconnect || readiness?.lastReconnect || null,
    uptime: execution.uptime ?? execution.uptimeMs ?? readiness?.uptime ?? null,
    reconnectCount: execution.reconnectCount ?? readiness?.reconnectCount ?? 0,
    runtimeLifecycle: execution.runtimeLifecycle || readiness?.runtimeLifecycle || null,
    runtimeLifecycleState: execution.runtimeLifecycleState || readiness?.runtimeLifecycleState || null,
    runtimeReady,
    dailyQuota: execution.dailyQuota || { used: 0, max: 3, remaining: 3 },
    openTrades: safeArray(execution.openTrades),
    openTradeCount: Number(execution.openTradeCount || safeArray(execution.openTrades).length || 0),
    closedTrades: safeArray(execution.closedTrades),
    closedTradeCount: Number(execution.closedTradeCount || safeArray(execution.closedTrades).length || 0),
    lastExecutionResult: execution.lastExecutionResult || null,
    selectedBlueprint,
    selectedBlueprintSource: truth.ibPaper.selectedBlueprintSource || null,
    manualApproval: truth.ibPaper.manualApproval || null,
    topStrategies: truth.topStrategies?.topStrategies || [],
    candidateReadiness: truth.candidateReadiness,
    noLiveTradingBadge: true,
    manualApprovalRequired: true,
    accountVerified: execution.paperAccountVerified === true || readiness?.paperAccountVerified === true,
    paperAccountVerified: execution.paperAccountVerified === true || readiness?.paperAccountVerified === true,
    gatewayReachable: execution.gatewayReachable === true || readiness?.gatewayReachable === true || execution.executionConnected === true,
    ibApiVerified: execution.ibApiVerified === true || readiness?.ibApiVerified === true || execution.nextValidIdReady === true,
    generatedAt: truth.generatedAt,
    issues: truth.issues,
    summary: {
      dailyQuotaUsed: Number(execution.dailyQuota?.used || 0),
      dailyQuotaMax: Number(execution.dailyQuota?.max || 3),
      openTradeCount: Number(execution.openTradeCount || safeArray(execution.openTrades).length || 0),
      closedTradeCount: Number(execution.closedTradeCount || safeArray(execution.closedTrades).length || 0),
      selectedBlueprint: selectedBlueprint ? {
        symbol: selectedBlueprint.symbol || null,
        strategyId: selectedBlueprint.strategyId || null,
        strategyName: selectedBlueprint.strategyName || null,
      } : null,
    },
  };
}

module.exports = {
  SAFETY,
  TOP_LIMIT,
  buildTopStrategySelector,
  buildPaperTradingTruth,
  buildExecutionStatus,
};
