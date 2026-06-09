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

const ROOT = path.resolve(__dirname, '../..');
const DATA_ROOT = path.join(ROOT, 'data');
const DATA_FILES = Object.freeze({
  batchResultsDir: path.join(DATA_ROOT, 'strategy-batches/results'),
  batchGridSummary: path.join(DATA_ROOT, 'strategy-batches/top-strategy-grid-v1-summary.json'),
  replayRunsDir: path.join(DATA_ROOT, 'replay/runs'),
  paperTradesFile: path.join(DATA_ROOT, 'paper-trading/trades.jsonl'),
  learningConnectorSummary: path.join(DATA_ROOT, 'learning-connector/summary.json'),
  signalLearningSummary: path.join(DATA_ROOT, 'signals/learning-summary.json'),
  paperAllowlistFile: path.join(DATA_ROOT, 'automation-approvals.json'),
});

const BATCH_HISTORY_FALLBACK_TTL_MS = 60 * 1000;
let batchHistoryFallbackCache = { at: 0, value: null };
const READONLY_SOURCE_CACHE_TTL_MS = 60 * 1000;
let readonlySourceCache = new Map();

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

function readJsonFile(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function listJsonFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => /\.json$/i.test(name))
      .map((name) => path.join(dir, name))
      .sort();
  } catch (_) {
    return [];
  }
}

function uniqueStrings(values, limit = 10) {
  return [...new Set(arr(values).map((v) => text(v)).filter(Boolean))].slice(0, limit);
}

