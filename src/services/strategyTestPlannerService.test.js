'use strict';

const assert = require('assert/strict');

const { createStrategyTestPlannerService } = require('./strategyTestPlannerService');

function makeRegistry() {
  return {
    listStrategies() {
      return [
        {
          strategy_id: 'ACTIVE_NO_DATA',
          source: 'internal',
          status: 'active',
          enabled: true,
        },
        {
          strategy_id: 'ACTIVE_NEEDS_REPLAY',
          source: 'internal',
          status: 'active',
          enabled: true,
        },
        {
          strategy_id: 'ACTIVE_NEEDS_BATCH',
          source: 'internal',
          status: 'active',
          enabled: true,
        },
        {
          strategy_id: 'TV_LOW_DATA',
          source: 'tradingview',
          status: 'paper_only',
          enabled: true,
        },
        {
          strategy_id: 'PAUSED_WITH_HISTORY',
          source: 'internal',
          status: 'paused',
          enabled: false,
        },
        {
          strategy_id: 'DEPRECATED_TV',
          source: 'tradingview',
          status: 'deprecated',
          enabled: false,
        },
      ];
    },
  };
}

function makeScoreService() {
  const rows = [
    {
      strategy_id: 'ACTIVE_NO_DATA',
      source: 'internal',
      status: 'active',
      score: 41,
      confidence: 33,
      sample_size: 0,
      weaknesses: ['Inget mätbart underlag ännu'],
      recommended_action: 'Kör replay och batch-test innan fler paper entries.',
    },
    {
      strategy_id: 'ACTIVE_NEEDS_REPLAY',
      source: 'internal',
      status: 'active',
      score: 45,
      confidence: 42,
      sample_size: 5,
      weaknesses: ['Litet dataunderlag'],
      recommended_action: 'Kör replay/batch och samla mer paper-data.',
    },
    {
      strategy_id: 'ACTIVE_NEEDS_BATCH',
      source: 'internal',
      status: 'active',
      score: 53,
      confidence: 61,
      sample_size: 18,
      weaknesses: ['Behöver mer jämförelse'],
      recommended_action: 'Kör batch-test för att jämföra parametrar.',
    },
    {
      strategy_id: 'TV_LOW_DATA',
      source: 'tradingview',
      status: 'paper_only',
      score: 44,
      confidence: 31,
      sample_size: 3,
      weaknesses: ['Extern strategi med litet dataunderlag'],
      recommended_action: 'Kör replay/batch och samla mer data.',
    },
    {
      strategy_id: 'PAUSED_WITH_HISTORY',
      source: 'internal',
      status: 'paused',
      score: 27,
      confidence: 25,
      sample_size: 11,
      weaknesses: ['Pausad strategi'],
      recommended_action: 'Håll pausad/deprecated. Nya paper entries rekommenderas inte.',
    },
    {
      strategy_id: 'DEPRECATED_TV',
      source: 'tradingview',
      status: 'deprecated',
      score: 16,
      confidence: 12,
      sample_size: 0,
      weaknesses: ['Deprecated/arkiverad strategi'],
      recommended_action: 'Håll pausad/deprecated. Nya paper entries rekommenderas inte.',
    },
  ];

  return {
    getStrategyScores() {
      return {
        ok: true,
        strategies: rows,
      };
    },
  };
}

function makeHistoryService() {
  return {
    getStrategyHistory(strategyId) {
      const map = {
        ACTIVE_NO_DATA: {
          ok: true,
          strategy_id: 'ACTIVE_NO_DATA',
          history_summary: {
            paper_trades_count: 0,
            replay_tests_count: 0,
            batch_tests_count: 0,
          },
        },
        ACTIVE_NEEDS_REPLAY: {
          ok: true,
          strategy_id: 'ACTIVE_NEEDS_REPLAY',
          history_summary: {
            paper_trades_count: 2,
            replay_tests_count: 0,
            batch_tests_count: 0,
          },
        },
        ACTIVE_NEEDS_BATCH: {
          ok: true,
          strategy_id: 'ACTIVE_NEEDS_BATCH',
          history_summary: {
            paper_trades_count: 2,
            replay_tests_count: 2,
            batch_tests_count: 0,
          },
        },
        TV_LOW_DATA: {
          ok: true,
          strategy_id: 'TV_LOW_DATA',
          history_summary: {
            paper_trades_count: 1,
            replay_tests_count: 0,
            batch_tests_count: 0,
          },
        },
        PAUSED_WITH_HISTORY: {
          ok: true,
          strategy_id: 'PAUSED_WITH_HISTORY',
          history_summary: {
            paper_trades_count: 1,
            replay_tests_count: 1,
            batch_tests_count: 0,
          },
        },
        DEPRECATED_TV: {
          ok: true,
          strategy_id: 'DEPRECATED_TV',
          history_summary: {
            paper_trades_count: 0,
            replay_tests_count: 0,
            batch_tests_count: 0,
          },
        },
      };
      return map[strategyId] || {
        ok: true,
        strategy_id: strategyId,
        history_summary: {
          paper_trades_count: 0,
          replay_tests_count: 0,
          batch_tests_count: 0,
        },
      };
    },
  };
}

