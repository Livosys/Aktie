'use strict';

const assert = require('assert/strict');
const { createStrategyHistoryService } = require('./strategyHistoryService');

const registryService = {
  getStrategy(strategyId) {
    if (strategyId === 'TV_TEST') {
      return {
        strategy_id: 'TV_TEST',
        source: 'tradingview',
        status: 'paper_only',
        enabled: true,
        mode: 'paper_only',
        disabled_reason: null,
      };
    }
    if (strategyId === 'INT_TEST') {
      return {
        strategy_id: 'INT_TEST',
        source: 'internal',
        status: 'active',
        enabled: true,
        mode: 'paper_only',
        disabled_reason: null,
      };
    }
    return null;
  },
};

const scoreService = {
  getStrategyScore(strategyId) {
    if (strategyId === 'TV_TEST') {
      return {
        ok: true,
        strategy: {
          strategy_id: 'TV_TEST',
          score: 64,
          confidence: 58,
          sample_size: 7,
          strengths: ['Extern TradingView-strategi registrerad'],
          weaknesses: ['Behöver replay/batch-test'],
          recommended_action: 'Kör replay/batch och samla mer data.',
        },
      };
    }
    return {
      ok: true,
      strategy: {
        strategy_id: 'INT_TEST',
        score: 73,
        confidence: 71,
        sample_size: 18,
        strengths: ['Intern katalogstrategi'],
        weaknesses: ['Svag historisk trend'],
        recommended_action: 'Kör replay och batch-test innan fler paper entries.',
      },
    };
  },
};

const performanceService = {
  getStrategyDetails(strategyId) {
    if (strategyId !== 'INT_TEST') {
      return { ok: true, performance: null, results: [] };
    }
    return {
      ok: true,
      strategy: { id: 'INT_TEST', name: 'Internal Test' },
      performance: {
        performance_badge: { label: 'Blandad historik', tone: 'mixed' },
      },
      results: [
        {
          strategy_id: 'INT_TEST',
          source: 'replay',
          created_at: '2026-06-03T10:00:00.000Z',
          trades: 10,
          win_rate: 60,
          avg_pnl: 0.4,
          total_pnl: 4,
          score: 70,
        },
      ],
    };
  },
};

const eventLogService = {
  readRecentEvents() {
    return {
      ok: true,
      events: [
        {
          strategy_id: 'TV_TEST',
          timestamp: '2026-06-03T10:10:00.000Z',
          source: 'tradingview',
          event_type: 'signal.detected',
          symbol: 'AAPL',
          reason: 'watch',
        },
        {
          strategy_id: 'INT_TEST',
          timestamp: '2026-06-03T10:05:00.000Z',
          source: 'scanner',
          event_type: 'strategy.matched',
          symbol: 'MSFT',
          decision: 'allowed',
        },
      ],
    };
  },
};

const paperTradingService = {
  getTrades() {
    return {
      ok: true,
      trades: [
        {
          strategy_id: 'TV_TEST',
          result: 'WIN',
          closed_at: '2026-06-03T10:15:00.000Z',
          symbol: 'AAPL',
          pnlPct: 0.42,
        },
        {
          strategy_id: 'INT_TEST',
          result: 'LOSS',
          closed_at: '2026-06-03T10:20:00.000Z',
          symbol: 'MSFT',
          pnlPct: -0.2,
        },
      ],
    };
  },
};

const historyService = createStrategyHistoryService({
  registryService,
  scoreService,
  performanceService,
  eventLogService,
  paperTradingService,
  learningEventsLoader: () => ([
    {
      strategy_id: 'TV_TEST',
      source: 'replay',
      timestamp: '2026-06-03T10:02:00.000Z',
      extra: { total_trades: 8, win_rate: 62 },
    },
    {
      strategy_id: 'TV_TEST',
      source: 'batch',
      timestamp: '2026-06-03T10:03:00.000Z',
      extra: { recommendation: 'keep', total_tests: 12 },
    },
    {
      strategy_id: 'INT_TEST',
      source: 'paper',
      timestamp: '2026-06-03T10:01:00.000Z',
      result: { outcome: 'win', pnl_pct: 0.2 },
    },
  ]),
});

{
  const tv = historyService.getStrategyHistory('TV_TEST');
  assert.equal(tv.ok, true, 'tv history ok');
  assert.equal(tv.strategy_id, 'TV_TEST', 'tv strategy id');
  assert.equal(tv.registry.source, 'tradingview', 'tv registry source');
  assert.equal(tv.registry.status, 'paper_only', 'tv registry status');
  assert.equal(tv.score.score, 64, 'tv score');
  assert.equal(tv.history_summary.paper_trades_count, 1, 'tv paper trades');
  assert.equal(tv.history_summary.replay_tests_count, 1, 'tv replay tests');
  assert.equal(tv.history_summary.batch_tests_count, 1, 'tv batch tests');
  assert.equal(tv.history_summary.learning_events_count, 2, 'tv learning events');
  assert.ok(tv.history_summary.last_signal_at, 'tv last signal');
  assert.ok(tv.history_summary.last_test_at, 'tv last test');
  assert.ok(tv.recent_events.length <= 5, 'tv recent events capped');
  assert.ok(tv.learning_notes.length > 0, 'tv learning notes');
  assert.ok(tv.recommended_next_steps.length > 0, 'tv next steps');
  assert.equal(tv.actions_allowed, false, 'tv safety actions_allowed');
  assert.equal(tv.can_place_orders, false, 'tv safety can_place_orders');
  assert.equal(tv.live_trading_enabled, false, 'tv safety live_trading_enabled');
  assert.equal(tv.mode, 'paper_only', 'tv safety mode');

  const internal = historyService.getStrategyHistory('INT_TEST');
  assert.equal(internal.ok, true, 'internal history ok');
  assert.equal(internal.registry.source, 'internal', 'internal registry source');
  assert.equal(internal.score.sample_size, 18, 'internal score sample');
  assert.ok(internal.recent_events.length > 0, 'internal has recent events');
  assert.ok(internal.learning_notes.length > 0, 'internal has learning notes');
}

{
  const missing = historyService.getStrategyHistory('UNKNOWN');
  assert.equal(missing.ok, false, 'missing strategy not ok');
  assert.equal(missing.error, 'unknown_strategy_id', 'missing strategy error');
}

console.log('Strategy history tests passed.');
