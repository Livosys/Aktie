'use strict';

/**
 * Supervisor Overview Service — READ-ONLY system brain aggregator.
 *
 * Collects the already-existing system-wide endpoints into one fault-isolated
 * response so the Supervisor can answer: how is the system, what did AI learn,
 * best/worst strategies, what is being tested, what to test next, risks, and a
 * focus action plan.
 *
 * Contract: docs/supervisor-overview-contract.md
 *
 * SAFETY: only reads. Never writes files, never places orders, never enables a
 * broker, never changes risk. Each block is wrapped so one failing source can
 * never blank the page or throw out of buildOverview().
 */

const fs = require('fs');
const path = require('path');

const tradeStats = require('./tradeStatsService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'supervisor_overview_v1',
});

// Lazy require so a load error in one source module cannot break the whole file.
function lazy(modPath) {
  try { return require(modPath); } catch (_) { return null; }
}

/**
 * Run one block producer in full isolation. Always resolves to a block object;
 * never throws. `producer` may be sync or async and may return null/undefined
 * (→ status 'empty').
 */
async function safeBlock(meta, producer) {
  const base = { status: 'error', scope: meta.scope, source: meta.source, summary: null };
  try {
    const raw = await producer();
    if (raw === null || raw === undefined) return { ...base, status: 'empty' };
    return { ...base, status: 'ok', summary: raw };
  } catch (err) {
    return { ...base, status: 'error', error: err && err.message ? err.message : String(err) };
  }
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function bool(value) {
  return value === true;
}

function text(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

function statusBlock(status, source, extra = {}) {
  return { status, source, ...extra };
}

function listStoredTimeframes() {
  try {
    const root = path.resolve(__dirname, '../../data/market-data');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root)
      .filter((name) => /^candles-/.test(name))
      .map((name) => name.replace(/^candles-/, ''))
      .sort();
  } catch (_) {
    return [];
  }
}

// ── per-block summarizers (condense, never dump full payloads) ────────────────
function summarizeSystemHealth(h) {
  if (!h) return null;
  const alerts = Array.isArray(h.alerts) ? h.alerts : [];
  return {
    overallStatus: h.overallStatus || h.status || 'UNKNOWN',
    summarySv: h.summarySv || h.summary_sv || null,
    componentCount: Array.isArray(h.components) ? h.components.length : null,
    alertCount: alerts.length,
    criticalAlerts: alerts.filter((a) => (a.severity || '').toLowerCase() === 'critical').length,
  };
}

function summarizeLearning(latest) {
  // Canonical paper-trade truth, always available from disk.
  let canonical = null;
  try { canonical = tradeStats.buildPaperTradeStats(); } catch (_) { canonical = null; }
  return {
    canonicalPaperStats: canonical && {
      totalTrades: canonical.totalTrades,
      winRate: canonical.winRate,
      decisiveWinRate: canonical.decisiveWinRate,
      timeoutRate: canonical.timeoutRate,
      avgPnl: canonical.avgPnl,
    },
    connectorSummary: latest ? {
      generatedAt: latest.generatedAt || latest.generated_at || null,
      strategiesTracked: Array.isArray(latest.strategies) ? latest.strategies.length
        : (latest.strategyCount || latest.strategies_tracked || null),
    } : null,
  };
}

function summarizeStrategies(top, worst) {
  const pick = (list) => (Array.isArray(list) ? list : (list && list.strategies) || [])
    .slice(0, 5)
    .map((s) => ({
      key: s.key || s.strategy_id || s.strategyId || s.id || s.name || 'unknown',
      winRate: num(s.win_rate ?? s.winRate ?? s.winRatePct),
      trades: num(s.trades ?? s.tradeCount ?? s.n ?? s.total),
    }));
  return { top: pick(top), worst: pick(worst) };
}

function summarizeNarrow(n) {
  if (!n) return null;
  const s = n.summary || n;
  return {
    status: s.status || null,
    totalTrades: num(s.totalTrades ?? s.totalNarrowTrades),
    dataConfidence: s.dataConfidence || null,
    bestStrategy: s.bestStrategy && (s.bestStrategy.strategy_id || s.bestStrategy.id || s.bestStrategy),
    worstStrategy: s.worstStrategy && (s.worstStrategy.strategy_id || s.worstStrategy.id || s.worstStrategy),
    bestScoreBand: s.bestScoreBand || null,
    recommendedNextTest: s.recommendedNextTest || null,
  };
}

function summarizeAutopilot(status, scheduler) {
  const a = (status && status.autopilot) || status || {};
  return {
    schedulerActive: scheduler ? Boolean(scheduler.schedulerActive) : null,
    dryRunOnly: scheduler ? Boolean(scheduler.dryRunOnly) : true,
    executionEnabled: scheduler ? Boolean(scheduler.executionEnabled) : false,
    nextRunAt: scheduler ? scheduler.nextRunAt || null : null,
    lastRecommendedTest: scheduler ? scheduler.lastRecommendedTest || null : null,
    lastPlanStrategy: a && a.lastPlan ? (a.lastPlan.strategy_id || null) : null,
    blockedReason: scheduler ? scheduler.blockedReason || null : null,
  };
}

function summarizeRegime(r) {
  if (!r) return null;
  return {
    regime: r.regime || r.currentRegime || (r.detected && r.detected.regime) || null,
    biasSv: r.biasSv || r.bias_sv || (r.bias && r.bias.labelSv) || null,
    volatilityState: r.volatilityState || (r.detected && r.detected.volatilityState) || null,
  };
}

function summarizePriority(p) {
  if (!p) return null;
  const len = (x) => (Array.isArray(x) ? x.length : null);
  const top = (p.topFocus || p.top_focus || [])[0] || null;
  return {
    topFocusCount: len(p.topFocus || p.top_focus),
    watchlistCount: len(p.watchlist),
    avoidCount: len(p.avoid),
    topPick: top && (top.symbol || top.key || null),
  };
}

function summarizeDaily(d) {
  if (!d) return null;
  return {
    enabled: d.enabled !== undefined ? Boolean(d.enabled) : null,
    lastRunAt: d.lastRunAt || d.last_run_at || (d.lastRun && d.lastRun.startedAt) || null,
    lastStatus: d.lastStatus || d.last_status || (d.lastRun && d.lastRun.status) || null,
  };
}

function summarizeOptimization(o) {
  if (!o) return null;
  const st = o.overallStats || o;
  return {
    tradeCount: num(o.tradeCount ?? st.n),
    overallScore: num(o.overallScore),
    winRatePct: num(st.winRatePct),
    timeoutRatePct: num(st.timeoutRatePct),
    avgPnl: num(st.avgPnl),
  };
}

function summarizeOpsAdvisor(o) {
  if (!o) return null;
  return {
    headlineSv: o.headlineSv || o.headline_sv || o.summarySv || null,
    recommendationCount: Array.isArray(o.recommendations) ? o.recommendations.length : null,
    window: o.window || null,
  };
}

function summarizeAutopilotControl(status, kind) {
  const label = kind === 'replay' ? 'Replay-autopilot' : 'Batch-autopilot';
  if (!status) {
    return { status: 'empty', message: `${label}-status kunde inte läsas.`, updatedAt: new Date().toISOString(), ...SAFETY };
  }
  const out = {
    status: status.status || (status.enabled ? 'idle' : 'disabled'),
    enabled: status.enabled === true,
    dryRunOnly: status.dryRunOnly !== false,
    intervalMinutes: num(status.intervalMinutes),
    maxPerDay: num(status.maxPerDay),
    lastRun: status.lastRun || null,
    nextRun: status.nextRun || null,
    todayRunCount: num(status.todayRunCount),
    lastBlockedReason: status.lastBlockedReason || null,
    latestTimestamp: status.lastRun || null,
    message: status.message || `${label} status.`,
    updatedAt: status.updatedAt || new Date().toISOString(),
    ...SAFETY,
  };
  if (kind === 'replay') {
    out.lastReplayPlan = status.lastReplayPlan || null;
    out.lastReplayResult = status.lastReplayResult || null;
  } else {
    out.lastPlan = status.lastPlan || null;
  }
  return out;
}

function summarizeAiAnalystStatus(status) {
  if (!status) return null;
  return {
    provider: status.provider || null,
    enabled: status.enabled === true,
    providerAvailable: status.providerAvailable === true,
    anthropicConfigured: status.anthropicConfigured === true,
    openaiConfigured: status.openaiConfigured === true,
    readiness: status.status || null,
    message: status.message || null,
    model: status.model || null,
    cacheEnabled: status.cacheEnabled === true,
    cacheTtlMs: num(status.cacheTtlMs),
    latestExists: status.latestExists === true,
    latestTimestamp: status.latestTimestamp || null,
    latestStatus: status.latestStatus || null,
    latestProvider: status.latestProvider || null,
    latestDurationMs: num(status.latestDurationMs),
    logPathExists: status.logPathExists === true,
    logEventCount: num(status.logEventCount),
    lastError: status.lastError || null,
    ...SAFETY,
  };
}

function summarizeDataStatus(dataCoverage, marketDataStore) {
  const source = 'dataCoverageExpansionService|marketDataStore';
  if (!dataCoverage || typeof dataCoverage.getCoverageStatus !== 'function') {
    return statusBlock('error', source, { message: 'Datatäckning kunde inte läsas.' });
  }
  try {
    const coverage = dataCoverage.getCoverageStatus();
    const timeframes = listStoredTimeframes();
    const symbols = marketDataStore && typeof marketDataStore.listSymbols === 'function'
      ? arr(marketDataStore.listSymbols())
      : [];
    const providerStatus = coverage.provider_status || (typeof dataCoverage.getProviderStatus === 'function' ? dataCoverage.getProviderStatus() : {});
    const providerIssues = Object.values(providerStatus).filter((row) => row && row.ok === false).length;
    const status = coverage.symbols_total > 0
      ? (coverage.symbols_missing_data > 0 || providerIssues > 0 ? 'degraded' : 'ok')
      : 'empty';
    return statusBlock(status, source, {
      symbolsTotal: num(coverage.symbols_total) || 0,
      storedSymbols: symbols.length,
      readyForReplay: num(coverage.symbols_ready_for_replay) || 0,
      readyForBatch: num(coverage.symbols_ready_for_batch) || 0,
      readyForAiLearning: num(coverage.symbols_ready_for_ai_learning) || 0,
      missingData: num(coverage.symbols_missing_data) || 0,
      goodData: num(coverage.symbols_good_data) || 0,
      weakData: num(coverage.symbols_weak_data) || 0,
      totalCoverageScore: num(coverage.total_coverage_score),
      activeBackfillJobs: num(coverage.active_backfill_jobs) || 0,
      availableTimeframes: timeframes,
      providerStatus,
      updatedAt: coverage.generated_at || null,
      message: status === 'empty'
        ? 'Ingen datatäckning hittades ännu.'
        : (status === 'degraded'
          ? 'Datatäckning finns men vissa symboler/provider saknas.'
          : 'Datatäckning och lagrade timeframes lästa.'),
      ...SAFETY,
    });
  } catch (err) {
    return statusBlock('error', source, { message: err && err.message ? err.message : String(err), ...SAFETY });
  }
}

function summarizeBatchStatus(batchStatusService) {
  const source = 'batchStatusService';
  if (!batchStatusService || typeof batchStatusService.buildBatchStatus !== 'function') {
    return statusBlock('error', source, { message: 'Batchstatus kunde inte läsas.', ...SAFETY });
  }
  try {
    const batch = batchStatusService.buildBatchStatus();
    return statusBlock(batch.status || 'error', source, {
      totalBatches: num(batch.totalBatches) || 0,
      latestBatch: batch.latestBatch || null,
      latestCompletedBatch: batch.latestCompletedBatch || null,
      latestResult: batch.latestResult || null,
      hasBatchResults: !!batch.latestResult,
      recentBatchEvents: arr(batch.recentBatchEvents).slice(0, 10),
      updatedAt: batch.updatedAt || null,
      message: batch.message || null,
      ...SAFETY,
    });
  } catch (err) {
    return statusBlock('error', source, { message: err && err.message ? err.message : String(err), ...SAFETY });
  }
}

function summarizeReplayStatusBlock(replayStatusService, replayIntelligenceService) {
  const source = 'replayStatusService|replayIntelligenceService';
  if (!replayStatusService || typeof replayStatusService.buildReplayStatus !== 'function') {
    return statusBlock('error', source, { message: 'Replaystatus kunde inte läsas.', ...SAFETY });
  }
  try {
    const replay = replayStatusService.buildReplayStatus();
    const sessions = replayIntelligenceService && typeof replayIntelligenceService.listReplaySessions === 'function'
      ? arr(replayIntelligenceService.listReplaySessions())
      : [];
    return statusBlock(replay.status || 'error', source, {
      totalReplayRuns: num(replay.totalReplayTests) || 0,
      latestReplay: replay.latestReplay || null,
      latestResult: replay.latestResult || null,
      recentReplays: arr(replay.recentReplays).slice(0, 10),
      hasReplayData: (num(replay.totalReplayTests) || 0) > 0,
      replayIntelligenceSessions: sessions.length,
      timeframes: arr(replay.timeframes),
      symbols: arr(replay.symbols).slice(0, 20),
      updatedAt: replay.updatedAt || null,
      message: replay.message || null,
      ...SAFETY,
    });
  } catch (err) {
    return statusBlock('error', source, { message: err && err.message ? err.message : String(err), ...SAFETY });
  }
}

function summarizePaperStatus(paperTradingStatusService) {
  const source = 'paperTradingStatusService|tradeStatsService';
  if (!paperTradingStatusService || typeof paperTradingStatusService.buildPaperTradingStatus !== 'function') {
    return statusBlock('error', source, { message: 'Paperstatus kunde inte läsas.', ...SAFETY });
  }
  try {
    const paper = paperTradingStatusService.buildPaperTradingStatus();
    const groups = typeof tradeStats.computeStatsByGroup === 'function'
      ? tradeStats.computeStatsByGroup(tradeStats.loadPaperTrades(), undefined, { deriveFromPnl: true })
      : [];
    const ranked = groups.filter((row) => num(row.totalTrades) > 0);
    const bestStrategy = ranked[0] ? {
      strategy: ranked[0].key,
      winRate: ranked[0].winRate,
      decisiveWinRate: ranked[0].decisiveWinRate,
      totalTrades: ranked[0].totalTrades,
      avgPnl: ranked[0].avgPnl,
    } : null;
    const worstStrategy = ranked.length ? {
      strategy: ranked[ranked.length - 1].key,
      winRate: ranked[ranked.length - 1].winRate,
      decisiveWinRate: ranked[ranked.length - 1].decisiveWinRate,
      totalTrades: ranked[ranked.length - 1].totalTrades,
      avgPnl: ranked[ranked.length - 1].avgPnl,
    } : null;
    return statusBlock(paper.status || 'error', source, {
      count: num(paper.count) || 0,
      summary: paper.summary || null,
      latestPaperTrade: paper.latestPaperTrade || null,
      bestStrategy,
      worstStrategy,
      updatedAt: paper.updatedAt || null,
      message: paper.message || null,
      ...SAFETY,
    });
  } catch (err) {
    return statusBlock('error', source, { message: err && err.message ? err.message : String(err), ...SAFETY });
  }
}

function summarizeLearningStatus(learningConnector, narrowPerf, daytradingLearning, aiAnalyst) {
  const source = 'narrowPerformanceLearningService|learningConnectorService|daytradingLearningEngineService|aiAnalystService';
  try {
    const connector = learningConnector && typeof learningConnector.loadLatestSummary === 'function'
      ? learningConnector.loadLatestSummary()
      : null;
    const narrow = narrowPerf && typeof narrowPerf.buildSupervisorNarrowLearning === 'function'
      ? narrowPerf.buildSupervisorNarrowLearning()
      : null;
    const day = daytradingLearning && typeof daytradingLearning.getLearningSummary === 'function'
      ? daytradingLearning.getLearningSummary({ hours: 168, limit: 200 })
      : null;
    const analyst = aiAnalyst && typeof aiAnalyst.getStatus === 'function'
      ? summarizeAiAnalystStatus(aiAnalyst.getStatus())
      : null;

    const daySummary = day && day.summary ? day.summary : {};
    const dayLooksLegacy = (num(daySummary.trades_total) || 0) === 0 && (num(daySummary.skipped_total) || 0) > 1000;
    const mostReliableSource = narrow && text(narrow.status) && text(narrow.dataConfidence) !== 'none'
      ? 'narrowPerformanceLearningService'
      : (connector ? 'learningConnectorService' : (day ? 'daytradingLearningEngineService' : null));
    let status = 'empty';
    if (narrow || connector || day || analyst) status = 'ok';
    if (dayLooksLegacy) status = 'degraded';
    if (!narrow && !connector && !day && !analyst) status = 'empty';

    return statusBlock(status, source, {
      narrowLearning: narrow || null,
      connectorSummary: connector ? summarizeLearning(connector) : null,
      aiAnalystStatus: analyst,
      mostReliableSource,
      legacySources: dayLooksLegacy ? [{
        source: 'daytradingLearningEngineService',
        status: 'degraded',
        reason: 'zero_trades_with_many_skipped_signals',
      }] : [],
      daytradingLearning: day ? {
        status: dayLooksLegacy ? 'degraded' : (day.ok === false ? 'error' : 'ok'),
        tradesTotal: num(daySummary.trades_total) || 0,
        skippedTotal: num(daySummary.skipped_total) || 0,
        wins: num(daySummary.wins) || 0,
        losses: num(daySummary.losses) || 0,
        timeout: num(daySummary.timeout) || 0,
        bestStrategy: daySummary.best_strategy || null,
        worstStrategy: daySummary.worst_strategy || null,
      } : null,
      message: dayLooksLegacy
        ? 'Narrow learning är mest tillförlitlig. Daytrading learning markeras som legacy/degraded.'
        : (mostReliableSource
          ? `Learning-status läst. Mest tillförlitlig källa: ${mostReliableSource}.`
          : 'Ingen samlad learning-källa hittades ännu.'),
      ...SAFETY,
    });
  } catch (err) {
    return statusBlock('error', source, { message: err && err.message ? err.message : String(err), ...SAFETY });
  }
}

function summarizeStrategyRanking(strategyRegistry, strategyRead, strategyScore) {
  const source = 'strategyRegistryService|strategyPerformanceReadService|strategyScoreService';
  if (!strategyRegistry || typeof strategyRegistry.getStatus !== 'function') {
    return statusBlock('error', source, {
      totalStrategies: 0,
      activeStrategies: 0,
      inactiveStrategies: 0,
      paperOnlyStrategies: 0,
      pausedStrategies: 0,
      tradingviewStrategies: 0,
      topStrategies: [],
      weakStrategies: [],
      strategiesNeedingMoreData: [],
      latestBlockedReason: null,
      message: 'Strategiranking kunde inte läsas.',
      ...SAFETY,
    });
  }
  try {
    const registry = strategyRegistry.getStatus();
    const perfTop = strategyRead && typeof strategyRead.getTopStrategies === 'function'
      ? arr(strategyRead.getTopStrategies(5).strategies)
      : [];
    const perfWorst = strategyRead && typeof strategyRead.getWorstStrategies === 'function'
      ? arr(strategyRead.getWorstStrategies(5).strategies)
      : [];
    const scoreRows = strategyScore && strategyScore.defaultStrategyScoreService && typeof strategyScore.defaultStrategyScoreService.getStrategyScores === 'function'
      ? strategyScore.defaultStrategyScoreService.getStrategyScores()
      : null;
    const strategies = arr(scoreRows && scoreRows.strategies);
    const strategiesNeedingMoreData = strategies.filter((row) => (num(row.sample_size) || 0) < 10).slice(0, 10);
    const topStrategies = strategies.length
      ? arr(scoreRows.top_strategies).slice(0, 5)
      : perfTop.slice(0, 5);
    const weakStrategies = strategies.length
      ? arr(scoreRows.weak_strategies).slice(0, 5)
      : perfWorst.slice(0, 5);
    const status = num(registry.total_strategies) > 0 ? 'ok' : 'empty';
    return statusBlock(status, source, {
      totalStrategies: num(registry.total_strategies) || 0,
      activeStrategies: num(registry.active_strategies) || 0,
      inactiveStrategies: Math.max(0, (num(registry.total_strategies) || 0) - (num(registry.active_strategies) || 0)),
      paperOnlyStrategies: num(registry.paper_only_strategies) || 0,
      pausedStrategies: num(registry.paused_strategies) || 0,
      tradingviewStrategies: num(registry.tradingview_strategies) || 0,
      topStrategies,
      weakStrategies,
      strategiesNeedingMoreData,
      latestBlockedReason: registry.latest_blocked_reason || null,
      message: status === 'empty' ? 'Inga strategier hittades ännu.' : 'Strategiregistry och ranking lästa.',
      ...SAFETY,
    });
  } catch (err) {
    return statusBlock('error', source, {
      totalStrategies: 0,
      activeStrategies: 0,
      inactiveStrategies: 0,
      paperOnlyStrategies: 0,
      pausedStrategies: 0,
      tradingviewStrategies: 0,
      topStrategies: [],
      weakStrategies: [],
      strategiesNeedingMoreData: [],
      latestBlockedReason: null,
      message: err && err.message ? err.message : String(err),
      ...SAFETY,
    });
  }
}

function normalizeExternalRecentTest(row, kind) {
  if (!row || typeof row !== 'object') return null;
  if (kind === 'batch') {
    return {
      id: row.id || null,
      timestamp: row.completedAt || row.startedAt || null,
      type: 'batch',
      source: 'batch_status',
      strategy: row.strategy || null,
      symbol: arr(row.symbols).join(', ') || null,
      timeframe: row.timeframe || null,
      scoreBand: null,
      tradesCount: num(row.combinationsTested),
      winRate: num(row.winRate),
      avgResult: num(row.avgResult),
      dryRun: true,
      executed: false,
      accepted: null,
      blockedReason: null,
      reason: row.status || null,
      recommendation: row.bestOutcome ? row.bestOutcome.strategy || null : null,
      status: row.status || null,
    };
  }
  if (kind === 'replay') {
    return {
      id: row.runId || null,
      timestamp: row.createdAt || null,
      type: 'replay',
      source: 'replay_status',
      strategy: null,
      symbol: arr(row.symbols).join(', ') || null,
      timeframe: row.timeframe || null,
      scoreBand: null,
      tradesCount: num(row.totalEvents),
      winRate: null,
      avgResult: num(row.avgTradeScore),
      dryRun: null,
      executed: true,
      accepted: null,
      blockedReason: null,
      reason: row.outcome || null,
      recommendation: row.bestSymbol ? row.bestSymbol.symbol || null : null,
      status: 'completed',
    };
  }
  if (kind === 'paper') {
    return {
      id: row.id || null,
      timestamp: row.timestamp || null,
      type: 'paper',
      source: 'paper_status',
      strategy: row.strategy || null,
      symbol: row.symbol || null,
      timeframe: row.timeframe || null,
      scoreBand: null,
      tradesCount: 1,
      winRate: null,
      avgResult: num(row.pnl),
      dryRun: false,
      executed: true,
      accepted: null,
      blockedReason: null,
      reason: row.lesson || row.result || null,
      recommendation: null,
      status: row.status || null,
    };
  }
  return null;
}

function buildUnifiedRecentTests(recentTests, batchStatus, replayStatusBlock, paperStatus) {
  const items = []
    .concat(arr(recentTests))
    .concat(batchStatus && batchStatus.latestBatch ? [normalizeExternalRecentTest(batchStatus.latestBatch, 'batch')] : [])
    .concat(replayStatusBlock && replayStatusBlock.latestReplay ? [normalizeExternalRecentTest(replayStatusBlock.latestReplay, 'replay')] : [])
    .concat(paperStatus && paperStatus.latestPaperTrade ? [normalizeExternalRecentTest(paperStatus.latestPaperTrade, 'paper')] : [])
    .filter(Boolean)
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    .slice(0, 25);
  return items;
}

function buildAiRecommendations(aiAnalystStatus) {
  return statusBlock('empty', 'aiAnalystService', {
    items: [],
    reason: aiAnalystStatus && aiAnalystStatus.latestExists === true
      ? 'latest_ai_output_exists_but_not_exposed_as_unified_recommendations_yet'
      : 'no_unified_ai_recommendation_source_yet',
    ...SAFETY,
  });
}

function buildLossFeedbackQueue() {
  return statusBlock('empty', 'supervisor_overview', {
    items: [],
    reason: 'loss_feedback_queue_not_implemented_yet',
    ...SAFETY,
  });
}

function buildNextRecommendedActions(learningStatus) {
  const actions = [];
  const narrowRec = learningStatus && learningStatus.narrowLearning && learningStatus.narrowLearning.recommendedNextTest;
  if (narrowRec) {
    actions.push({
      title: narrowRec.title || 'Run recommended narrow test',
      reason: narrowRec.reason || null,
      strategy_id: narrowRec.strategy_id || null,
      priority: narrowRec.priority || 'low',
      source: 'narrowPerformanceLearningService',
      ...SAFETY,
    });
  } else {
    actions.push(
      { title: 'Improve supervisor visibility', reason: 'Unify read-only system status in Supervisor.', source: 'supervisor_overview', priority: 'low', ...SAFETY },
      { title: 'Validate data coverage', reason: 'Confirm which symbols are ready for replay/batch.', source: 'dataCoverageExpansionService', priority: 'low', ...SAFETY },
      { title: 'Run dry-run batch planner later', reason: 'Keep batch planning manual-first and paper-only.', source: 'batchAutopilotService', priority: 'low', ...SAFETY },
      { title: 'Keep paper_only', reason: 'No live trading, broker, or order paths should be enabled.', source: 'safety', priority: 'high', ...SAFETY },
    );
  }
  return actions.slice(0, 5);
}

function normalizeBatchOutcome(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  return {
    strategy: row.strategy_id || row.strategyId || row.strategy_name || row.strategyName || null,
    symbol: row.symbol || row.traded_symbol || row.underlying_symbol || null,
    timeframe: row.timeframe || null,
    score: num(row.score ?? row.outcome),
    winRate: num(row.win_rate ?? row.winRate),
    avgResult: num(row.avg_pnl ?? row.avgPnl ?? row.avgResult ?? row.pnlPercent ?? row.paper_pnl_percent),
    trades: num(row.trades ?? row.tradeCount),
    result: row.result || null,
  };
}

function normalizeBatchResult(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  return {
    batchId: row.batch_id || row.batchId || null,
    strategy: row.strategy_id || row.strategyId || row.strategy_name || row.strategyName || null,
    symbol: row.symbol || row.traded_symbol || row.underlying_symbol || null,
    timeframe: row.timeframe || null,
    completedAt: row.run_completed_at || row.completed_at || row.test_completed_at || row.created_at || null,
    score: num(row.score),
    winRate: num(row.win_rate ?? row.winRate),
    avgResult: num(row.avg_pnl ?? row.avgPnl ?? row.avgResult ?? row.pnlPercent ?? row.paper_pnl_percent),
    trades: num(row.trades ?? row.tradeCount),
    mode: row.mode || 'paper_only',
    paperOnly: row.paper_only !== false,
    canPlaceOrders: row.can_place_orders === true,
    liveTradingEnabled: row.live_trading_enabled === true,
    brokerEnabled: false,
  };
}

function batchTime(batch) {
  return String(firstValue(batch?.updated_at, batch?.completed_at, batch?.batch_completed_at, batch?.started_at, batch?.created_at, ''));
}

function normalizeBatch(batch, extra = {}) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return null;
  const config = batch.config && typeof batch.config === 'object' ? batch.config : {};
  const progress = batch.progress && typeof batch.progress === 'object' ? batch.progress : {};
  const best = normalizeBatchOutcome(extra.bestOutcome);
  const worst = normalizeBatchOutcome(extra.worstOutcome);
  const latestResult = normalizeBatchResult(extra.latestResult);
  return {
    id: batch.id || null,
    status: batch.status || null,
    strategy: arr(config.strategy_ids || config.strategyIds || config.strategies).join(', ') || batch.strategy_id || batch.strategy || null,
    timeframe: arr(config.timeframes || config.timeframe).join(', ') || batch.timeframe || null,
    symbols: arr(config.symbols || batch.symbols),
    startedAt: firstValue(batch.started_at, batch.batch_started_at, batch.last_run_at),
    completedAt: firstValue(batch.completed_at, batch.batch_completed_at),
    combinationsTested: num(progress.completed ?? batch.combinations_tested ?? extra.resultsCount),
    bestOutcome: best,
    worstOutcome: worst,
    winRate: num(latestResult?.winRate ?? best?.winRate),
    avgResult: num(latestResult?.avgResult ?? best?.avgResult),
    mode: batch.mode || 'paper_only',
    paperOnly: batch.paper_only !== false,
    canPlaceOrders: batch.can_place_orders === true,
    liveTradingEnabled: batch.live_trading_enabled === true,
    brokerEnabled: false,
  };
}

