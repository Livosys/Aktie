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
const researchScoreService = require('./researchScoreService');
const { buildImprovementRecommendation } = require('./strategyImprovementRecommendationService');

const DEFAULT_DATA_FILE = path.resolve(__dirname, '../../data/research/strategy-evolution.json');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const SAFE_RECOMMENDATION = Object.freeze({
  recommendedAction: 'wait_for_test',
  priority: 'medium',
  reason: 'No recommendation available yet.',
  weaknesses: [],
  suggestedChanges: [],
  nextTestPlan: Object.freeze({
    type: 'replay',
    dryRun: true,
    execution: false,
    broker: false,
    orders: false,
  }),
  confidence: 0,
  blockedReason: 'recommendation_unavailable',
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
    stabilityAcrossSymbols: numberOrNull(value.stabilityAcrossSymbols),
    stabilityAcrossTimeframes: numberOrNull(value.stabilityAcrossTimeframes),
    stabilityAcrossPeriods: numberOrNull(value.stabilityAcrossPeriods),
    dataQuality: numberOrNull(value.dataQuality),
  };
}

function normalizeScoreDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const components = value.components && typeof value.components === 'object' && !Array.isArray(value.components)
    ? {
        profitFactor: numberOrNull(value.components.profitFactor),
        drawdown: numberOrNull(value.components.drawdown),
        winRate: numberOrNull(value.components.winRate),
        sampleSize: numberOrNull(value.components.sampleSize),
        stability: numberOrNull(value.components.stability),
        riskReward: numberOrNull(value.components.riskReward),
        dataQuality: numberOrNull(value.components.dataQuality),
      }
    : null;
  return {
    reasons: Array.isArray(value.reasons) ? value.reasons.map((entry) => text(entry, '')).filter(Boolean) : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.map((entry) => text(entry, '')).filter(Boolean) : [],
    components,
  };
}

function textArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => text(entry, '')).filter(Boolean);
}

function firstText(value) {
  if (Array.isArray(value)) {
    return text(value.find((entry) => text(entry, '')), '');
  }
  return text(value, '');
}

function mergeMetadata(...values) {
  const merged = {};
  let hasAny = false;
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    Object.assign(merged, value);
    hasAny = true;
  }
  return hasAny ? merged : null;
}

function normalizeRecommendation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return SAFE_RECOMMENDATION;
  const nextTestPlan = value.nextTestPlan && typeof value.nextTestPlan === 'object' && !Array.isArray(value.nextTestPlan)
    ? {
        type: text(value.nextTestPlan.type, 'replay'),
        dryRun: bool(value.nextTestPlan.dryRun, true),
        execution: bool(value.nextTestPlan.execution, false),
        broker: bool(value.nextTestPlan.broker, false),
        orders: bool(value.nextTestPlan.orders, false),
        symbols: textArray(value.nextTestPlan.symbols),
        timeframes: textArray(value.nextTestPlan.timeframes),
        lookbackDays: numberOrNull(value.nextTestPlan.lookbackDays) || 180,
        reason: text(value.nextTestPlan.reason, ''),
      }
    : SAFE_RECOMMENDATION.nextTestPlan;

  const suggestedChanges = Array.isArray(value.suggestedChanges)
    ? value.suggestedChanges
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => ({
        type: text(entry.type, ''),
        name: text(entry.name, ''),
        why: text(entry.why, ''),
      }))
      .filter((entry) => entry.type || entry.name || entry.why)
    : [];

  return {
    recommendedAction: text(value.recommendedAction, SAFE_RECOMMENDATION.recommendedAction),
    priority: text(value.priority, SAFE_RECOMMENDATION.priority),
    reason: text(value.reason, SAFE_RECOMMENDATION.reason),
    weaknesses: textArray(value.weaknesses),
    suggestedChanges,
    nextTestPlan,
    confidence: numberOrNull(value.confidence) ?? 0,
    blockedReason: value.blockedReason ? text(value.blockedReason, null) : null,
  };
}

function buildRecommendation(row = {}, version = {}, normalizedVersion = {}) {
  const recommendationInput = {
    strategyId: row.strategyId || row.strategy_id || row.id || null,
    name: row.name || null,
    direction: firstText(version.direction || row.direction || normalizedVersion.direction || null),
    timeframe: firstText(version.timeframe || version.timeframes || row.timeframe || row.timeframes || null),
    symbols: Array.isArray(version.symbols)
      ? version.symbols
      : (Array.isArray(row.symbols) ? row.symbols : (version.symbol ? [version.symbol] : (row.symbol ? [row.symbol] : []))),
    version: normalizedVersion.version,
    status: normalizedVersion.status,
    decision: normalizedVersion.decision || normalizeDecision(version.decision || row.decision),
    aiScore: normalizedVersion.aiScore,
    band: normalizedVersion.band,
    scoreDetails: normalizedVersion.scoreDetails,
    testResult: normalizedVersion.testResult,
    metadata: mergeMetadata(row.metadata, version.metadata, row.meta, version.meta),
  };

  try {
    return normalizeRecommendation(buildImprovementRecommendation(recommendationInput));
  } catch (err) {
    return SAFE_RECOMMENDATION;
  }
}