function mean(values) {
  const nums = arr(values).map((v) => Number(v)).filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function newestFirstByIso(a, b, fields) {
  const ta = String(fields.map((field) => a?.[field]).find(Boolean) || '');
  const tb = String(fields.map((field) => b?.[field]).find(Boolean) || '');
  return tb.localeCompare(ta);
}

function safeObjectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function signatureOf(...fns) {
  return fns.map((fn) => {
    if (!fn) return 'null';
    if (typeof fn === 'function') return fn.toString();
    return String(fn);
  }).join('|');
}

function getCachedReadOnly(key, fnRef, producer, ttlMs = READONLY_SOURCE_CACHE_TTL_MS) {
  try {
    const now = Date.now();
    const cached = readonlySourceCache.get(key);
    if (cached && cached.fnRef === fnRef && (now - cached.at) < ttlMs) {
      return cached.value;
    }
    const value = producer();
    readonlySourceCache.set(key, { at: now, fnRef, value });
    return value;
  } catch (_) {
    return undefined;
  }
}

async function getCachedReadOnlyAsync(key, fnRef, producer, ttlMs = READONLY_SOURCE_CACHE_TTL_MS) {
  try {
    const now = Date.now();
    const cached = readonlySourceCache.get(key);
    if (cached && cached.fnRef === fnRef && (now - cached.at) < ttlMs) {
      return cached.value;
    }
    const value = await producer();
    readonlySourceCache.set(key, { at: now, fnRef, value });
    return value;
  } catch (_) {
    return undefined;
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

function summarizeLearning(latest, canonicalOverride = null) {
  // Canonical paper-trade truth, always available from disk.
  let canonical = canonicalOverride;
  if (!canonical) {
    try { canonical = tradeStats.buildPaperTradeStats(); } catch (_) { canonical = null; }
  }
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

function summarizeDataStatus(dataCoverage, marketDataStore, preloaded = {}) {
  const source = 'dataCoverageExpansionService|marketDataStore';
  if (!dataCoverage || typeof dataCoverage.getCoverageStatus !== 'function') {
    return statusBlock('error', source, { message: 'Datatäckning kunde inte läsas.' });
  }
  try {
    const coverage = preloaded.coverage !== undefined
      ? preloaded.coverage
      : dataCoverage.getCoverageStatus();
    const timeframes = listStoredTimeframes();
    const symbols = marketDataStore && typeof marketDataStore.listSymbols === 'function'
      ? arr(marketDataStore.listSymbols())
      : [];
    const providerStatus = coverage.provider_status || (typeof dataCoverage.getProviderStatus === 'function' ? dataCoverage.getProviderStatus() : {});
    const providerIssues = Object.values(providerStatus).filter((row) => row && row.ok === false).length;
    const allCoverageRaw = preloaded.allCoverage !== undefined
      ? preloaded.allCoverage
      : (dataCoverage && typeof dataCoverage.getAllSymbolCoverage === 'function'
        ? dataCoverage.getAllSymbolCoverage()
        : null);
    const allCoverage = arr(allCoverageRaw && allCoverageRaw.symbols);
    const missingSymbolRows = allCoverage.filter((row) => ['weak', 'medium', 'missing', 'missing_provider'].includes(row.data_quality));
    const readyReplayRows = allCoverage.filter((row) => row.usable_for_replay);
    const readyBatchRows = allCoverage.filter((row) => row.usable_for_batch);
    const missingByProvider = missingSymbolRows.filter((row) => row.data_quality === 'missing_provider');
    const missingByCoverage = missingSymbolRows.filter((row) => row.data_quality !== 'missing_provider');
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
      readySymbols: readyReplayRows.slice(0, 12).map((row) => ({ symbol: row.symbol, coverageScore: row.coverage_score, daysCovered: row.days_covered, marketGroup: row.market_group })),
      missingSymbols: missingSymbolRows.slice(0, 15).map((row) => ({
        symbol: row.symbol,
        marketGroup: row.market_group,
        quality: row.data_quality,
        coverageScore: row.coverage_score,
        daysCovered: row.days_covered,
        reason: row.reason,
        provider: row.provider,
        timeframes: row.timeframes || {},
      })),
      missingProviderSymbols: missingByProvider.slice(0, 10).map((row) => ({ symbol: row.symbol, provider: row.provider, reason: row.reason })),
      missingCoverageSymbols: missingByCoverage.slice(0, 10).map((row) => ({ symbol: row.symbol, reason: row.reason })),
      readyForReplaySymbols: readyReplayRows.slice(0, 12).map((row) => row.symbol),
      readyForBatchSymbols: readyBatchRows.slice(0, 12).map((row) => row.symbol),
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
    const fileFallback = buildBatchHistoryFallback();
    const batchHistoryAvailable = Boolean((num(batch.totalBatches) || 0) > 0 || fileFallback.batchCount > 0);
    const mergedRecent = arr(batch.recentBatchEvents).length
      ? arr(batch.recentBatchEvents).slice(0, 10)
      : arr(fileFallback.recentBatchResults).slice(0, 10);
    return statusBlock(batch.status || 'error', source, {
      totalBatches: num(batch.totalBatches) || 0,
      latestBatch: batch.latestBatch || null,
      latestCompletedBatch: batch.latestCompletedBatch || null,
      latestResult: batch.latestResult || null,
      hasBatchResults: !!batch.latestResult,
      bestOutcome: batch.bestOutcome || fileFallback.bestOutcome || null,
      worstOutcome: batch.worstOutcome || fileFallback.worstOutcome || null,
      bestBatch: batch.bestBatch || fileFallback.bestBatch || null,
      worstBatch: batch.worstBatch || fileFallback.worstBatch || null,
      batchHistoryAvailable,
      batchHistorySource: batch.batchHistorySource || fileFallback.source || source,
      recentBatchResults: arr(batch.recentBatchResults).length ? arr(batch.recentBatchResults).slice(0, 8) : arr(fileFallback.recentBatchResults).slice(0, 8),
      recentBatchEvents: mergedRecent,
      updatedAt: batch.updatedAt || null,
      message: batch.message || fileFallback.message || null,
      ...SAFETY,
    });
  } catch (err) {
    const fileFallback = buildBatchHistoryFallback();
    return statusBlock(fileFallback.batchCount ? 'degraded' : 'error', source, {
      totalBatches: fileFallback.batchCount || 0,
      latestBatch: fileFallback.latestBatch || null,
      latestCompletedBatch: fileFallback.latestBatch || null,
      latestResult: fileFallback.latestResult || null,
      hasBatchResults: Boolean(fileFallback.latestResult),
      bestOutcome: fileFallback.bestOutcome || null,
      worstOutcome: fileFallback.worstOutcome || null,
      bestBatch: fileFallback.bestBatch || null,
      worstBatch: fileFallback.worstBatch || null,
      batchHistoryAvailable: fileFallback.batchCount > 0,
      batchHistorySource: fileFallback.source,
      recentBatchResults: fileFallback.recentBatchResults || [],
      recentBatchEvents: fileFallback.recentBatchResults || [],
      message: fileFallback.batchCount
        ? fileFallback.message
        : (err && err.message ? err.message : String(err)),
      ...SAFETY,
    });
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
    const ranked = arr(replay.recentReplays).slice().sort((a, b) => (num(b.avgTradeScore) || -Infinity) - (num(a.avgTradeScore) || -Infinity));
    return statusBlock(replay.status || 'error', source, {
      totalReplayRuns: num(replay.totalReplayTests) || 0,
      latestReplay: replay.latestReplay || null,
      latestResult: replay.latestResult || null,
      recentReplays: arr(replay.recentReplays).slice(0, 10),
      bestReplay: ranked[0] || replay.latestReplay || null,
      worstReplay: ranked[ranked.length - 1] || null,
      recentReplayResults: ranked.slice(0, 5),
      hasReplayData: (num(replay.totalReplayTests) || 0) > 0,
      replayIntelligenceSessions: sessions.length,
      timeframes: arr(replay.timeframes),
      symbols: arr(replay.symbols).slice(0, 20),
      sourceFiles: ['data/replay/runs', 'data/replay-intelligence'],
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
    const paperAllowlistService = lazy('./paperAllowlistService');
    const allowlistStatus = paperAllowlistService && typeof paperAllowlistService.getPaperAllowlistStatus === 'function'
      ? paperAllowlistService.getPaperAllowlistStatus()
      : null;
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
      allowlist: allowlistStatus ? {
        totalApproved: allowlistStatus.totalApproved || 0,
        readyForPaperRuntime: allowlistStatus.readyForPaperRuntime || 0,
        pendingRuntimeConnection: allowlistStatus.pendingRuntimeConnection || 0,
        approvedStrategyIds: arr(allowlistStatus.allowlist).map((row) => row.id).filter(Boolean),
        waitingForApproval: arr(allowlistStatus.waitingForApproval).slice(0, 10),
        note: allowlistStatus.note || null,
      } : null,
      recentPaperTrades: arr(paper.recentPaperTrades).slice(0, 10),
      updatedAt: paper.updatedAt || null,
      message: paper.message || null,
      ...SAFETY,
    });
  } catch (err) {
    return statusBlock('error', source, { message: err && err.message ? err.message : String(err), ...SAFETY });
  }
}

function summarizeLearningStatus(learningConnector, narrowPerf, daytradingLearning, aiAnalyst, preloaded = {}) {
  const source = 'narrowPerformanceLearningService|learningConnectorService|daytradingLearningEngineService|aiAnalystService';
  try {
    const connector = preloaded.latestLearningSummary !== undefined
      ? preloaded.latestLearningSummary
      : (learningConnector && typeof learningConnector.loadLatestSummary === 'function'
        ? learningConnector.loadLatestSummary()
        : null);
    const narrow = preloaded.narrowLearningSnapshot !== undefined
      ? preloaded.narrowLearningSnapshot
      : (narrowPerf && typeof narrowPerf.buildSupervisorNarrowLearning === 'function'
        ? narrowPerf.buildSupervisorNarrowLearning()
        : null);
    const day = preloaded.dayLearningSummary !== undefined
      ? preloaded.dayLearningSummary
      : (daytradingLearning && typeof daytradingLearning.getLearningSummary === 'function'
        ? daytradingLearning.getLearningSummary({ hours: 168, limit: 200 })
        : null);
    const analyst = aiAnalyst && typeof aiAnalyst.getStatus === 'function'
      ? summarizeAiAnalystStatus(aiAnalyst.getStatus())
      : null;
    const signalLearning = readJsonFile(DATA_FILES.signalLearningSummary, null);
    const connectorSummary = connector ? summarizeLearning(connector, preloaded.canonicalStats || null) : null;
    const failureReasons = arr(signalLearning?.failureAnalysis?.reasons).slice(0, 5).map((row) => ({
      reason: row.reason || null,
      labelSv: row.labelSv || null,
      count: num(row.count),
      pct: num(row.pct),
    }));
    const narrowRecommendation = narrow?.recommendedNextTest || null;
    const topInsight = arr(signalLearning?.insightsSv)[0] || null;

    const daySummary = day && day.summary ? day.summary : {};
    const dayLooksLegacy = (num(daySummary.trades_total) || 0) === 0 && (num(daySummary.skipped_total) || 0) > 1000;
    const mostReliableSource = narrow && text(narrow.status) && text(narrow.dataConfidence) !== 'none'
      ? 'narrowPerformanceLearningService'
      : (connector ? 'learningConnectorService' : (day ? 'daytradingLearningEngineService' : null));
    let status = 'empty';
    if (narrow || connector || day || analyst) status = 'ok';
    if (dayLooksLegacy) status = 'degraded';
    if (!narrow && !connector && !day && !analyst) status = 'empty';
    const bestLearning = narrow?.bestStrategy ? {
      strategy_id: narrow.bestStrategy.strategy_id || null,
      name: narrow.bestStrategy.name || null,
      winRate: narrow.bestStrategy.winRate ?? null,
      avgPnl: narrow.bestStrategy.avgPnl ?? null,
      trades: narrow.bestStrategy.trades ?? null,
    } : (connectorSummary?.canonicalPaperStats ? {
      strategy_id: 'paper_connector',
      name: 'Learning connector',
      winRate: connectorSummary.canonicalPaperStats.winRate ?? null,
      avgPnl: connectorSummary.canonicalPaperStats.avgPnl ?? null,
      trades: connectorSummary.canonicalPaperStats.totalTrades ?? null,
    } : null);
    const worstWeakness = narrow?.worstStrategy ? {
      strategy_id: narrow.worstStrategy.strategy_id || null,
      name: narrow.worstStrategy.name || null,
      winRate: narrow.worstStrategy.winRate ?? null,
      avgPnl: narrow.worstStrategy.avgPnl ?? null,
      trades: narrow.worstStrategy.trades ?? null,
    } : (failureReasons[0] || null);

    return statusBlock(status, source, {
      narrowLearning: narrow || null,
      connectorSummary,
      signalLearningSummary: signalLearning ? {
        updatedAt: signalLearning.updatedAt || null,
        totalSignals: num(signalLearning.totalSignals),
        totalOutcomes: num(signalLearning.totalOutcomes),
        overallWinRate: num(signalLearning.overallWinRate),
        bestSymbols: arr(signalLearning.bestSymbols).slice(0, 3),
        worstSymbols: arr(signalLearning.worstSymbols).slice(0, 3),
        bestEventTypes: arr(signalLearning.bestEventTypes).slice(0, 5),
        bestMarketRegimes: arr(signalLearning.bestMarketRegimes).slice(0, 5),
        failureAnalysis: failureReasons,
        insightsSv: arr(signalLearning.insightsSv).slice(0, 10),
      } : null,
      aiAnalystStatus: analyst,
      mostReliableSource,
      bestLearning,
      worstWeakness,
      nextRecommendedTest: narrowRecommendation,
      topInsight,
      learningRecommendations: [
        narrowRecommendation ? {
          title: narrowRecommendation.title || 'Kör nästa rekommenderade test',
          reason: narrowRecommendation.reason || null,
          source: narrowRecommendation.source || 'narrowPerformanceLearningService',
          strategy_id: narrowRecommendation.strategy_id || null,
        } : null,
        topInsight ? { title: 'Bästa historiska lärdom', reason: topInsight, source: 'data/signals/learning-summary.json' } : null,
        failureReasons[0] ? { title: 'Största svaghet', reason: failureReasons[0].labelSv || failureReasons[0].reason, source: 'data/signals/learning-summary.json' } : null,
      ].filter(Boolean),
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
    const strategyMap = new Map(arr(registry.strategies).map((row) => [row.strategy_id, row]));
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
    const mapRow = (row) => {
      const registryRow = strategyMap.get(row.strategy_id) || {};
      return {
        id: row.strategy_id,
        key: row.strategy_id,
        name: registryRow.strategy_name || registryRow.strategy_id || row.strategy_id,
        source: row.source || registryRow.source || 'internal',
        status: row.status || registryRow.status || null,
        score: num(row.score),
        confidence: num(row.confidence),
        sampleSize: num(row.sample_size),
        trades: num(row.sample_size ?? row.paper_trades ?? row.candidate_count),
        winRate: num(row.win_rate ?? row.performance_summary?.win_rate ?? registryRow.performance_summary?.win_rate),
        avgPnl: num(row.avg_pnl ?? row.performance_summary?.avg_pnl ?? registryRow.performance_summary?.avg_pnl),
        paperTrades: num(row.paper_trades),
        candidateCount: num(row.candidate_count),
        recommendedAction: row.recommended_action || null,
        strengths: arr(row.strengths).slice(0, 4),
        weaknesses: arr(row.weaknesses).slice(0, 4),
        needsMoreData: (num(row.sample_size) || 0) < 10 || (num(row.confidence) || 0) < 50,
        ...SAFETY,
      };
    };
    const ranked = strategies.length ? strategies.map(mapRow).sort((a, b) => (num(b.score) || -Infinity) - (num(a.score) || -Infinity)) : perfTop.map((row) => ({
      id: row.strategy_id || row.key || null,
      key: row.strategy_id || row.key || null,
      name: row.strategy_name || row.key || row.strategy_id || null,
      source: row.source || 'internal',
      status: row.status || null,
      score: num(row.score),
      confidence: num(row.confidence),
      sampleSize: num(row.sample_size),
      trades: num(row.trades),
      winRate: num(row.win_rate),
      avgPnl: num(row.avg_pnl),
      paperTrades: num(row.paper_trades),
      candidateCount: num(row.candidate_count),
      recommendedAction: row.recommended_action || null,
      strengths: arr(row.strengths).slice(0, 4),
      weaknesses: arr(row.weaknesses).slice(0, 4),
      needsMoreData: (num(row.sample_size) || 0) < 10 || (num(row.confidence) || 0) < 50,
      ...SAFETY,
    }));
    const topStrategies = ranked.slice(0, 5);
    const weakStrategies = ranked.slice(-5).reverse();
    const strategiesNeedingMoreData = ranked.filter((row) => row.needsMoreData).slice(0, 10);
    const bestStrategies = topStrategies;
    const weakestStrategies = weakStrategies;
    const strategiesWithoutTests = ranked.filter((row) => (num(row.sampleSize) || 0) === 0).slice(0, 10);
    const status = num(registry.total_strategies) > 0 ? 'ok' : 'empty';
    return statusBlock(status, source, {
      totalStrategies: num(registry.total_strategies) || 0,
      activeStrategies: num(registry.active_strategies) || 0,
      inactiveStrategies: Math.max(0, (num(registry.total_strategies) || 0) - (num(registry.active_strategies) || 0)),
      paperOnlyStrategies: num(registry.paper_only_strategies) || 0,
      pausedStrategies: num(registry.paused_strategies) || 0,
      tradingviewStrategies: num(registry.tradingview_strategies) || 0,
      activeStrategiesWithEvidence: ranked.filter((row) => row.status === 'active' && (num(row.sampleSize) || 0) > 0).length,
      strategiesWithoutTests: strategiesWithoutTests,
      strategiesNeedingMoreDataCount: strategiesNeedingMoreData.length,
      topStrategies,
      weakStrategies,
      bestStrategies,
      weakestStrategies,
      strategiesNeedingMoreData,
      bestJustNow: topStrategies[0] || null,
      weakestJustNow: weakStrategies[0] || null,
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
      bestStrategies: [],
      weakestStrategies: [],
      strategiesWithoutTests: [],
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

function buildAiRecommendations({
  aiAnalystStatus,
  learningStatus,
  strategyRanking,
  dataStatus,
  batchStatus,
  replayStatus,
  paperStatus,
} = {}) {
  const items = [];
  const push = (item) => {
    if (!item || !item.title) return;
    items.push({
      priority: 'low',
      source: 'supervisor_overview',
      ...SAFETY,
      ...item,
    });
  };

  if (aiAnalystStatus && aiAnalystStatus.latestExists === true) {
    push({
      title: 'Senaste AI-analys finns',
      reason: `Senaste analysen är ${aiAnalystStatus.latestStatus || 'ok'} och kan läsas read-only.`,
      source: 'aiAnalystService',
    });
  }
  if (learningStatus?.nextRecommendedTest) {
    push({
      title: learningStatus.nextRecommendedTest.title || 'Nästa rekommenderade test',
      reason: learningStatus.nextRecommendedTest.reason || null,
      strategy_id: learningStatus.nextRecommendedTest.strategy_id || null,
      source: learningStatus.nextRecommendedTest.source || 'narrowPerformanceLearningService',
    });
  }
  if (strategyRanking?.bestJustNow) {
    push({
      title: 'Fortsätt följa bästa strategin',
      reason: `${strategyRanking.bestJustNow.name || strategyRanking.bestJustNow.key || 'Strategi'} leder just nu.`,
      strategy_id: strategyRanking.bestJustNow.id || strategyRanking.bestJustNow.key || null,
      source: 'strategyRanking',
    });
  }
  if (dataStatus?.missingSymbols?.length) {
    const first = dataStatus.missingSymbols[0];
    push({
      title: 'Fyll datagap innan fler tester',
      reason: `${dataStatus.missingSymbols.length} symboler har svag eller saknad historik. Exempel: ${first.symbol}.`,
      strategy_id: null,
      source: 'dataCoverageExpansionService',
      priority: 'medium',
    });
  }
  if (paperStatus?.allowlist?.waitingForApproval?.length) {
    const first = paperStatus.allowlist.waitingForApproval[0];
    push({
      title: 'Granska paper allowlist',
      reason: `${paperStatus.allowlist.waitingForApproval.length} kandidater väntar på godkännande. Exempel: ${first.id}.`,
      strategy_id: first.id || null,
      source: 'paperAllowlistService',
      priority: 'medium',
    });
  }
  if (batchStatus?.bestOutcome || replayStatus?.bestReplay) {
    push({
      title: 'Jämför batch och replay',
      reason: 'Batch- och replayhistorik finns och kan jämföras read-only innan nästa manuell kontroll.',
      source: 'batchStatusService|replayStatusService',
    });
  }

  return statusBlock(items.length ? 'ok' : 'empty', 'aiAnalystService', {
    items: items.slice(0, 8),
    reason: items.length ? 'sammanställda_read_only_recommendations' : 'no_unified_ai_recommendation_source_yet',
    latestAnalyst: aiAnalystStatus || null,
    ...SAFETY,
  });
}

function buildLossFeedbackQueue({ learningStatus, strategyRanking, paperStatus, batchStatus, dataStatus } = {}) {
  const items = [];
  const push = (item) => {
    if (!item || !item.title) return;
    items.push({
      priority: 'medium',
      source: 'supervisor_overview',
      ...SAFETY,
      ...item,
    });
  };

  arr(learningStatus?.signalLearningSummary?.failureAnalysis).slice(0, 3).forEach((failure) => {
    push({
      title: failure.labelSv || failure.reason || 'Historisk svaghet',
      reason: `Frekvens ${failure.pct != null ? `${failure.pct}%` : 'okänd'} (${failure.count ?? 'okänt'} fall).`,
      source: 'data/signals/learning-summary.json',
      kind: 'learning_failure',
    });
  });
  if (strategyRanking?.weakestJustNow) {
    push({
      title: `Svag strategi: ${strategyRanking.weakestJustNow.name || strategyRanking.weakestJustNow.key}`,
      reason: `Score ${strategyRanking.weakestJustNow.score ?? 'okänd'} / sample ${strategyRanking.weakestJustNow.sampleSize ?? 0}.`,
      strategy_id: strategyRanking.weakestJustNow.id || strategyRanking.weakestJustNow.key || null,
      source: 'strategyRanking',
      kind: 'weak_strategy',
    });
  }
  if (paperStatus?.worstStrategy) {
    push({
      title: `Paper: svagast ${paperStatus.worstStrategy.strategy || 'strategi'}`,
      reason: `Win rate ${paperStatus.worstStrategy.winRate ?? 'okänd'}% och avgPnL ${paperStatus.worstStrategy.avgPnl ?? 'okänd'}.`,
      source: 'paperTradingStatusService',
      kind: 'paper_loss',
    });
  }
  if (dataStatus?.missingSymbols?.length) {
    push({
      title: 'Datakvalitet blockerar feedback',
      reason: `${dataStatus.missingSymbols.length} symboler saknar tillräcklig historik.`,
      source: 'dataCoverageExpansionService',
      kind: 'data_gap',
    });
  }
  if (batchStatus?.failedBatches > 0) {
    push({
      title: `${batchStatus.failedBatches} batchar misslyckades`,
      reason: 'Granska misslyckade batchresultat innan nästa jämförelse.',
      source: 'batchStatusService',
      kind: 'batch_failure',
    });
  }

  return statusBlock(items.length ? 'ok' : 'empty', 'supervisor_overview', {
    items: items.slice(0, 8),
    reason: items.length ? 'loss_feedback_derived_from_read_only_history' : 'loss_feedback_queue_not_implemented_yet',
    ...SAFETY,
  });
}

function buildNextRecommendedActions({ learningStatus, strategyRanking, dataStatus, batchStatus, paperStatus } = {}) {
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
  }
  if (dataStatus?.missingSymbols?.length) {
    const first = dataStatus.missingSymbols[0];
    actions.push({
      title: `Backfill ${first.symbol}`,
      reason: `${dataStatus.missingSymbols.length} symboler har svag eller saknad historik.`,
      source: 'dataCoverageExpansionService',
      priority: 'medium',
      ...SAFETY,
    });
  }
  if (strategyRanking?.weakestJustNow) {
    actions.push({
      title: `Granska ${strategyRanking.weakestJustNow.name || strategyRanking.weakestJustNow.key}`,
      reason: 'Det här är svagaste strategin just nu enligt read-only ranking.',
      strategy_id: strategyRanking.weakestJustNow.id || strategyRanking.weakestJustNow.key || null,
      source: 'strategyRanking',
      priority: 'medium',
      ...SAFETY,
    });
  }
  if (batchStatus?.batchHistoryAvailable || batchStatus?.totalBatches > 0) {
    actions.push({
      title: 'Jämför senaste batchresultat',
      reason: 'Batchhistorik finns och kan jämföras utan att starta något nytt.',
      source: 'batchStatusService',
      priority: 'low',
      ...SAFETY,
    });
  }
  if (paperStatus?.allowlist?.waitingForApproval?.length) {
    actions.push({
      title: 'Granska paper allowlist',
      reason: `${paperStatus.allowlist.waitingForApproval.length} strategier väntar på manuell kontroll.`,
      source: 'paperAllowlistService',
      priority: 'low',
      ...SAFETY,
    });
  }
  actions.push(
    { title: 'Keep paper_only', reason: 'No live trading, broker, or order paths should be enabled.', source: 'safety', priority: 'high', ...SAFETY },
  );
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

function buildBatchHistoryFallback({ force = false } = {}) {
  const now = Date.now();
  if (!force && batchHistoryFallbackCache.value && (now - batchHistoryFallbackCache.at) < BATCH_HISTORY_FALLBACK_TTL_MS) {
    return batchHistoryFallbackCache.value;
  }
  const files = listJsonFiles(DATA_FILES.batchResultsDir);
  if (!files.length) {
    const gridSummary = readJsonFile(DATA_FILES.batchGridSummary, null);
    const value = {
      status: gridSummary ? 'degraded' : 'empty',
      source: 'data/strategy-batches/results|top-strategy-grid-v1-summary.json',
      batchCount: 0,
      batches: [],
      latestBatch: null,
      bestBatch: null,
      worstBatch: null,
      latestResult: null,
      bestOutcome: null,
      worstOutcome: null,
      recentBatchResults: [],
      failedCount: 0,
      unreadableFiles: 0,
      message: gridSummary
        ? 'Batchhistorik saknas som batchlista, men en grid-sammanfattning finns.'
        : 'Batchhistorik saknas i filsystemet.',
      gridSummary,
    };
    batchHistoryFallbackCache = { at: now, value };
    return value;
  }

  const rows = [];
  let unreadableFiles = 0;
  for (const file of files) {
    const parsed = readJsonFile(file, null);
    if (!parsed) {
      unreadableFiles += 1;
      continue;
    }
    const sourceRows = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed.results) ? parsed.results : [parsed]);
    for (const row of sourceRows) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        rows.push({ ...row, _sourceFile: path.relative(ROOT, file) });
      }
    }
  }

  const grouped = new Map();
  for (const row of rows) {
    const batchId = row.batch_id || row.batchId || row.id || row.runId || row.batch_id_ref || null;
    const key = batchId || `${row.strategy_id || row.strategyId || 'unknown'}:${row.symbol || 'unknown'}:${row.timeframe || 'unknown'}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(row);
  }

  const batches = [...grouped.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => newestFirstByIso(a, b, ['run_completed_at', 'completed_at', 'created_at', 'run_started_at', 'started_at']));
    const latest = sorted[0] || null;
    const latestFailed = sorted.find((row) => ['failed', 'error'].includes(String(row.status || '').toLowerCase())) || null;
    const best = [...list].sort((a, b) => (num(b.score ?? b.avg_pnl ?? b.avgPnl ?? b.paper_pnl_percent) || -Infinity) - (num(a.score ?? a.avg_pnl ?? a.avgPnl ?? a.paper_pnl_percent) || -Infinity))[0] || null;
    const worst = [...list].sort((a, b) => (num(a.score ?? a.avg_pnl ?? a.avgPnl ?? a.paper_pnl_percent) || Infinity) - (num(b.score ?? b.avg_pnl ?? b.avgPnl ?? b.paper_pnl_percent) || Infinity))[0] || null;
    const wins = list.reduce((sum, row) => sum + (num(row.wins) || 0), 0);
    const losses = list.reduce((sum, row) => sum + (num(row.losses) || 0), 0);
    const timeouts = list.reduce((sum, row) => sum + (num(row.timeouts) || 0), 0);
    const totalPnl = mean(list.map((row) => num(row.total_pnl ?? row.totalPnl ?? row.paper_pnl_percent ?? row.avg_pnl ?? row.avgPnl)));
    return {
      id: latest?.batch_id || latest?.batchId || key,
      status: 'completed',
      strategy: uniqueStrings(list.map((row) => row.strategy_name || row.strategy_id || row.strategyId), 3).join(', ') || null,
      symbols: uniqueStrings(list.map((row) => row.symbol || row.traded_symbol || row.underlying_symbol), 8),
      timeframe: uniqueStrings(list.map((row) => row.timeframe), 4).join(', ') || null,
      startedAt: sorted[sorted.length - 1]?.run_started_at || sorted[sorted.length - 1]?.started_at || sorted[sorted.length - 1]?.created_at || null,
      completedAt: latest?.run_completed_at || latest?.completed_at || latest?.created_at || null,
      runsCount: list.length,
      combinationsTested: list.length,
      wins,
      losses,
      timeouts,
      winRate: list.length ? round((list.reduce((sum, row) => sum + (num(row.win_rate) || 0), 0)) / list.length, 2) : null,
      avgResult: list.length ? round(list.reduce((sum, row) => sum + (num(row.avg_pnl ?? row.avgPnl ?? row.paper_pnl_percent) || 0), 0) / list.length, 4) : null,
      totalPnl: list.length ? round(list.reduce((sum, row) => sum + (num(row.total_pnl ?? row.totalPnl ?? row.paper_pnl_percent) || 0), 0), 4) : null,
      bestOutcome: normalizeBatchOutcome(best),
      worstOutcome: normalizeBatchOutcome(worst),
      latestResult: normalizeBatchResult(latest),
      paperOnly: true,
      mode: 'paper_only',
      source: 'data/strategy-batches/results',
      _sourceFile: latest?._sourceFile || null,
      ...SAFETY,
    };
  }).sort((a, b) => String(b.completedAt || b.startedAt || '').localeCompare(String(a.completedAt || a.startedAt || '')));

  const bestBatch = [...batches].sort((a, b) => (num(b.bestOutcome?.score ?? b.avgResult ?? b.winRate) || -Infinity) - (num(a.bestOutcome?.score ?? a.avgResult ?? a.winRate) || -Infinity))[0] || null;
  const worstBatch = [...batches].sort((a, b) => (num(a.bestOutcome?.score ?? a.avgResult ?? a.winRate) || Infinity) - (num(b.bestOutcome?.score ?? b.avgResult ?? b.winRate) || Infinity))[0] || null;
  const latestBatch = batches[0] || null;
  const value = {
    status: unreadableFiles ? 'degraded' : 'ok',
    source: 'data/strategy-batches/results',
    batchCount: batches.length,
    batches,
    latestBatch,
    bestBatch,
    worstBatch,
    latestResult: latestBatch?.latestResult || null,
    bestOutcome: bestBatch?.bestOutcome || latestBatch?.bestOutcome || null,
    worstOutcome: worstBatch?.worstOutcome || latestBatch?.worstOutcome || null,
    recentBatchResults: batches.slice(0, 8),
    failedCount: 0,
    unreadableFiles,
    message: batches.length
      ? (unreadableFiles ? 'Batchhistorik lästes delvis från result-filer.' : 'Batchhistorik lästes från result-filer.')
      : 'Batchhistorik saknas i result-filerna.',
    gridSummary: readJsonFile(DATA_FILES.batchGridSummary, null),
  };
  batchHistoryFallbackCache = { at: now, value };
  return value;
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

    const fileFallback = buildBatchHistoryFallback();
    if (!batches.length && fileFallback.batchCount > 0) {
      const fallbackLatest = fileFallback.latestBatch;
      return {
        ...base,
        status: fileFallback.status === 'degraded' ? 'degraded' : 'ok',
        totalBatches: fileFallback.batchCount,
        completedBatches: fileFallback.batchCount,
        runningBatches: 0,
        pausedBatches: 0,
        failedBatches: fileFallback.failedCount || 0,
        latestBatch: fallbackLatest,
        latestCompletedBatch: fallbackLatest,
        latestResult: fileFallback.latestResult,
        activeBatch: null,
        bestOutcome: fileFallback.bestOutcome || fallbackLatest?.bestOutcome || null,
        worstOutcome: fileFallback.worstOutcome || fallbackLatest?.worstOutcome || null,
        bestBatch: fileFallback.bestBatch || fallbackLatest,
        worstBatch: fileFallback.worstBatch || null,
        recentBatchResults: fileFallback.recentBatchResults,
        batchHistorySource: fileFallback.source,
        batchHistoryAvailable: true,
        message: 'Batchhistorik saknas i batchlistan, men batchresultat finns i data/strategy-batches/results.',
      };
    }

    if (!batches.length) {
      return {
        status: fileFallback.batchCount ? 'degraded' : 'empty',
        ...base,
        batchHistorySource: fileFallback.source,
        batchHistoryAvailable: fileFallback.batchCount > 0,
        bestBatch: fileFallback.bestBatch || null,
        worstBatch: fileFallback.worstBatch || null,
        recentBatchResults: fileFallback.recentBatchResults,
        message: fileFallback.batchCount
          ? 'Batchhistorik finns i result-filer men saknar batchlista.'
          : 'Det finns inga batchtester att visa ännu.',
      };
    }

    const sorted = [...batches].sort((a, b) => batchTime(b).localeCompare(batchTime(a)));
    const latest = sorted[0] || null;
    const latestCompleted = sorted.find((b) => String(b?.status || '').toLowerCase() === 'completed') || null;
    const latestFailed = sorted.find((b) => ['failed', 'error'].includes(String(b?.status || '').toLowerCase())) || null;
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
      bestOutcome: normalizeBatchOutcome(bestOutcome),
      worstOutcome: normalizeBatchOutcome(worstOutcome),
      bestBatch: normalizeBatch(latestCompleted || latest, { bestOutcome, worstOutcome, latestResult, resultsCount }),
      worstBatch: normalizeBatch(latestFailed || latestCompleted || latest, { bestOutcome, worstOutcome, latestResult, resultsCount }),
      batchHistoryAvailable: true,
      batchHistorySource: 'strategyBatchTestService',
      recentBatchResults: batches.slice(0, 5).map((batch) => normalizeBatch(batch, { bestOutcome, worstOutcome, latestResult, resultsCount })),
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
  const safety = blocks.safety || null;

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

  const data = blocks.data_status;
  if (data && data.status && data.status !== 'ok') {
    risks.push({ level: 'warning', code: 'data_degraded', message_sv: `Datalagret är ${data.status}. ${data.message || 'Vissa menyer får ofullständig historik.'}` });
  }
  const batch = blocks.batch_status;
  if (batch && batch.status && batch.status !== 'ok') {
    risks.push({ level: 'warning', code: 'batch_degraded', message_sv: `Batchhistoriken är ${batch.status}. ${batch.message || 'Batchmenyn kan visa tomma sammanfattningar.'}` });
  }
  const replay = blocks.replay_status;
  if (replay && replay.status && replay.status !== 'ok') {
    risks.push({ level: 'warning', code: 'replay_degraded', message_sv: `Replayhistoriken är ${replay.status}. ${replay.message || 'Replaymenyn kan vara delvis tom.'}` });
  }
  const paper = blocks.paper_status;
  if (paper && paper.status && paper.status !== 'ok') {
    risks.push({ level: 'warning', code: 'paper_degraded', message_sv: `Paperstatus är ${paper.status}. ${paper.message || 'Paper-menyn kan sakna senaste trades.'}` });
  }

  for (const [name, b] of Object.entries(blocks)) {
    if (b && b.status === 'error') {
      risks.push({ level: 'warning', code: `block_error:${name}`, message_sv: `Block "${name}" kunde inte läsas: ${b.error || 'okänt fel'}.` });
    }
  }

  if (!safety || safety.mode === 'paper_only') {
    risks.push({ level: 'info', code: 'paper_only', message_sv: 'Systemet är i paper_only. Inga riktiga order, broker eller live-trading är aktiva.' });
  }
  risks.push({ level: 'info', code: 'no_live_trading', message_sv: 'Live trading är avstängt.' });
  risks.push({ level: 'info', code: 'no_broker', message_sv: 'Broker är avstängd.' });
  risks.push({ level: 'info', code: 'no_orders', message_sv: 'Orderexekvering är avstängd.' });
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

  const data = blocks.data_status;
  if (data && data.status && data.status !== 'ok' && Array.isArray(data.summary?.missingSymbols) && data.summary.missingSymbols.length) {
    const example = data.summary.missingSymbols[0];
    plan.push({
      priority: 'medium',
      title_sv: 'Fyll datagap för testbarhet',
      detail_sv: `Symbolen ${example.symbol} saknar tillräcklig historik. Det här påverkar endast testkvalitet, inte pengar.`,
      source: 'dataCoverageExpansionService',
    });
  }

  const batch = blocks.batch_status;
  if (batch && batch.status && batch.status !== 'ok' && batch.summary && batch.summary.batchHistoryAvailable) {
    plan.push({
      priority: 'low',
      title_sv: 'Jämför batchhistorik',
      detail_sv: 'Batchdata finns men är delvis degraderad. Granska senaste resultat och skillnaden mellan bästa och sämsta körning.',
      source: 'batchStatusService',
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

  let preloadedLearningSummary = null;
  try {
    preloadedLearningSummary = learningConnector && typeof learningConnector.loadLatestSummary === 'function'
      ? getCachedReadOnly('learning_summary', learningConnector.loadLatestSummary, () => learningConnector.loadLatestSummary())
      : null;
  } catch (_) {
    preloadedLearningSummary = null;
  }

  let preloadedNarrowLearning = null;
  try {
    preloadedNarrowLearning = narrowPerf && typeof narrowPerf.buildSupervisorNarrowLearning === 'function'
      ? getCachedReadOnly('narrow_learning', narrowPerf.buildSupervisorNarrowLearning, () => narrowPerf.buildSupervisorNarrowLearning())
      : null;
  } catch (_) {
    preloadedNarrowLearning = null;
  }

  let preloadedCanonicalStats = null;
  try {
    const c = getCachedReadOnly('paper_stats', tradeStats.buildPaperTradeStats, () => tradeStats.buildPaperTradeStats());
    preloadedCanonicalStats = {
      totalTrades: c.totalTrades,
      winRate: c.winRate,
      decisiveWinRate: c.decisiveWinRate,
      timeoutRate: c.timeoutRate,
      avgPnl: c.avgPnl,
    };
  } catch (_) {
    preloadedCanonicalStats = null;
  }

  const preloadedDayLearning = getCachedReadOnly('day_learning_summary', daytradingLearning.getLearningSummary, () => daytradingLearning.getLearningSummary({ hours: 168, limit: 200 }));

  const [
    system_health, learning, strategies, narrow, autopilotBlock,
    market_regime, priorityBlock, daily_pipeline, ai_optimization, operations_advisor,
  ] = await Promise.all([
    safeBlock({ scope: 'system_wide', source: '/api/system/health' },
      () => summarizeSystemHealth(systemHealth.buildSystemHealth())),
    safeBlock({ scope: 'system_wide', source: '/api/learning/latest-summary' },
      () => summarizeLearning(preloadedLearningSummary, preloadedCanonicalStats)),
    safeBlock({ scope: 'system_wide', source: '/api/daytrading-strategies/top|worst' },
      () => summarizeStrategies(strategyRead.getTopStrategies(5), strategyRead.getWorstStrategies(5))),
    safeBlock({ scope: 'narrow_only', source: '/api/supervisor/narrow-state' },
      () => summarizeNarrow(preloadedNarrowLearning)),
    safeBlock({ scope: 'narrow_only', source: '/api/autopilot/narrow/status' },
      () => summarizeAutopilot(null, scheduler.getNarrowAutopilotSchedulerStatus())),
    safeBlock({ scope: 'system_wide', source: '/api/market-regime/status' },
      () => summarizeRegime(marketRegime.buildRegimeSummary(false))),
    safeBlock({ scope: 'system_wide', source: '/api/priority/summary' },
      () => summarizePriority(null)),
    safeBlock({ scope: 'system_wide', source: '/api/pipeline/daily/status' },
      () => summarizeDaily(daily.status())),
    safeBlock({ scope: 'system_wide', source: '/api/optimization/summary' },
      () => summarizeOptimization(optimization.getCachedSummary())),
    safeBlock({ scope: 'system_wide', source: '/api/supervisor/operations-advisor' },
      () => summarizeOpsAdvisor(null)),
  ]);

  // Canonical headline from the single source of truth.
  let canonicalStats = preloadedCanonicalStats;

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
    batchSummary = getCachedReadOnly(
      'overview_batch_summary',
      signatureOf(strategyBatch.listBatchTests, strategyBatch.getBatchTestResults, strategyBatch.getLatestBatchComparison),
      () => buildBatchSummary(strategyBatch),
    );
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
    liveActivitySummary = {
      status: 'empty',
      count: 0,
      latestEvents: [],
      message: 'Live activity summary deferred.',
      ...SAFETY,
    };
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
    if (replayStatusBlock && replayStatusBlock.status && replayStatusBlock.status !== 'ok') {
      replaySummary = {
        status: replayStatusBlock.status,
        totalReplayTests: replayStatusBlock.totalReplayRuns || 0,
        latestReplay: replayStatusBlock.latestReplay || null,
        latestResult: replayStatusBlock.latestResult || null,
        message: replayStatusBlock.message || null,
        ...SAFETY,
      };
    } else {
      replaySummary = replayStatus && typeof replayStatus.buildSupervisorReplaySummary === 'function'
        ? getCachedReadOnly('replay_summary', signatureOf(replayStatus.buildSupervisorReplaySummary), () => replayStatus.buildSupervisorReplaySummary())
        : null;
    }
  } catch (err) {
    replaySummary = { status: 'error', totalReplayTests: 0, latestReplay: null, message: err && err.message ? err.message : 'unavailable', ...SAFETY };
  }

  let paperTradingSummary = null;
  try {
    paperTradingSummary = paperTradingStatus && typeof paperTradingStatus.buildSupervisorPaperSummary === 'function'
      ? getCachedReadOnly('paper_trading_summary', signatureOf(paperTradingStatus.buildSupervisorPaperSummary), () => paperTradingStatus.buildSupervisorPaperSummary())
      : null;
  } catch (err) {
    paperTradingSummary = { status: 'error', count: 0, latestPaperTrade: null, message: err && err.message ? err.message : 'unavailable', ...SAFETY };
  }

  const preloadedCoverageStatus = getCachedReadOnly('data_coverage_status', dataCoverage.getCoverageStatus, () => dataCoverage.getCoverageStatus());
  const preloadedAllCoverage = getCachedReadOnly('data_coverage_all', dataCoverage.getAllSymbolCoverage, () => dataCoverage.getAllSymbolCoverage());
  const dataStatus = getCachedReadOnly(
    'overview_data_status',
    signatureOf(dataCoverage.getCoverageStatus, dataCoverage.getAllSymbolCoverage, marketDataStore.listSymbols),
    () => summarizeDataStatus(dataCoverage, marketDataStore, {
      coverage: preloadedCoverageStatus,
      allCoverage: preloadedAllCoverage,
    }),
  );
  const batchStatus = getCachedReadOnly(
    'overview_batch_status',
    signatureOf(batchStatusService.buildBatchStatus),
    () => summarizeBatchStatus(batchStatusService),
  );
  const replayStatusBlock = getCachedReadOnly(
    'overview_replay_status',
    signatureOf(replayStatus.buildReplayStatus, replayIntelligence.listReplaySessions),
    () => summarizeReplayStatusBlock(replayStatus, replayIntelligence),
  );
  const paperStatus = getCachedReadOnly(
    'overview_paper_status',
    signatureOf(paperTradingStatus.buildPaperTradingStatus, tradeStats.buildPaperTradeStats),
    () => summarizePaperStatus(paperTradingStatus),
  );
  const learningStatus = getCachedReadOnly(
    'overview_learning_status',
    signatureOf(
      learningConnector.loadLatestSummary,
      narrowPerf.buildSupervisorNarrowLearning,
      daytradingLearning.getLearningSummary,
      aiAnalyst.getStatus,
    ),
    () => summarizeLearningStatus(learningConnector, narrowPerf, daytradingLearning, aiAnalyst, {
      latestLearningSummary: preloadedLearningSummary,
      narrowLearningSnapshot: preloadedNarrowLearning,
      dayLearningSummary: preloadedDayLearning,
      canonicalStats: preloadedCanonicalStats,
    }),
  );
  const strategyRanking = getCachedReadOnly(
    'overview_strategy_ranking',
    signatureOf(strategyRegistry.getStatus, strategyRead.getTopStrategies, strategyRead.getWorstStrategies, strategyScore.defaultStrategyScoreService && strategyScore.defaultStrategyScoreService.getStrategyScores),
    () => summarizeStrategyRanking(strategyRegistry, strategyRead, strategyScore),
  );
  const blocks = {
    system_health, learning, strategies, narrow, autopilot: autopilotBlock,
    market_regime, priority: priorityBlock, daily_pipeline, ai_optimization, operations_advisor,
    safety: SAFETY,
    data_status: dataStatus,
    batch_status: batchStatus,
    replay_status: replayStatusBlock,
    paper_status: paperStatus,
    learning_status: learningStatus,
    strategy_ranking: strategyRanking,
  };
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
  const aiRecommendations = buildAiRecommendations({
    aiAnalystStatus,
    learningStatus,
    strategyRanking,
    dataStatus,
    batchStatus,
    replayStatus: replayStatusBlock,
    paperStatus,
  });
  const lossFeedbackQueue = buildLossFeedbackQueue({
    learningStatus,
    strategyRanking,
    paperStatus,
    batchStatus,
    dataStatus,
  });
  const nextRecommendedActions = buildNextRecommendedActions({
    learningStatus,
    strategyRanking,
    dataStatus,
    batchStatus,
    paperStatus,
  });

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