function buildBatchSummary(batchService = lazy('./strategyBatchTestService')) {
  const source = 'strategyBatchTestService';
  const safety = {
    mode: 'paper_only',
    paperOnly: true,
    canPlaceOrders: false,
    liveTradingEnabled: false,
    brokerEnabled: false,
  };

  if (!batchService || typeof batchService.listBatchTests !== 'function') {
    return {
      status: 'error',
      totalBatches: 0,
      completedBatches: 0,
      runningBatches: 0,
      pausedBatches: 0,
      failedBatches: 0,
      latestBatch: null,
      latestCompletedBatch: null,
      latestResult: null,
      activeBatch: null,
      source,
      message: 'Batchservice kunde inte laddas.',
      ...safety,
    };
  }

  try {
    const listed = batchService.listBatchTests();
    const batches = arr(listed && listed.batches);
    const base = {
      totalBatches: batches.length,
      completedBatches: batches.filter((b) => String(b?.status || '').toLowerCase() === 'completed').length,
      runningBatches: batches.filter((b) => String(b?.status || '').toLowerCase() === 'running').length,
      pausedBatches: batches.filter((b) => String(b?.status || '').toLowerCase() === 'paused').length,
      failedBatches: batches.filter((b) => ['failed', 'error'].includes(String(b?.status || '').toLowerCase())).length,
      latestBatch: null,
      latestCompletedBatch: null,
      latestResult: null,
      activeBatch: null,
      source,
      message: '',
      ...safety,
    };

    if (!batches.length) {
      return { status: 'empty', ...base, message: 'Det finns inga batchtester att visa ännu.' };
    }

    const sorted = [...batches].sort((a, b) => batchTime(b).localeCompare(batchTime(a)));
    const latest = sorted[0] || null;
    const latestCompleted = sorted.find((b) => String(b?.status || '').toLowerCase() === 'completed') || null;
    const active = sorted.find((b) => ['running', 'paused'].includes(String(b?.status || '').toLowerCase())) || null;

    let status = 'ok';
    let message = `${batches.length} batchtester lästa.`;
    let latestResults = null;
    let latestCompare = null;

    if (latest && typeof batchService.getBatchTestResults === 'function') {
      try {
        latestResults = batchService.getBatchTestResults(latest.id);
        if (latestResults && latestResults.ok === false) status = 'degraded';
      } catch (_) {
        status = 'degraded';
        message = 'Batchhistorik finns men senaste resultat kunde inte läsas.';
      }
    }

    if (typeof batchService.getLatestBatchComparison === 'function') {
      try {
        latestCompare = batchService.getLatestBatchComparison();
        if (latestCompare && latestCompare.ok === false) status = 'degraded';
      } catch (_) {
        status = 'degraded';
        message = 'Batchhistorik finns men jämförelsedata kunde inte läsas.';
      }
    }

    const top = arr(latestResults?.top);
    const worst = arr(latestResults?.worst);
    const latestResult = top[0] || latestCompare?.recommended_config || arr(latestCompare?.best_overall)[0] || null;
    const bestOutcome = top[0] || arr(latestCompare?.best_overall)[0] || latestCompare?.recommended_config || null;
    const worstOutcome = worst[0] || arr(latestCompare?.worst_overall)[0] || null;
    const resultsCount = num(latestResults?.count ?? latestCompare?.total_results);

    if (status === 'degraded' && message === `${batches.length} batchtester lästa.`) {
      message = 'Batchhistorik lästes delvis.';
    }

    return {
      status,
      ...base,
      latestBatch: normalizeBatch(latest, { bestOutcome, worstOutcome, latestResult, resultsCount }),
      latestCompletedBatch: normalizeBatch(latestCompleted, { bestOutcome, worstOutcome, latestResult, resultsCount }),
      latestResult: normalizeBatchResult(latestResult),
      activeBatch: normalizeBatch(active),
      message,
    };
  } catch (err) {
    return {
      status: 'error',
      totalBatches: 0,
      completedBatches: 0,
      runningBatches: 0,
      pausedBatches: 0,
      failedBatches: 0,
      latestBatch: null,
      latestCompletedBatch: null,
      latestResult: null,
      activeBatch: null,
      source,
      message: err && err.message ? err.message : String(err),
      ...safety,
    };
  }
}

