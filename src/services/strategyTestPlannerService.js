'use strict';

const strategyRegistry = require('./strategyRegistryService');
const strategyScore = require('./strategyScoreService');
const strategyHistory = require('./strategyHistoryService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  mode: 'paper_only',
});

function safeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSource(value) {
  return safeString(value).toLowerCase() || 'internal';
}

function normalizeStatus(value) {
  return safeString(value).toLowerCase() || 'paper_only';
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function buildScope(testType, context) {
  const { source, sampleSize, paper, replay, batch } = context;
  if (testType === 'replay') {
    if (source === 'tradingview') return 'Liten TradingView-kontrollerad replay: få symboler och kort tidsfönster.';
    if (paper === 0) return 'Kort replay-scope: samla första evidence utan att öka bredden.';
    return 'Replay över senaste relevanta signaler med smal symbol- och tidsram.';
  }
  if (testType === 'batch') {
    if (source === 'tradingview') return 'Smalt TradingView-batch: 3-5 symboler och 1-2 timeframe-varianter.';
    return 'Smalt batch-scope med få symboler och få parameterkombinationer.';
  }
  if (testType === 'paper_observation') {
    return 'Fortsätt paper-observation och samla mer verklig trade-historik.';
  }
  return 'Granska registry, score, history och learning-notes utan att starta nya tester.';
}

function expectedLearningValue(testType, context) {
  const { sampleSize, source } = context;
  if (testType === 'replay') {
    if (sampleSize === 0) return source === 'tradingview' ? 'Hög - ny extern strategi behöver första replay-underlaget.' : 'Hög - saknar replay-underlag.';
    return 'Hög - replay fyller tydliga datagap.';
  }
  if (testType === 'batch') {
    return 'Hög - batch jämför parametrar och marknadslägen.';
  }
  if (testType === 'paper_observation') {
    return 'Medel - mer paper-data behövs för att stabilisera score.';
  }
  return 'Medel - historisk granskning kan förklara varför strategin är pausad eller svag.';
}

function buildSafetyNote(testType) {
  if (testType === 'history_review') {
    return 'Read-only. Ingen körning startas och ingen state ändras.';
  }
  return 'Read-only. Rekommendationen startar inte testet automatiskt.';
}

function buildReason(context, testType) {
  const {
    strategy_id: strategyId,
    status,
    source,
    score,
    confidence,
    sampleSize,
    paper,
    replay,
    batch,
    weaknesses,
    recommendedAction,
  } = context;

  const parts = [];
  if (status === 'paused' || status === 'deprecated') {
    parts.push('Strategin är pausad/deprecated');
  } else if (source === 'tradingview') {
    parts.push('TradingView-strategi med begränsat underlag');
  } else if (sampleSize === 0) {
    parts.push('Saknar dataunderlag');
  } else if (paper > 0 && replay === 0) {
    parts.push('Har paper-data men saknar replay');
  } else if (replay > 0 && batch === 0) {
    parts.push('Har replay-data men saknar batch');
  } else if (confidence < 50 || weaknesses.length > 0) {
    parts.push('Låg confidence eller tydliga svagheter');
  } else {
    parts.push('Behöver fortsatt jämförelse och observation');
  }

  parts.push(`score=${score}`);
  parts.push(`confidence=${confidence}`);
  parts.push(`sample_size=${sampleSize}`);
  parts.push(`paper=${paper}`);
  parts.push(`replay=${replay}`);
  parts.push(`batch=${batch}`);

  if (recommendedAction) {
    parts.push(`recommended_action=${recommendedAction}`);
  }

  if (testType === 'history_review') {
    parts.push('rekommenderas endast för historisk granskning');
  }

  return `${strategyId}: ${parts.join(' · ')}`;
}

function buildPriority(context, testType) {
  const { status, source, sampleSize, paper, replay, batch, confidence } = context;
  if (status === 'paused' || status === 'deprecated') {
    return testType === 'replay' ? 80 : 90;
  }
  if (testType === 'replay') {
    if (source === 'tradingview') return 10;
    if (sampleSize === 0) return 12;
    if (paper > 0 && replay === 0) return 18;
    return 24;
  }
  if (testType === 'batch') {
    if (source === 'tradingview') return 22;
    if (replay > 0 && batch === 0) return 28;
    return 34;
  }
  if (testType === 'paper_observation') {
    return confidence < 40 ? 42 : 48;
  }
  return 70;
}

function determineRecommendation(context) {
  const { status, source, sampleSize, paper, replay, batch, confidence, weaknesses } = context;

  if (status === 'paused' || status === 'deprecated') {
    if (paper > 0 && replay === 0) {
      return { testType: 'replay', priority: buildPriority(context, 'replay') };
    }
    return { testType: 'history_review', priority: buildPriority(context, 'history_review') };
  }

  if (sampleSize === 0) {
    return { testType: 'replay', priority: buildPriority(context, 'replay') };
  }

  if (source === 'tradingview' && sampleSize < 10) {
    return { testType: replay === 0 ? 'replay' : 'batch', priority: buildPriority(context, replay === 0 ? 'replay' : 'batch') };
  }

  if (paper > 0 && replay === 0) {
    return { testType: 'replay', priority: buildPriority(context, 'replay') };
  }

  if (replay > 0 && batch === 0) {
    return { testType: 'batch', priority: buildPriority(context, 'batch') };
  }

  if (confidence < 50 || weaknesses.length > 0) {
    if (replay === 0) return { testType: 'replay', priority: buildPriority(context, 'replay') };
    if (batch === 0) return { testType: 'batch', priority: buildPriority(context, 'batch') };
    return { testType: 'paper_observation', priority: buildPriority(context, 'paper_observation') };
  }

  if (sampleSize < 20) {
    if (replay === 0) return { testType: 'replay', priority: buildPriority(context, 'replay') };
    if (batch === 0) return { testType: 'batch', priority: buildPriority(context, 'batch') };
    return { testType: 'paper_observation', priority: buildPriority(context, 'paper_observation') };
  }

  return null;
}

function createStrategyTestPlannerService(options = {}) {
  const registryService = options.registryService || strategyRegistry;
  const scoreService = options.scoreService || strategyScore.defaultStrategyScoreService;
  const historyService = options.historyService || strategyHistory.defaultStrategyHistoryService;

  function loadRegistryStrategies() {
    if (typeof registryService.listStrategies === 'function') {
      return registryService.listStrategies() || [];
    }
    return [];
  }

  function loadScores() {
    const status = typeof scoreService.getStrategyScores === 'function'
      ? scoreService.getStrategyScores()
      : { strategies: [] };
    return safeArray(status.strategies);
  }

  function buildContext(strategy, scoreRow, historyRow) {
    const historySummary = historyRow?.history_summary || {};
    const score = scoreRow || {};
    const source = normalizeSource(strategy?.source || score.source || historyRow?.registry?.source);
    const status = normalizeStatus(strategy?.status || score.status || historyRow?.registry?.status);
    const sampleSize = safeNumber(score.sample_size, 0);
    const paper = safeNumber(historySummary.paper_trades_count, 0);
    const replay = safeNumber(historySummary.replay_tests_count, 0);
    const batch = safeNumber(historySummary.batch_tests_count, 0);
    const confidence = safeNumber(score.confidence, 0);
    const weaknesses = safeArray(score.weaknesses);
    const recommendedAction = safeString(score.recommended_action);
    return {
      strategy_id: strategy?.strategy_id || score.strategy_id || historyRow?.strategy_id || null,
      source,
      status,
      enabled: strategy?.enabled !== false,
      score: safeNumber(score.score, 0),
      confidence,
      sampleSize,
      paper,
      replay,
      batch,
      weaknesses,
      recommendedAction,
      historySummary,
      historyRow,
      strategy,
      scoreRow: score,
    };
  }

  function buildRecommendation(context) {
    const recommendation = determineRecommendation(context);
    if (!recommendation) return null;
    const { testType, priority } = recommendation;
    return {
      id: `${context.strategy_id}:${testType}`,
      strategy_id: context.strategy_id,
      source: context.source,
      status: context.status,
      priority,
      test_type: testType,
      reason: buildReason(context, testType),
      suggested_scope: buildScope(testType, {
        source: context.source,
        sampleSize: context.sampleSize,
        paper: context.paper,
        replay: context.replay,
        batch: context.batch,
      }),
      expected_learning_value: expectedLearningValue(testType, {
        sampleSize: context.sampleSize,
        source: context.source,
      }),
      safety_note: buildSafetyNote(testType),
    };
  }

  function getTestPlannerStatus() {
    const strategies = loadRegistryStrategies();
    const scoreRows = loadScores();
    const scoreById = new Map(scoreRows.map((row) => [row.strategy_id, row]));
    const recommendations = [];
    let skippedPausedCount = 0;

    for (const strategy of strategies) {
      const scoreRow = scoreById.get(strategy.strategy_id) || null;
      const historyRow = typeof historyService.getStrategyHistory === 'function'
        ? historyService.getStrategyHistory(strategy.strategy_id)
        : null;
      const context = buildContext(strategy, scoreRow, historyRow);
      const isPausedLike = context.status === 'paused' || context.status === 'deprecated' || context.enabled === false;
      if (isPausedLike) skippedPausedCount += 1;
      const recommendation = buildRecommendation(context);
      if (!recommendation) continue;
      recommendations.push(recommendation);
    }

    recommendations.sort((a, b) => a.priority - b.priority || String(a.strategy_id).localeCompare(String(b.strategy_id)));

    const summary = {
      total_recommendations: recommendations.length,
      replay_recommendations: recommendations.filter((row) => row.test_type === 'replay').length,
      batch_recommendations: recommendations.filter((row) => row.test_type === 'batch').length,
      paper_observation_recommendations: recommendations.filter((row) => row.test_type === 'paper_observation').length,
      history_review_recommendations: recommendations.filter((row) => row.test_type === 'history_review').length,
      tradingview_recommendations: recommendations.filter((row) => row.source === 'tradingview').length,
      internal_recommendations: recommendations.filter((row) => row.source === 'internal').length,
      skipped_paused_count: skippedPausedCount,
    };

    return {
      ok: true,
      generated_at: new Date().toISOString(),
      planner_mode: 'read_only',
      recommendations,
      summary,
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    getTestPlannerStatus,
  };
}

const defaultStrategyTestPlannerService = createStrategyTestPlannerService();

module.exports = {
  SAFETY,
  createStrategyTestPlannerService,
  defaultStrategyTestPlannerService,
};
