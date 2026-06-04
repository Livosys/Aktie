'use strict';

const assert = require('assert/strict');

const { createManualTestPlanPreviewService } = require('./manualTestPlanPreviewService');

function makeServices() {
  const queueItems = new Map([
    ['replay-1', {
      id: 'replay-1',
      status: 'pending',
      source: 'planner',
      strategy_id: 'TV_PREVIEW_REPLAY',
      test_type: 'replay',
      priority: 10,
      reason: 'Replay reason',
      suggested_scope: 'Replay scope',
      expected_learning_value: 'Replay learning',
      safety_note: 'Queue only',
      created_at: '2026-06-04T10:00:00.000Z',
    }],
    ['batch-1', {
      id: 'batch-1',
      status: 'pending',
      source: 'planner',
      strategy_id: 'INT_PREVIEW_BATCH',
      test_type: 'batch',
      priority: 20,
      reason: 'Batch reason',
      suggested_scope: 'Batch scope',
      expected_learning_value: 'Batch learning',
      safety_note: 'Queue only',
      created_at: '2026-06-04T10:10:00.000Z',
    }],
    ['history-1', {
      id: 'history-1',
      status: 'cancelled',
      source: 'planner',
      strategy_id: 'INT_PREVIEW_HISTORY',
      test_type: 'history_review',
      priority: 30,
      reason: 'History reason',
      suggested_scope: 'History scope',
      expected_learning_value: 'History learning',
      safety_note: 'Queue only',
      created_at: '2026-06-04T10:20:00.000Z',
    }],
    ['paper-1', {
      id: 'paper-1',
      status: 'completed',
      source: 'tradingview',
      strategy_id: 'TV_PREVIEW_PAPER',
      test_type: 'paper_observation',
      priority: 40,
      reason: 'Paper reason',
      suggested_scope: 'Paper scope',
      expected_learning_value: 'Paper learning',
      safety_note: 'Queue only',
      created_at: '2026-06-04T10:30:00.000Z',
    }],
    ['failed-1', {
      id: 'failed-1',
      status: 'failed',
      source: 'planner',
      strategy_id: 'INT_PREVIEW_FAILED',
      test_type: 'history_review',
      priority: 50,
      reason: 'Failed reason',
      suggested_scope: 'Failed scope',
      expected_learning_value: 'Failed learning',
      safety_note: 'Queue only',
      created_at: '2026-06-04T10:40:00.000Z',
    }],
  ]);

  const histories = {
    TV_PREVIEW_REPLAY: {
      ok: true,
      strategy_id: 'TV_PREVIEW_REPLAY',
      registry: { source: 'tradingview', status: 'paper_only', mode: 'paper_only' },
      score: { score: 44, confidence: 34, sample_size: 1, strengths: ['S1'], weaknesses: ['W1'], recommended_action: 'Kör replay' },
      history_summary: {
        paper_trades_count: 1,
        replay_tests_count: 0,
        batch_tests_count: 0,
        learning_events_count: 0,
        missing_data: {
          paper_trades: false,
          replay_tests: true,
          batch_tests: true,
          learning_events: true,
          recent_events: true,
        },
      },
    },
    INT_PREVIEW_BATCH: {
      ok: true,
      strategy_id: 'INT_PREVIEW_BATCH',
      registry: { source: 'internal', status: 'paper_only', mode: 'paper_only' },
      score: { score: 61, confidence: 52, sample_size: 12, strengths: ['S2'], weaknesses: ['W2'], recommended_action: 'Kör batch' },
      history_summary: {
        paper_trades_count: 3,
        replay_tests_count: 1,
        batch_tests_count: 0,
        learning_events_count: 2,
        missing_data: {
          paper_trades: false,
          replay_tests: false,
          batch_tests: true,
          learning_events: false,
          recent_events: false,
        },
      },
    },
    INT_PREVIEW_HISTORY: {
      ok: true,
      strategy_id: 'INT_PREVIEW_HISTORY',
      registry: { source: 'internal', status: 'paused', mode: 'paper_only' },
      score: { score: 35, confidence: 22, sample_size: 4, strengths: [], weaknesses: ['Paused'], recommended_action: 'Håll pausad' },
      history_summary: {
        paper_trades_count: 0,
        replay_tests_count: 0,
        batch_tests_count: 0,
        learning_events_count: 1,
        missing_data: {
          paper_trades: true,
          replay_tests: true,
          batch_tests: true,
          learning_events: false,
          recent_events: false,
        },
      },
    },
    TV_PREVIEW_PAPER: {
      ok: true,
      strategy_id: 'TV_PREVIEW_PAPER',
      registry: { source: 'tradingview', status: 'paper_only', mode: 'paper_only' },
      score: { score: 55, confidence: 47, sample_size: 8, strengths: ['S3'], weaknesses: ['W3'], recommended_action: 'Fortsätt paper' },
      history_summary: {
        paper_trades_count: 5,
        replay_tests_count: 2,
        batch_tests_count: 1,
        learning_events_count: 2,
        missing_data: {
          paper_trades: false,
          replay_tests: false,
          batch_tests: false,
          learning_events: false,
          recent_events: false,
        },
      },
    },
    INT_PREVIEW_FAILED: {
      ok: true,
      strategy_id: 'INT_PREVIEW_FAILED',
      registry: { source: 'internal', status: 'failed', mode: 'paper_only' },
      score: { score: 12, confidence: 10, sample_size: 0, strengths: [], weaknesses: ['Failed'], recommended_action: 'Titta igen' },
      history_summary: {
        paper_trades_count: 0,
        replay_tests_count: 0,
        batch_tests_count: 0,
        learning_events_count: 0,
        missing_data: {
          paper_trades: true,
          replay_tests: true,
          batch_tests: true,
          learning_events: true,
          recent_events: true,
        },
      },
    },
  };

  return createManualTestPlanPreviewService({
    queueService: {
      getQueueItem(id) {
        return queueItems.get(id) || null;
      },
    },
    historyService: {
      getStrategyHistory(strategyId) {
        return histories[strategyId] || { ok: false, error: 'unknown_strategy_id' };
      },
    },
    scoreService: {
      getStrategyScore(strategyId) {
        const result = histories[strategyId];
        return result
          ? { ok: true, strategy: result.score, ...result.safety }
          : { ok: false, error: 'strategy_not_found', ...result?.safety };
      },
    },
    registryService: {
      getStrategy(strategyId) {
        const result = histories[strategyId];
        return result ? result.registry : null;
      },
    },
  });
}