// ── risk + action-plan derivation (read-only, derived from the blocks) ────────
function deriveRisks(blocks, canonical) {
  const risks = [];

  const sh = blocks.system_health;
  if (sh && sh.status === 'ok' && sh.summary) {
    const os = (sh.summary.overallStatus || '').toUpperCase();
    if (os === 'CRITICAL') risks.push({ level: 'critical', code: 'system_health_critical', message_sv: sh.summary.summarySv || 'Systemhälsa kritisk.' });
    else if (os === 'WARNING' || os === 'DEGRADED') risks.push({ level: 'warning', code: 'system_health_degraded', message_sv: sh.summary.summarySv || 'Systemhälsa försämrad.' });
    if (sh.summary.criticalAlerts > 0) risks.push({ level: 'critical', code: 'critical_alerts', message_sv: `${sh.summary.criticalAlerts} kritiska larm aktiva.` });
  }

  if (canonical) {
    if (canonical.avgPnl !== null && canonical.avgPnl < 0) {
      risks.push({ level: 'warning', code: 'negative_avg_pnl', message_sv: `Genomsnittlig P/L är negativ (${canonical.avgPnl}). Detta är testdata, ingen bevisad edge.` });
    }
    if (canonical.timeoutRate !== null && canonical.timeoutRate >= 15) {
      risks.push({ level: 'warning', code: 'high_timeout_rate', message_sv: `Hög timeout-andel (${canonical.timeoutRate}%): många trades avgörs av maxtid, inte target/stop.` });
    }
  }

  const ap = blocks.autopilot;
  if (ap && ap.status === 'ok' && ap.summary && ap.summary.blockedReason) {
    risks.push({ level: 'info', code: 'autopilot_blocked', message_sv: `Autopilot pausad/blockerad: ${ap.summary.blockedReason}.` });
  }

  for (const [name, b] of Object.entries(blocks)) {
    if (b && b.status === 'error') {
      risks.push({ level: 'warning', code: `block_error:${name}`, message_sv: `Block "${name}" kunde inte läsas: ${b.error || 'okänt fel'}.` });
    }
  }

  // Always-on reassurance that live trading stays off.
  risks.push({ level: 'info', code: 'paper_only', message_sv: 'Live trading är avstängt. Endast analys, paper, replay och batch.' });
  return risks;
}

