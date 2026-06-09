'use strict';

/**
 * Read-only batch status service.
 *
 * This service never creates, starts, pauses, stops or schedules a batch. It
 * only reads existing batch metadata, result summaries and recent batch events.
 */

const strategyBatchTest = require('./strategyBatchTestService');
const eventLogService = require('./eventLogService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function nowIso() { return new Date().toISOString(); }
function arr(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}
function lower(value) { return String(value || '').toLowerCase(); }
function batchTime(batch) {
  return String(firstPresent(batch?.updated_at, batch?.completed_at, batch?.batch_completed_at, batch?.started_at, batch?.created_at, ''));
}

function normalizeOutcome(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  return {
    strategy: firstPresent(row.strategy_id, row.strategyId, row.strategy_name, row.strategyName),
    symbol: firstPresent(row.symbol, row.traded_symbol, row.underlying_symbol),
    timeframe: row.timeframe || null,
    score: num(row.score),
    winRate: num(firstPresent(row.win_rate, row.winRate)),
    avgResult: num(firstPresent(row.avg_pnl, row.avgPnl, row.avgResult, row.paper_pnl_percent, row.pnlPct)),
    totalPnl: num(firstPresent(row.total_pnl, row.totalPnl)),
    trades: num(firstPresent(row.trades, row.tradeCount)),
    result: row.result || null,
    sampleQuality: row.sample_quality || null,
    mode: row.mode || 'paper_replay',
    paperOnly: row.paper_only !== false,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  };
}

function normalizeBatch(batch, extra = {}) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return null;
  const config = batch.config && typeof batch.config === 'object' ? batch.config : {};
  const progress = batch.progress && typeof batch.progress === 'object' ? batch.progress : {};
  const symbols = arr(firstPresent(config.symbols, batch.symbols));
  const strategies = arr(firstPresent(config.strategy_ids, config.strategyIds, config.strategies, batch.strategy_id, batch.strategy));
  const timeframes = arr(firstPresent(config.timeframes, config.timeframe, batch.timeframe));
  const totalCombinations = num(firstPresent(progress.total, batch.total_combinations, batch.totalCombinations, extra.totalCombinations));
  const combinationsTested = num(firstPresent(progress.completed, batch.combinations_tested, batch.combinationsTested, extra.combinationsTested));
  const progressPct = num(firstPresent(progress.pct, batch.progressPct, totalCombinations ? ((combinationsTested || 0) / totalCombinations) * 100 : null));
  const bestOutcome = normalizeOutcome(extra.bestOutcome || batch.bestOutcome);
  const worstOutcome = normalizeOutcome(extra.worstOutcome || batch.worstOutcome);
  const latestResult = normalizeOutcome(extra.latestResult);
  return {
    id: batch.id || null,
    status: batch.status || null,
    strategy: strategies.join(', ') || null,
    symbols,
    timeframe: timeframes.join(', ') || null,
    startedAt: firstPresent(batch.started_at, batch.batch_started_at, batch.last_run_at),
    completedAt: firstPresent(batch.completed_at, batch.batch_completed_at),
    progressPct,
    combinationsTested,
    totalCombinations,
    winRate: num(firstPresent(latestResult?.winRate, bestOutcome?.winRate, batch.win_rate, batch.winRate)),
    avgResult: num(firstPresent(latestResult?.avgResult, bestOutcome?.avgResult, batch.avg_pnl, batch.avgPnl)),
    bestOutcome,
    worstOutcome,
    paperOnly: batch.paper_only !== false,
    mode: batch.mode || 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  };
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = event.event_type || event.type || 'batch.event';
  if (!/batch/i.test(`${type} ${event.source || ''} ${event.strategy || ''} ${event.raw_signal || ''}`)) return null;
  return {
    id: event.event_id || event.id || `${type}:${event.timestamp || ''}:${event.symbol || ''}`,
    timestamp: event.timestamp || null,
    type,
    status: /completed/i.test(type) ? 'completed' : /started|running/i.test(type) ? 'running' : /failed|error/i.test(type) ? 'failed' : 'info',
    message: event.reason || event.message || type,
    batchId: event.metadata?.batch_id || event.details?.batch_id || null,
    strategy: event.strategy || null,
    symbol: event.symbol || null,
    timeframe: event.timeframe || null,
    source: event.source || 'batch',
    paperOnly: true,
    ...SAFETY,
  };
}