{
  const planner = createStrategyTestPlannerService({
    registryService: makeRegistry(),
    scoreService: makeScoreService(),
    historyService: makeHistoryService(),
  });

  const status = planner.getTestPlannerStatus();

  assert.equal(status.ok, true, 'planner ok');
  assert.equal(status.planner_mode, 'read_only', 'planner mode');
  assert.equal(status.safety.actions_allowed, false, 'safety actions_allowed');
  assert.equal(status.safety.can_place_orders, false, 'safety can_place_orders');
  assert.equal(status.safety.live_trading_enabled, false, 'safety live');
  assert.equal(status.safety.broker_enabled, false, 'safety broker');
  assert.equal(status.safety.mode, 'paper_only', 'safety mode');

  assert.ok(Array.isArray(status.recommendations), 'recommendations array');
  assert.ok(status.recommendations.length >= 4, 'recommendations exist');
  assert.equal(status.summary.total_recommendations, status.recommendations.length, 'summary count matches');
  assert.equal(status.summary.replay_recommendations >= 2, true, 'replay recommendations present');
  assert.equal(status.summary.batch_recommendations >= 1, true, 'batch recommendations present');
  assert.equal(status.summary.tradingview_recommendations >= 1, true, 'tv recommendations present');
  assert.equal(status.summary.internal_recommendations >= 2, true, 'internal recommendations present');
  assert.equal(status.summary.skipped_paused_count, 2, 'paused/deprecated skipped count');

  const activeNoData = status.recommendations.find((row) => row.strategy_id === 'ACTIVE_NO_DATA');
  assert.ok(activeNoData, 'active no data recommendation');
  assert.equal(activeNoData.test_type, 'replay', 'active no data replay');
  assert.ok(activeNoData.reason.includes('Saknar dataunderlag'), 'active no data reason');
  assert.ok(activeNoData.suggested_scope.length > 0, 'active no data scope');
  assert.ok(activeNoData.expected_learning_value.includes('Hög'), 'active no data learning value');

  const tvLowData = status.recommendations.find((row) => row.strategy_id === 'TV_LOW_DATA');
  assert.ok(tvLowData, 'tv low data recommendation');
  assert.equal(tvLowData.source, 'tradingview', 'tv low data source');
  assert.equal(tvLowData.test_type, 'replay', 'tv low data replay');
  assert.ok(tvLowData.suggested_scope.toLowerCase().includes('tradingview'), 'tv low data scope');

  const needsBatch = status.recommendations.find((row) => row.strategy_id === 'ACTIVE_NEEDS_BATCH');
  assert.ok(needsBatch, 'batch recommendation exists');
  assert.equal(needsBatch.test_type, 'batch', 'needs batch test type');
  assert.ok(needsBatch.reason.includes('saknar batch') || needsBatch.reason.includes('saknar batch-historik') || needsBatch.reason.includes('batch'), 'needs batch reason');

  const paused = status.recommendations.find((row) => row.strategy_id === 'PAUSED_WITH_HISTORY');
  assert.ok(paused, 'paused recommendation exists');
  assert.ok(['replay', 'history_review'].includes(paused.test_type), 'paused test type safe');
  assert.ok(paused.safety_note.includes('Read-only'), 'paused safety note');

  const deprecated = status.recommendations.find((row) => row.strategy_id === 'DEPRECATED_TV');
  assert.ok(deprecated, 'deprecated recommendation exists');
  assert.equal(deprecated.test_type, 'history_review', 'deprecated history review');
  assert.ok(deprecated.reason.includes('deprecated') || deprecated.reason.includes('Pausad'), 'deprecated reason');
}

console.log('Strategy test planner tests passed.');