function deriveActionPlan(blocks) {
  const plan = [];

  const narrow = blocks.narrow;
  const rec = narrow && narrow.status === 'ok' && narrow.summary && narrow.summary.recommendedNextTest;
  if (rec) {
    plan.push({
      priority: rec.priority || 'low',
      title_sv: 'Kör nästa rekommenderade narrow-test',
      detail_sv: rec.reason || `Testa ${rec.strategy_id || 'rekommenderad strategi'} (${rec.selectedNarrowScoreBand || 'band okänt'}).`,
      source: '/api/supervisor/narrow-state',
    });
  }

  const strat = blocks.strategies;
  if (strat && strat.status === 'ok' && strat.summary && Array.isArray(strat.summary.worst) && strat.summary.worst.length) {
    const w = strat.summary.worst[0];
    plan.push({
      priority: 'medium',
      title_sv: 'Granska svagaste strategin',
      detail_sv: `"${w.key}" presterar svagast (winRate ${w.winRate}%, ${w.trades} trades). Överväg att pausa eller justera i Trading Lab — ingen auto-apply.`,
      source: '/api/daytrading-strategies/worst',
    });
  }

  if (!plan.length) {
    plan.push({ priority: 'low', title_sv: 'Samla mer testdata', detail_sv: 'För få avgjorda trades för en stark rekommendation. Kör fler paper/batch-tester.', source: 'supervisor_overview' });
  }
  return plan;
}

