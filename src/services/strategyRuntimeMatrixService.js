'use strict';

const fs = require('fs');
const path = require('path');

const catalogService = require('./daytradingStrategyCatalogService');
const runtimeConnector = require('./strategyRuntimeConnectorService');
const strategyPerformanceRead = require('./strategyPerformanceReadService');
const batchAutopilotService = require('./batchAutopilotService');
const replayAutopilotService = require('./replayAutopilotService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const ROOT = path.resolve(__dirname, '../..');
const PAPER_TRADES_FILE = path.join(ROOT, 'data/paper-trading/trades.jsonl');

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function safeArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && item !== '');
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function unique(values) {
  return [...new Set(safeArray(values).flatMap((value) => safeArray(value)).filter(Boolean).map(String))];
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); }
        catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function resultOfTrade(row) {
  const raw = String(row.result || row.status || row.exit_reason || row.reason || '').toLowerCase();
  if (raw.includes('win') || raw.includes('target') || raw === 'tp') return 'win';
  if (raw.includes('loss') || raw.includes('stop') || raw === 'sl') return 'loss';
  if (raw.includes('timeout') || raw.includes('max')) return 'timeout';
  if (Number.isFinite(Number(row.pnlPct ?? row.pnl_pct ?? row.pnl_percent))) {
    const pnl = Number(row.pnlPct ?? row.pnl_pct ?? row.pnl_percent);
    if (pnl > 0) return 'win';
    if (pnl < 0) return 'loss';
  }
  return 'unknown';
}