const preview = makeServices();

{
  const result = preview.getTestPlanPreview('replay-1');
  assert.equal(result.ok, true, 'replay preview ok');
  assert.equal(result.queue_item.strategy_id, 'TV_PREVIEW_REPLAY', 'replay queue item');
  assert.equal(result.strategy_context.source, 'tradingview', 'replay source');
  assert.equal(result.strategy_context.status, 'paper_only', 'replay status');
  assert.equal(result.plan_preview.test_type, 'replay', 'replay test type');
  assert.match(result.plan_preview.objective, /historisk data/i, 'replay objective');
  assert.ok(result.plan_preview.what_it_would_measure.length >= 3, 'replay measures');
  assert.equal(result.can_execute, false, 'replay cannot execute');
  assert.equal(result.execution_available, false, 'replay execution unavailable');
  assert.equal(result.safety.mode, 'paper_only', 'safety mode');
}

{
  const result = preview.getTestPlanPreview('batch-1');
  assert.equal(result.ok, true, 'batch preview ok');
  assert.equal(result.plan_preview.test_type, 'batch', 'batch test type');
  assert.match(result.plan_preview.objective, /flera symboler/i, 'batch objective');
  assert.match(result.plan_preview.manual_next_step, /batch-körning/i, 'batch next step');
}

{
  const result = preview.getTestPlanPreview('history-1');
  assert.equal(result.ok, true, 'history preview ok');
  assert.equal(result.queue_item.status, 'cancelled', 'history cancelled');
  assert.match(result.queue_status_message, /avbruten/i, 'history status message');
  assert.match(result.plan_preview.objective, /historiken/i, 'history objective');
}

{
  const result = preview.getTestPlanPreview('paper-1');
  assert.equal(result.ok, true, 'paper preview ok');
  assert.equal(result.plan_preview.test_type, 'paper_observation', 'paper test type');
  assert.match(result.plan_preview.objective, /paper-observation/i, 'paper objective');
  assert.ok(result.plan_preview.safety_notes.some((text) => /TradingView-strategi/i.test(text)), 'tv safety note');
}

{
  const result = preview.getTestPlanPreview('failed-1');
  assert.equal(result.ok, true, 'failed preview ok');
  assert.equal(result.queue_item.status, 'failed', 'failed status');
  assert.match(result.queue_status_message, /failed/i, 'failed status message');
}

{
  const result = preview.getTestPlanPreview('missing');
  assert.equal(result.ok, false, 'missing rejected');
  assert.equal(result.error, 'queue_item_not_found', 'missing error');
  assert.equal(result.mode, 'paper_only', 'missing safety');
}

console.log('Manual test plan preview tests passed.');