// ── recent tests (read-only autopilot history) ───────────────────────────────
const RECENT_TESTS_SOURCE = 'data/autopilot/narrow-autopilot-history.jsonl';

// Normalize one raw history event into a stable, render-safe shape. Returns null
// for anything that is not a usable object (so callers can count drops).
function normalizeRecentTest(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
  const symbols = Array.isArray(ev.symbols) ? ev.symbols : null;
  const tfs = Array.isArray(ev.timeframes) ? ev.timeframes : null;
  const summary = ev.summary && typeof ev.summary === 'object' && !Array.isArray(ev.summary) ? ev.summary : null;
  const type = typeof ev.event === 'string' ? ev.event : null;
  const warnings = Array.isArray(ev.warnings) ? ev.warnings.filter((w) => typeof w === 'string') : [];
  const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    id: ev.planId || ev.id || null,
    timestamp: ev.timestamp || null,
    type,
    source: 'narrow_autopilot',
    strategy: ev.strategy_id || ev.strategyId || null,
    symbol: symbols && symbols.length ? symbols.join(', ') : null,
    timeframe: tfs && tfs.length ? tfs.join(', ') : null,
    scoreBand: ev.selectedNarrowScoreBand || ev.scoreBand || (ev.filters && ev.filters.narrowScoreBand) || null,
    tradesCount: summary ? finite(summary.totalTrades ?? summary.tradesCount) : null,
    winRate: summary ? finite(summary.winRate) : null,
    avgResult: summary ? finite(summary.avgPnl ?? summary.avgResult) : null,
    dryRun: typeof ev.dryRun === 'boolean' ? ev.dryRun : null,
    executed: type === 'run_completed' ? true : (type === 'run_blocked' ? false : null),
    accepted: typeof ev.accepted === 'boolean' ? ev.accepted : null,
    blockedReason: ev.blockedReason || (type === 'run_blocked' ? (warnings[0] || 'blocked') : null),
    reason: ev.reason || (warnings.length ? warnings.join('; ') : null),
    recommendation: summary && summary.bestStrategy ? summary.bestStrategy : null,
    status: ev.status || null,
  };
}