function readRecentBatchEvents(logService = eventLogService) {
  try {
    if (!logService || typeof logService.readRecentEvents !== 'function') return { status: 'empty', events: [] };
    const raw = logService.readRecentEvents(80);
    const events = arr(raw?.events).map(normalizeEvent).filter(Boolean).slice(0, 20);
    return { status: raw?.ok === false ? 'degraded' : (events.length ? 'ok' : 'empty'), events, error: raw?.error || null };
  } catch (err) {
    return { status: 'degraded', events: [], error: err && err.message ? err.message : String(err) };
  }
}

function readLatestResults(batchService, batch) {
  if (!batch || !batchService || typeof batchService.getBatchTestResults !== 'function') return { status: 'empty', top: [], worst: [], latestResult: null, count: 0 };
  try {
    const out = batchService.getBatchTestResults(batch.id);
    if (!out || out.ok === false) return { status: 'degraded', top: [], worst: [], latestResult: null, count: 0, error: out?.error || 'results_unavailable' };
    const top = arr(out.top);
    const worst = arr(out.worst);
    return {
      status: 'ok',
      top,
      worst,
      latestResult: top[0] || arr(out.results)[0] || null,
      count: num(out.count) || arr(out.results).length,
    };
  } catch (err) {
    return { status: 'degraded', top: [], worst: [], latestResult: null, count: 0, error: err && err.message ? err.message : String(err) };
  }
}

function readLatestComparison(batchService) {
  try {
    if (!batchService || typeof batchService.getLatestBatchComparison !== 'function') return null;
    const cmp = batchService.getLatestBatchComparison();
    if (!cmp || cmp.ok === false) return null;
    return cmp;
  } catch (_) {
    return null;
  }
}

function buildBatchStatus(options = {}) {
  const batchService = Object.prototype.hasOwnProperty.call(options, 'batchService') ? options.batchService : strategyBatchTest;
  const logService = Object.prototype.hasOwnProperty.call(options, 'eventLogService') ? options.eventLogService : eventLogService;
  const source = 'strategyBatchTestService';
  const base = {
    ok: true,
    status: 'empty',
    emptyReason: 'no_batch_tests',
    isRunning: false,
    activeBatch: null,
    latestBatch: null,
    latestCompletedBatch: null,
    latestFailedBatch: null,
    totalBatches: 0,
    completedBatches: 0,
    runningBatches: 0,
    pausedBatches: 0,
    failedBatches: 0,
    queuedBatches: 0,
    latestResult: null,
    bestOutcome: null,
    worstOutcome: null,
    recentBatchEvents: [],
    summary: null,
    source,
    updatedAt: nowIso(),
    ...SAFETY,
  };

  if (!batchService || typeof batchService.listBatchTests !== 'function') {
    return {
      ...base,
      status: 'missing',
      emptyReason: 'batch_service_missing',
      summary: {
        status: 'missing',
        source,
        message: 'Batchservice kunde inte läsas.',
        emptyReason: 'batch_service_missing',
        batchCount: 0,
        latestBatchId: null,
        bestBatchId: null,
        worstBatchId: null,
        activeBatchId: null,
        failedCount: 0,
        queuedCount: 0,
        paperOnly: true,
      },
      ok: false,
      message: 'Batchservice kunde inte läsas.',
    };
  }

  const warnings = [];
  try {
    const listed = batchService.listBatchTests();
    if (listed && listed.ok === false) return { ...base, status: 'error', ok: false, message: listed.error || 'Batchlista kunde inte läsas.' };
    const batches = arr(listed?.batches);
    const sorted = [...batches].sort((a, b) => batchTime(b).localeCompare(batchTime(a)));
    const latest = sorted[0] || null;
    const latestCompleted = sorted.find((b) => lower(b?.status) === 'completed') || null;
    const active = sorted.find((b) => ['running', 'paused'].includes(lower(b?.status))) || null;
    const latestFailed = sorted.find((b) => ['failed', 'error', 'stopped'].includes(lower(b?.status))) || null;
    const results = readLatestResults(batchService, latestCompleted || latest);
    const comparison = readLatestComparison(batchService);
    const events = readRecentBatchEvents(logService);
    if (results.status === 'degraded') warnings.push(results.error || 'batch_results_degraded');
    if (events.status === 'degraded') warnings.push(events.error || 'batch_events_degraded');

    const bestOutcome = results.top[0] || arr(comparison?.best_overall)[0] || comparison?.recommended_config || null;
    const worstOutcome = results.worst[0] || arr(comparison?.worst_overall)[0] || null;
    const status = warnings.length ? 'degraded' : (batches.length ? 'ok' : 'empty');
    const emptyReason = !batches.length
      ? 'no_batch_tests'
      : warnings.length
        ? 'batch_results_degraded'
        : null;
    const summary = {
      status,
      source,
      message: warnings.length ? 'Batchstatus lästes delvis.' : (batches.length ? 'Batchstatus läst.' : 'Inga batchtester hittades.'),
      emptyReason,
      batchCount: batches.length,
      completedCount: batches.filter((b) => lower(b?.status) === 'completed').length,
      runningCount: batches.filter((b) => lower(b?.status) === 'running').length,
      pausedCount: batches.filter((b) => lower(b?.status) === 'paused').length,
      failedCount: batches.filter((b) => ['failed', 'error', 'stopped'].includes(lower(b?.status))).length,
      queuedCount: batches.filter((b) => ['created', 'queued', 'pending'].includes(lower(b?.status))).length,
      latestBatchId: latest?.id || null,
      latestCompletedBatchId: latestCompleted?.id || null,
      latestFailedBatchId: latestFailed?.id || null,
      bestBatchId: latestCompleted?.id || latest?.id || null,
      worstBatchId: latestFailed?.id || null,
      activeBatchId: active?.id || null,
      paperOnly: true,
    };

    return {
      ...base,
      status,
      emptyReason,
      isRunning: Boolean(active && lower(active.status) === 'running') || Number(listed?.active_count || 0) > 0,
      activeBatch: normalizeBatch(active, { bestOutcome, worstOutcome, latestResult: results.latestResult, combinationsTested: results.count }),
      latestBatch: normalizeBatch(latest, { bestOutcome, worstOutcome, latestResult: results.latestResult, combinationsTested: results.count }),
      latestCompletedBatch: normalizeBatch(latestCompleted, { bestOutcome, worstOutcome, latestResult: results.latestResult, combinationsTested: results.count }),
      latestFailedBatch: normalizeBatch(latestFailed),
      totalBatches: batches.length,
      completedBatches: batches.filter((b) => lower(b?.status) === 'completed').length,
      runningBatches: batches.filter((b) => lower(b?.status) === 'running').length,
      pausedBatches: batches.filter((b) => lower(b?.status) === 'paused').length,
      failedBatches: batches.filter((b) => ['failed', 'error', 'stopped'].includes(lower(b?.status))).length,
      queuedBatches: batches.filter((b) => ['created', 'queued', 'pending'].includes(lower(b?.status))).length,
      latestResult: normalizeOutcome(results.latestResult),
      bestOutcome: normalizeOutcome(bestOutcome),
      worstOutcome: normalizeOutcome(worstOutcome),
      recentBatchEvents: events.events,
      summary,
      warnings,
      message: summary.message,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      status: 'degraded',
      emptyReason: 'batch_status_error',
      summary: {
        status: 'degraded',
        source,
        message: err && err.message ? err.message : String(err),
        emptyReason: 'batch_status_error',
        batchCount: 0,
        latestBatchId: null,
        bestBatchId: null,
        worstBatchId: null,
        activeBatchId: null,
        failedCount: 0,
        queuedCount: 0,
        paperOnly: true,
      },
      message: err && err.message ? err.message : String(err),
    };
  }
}