function pnlOfTrade(row) {
  const raw = row.pnlPct ?? row.pnl_pct ?? row.pnl_percent ?? row.paper_pnl_percent ?? row.pnl;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function timestampOf(row) {
  return row.closedAt
    || row.closed_at
    || row.exitAt
    || row.exit_at
    || row.updated_at
    || row.created_at
    || row.openedAt
    || row.opened_at
    || null;
}

function buildPaperStats() {
  const groups = new Map();
  for (const row of readJsonl(PAPER_TRADES_FILE)) {
    const id = row.strategy_id || row.strategyId || row.runtime_strategy || row.strategy;
    if (!id) continue;
    if (!groups.has(id)) {
      groups.set(id, {
        source: 'data/paper-trading/trades.jsonl',
        trades: 0,
        wins: 0,
        losses: 0,
        timeouts: 0,
        unknown: 0,
        totalPnl: 0,
        pnlCount: 0,
        lastTested: null,
      });
    }
    const stat = groups.get(id);
    const result = resultOfTrade(row);
    const pnl = pnlOfTrade(row);
    const ts = timestampOf(row);
    stat.trades += 1;
    if (result === 'win') stat.wins += 1;
    else if (result === 'loss') stat.losses += 1;
    else if (result === 'timeout') stat.timeouts += 1;
    else stat.unknown += 1;
    if (pnl !== null) {
      stat.totalPnl += pnl;
      stat.pnlCount += 1;
    }
    if (ts && (!stat.lastTested || String(ts) > String(stat.lastTested))) stat.lastTested = ts;
  }

  return new Map([...groups.entries()].map(([id, stat]) => {
    const decisive = stat.wins + stat.losses;
    return [id, {
      source: stat.source,
      totalTrades: stat.trades,
      wins: stat.wins,
      losses: stat.losses,
      timeouts: stat.timeouts,
      unknown: stat.unknown,
      winRate: stat.trades ? round((stat.wins / stat.trades) * 100, 2) : null,
      decisiveWinRate: decisive ? round((stat.wins / decisive) * 100, 2) : null,
      avgPnl: stat.pnlCount ? round(stat.totalPnl / stat.pnlCount, 4) : null,
      totalPnl: stat.pnlCount ? round(stat.totalPnl, 4) : null,
      lastTested: stat.lastTested,
    }];
  }));
}

function performanceByStrategy() {
  const response = strategyPerformanceRead.getStrategyPerformance();
  const rows = Array.isArray(response.strategies) ? response.strategies : [];
  return new Map(rows.map((row) => [row.strategy_id, row]));
}

function runtimeByStrategy() {
  const response = runtimeConnector.getStrategyRuntimeSummary();
  const rows = Array.isArray(response.strategies) ? response.strategies : [];
  return new Map(rows.map((row) => [row.id || row.strategy_id, row]));
}

function getRequiredData(strategy, runtime) {
  return unique([
    strategy.required_data,
    strategy.requiredData,
    strategy.required_indicators,
    strategy.requiredIndicators,
    strategy.signal_rules,
    runtime.required_data,
    runtime.requiredData,
  ]);
}

function getBlockers(strategy, runtime, scannerEnabled) {
  const blockers = [];
  const runtimeStatus = runtime.paperRuntimeStatus || runtime.runtime_status || 'unknown';
  for (const item of safeArray(runtime.missing_data || runtime.missingData)) {
    blockers.push(`missing_data:${item}`);
  }
  if (strategy.status === 'paused' || strategy.catalog_status === 'paused') blockers.push('catalog_status:paused');
  if (runtimeStatus === 'disabled') blockers.push('paper_runtime:disabled');
  if (runtimeStatus === 'paused') blockers.push('paper_runtime:paused');
  if (runtimeStatus === 'not_connected') blockers.push('paper_runtime:not_connected');
  if (runtimeStatus === 'no_entry_rule') blockers.push('paper_runtime:no_entry_rule');
  if (runtimeStatus === 'partial') blockers.push('paper_runtime:partial');
  if (!scannerEnabled) blockers.push('scanner:not_connected');
  if (runtime.runtime_comment_sv && runtimeStatus !== 'active') blockers.push(runtime.runtime_comment_sv);
  return unique(blockers);
}

function simulationSummaryFor(row) {
  if (!row) {
    return {
      source: 'data/daytrading-strategies/results-v1.json',
      status: 'needs_more_data',
      runs: 0,
      trades: 0,
      winRate: null,
      avgPnl: null,
      totalPnl: null,
      score: null,
      lastTested: null,
    };
  }
  return {
    source: 'data/daytrading-strategies/results-v1.json',
    status: row.needs_more_data ? 'needs_more_data' : 'available',
    runs: row.runs || 0,
    trades: row.trades || 0,
    wins: row.wins || 0,
    losses: row.losses || 0,
    timeouts: row.timeouts || 0,
    winRate: row.win_rate ?? null,
    avgPnl: row.avg_pnl ?? null,
    totalPnl: row.total_pnl ?? null,
    score: row.score ?? null,
    badge: row.performance_badge || null,
    lastTested: row.latest_result?.created_at || row.latest_result?.test_completed_at || null,
  };
}

function paperSummaryFor(row) {
  if (!row) {
    return {
      source: 'data/paper-trading/trades.jsonl',
      status: 'needs_more_data',
      totalTrades: 0,
      winRate: null,
      avgPnl: null,
      totalPnl: null,
      lastTested: null,
    };
  }
  return {
    ...row,
    status: row.totalTrades >= 10 ? 'available' : 'needs_more_data',
  };
}

function classifyEvidence(sim, paper) {
  const paperEnough = paper.totalTrades >= 10;
  const simEnough = sim.trades >= 30 || sim.runs >= 3;
  const evidenceTrades = (paper.totalTrades || 0) + (sim.trades || 0);
  const bestWinRate = Math.max(Number(paper.winRate) || 0, Number(sim.winRate) || 0);
  const bestAvg = Math.max(Number(paper.avgPnl) || -Infinity, Number(sim.avgPnl) || -Infinity);
  const weakPaper = paperEnough && ((Number(paper.winRate) || 0) < 45 || (Number(paper.avgPnl) || 0) < 0);
  const weakSim = simEnough && ((Number(sim.winRate) || 0) < 45 || (Number(sim.avgPnl) || 0) < 0);
  return {
    needsMoreData: evidenceTrades < 30 && !paperEnough && !simEnough,
    strongCandidate: (paperEnough || simEnough) && bestWinRate >= 55 && bestAvg >= 0,
    weakCandidate: weakPaper || weakSim,
  };
}

function classifyStrategy({ strategy, runtime, scannerEnabled, paperRuntimeStatus, catalogPaperSupported, simulationSummary, paperSummary, blockers }) {
  const catalogPaused = strategy.status === 'paused' || strategy.catalog_status === 'paused';
  const runtimeBlocked = ['disabled', 'paused', 'not_connected', 'no_entry_rule'].includes(paperRuntimeStatus);
  const runtimePartial = paperRuntimeStatus === 'partial';
  const canCreatePaper = runtime.can_create_paper_trade === true;
  const evidence = classifyEvidence(simulationSummary, paperSummary);

  let automaticStatus = 'manualOnly';
  if (catalogPaused || runtimeBlocked) automaticStatus = 'pausedOrBlocked';
  else if (scannerEnabled && paperRuntimeStatus === 'active' && catalogPaperSupported && canCreatePaper) automaticStatus = 'fullyAutomatic';
  else if (scannerEnabled || runtimePartial || blockers.some((b) => String(b).startsWith('missing_data:'))) automaticStatus = 'partlyAutomatic';

  if (automaticStatus === 'fullyAutomatic' && evidence.needsMoreData) {
    automaticStatus = 'partlyAutomatic';
  }

  return {
    automaticStatus,
    needsMoreData: evidence.needsMoreData,
    strongCandidate: evidence.strongCandidate,
    weakCandidate: evidence.weakCandidate || automaticStatus === 'pausedOrBlocked',
  };
}

function recommendationFor(row) {
  if (row.automaticStatus === 'pausedOrBlocked') return 'do_not_automate_yet';
  if (row.weakCandidate) return 'reduce_priority_or_review';
  if (row.strongCandidate && row.automaticStatus === 'fullyAutomatic') return 'safe_to_monitor_more_closely_in_paper_only';
  if (row.strongCandidate) return 'good_candidate_for_more_manual_replay_or_batch';
  if (row.needsMoreData) return 'collect_more_paper_replay_data';
  if (row.automaticStatus === 'manualOnly') return 'manual_lab_replay_batch_only';
  return 'monitor_in_paper_only';
}

function getStrategyRuntimeMatrix() {
  const catalog = catalogService.getCatalog();
  const strategies = Array.isArray(catalog.strategies) ? catalog.strategies : [];
  const runtimeRows = runtimeByStrategy();
  const performanceRows = performanceByStrategy();
  const paperRows = buildPaperStats();
  const batchAutopilot = batchAutopilotService.getStatus();
  const replayAutopilot = replayAutopilotService.getStatus();

  const rows = strategies.map((strategy) => {
    const runtime = runtimeRows.get(strategy.id) || runtimeConnector.getRuntimeStatusForStrategy(strategy.id) || {};
    const paperRuntimeStatus = runtime.runtime_status || 'unknown';
    const scannerEnabled = strategy.supportsScanner === true || strategy.scanner === true || strategy.scanner_enabled === true;
    const catalogPaperSupported = strategy.supportsPaper !== false && strategy.paper_only === true;
    const replayEnabled = strategy.supportsReplay === true || strategy.replay_enabled === true;
    const batchEnabled = strategy.supportsBatch === true || strategy.batch_enabled === true;
    const learningEnabled = strategy.supportsLearning !== false;
    const requiredData = getRequiredData(strategy, runtime);
    const blockers = getBlockers(strategy, runtime, scannerEnabled);
    const simulationSummary = simulationSummaryFor(performanceRows.get(strategy.id));
    const paperSummary = paperSummaryFor(paperRows.get(strategy.id));
    const resultSummary = {
      status: simulationSummary.status === 'available' || paperSummary.status === 'available' ? 'available' : 'needs_more_data',
      simulation: simulationSummary.status,
      paper: paperSummary.status,
    };
    const lastTested = [paperSummary.lastTested, simulationSummary.lastTested]
      .filter(Boolean)
      .sort()
      .pop() || null;
    const classification = classifyStrategy({
      strategy,
      runtime,
      scannerEnabled,
      paperRuntimeStatus,
      catalogPaperSupported,
      simulationSummary,
      paperSummary,
      blockers,
    });
    const row = {
      id: strategy.id,
      name: strategy.name || strategy.strategy_name || strategy.id,
      catalogStatus: strategy.status || strategy.catalog_status || 'unknown',
      market: strategy.market || strategy.market_group || 'unknown',
      scannerEnabled,
      catalogPaperSupported,
      paperRuntimeStatus,
      replayEnabled,
      batchEnabled,
      learningEnabled,
      automaticStatus: classification.automaticStatus,
      manualLabTestSupported: true,
      requiredData: requiredData.length ? requiredData : ['not_exposed_yet'],
      blockers: blockers.length ? blockers : [],
      resultSummary,
      paperSummary,
      simulationSummary,
      lastTested: lastTested || 'unknown',
      needsMoreData: classification.needsMoreData,
      strongCandidate: classification.strongCandidate,
      weakCandidate: classification.weakCandidate,
      recommendation: null,
    };
    row.recommendation = recommendationFor(row);
    return row;
  });

  const summary = {
    total: rows.length,
    fullyAutomatic: rows.filter((row) => row.automaticStatus === 'fullyAutomatic').length,
    partlyAutomatic: rows.filter((row) => row.automaticStatus === 'partlyAutomatic').length,
    manualOnly: rows.filter((row) => row.automaticStatus === 'manualOnly').length,
    pausedOrBlocked: rows.filter((row) => row.automaticStatus === 'pausedOrBlocked').length,
    needsMoreData: rows.filter((row) => row.needsMoreData).length,
    strongCandidates: rows.filter((row) => row.strongCandidate).length,
    weakCandidates: rows.filter((row) => row.weakCandidate).length,
  };

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    strategies: rows,
    summary,
    automation: {
      scanner: {
        stocks_interval_seconds: 30,
        crypto_interval_seconds: 30,
        source: 'scanner schedulers',
      },
      batchAutopilot: {
        enabled: batchAutopilot.config?.enabled === true,
        dryRunOnly: batchAutopilot.safety?.dry_run_only !== false,
        status: batchAutopilot.status || 'unknown',
      },
      replayAutopilot: {
        enabled: replayAutopilot.config?.enabled === true,
        dryRunOnly: replayAutopilot.safety?.dry_run_only !== false,
        status: replayAutopilot.status || 'unknown',
      },
    },
    safety: SAFETY,
  };
}

module.exports = {
  SAFETY,
  getStrategyRuntimeMatrix,
};