// Build the recentTests list + status metadata from autopilot history.
// Fully read-only and fault-isolated: never throws, always returns a shape.
function buildRecentTests(limit = 25) {
  try {
    const autopilot = require('./narrowTestAutopilotService');
    const raw = autopilot.readNarrowAutopilotHistory(limit);
    if (!Array.isArray(raw)) {
      return { recentTests: [], recentTestsStatus: { status: 'error', count: 0, source: RECENT_TESTS_SOURCE, message: 'Oväntad historikform.' } };
    }
    if (raw.length === 0) {
      return { recentTests: [], recentTestsStatus: { status: 'empty', count: 0, source: RECENT_TESTS_SOURCE, message: 'Ingen testhistorik än.' } };
    }
    const normalized = [];
    let dropped = 0;
    for (const ev of raw) {
      const n = normalizeRecentTest(ev);
      if (n) normalized.push(n); else dropped++;
    }
    normalized.reverse(); // newest first
    let status = 'ok';
    let message = `${normalized.length} senaste testhändelser.`;
    if (normalized.length === 0) {
      status = 'degraded';
      message = 'Historik fanns men kunde inte tolkas.';
    } else if (dropped > 0) {
      status = 'degraded';
      message = `${normalized.length} händelser visas, ${dropped} ogiltiga hoppades över.`;
    }
    return { recentTests: normalized, recentTestsStatus: { status, count: normalized.length, source: RECENT_TESTS_SOURCE, message } };
  } catch (err) {
    return { recentTests: [], recentTestsStatus: { status: 'error', count: 0, source: RECENT_TESTS_SOURCE, message: err && err.message ? err.message : String(err) } };
  }
}