function buildSupervisorBatchSummary() {
  const full = buildBatchStatus();
  return {
    status: full.status,
    emptyReason: full.emptyReason || full.summary?.emptyReason || null,
    isRunning: full.isRunning,
    activeBatch: full.activeBatch,
    latestBatch: full.latestBatch,
    latestCompletedBatch: full.latestCompletedBatch,
    totalBatches: full.totalBatches,
    completedBatches: full.completedBatches,
    runningBatches: full.runningBatches,
    failedBatches: full.failedBatches,
    latestResult: full.latestResult,
    bestOutcome: full.bestOutcome,
    worstOutcome: full.worstOutcome,
    recentEventCount: full.recentBatchEvents.length,
    source: 'batchStatusService',
    message: full.message || full.summary?.message || null,
    summary: full.summary || {
      status: full.status,
      source: 'strategyBatchTestService',
      message: full.message || null,
      emptyReason: full.emptyReason || null,
      batchCount: full.totalBatches,
      latestBatchId: full.latestBatch?.id || null,
      latestCompletedBatchId: full.latestCompletedBatch?.id || null,
      bestBatchId: full.bestOutcome?.strategy || null,
      worstBatchId: full.worstOutcome?.strategy || null,
      activeBatchId: full.activeBatch?.id || null,
      failedCount: full.failedBatches,
      queuedCount: full.queuedBatches || 0,
      paperOnly: true,
    },
    updatedAt: full.updatedAt,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  buildBatchStatus,
  buildSupervisorBatchSummary,
  normalizeBatch,
  normalizeOutcome,
  normalizeEvent,
};
