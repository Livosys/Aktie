'use strict';

const assert = require('assert/strict');
const svc = require('./batchStatusService');

(async () => {
  const empty = svc.buildBatchStatus({
    batchService: {
      listBatchTests: () => ({ ok: true, batches: [], active_count: 0 }),
      getLatestBatchComparison: () => ({ ok: true, batch: {} }),
    },
    eventLogService: { readRecentEvents: () => ({ ok: true, events: [] }) },
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.mode, 'paper_only');
  assert.equal(empty.actions_allowed, false);
  assert.equal(empty.can_place_orders, false);
  assert.equal(empty.live_trading_enabled, false);
  assert.equal(empty.broker_enabled, false);

  const ok = svc.buildBatchStatus({
    batchService: {
      listBatchTests: () => ({
        ok: true,
        active_count: 0,
        batches: [
          {
            id: 'batch-2',
            status: 'completed',
            config: { strategy_ids: ['narrow_breakout_v1'], symbols: ['MSFT'], timeframes: ['2m'] },
            progress: { total: 3, completed: 3, pct: 100 },
            started_at: '2026-06-01T10:00:00.000Z',
            completed_at: '2026-06-01T10:01:00.000Z',
            paper_only: true,
          },
          { id: 'batch-1', status: 'created', created_at: '2026-05-01T10:00:00.000Z' },
        ],
      }),
      getBatchTestResults: () => ({
        ok: true,
        count: 1,
        top: [{ strategy_id: 'narrow_breakout_v1', symbol: 'MSFT', timeframe: '2m', score: 70, win_rate: 55, avg_pnl: 0.1, trades: 12 }],
        worst: [{ strategy_id: 'narrow_vwap_mean_reversion_v1', symbol: 'QQQ', timeframe: '2m', score: 20, win_rate: 30, avg_pnl: -0.1, trades: 8 }],
        results: [],
      }),
      getLatestBatchComparison: () => ({ ok: true, best_overall: [], worst_overall: [] }),
    },
    eventLogService: {
      readRecentEvents: () => ({
        ok: true,
        events: [{ event_id: 'e1', event_type: 'batch.completed', timestamp: '2026-06-01T10:01:00.000Z', source: 'batch', metadata: { batch_id: 'batch-2' } }],
      }),
    },
  });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.totalBatches, 2);
  assert.equal(ok.completedBatches, 1);
  assert.equal(ok.queuedBatches, 1);
  assert.equal(ok.latestCompletedBatch.id, 'batch-2');
  assert.equal(ok.latestCompletedBatch.can_place_orders, false);
  assert.equal(ok.bestOutcome.strategy, 'narrow_breakout_v1');
  assert.equal(ok.worstOutcome.strategy, 'narrow_vwap_mean_reversion_v1');
  assert.equal(ok.recentBatchEvents.length, 1);
  assert.equal(ok.recentBatchEvents[0].can_place_orders, false);
  assert.ok(ok.summary && typeof ok.summary === 'object');
  assert.equal(ok.summary.status, 'ok');
  assert.equal(ok.summary.batchCount, 2);
  assert.equal(ok.summary.latestBatchId, 'batch-2');
  assert.equal(ok.summary.failedCount, 0);

  const missing = svc.buildBatchStatus({ batchService: null, eventLogService: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.emptyReason, 'batch_service_missing');
  assert.equal(missing.can_place_orders, false);

  const degraded = svc.buildBatchStatus({
    batchService: {
      listBatchTests: () => ({ ok: true, active_count: 0, batches: [{ id: 'b', status: 'completed', updated_at: '2026-01-01T00:00:00.000Z' }] }),
      getBatchTestResults: () => { throw new Error('broken result file'); },
      getLatestBatchComparison: () => ({ ok: true }),
    },
    eventLogService: { readRecentEvents: () => { throw new Error('broken events'); } },
  });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.totalBatches, 1);
  assert.equal(degraded.can_place_orders, false);
  assert.ok(degraded.warnings.length >= 1);
  assert.equal(degraded.summary.status, 'degraded');
  assert.equal(degraded.summary.emptyReason, 'batch_results_degraded');

  // Service surface is read-only: no start/pause/stop methods are exported.
  assert.equal(typeof svc.runBatchTest, 'undefined');
  assert.equal(typeof svc.pauseBatchTest, 'undefined');
  assert.equal(typeof svc.stopBatchTest, 'undefined');

  console.log('# batchStatusService tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