// ── main aggregator ───────────────────────────────────────────────────────────
async function buildOverview() {
  const systemHealth = lazy('../systemHealth');
  const learningConnector = lazy('./learningConnectorService');
  const strategyRead = lazy('./strategyPerformanceReadService');
  const strategyRegistry = lazy('./strategyRegistryService');
  const strategyScore = lazy('./strategyScoreService');
  const narrowPerf = lazy('./narrowPerformanceLearningService');
  const daytradingLearning = lazy('./daytradingLearningEngineService');
  const autopilot = lazy('./narrowTestAutopilotService');
  const scheduler = lazy('../jobs/narrowAutopilotScheduler');
  const marketRegime = lazy('./marketRegimeService');
  const priority = lazy('./priorityEngineService');
  const daily = lazy('./dailyIntelligencePipelineService');
  const optimization = lazy('./aiOptimizationAgentService');
  const opsAdvisor = lazy('./supervisorOperationsAdvisorService');
  const strategyBatch = lazy('./strategyBatchTestService');
  const aiAnalyst = lazy('./aiAnalystService');
  const dataJobsStatus = lazy('./dataJobsStatusService');
  const dataCoverage = lazy('./dataCoverageExpansionService');
  const marketDataStore = lazy('../data/marketDataStore');
  const liveActivity = lazy('./liveActivityService');
  const batchAutopilot = lazy('./batchAutopilotService');
  const batchStatusService = lazy('./batchStatusService');
  const replayAutopilot = lazy('./replayAutopilotService');
  const replayIntelligence = lazy('./replayIntelligenceService');
  const replayStatus = lazy('./replayStatusService');
  const paperTradingStatus = lazy('./paperTradingStatusService');

  const [
    system_health, learning, strategies, narrow, autopilotBlock,
    market_regime, priorityBlock, daily_pipeline, ai_optimization, operations_advisor,
  ] = await Promise.all([
    safeBlock({ scope: 'system_wide', source: '/api/system/health' },
      () => summarizeSystemHealth(systemHealth.buildSystemHealth())),
    safeBlock({ scope: 'system_wide', source: '/api/learning/latest-summary' },
      () => summarizeLearning(learningConnector.loadLatestSummary())),
    safeBlock({ scope: 'system_wide', source: '/api/daytrading-strategies/top|worst' },
      () => summarizeStrategies(strategyRead.getTopStrategies(5), strategyRead.getWorstStrategies(5))),
    safeBlock({ scope: 'narrow_only', source: '/api/supervisor/narrow-state' },
      () => summarizeNarrow(narrowPerf.buildSupervisorNarrowLearning())),
    safeBlock({ scope: 'narrow_only', source: '/api/autopilot/narrow/status' },
      () => summarizeAutopilot(null, scheduler.getNarrowAutopilotSchedulerStatus())),
    safeBlock({ scope: 'system_wide', source: '/api/market-regime/status' },
      () => summarizeRegime(marketRegime.buildRegimeSummary(false))),
    safeBlock({ scope: 'system_wide', source: '/api/priority/summary' },
      async () => summarizePriority(await priority.buildPrioritySummary())),
    safeBlock({ scope: 'system_wide', source: '/api/pipeline/daily/status' },
      () => summarizeDaily(daily.status())),
    safeBlock({ scope: 'system_wide', source: '/api/optimization/summary' },
      () => summarizeOptimization(optimization.getCachedSummary())),
    safeBlock({ scope: 'system_wide', source: '/api/supervisor/operations-advisor' },
      () => summarizeOpsAdvisor(opsAdvisor.getOperationsAdvisor())),
  ]);

  const blocks = {
    system_health, learning, strategies, narrow, autopilot: autopilotBlock,
    market_regime, priority: priorityBlock, daily_pipeline, ai_optimization, operations_advisor,
  };

  // Canonical headline from the single source of truth.
  let canonicalStats = null;
  try {
    const c = tradeStats.buildPaperTradeStats();
    canonicalStats = {
      totalTrades: c.totalTrades, winRate: c.winRate, decisiveWinRate: c.decisiveWinRate,
      timeoutRate: c.timeoutRate, avgPnl: c.avgPnl,
    };
  } catch (_) { canonicalStats = null; }

  // Recent autopilot test history (read-only, fault-isolated).
  let recentTests = [];
  let recentTestsStatus = { status: 'error', count: 0, source: RECENT_TESTS_SOURCE, message: 'unavailable' };
  try {
    const rt = buildRecentTests(25);
    recentTests = rt.recentTests;
    recentTestsStatus = rt.recentTestsStatus;
  } catch (err) {
    recentTests = [];
    recentTestsStatus = { status: 'error', count: 0, source: RECENT_TESTS_SOURCE, message: err && err.message ? err.message : 'unavailable' };
  }

  // Batch summary is first-class read-only status. It is intentionally outside
  // the generic blocks because the UI consumes it directly as stable data.
  let batchSummary = null;
  try {
    batchSummary = buildBatchSummary(strategyBatch);
  } catch (err) {
    batchSummary = {
      status: 'error',
      totalBatches: 0,
      completedBatches: 0,
      runningBatches: 0,
      pausedBatches: 0,
      failedBatches: 0,
      latestBatch: null,
      latestCompletedBatch: null,
      latestResult: null,
      activeBatch: null,
      source: 'strategyBatchTestService',
      message: err && err.message ? err.message : 'unavailable',
      mode: 'paper_only',
      paperOnly: true,
      canPlaceOrders: false,
      liveTradingEnabled: false,
      brokerEnabled: false,
    };
  }

  let aiAnalystStatus = null;
  try {
    aiAnalystStatus = summarizeAiAnalystStatus(aiAnalyst && typeof aiAnalyst.getStatus === 'function' ? aiAnalyst.getStatus() : null);
  } catch (err) {
    aiAnalystStatus = { status: 'error', provider: null, enabled: false, lastError: err && err.message ? err.message : 'unavailable', ...SAFETY };
  }

  let dataJobsSummary = null;
  try {
    dataJobsSummary = dataJobsStatus && typeof dataJobsStatus.buildSupervisorDataJobsSummary === 'function'
      ? dataJobsStatus.buildSupervisorDataJobsSummary()
      : null;
  } catch (err) {
    dataJobsSummary = { status: 'error', message: err && err.message ? err.message : 'unavailable', ...SAFETY };
  }

  let liveActivitySummary = null;
  try {
    liveActivitySummary = liveActivity && typeof liveActivity.buildSupervisorLiveActivitySummary === 'function'
      ? liveActivity.buildSupervisorLiveActivitySummary()
      : null;
  } catch (err) {
    liveActivitySummary = { status: 'error', count: 0, latestEvents: [], message: err && err.message ? err.message : 'unavailable', ...SAFETY };
  }

  let batchAutopilotSummary = null;
  try {
    batchAutopilotSummary = summarizeAutopilotControl(
      batchAutopilot && typeof batchAutopilot.getStatus === 'function' ? batchAutopilot.getStatus() : null,
      'batch',
    );
  } catch (err) {
    batchAutopilotSummary = { status: 'error', message: err && err.message ? err.message : 'unavailable', ...SAFETY };
  }

  let replayAutopilotSummary = null;
  try {
    replayAutopilotSummary = summarizeAutopilotControl(
      replayAutopilot && typeof replayAutopilot.getStatus === 'function' ? replayAutopilot.getStatus() : null,
      'replay',
    );
  } catch (err) {
    replayAutopilotSummary = { status: 'error', message: err && err.message ? err.message : 'unavailable', ...SAFETY };
  }

  let replaySummary = null;
  try {
    replaySummary = replayStatus && typeof replayStatus.buildSupervisorReplaySummary === 'function'
      ? replayStatus.buildSupervisorReplaySummary()
      : null;
  } catch (err) {
    replaySummary = { status: 'error', totalReplayTests: 0, latestReplay: null, message: err && err.message ? err.message : 'unavailable', ...SAFETY };
  }

  let paperTradingSummary = null;
  try {
    paperTradingSummary = paperTradingStatus && typeof paperTradingStatus.buildSupervisorPaperSummary === 'function'
      ? paperTradingStatus.buildSupervisorPaperSummary()
      : null;
  } catch (err) {
    paperTradingSummary = { status: 'error', count: 0, latestPaperTrade: null, message: err && err.message ? err.message : 'unavailable', ...SAFETY };
  }

  const dataStatus = summarizeDataStatus(dataCoverage, marketDataStore);
  const batchStatus = summarizeBatchStatus(batchStatusService);
  const replayStatusBlock = summarizeReplayStatusBlock(replayStatus, replayIntelligence);
  const paperStatus = summarizePaperStatus(paperTradingStatus);
  const learningStatus = summarizeLearningStatus(learningConnector, narrowPerf, daytradingLearning, aiAnalyst);
  const strategyRanking = summarizeStrategyRanking(strategyRegistry, strategyRead, strategyScore);
  const combinedRecentTests = buildUnifiedRecentTests(recentTests, batchStatus, replayStatusBlock, paperStatus);
  const unifiedRecentTestsStatus = statusBlock(
    combinedRecentTests.length ? (recentTestsStatus.status === 'error' ? 'degraded' : 'ok') : recentTestsStatus.status,
    'narrowTestAutopilotService|batchStatusService|replayStatusService|paperTradingStatusService',
    {
      count: combinedRecentTests.length,
      message: combinedRecentTests.length ? 'Senaste tester från autopilot, batch, replay och paper.' : recentTestsStatus.message,
      ...SAFETY,
    },
  );
  const aiRecommendations = buildAiRecommendations(aiAnalystStatus);
  const lossFeedbackQueue = buildLossFeedbackQueue();
  const nextRecommendedActions = buildNextRecommendedActions(learningStatus);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    ...SAFETY,
    safety: {
      mode: SAFETY.mode,
      actions_allowed: SAFETY.actions_allowed,
      can_place_orders: SAFETY.can_place_orders,
      live_trading_enabled: SAFETY.live_trading_enabled,
      broker_enabled: SAFETY.broker_enabled,
    },
    canonicalStats,
    blocks,
    dataStatus,
    batchStatus,
    replayStatus: replayStatusBlock,
    paperStatus,
    learningStatus,
    strategyRanking,
    recentTests: combinedRecentTests,
    recentTestsStatus: unifiedRecentTestsStatus,
    aiRecommendations,
    lossFeedbackQueue,
    nextRecommendedActions,
    batchSummary,
    batchAutopilotSummary,
    replayAutopilotSummary,
    replaySummary,
    paperTradingSummary,
    aiAnalystStatus,
    dataJobsSummary,
    liveActivitySummary,
    risks: deriveRisks(blocks, canonicalStats),
    actionPlan: deriveActionPlan(blocks),
  };
}