function computeScoreDetails(testResult, context = {}) {
  const computed = researchScoreService.calculateResearchScore({
    strategyId: context.strategyId || null,
    version: context.version || null,
    testResult,
  });
  return {
    aiScore: computed.score,
    band: computed.band,
    scoreBand: computed.band,
    scoreDetails: {
      reasons: Array.isArray(computed.reasons) ? computed.reasons : [],
      warnings: Array.isArray(computed.warnings) ? computed.warnings : [],
      components: computed.components || null,
    },
  };
}

function normalizeVersion(row = {}, index = 0, strategyContext = {}) {
  const testResult = normalizeTestResult(row.testResult);
  const hasTestResult = Boolean(testResult);
  const status = hasTestResult ? normalizeStatus(row.status, 'tested') : 'waiting_for_test';
  const versionNumber = numberOrNull(row.version) || index + 1;
  const existingAiScore = clampScore(row.aiScore);
  const scoreDetails = normalizeScoreDetails(row.scoreDetails);
  const computedScore = existingAiScore === null && hasTestResult
    ? computeScoreDetails(testResult, { strategyId: row.strategyId || row.strategy_id || row.id, version: versionNumber })
    : null;
  const aiScore = existingAiScore !== null ? existingAiScore : computedScore?.aiScore ?? null;
  const band = text(row.band || row.scoreBand, '') || (aiScore !== null ? scoreBand(aiScore) : null);
  const normalizedVersion = {
    version: versionNumber,
    status,
    source: text(row.source, 'unknown'),
    pineScriptPossible: bool(row.pineScriptPossible, false),
    createdAt: text(row.createdAt, null),
    changeSummary: text(row.changeSummary, ''),
    hypothesis: text(row.hypothesis, ''),
    testResult,
    aiScore,
    band,
    scoreBand: band,
    scoreDetails: existingAiScore !== null ? scoreDetails : (computedScore?.scoreDetails || scoreDetails),
    decision: normalizeDecision(row.decision),
    nextImprovement: text(row.nextImprovement, ''),
  };
  return {
    ...normalizedVersion,
    recommendation: buildRecommendation(strategyContext, row, normalizedVersion),
  };
}

function normalizeStrategy(row = {}, index = 0) {
  const strategyId = text(row.strategyId || row.strategy_id || row.id, `strategy_${index + 1}`);
  const versions = Array.isArray(row.versions)
    ? row.versions.map((version, versionIndex) => normalizeVersion(version, versionIndex, row))
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
    recommendationSummary: {
      improveCount: 0,
      retestCount: 0,
      collectMoreDataCount: 0,
      promoteCandidateCount: 0,
      rejectCount: 0,
      waitForTestCount: 0,
    },
    byStatus: {},
    byDecision: {},
  };

  for (const item of items) {
    for (const version of item.versions) {
      summary.totalVersions += 1;
      summary.byStatus[version.status] = (summary.byStatus[version.status] || 0) + 1;
      if (version.decision) summary.byDecision[version.decision] = (summary.byDecision[version.decision] || 0) + 1;

      const band = version.band || version.scoreBand;
      if (version.aiScore >= 80 || band === 'strong_candidate') summary.strongCandidateCount += 1;
      if (version.aiScore >= 70 || version.status === 'promising' || version.decision === 'promising' || band === 'promising') summary.promisingCount += 1;
      if (version.status === 'needs_improvement' || version.decision === 'improve' || band === 'needs_improvement' || band === 'weak') {
        summary.needsImprovementCount += 1;
      }
      if (version.status === 'waiting_for_test' || !version.testResult) summary.waitingForTestCount += 1;

      const recommendationAction = version.recommendation && version.recommendation.recommendedAction;
      if (recommendationAction === 'improve') summary.recommendationSummary.improveCount += 1;
      if (recommendationAction === 'retest') summary.recommendationSummary.retestCount += 1;
      if (recommendationAction === 'collect_more_data') summary.recommendationSummary.collectMoreDataCount += 1;
      if (recommendationAction === 'promote_candidate') summary.recommendationSummary.promoteCandidateCount += 1;
      if (recommendationAction === 'reject') summary.recommendationSummary.rejectCount += 1;
      if (recommendationAction === 'wait_for_test') summary.recommendationSummary.waitForTestCount += 1;
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
  normalizeScoreDetails,
  normalizeVersion,
  normalizeStrategy,
  scoreBand,
  buildSummary,
  computeScoreDetails,
  createStrategyEvolutionService,
  defaultStrategyEvolutionService,
};
