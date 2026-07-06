'use strict';

/**
 * Strategy Evolution Service
 *
 * Read-only data model for the AI research loop. It reads strategy-version
 * research state from data/research/strategy-evolution.json and never starts
 * tests, writes files, touches broker/order paths or changes runtime risk.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_FILE = path.resolve(__dirname, '../../data/research/strategy-evolution.json');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const TARGET_SCORE = Object.freeze({
  min: 70,
  ideal: 80,
  type: 'ai_score',
  scale: '0-100',
});

const VERSION_STATUSES = Object.freeze(new Set([
  'draft',
  'waiting_for_test',
  'testing',
  'tested',
  'needs_improvement',
  'promising',
  'promoted_to_replay',
  'rejected',
]));

const VERSION_DECISIONS = Object.freeze(new Set([
  'improve',
  'retest',
  'promising',
  'reject',
  'promote_to_replay',
]));

function text(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

function bool(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampScore(value) {
  const n = numberOrNull(value);
  if (n === null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeStatus(value, fallback = 'draft') {
  const normalized = text(value, fallback).toLowerCase();
  return VERSION_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeDecision(value) {
  const normalized = text(value, '').toLowerCase();
  return VERSION_DECISIONS.has(normalized) ? normalized : null;
}

function normalizeTestResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    netProfitPct: numberOrNull(value.netProfitPct),
    profitFactor: numberOrNull(value.profitFactor),
    winRate: numberOrNull(value.winRate),
    maxDrawdownPct: numberOrNull(value.maxDrawdownPct),
    trades: numberOrNull(value.trades),
    avgTradePct: numberOrNull(value.avgTradePct),
    bestTradePct: numberOrNull(value.bestTradePct),
    worstTradePct: numberOrNull(value.worstTradePct),
  };
}

function normalizeVersion(row = {}, index = 0) {
  const testResult = normalizeTestResult(row.testResult);
  const status = normalizeStatus(row.status, testResult ? 'tested' : 'draft');
  const aiScore = clampScore(row.aiScore);
  return {
    version: numberOrNull(row.version) || index + 1,
    status,
    source: text(row.source, 'unknown'),
    pineScriptPossible: bool(row.pineScriptPossible, false),
    createdAt: text(row.createdAt, null),
    changeSummary: text(row.changeSummary, ''),
    hypothesis: text(row.hypothesis, ''),
    testResult,
    aiScore,
    scoreBand: scoreBand(aiScore),
    decision: normalizeDecision(row.decision),
    nextImprovement: text(row.nextImprovement, ''),
  };
}

function normalizeStrategy(row = {}, index = 0) {
  const strategyId = text(row.strategyId || row.strategy_id || row.id, `strategy_${index + 1}`);
  const versions = Array.isArray(row.versions)
    ? row.versions.map((version, versionIndex) => normalizeVersion(version, versionIndex))
    : [];
  return {
    strategyId,
    name: text(row.name, strategyId),
    versions,
  };
}

function scoreBand(score) {
  if (score === null || score === undefined) return 'unscored';
  if (score >= 80) return 'strong_candidate';
  if (score >= 70) return 'promising';
  if (score >= 60) return 'watchlist';
  if (score >= 40) return 'needs_improvement';
  return 'weak';
}

function extractItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.items)) return parsed.items;
    if (Array.isArray(parsed.strategies)) return parsed.strategies;
  }
  return null;
}

function buildSummary(items) {
  const summary = {
    totalStrategies: items.length,
    totalVersions: 0,
    promisingCount: 0,
    strongCandidateCount: 0,
    needsImprovementCount: 0,
    waitingForTestCount: 0,
    byStatus: {},
    byDecision: {},
  };

  for (const item of items) {
    for (const version of item.versions) {
      summary.totalVersions += 1;
      summary.byStatus[version.status] = (summary.byStatus[version.status] || 0) + 1;
      if (version.decision) summary.byDecision[version.decision] = (summary.byDecision[version.decision] || 0) + 1;

      if (version.aiScore >= 80 || version.scoreBand === 'strong_candidate') summary.strongCandidateCount += 1;
      if (version.aiScore >= 70 || version.status === 'promising' || version.decision === 'promising') summary.promisingCount += 1;
      if (version.status === 'needs_improvement' || version.decision === 'improve' || version.scoreBand === 'needs_improvement' || version.scoreBand === 'weak') {
        summary.needsImprovementCount += 1;
      }
      if (version.status === 'waiting_for_test' || !version.testResult) summary.waitingForTestCount += 1;
    }
  }

  return summary;
}

function emptyResult({ dataFile = DEFAULT_DATA_FILE, status = 'empty', error = null, warnings = [] } = {}) {
  return {
    ok: status !== 'error',
    source: 'strategyEvolutionService',
    status,
    dataFile,
    targetScore: TARGET_SCORE,
    safety: SAFETY,
    items: [],
    summary: buildSummary([]),
    warnings,
    error,
  };
}

function createStrategyEvolutionService(options = {}) {
  const dataFile = options.dataFile || DEFAULT_DATA_FILE;

  function readStrategyEvolution() {
    if (!fs.existsSync(dataFile)) {
      return emptyResult({
        dataFile,
        status: 'empty',
        warnings: ['strategy_evolution_file_missing'],
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    } catch (err) {
      return emptyResult({
        dataFile,
        status: 'error',
        error: `invalid_strategy_evolution_json: ${err.message}`,
      });
    }

    const rawItems = extractItems(parsed);
    if (!rawItems) {
      return emptyResult({
        dataFile,
        status: 'degraded',
        warnings: ['strategy_evolution_shape_not_supported'],
      });
    }

    const items = rawItems
      .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
      .map((row, index) => normalizeStrategy(row, index));

    return {
      ok: true,
      source: 'strategyEvolutionService',
      status: items.length ? 'ok' : 'empty',
      dataFile,
      targetScore: TARGET_SCORE,
      safety: SAFETY,
      items,
      summary: buildSummary(items),
      warnings: rawItems.length !== items.length ? ['strategy_evolution_rows_skipped'] : [],
      error: null,
    };
  }

  return {
    dataFile,
    readStrategyEvolution,
  };
}

const defaultStrategyEvolutionService = createStrategyEvolutionService();

module.exports = {
  DEFAULT_DATA_FILE,
  SAFETY,
  TARGET_SCORE,
  VERSION_STATUSES,
  VERSION_DECISIONS,
  normalizeTestResult,
  normalizeVersion,
  normalizeStrategy,
  scoreBand,
  buildSummary,
  createStrategyEvolutionService,
  defaultStrategyEvolutionService,
};