// ── short read-only cache ─────────────────────────────────────────────────────
// The overview fans out to several synchronous, file-scanning sources (cold
// builds take several seconds). A brief TTL keeps repeated dashboard polls fast
// without ever hiding stale errors for long: error/degraded block states clear
// on the next rebuild after TTL. Safety flags are never affected.
const OVERVIEW_TTL_MS = 45 * 1000;
let overviewCache = { at: 0, value: null };

async function getCachedOverview({ force = false } = {}) {
  const now = Date.now();
  if (!force && overviewCache.value && (now - overviewCache.at) < OVERVIEW_TTL_MS) {
    return { ...overviewCache.value, cached: true, cacheAgeMs: now - overviewCache.at };
  }
  const fresh = await buildOverview();
  overviewCache = { at: now, value: fresh };
  return { ...fresh, cached: false, cacheAgeMs: 0 };
}

function resetOverviewCache() {
  overviewCache = { at: 0, value: null };
}

module.exports = {
  SAFETY,
  OVERVIEW_TTL_MS,
  buildOverview,
  getCachedOverview,
  resetOverviewCache,
  // exported for tests
  safeBlock,
  deriveRisks,
  deriveActionPlan,
  summarizeStrategies,
  buildRecentTests,
  normalizeRecentTest,
  buildBatchSummary,
  normalizeBatch,
  normalizeBatchResult,
  summarizeAiAnalystStatus,
  summarizeAutopilotControl,
};
