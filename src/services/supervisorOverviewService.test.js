'use strict';

const assert = require('assert/strict');
const overview = require('./supervisorOverviewService');

// ── 1. safeBlock never throws and maps outcomes correctly ─────────────────────
(async () => {
  const ok = await overview.safeBlock({ scope: 's', source: 'x' }, () => ({ a: 1 }));
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.summary, { a: 1 });

  const empty = await overview.safeBlock({ scope: 's', source: 'x' }, () => null);
  assert.equal(empty.status, 'empty');

  const errored = await overview.safeBlock({ scope: 's', source: 'x' }, () => { throw new Error('boom'); });
  assert.equal(errored.status, 'error');
  assert.equal(errored.error, 'boom');

  const asyncOk = await overview.safeBlock({ scope: 's', source: 'x' }, async () => ({ b: 2 }));
  assert.equal(asyncOk.status, 'ok');

  // ── 2. deriveRisks always reassures paper_only and flags error blocks ───────
  const risks = overview.deriveRisks({
    system_health: { status: 'ok', summary: { overallStatus: 'OK', criticalAlerts: 0 } },
    autopilot: { status: 'ok', summary: { blockedReason: null } },
    broken: { status: 'error', error: 'nope' },
  }, { avgPnl: -0.01, timeoutRate: 18, totalTrades: 423 });
  const codes = risks.map((r) => r.code);
  assert.ok(codes.includes('paper_only'));
  assert.ok(codes.includes('negative_avg_pnl'));
  assert.ok(codes.includes('high_timeout_rate'));
  assert.ok(codes.some((c) => c.startsWith('block_error:')));

  // ── 3. deriveActionPlan is never empty ──────────────────────────────────────
  const planEmpty = overview.deriveActionPlan({});
  assert.ok(Array.isArray(planEmpty) && planEmpty.length >= 1);

  const planRec = overview.deriveActionPlan({
    narrow: { status: 'ok', summary: { recommendedNextTest: { strategy_id: 'narrow_fakeout_reversal_v1', priority: 'low', reason: 'x' } } },
  });
  assert.equal(planRec[0].source, '/api/supervisor/narrow-state');

  // ── 4. summarizeStrategies tolerates varied shapes ──────────────────────────
  const strat = overview.summarizeStrategies(
    [{ key: 'a', win_rate: 60, trades: 10 }],
    { strategies: [{ strategy_id: 'b', winRatePct: 20, n: 5 }] },
  );
  assert.equal(strat.top[0].key, 'a');
  assert.equal(strat.top[0].winRate, 60);
  assert.equal(strat.worst[0].key, 'b');

  // ── 5. buildOverview against REAL data: structure + safety, never throws ────
  const o = await overview.buildOverview();
  assert.equal(o.ok, true);
  assert.equal(o.mode, 'paper_only');
  assert.equal(o.actions_allowed, false);
  assert.equal(o.can_place_orders, false);
  assert.equal(o.live_trading_enabled, false);
  assert.equal(o.broker_enabled, false);

  const expectedBlocks = ['system_health', 'learning', 'strategies', 'narrow', 'autopilot',
    'market_regime', 'priority', 'daily_pipeline', 'ai_optimization', 'operations_advisor'];
  for (const b of expectedBlocks) {
    assert.ok(o.blocks[b], `block ${b} present`);
    assert.ok(['ok', 'empty', 'degraded', 'error'].includes(o.blocks[b].status), `block ${b} valid status`);
    assert.ok(o.blocks[b].source, `block ${b} has source`);
  }
  assert.ok(Array.isArray(o.risks) && o.risks.some((r) => r.code === 'paper_only'));
  assert.ok(Array.isArray(o.actionPlan) && o.actionPlan.length >= 1);
  assert.deepEqual(o.safety, {
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  });

  // ── 6. overview exposes recentTests array + status (real data) ──────────────
  assert.ok(Array.isArray(o.recentTests), 'recentTests is an array');
  assert.ok(o.recentTestsStatus && ['ok', 'empty', 'degraded', 'error'].includes(o.recentTestsStatus.status), 'recentTestsStatus valid');
  assert.ok(o.recentTestsStatus.source, 'recentTestsStatus source present');
  assert.ok(o.dataStatus && ['ok', 'empty', 'degraded', 'error'].includes(o.dataStatus.status), 'dataStatus valid');
  assert.ok(o.batchStatus && ['ok', 'empty', 'degraded', 'error'].includes(o.batchStatus.status), 'batchStatus valid');
  assert.ok(o.replayStatus && ['ok', 'empty', 'degraded', 'error'].includes(o.replayStatus.status), 'replayStatus valid');
  assert.ok(o.paperStatus && ['ok', 'empty', 'degraded', 'error'].includes(o.paperStatus.status), 'paperStatus valid');
  assert.ok(o.learningStatus && ['ok', 'empty', 'degraded', 'error'].includes(o.learningStatus.status), 'learningStatus valid');
  assert.ok(o.strategyRanking && ['ok', 'empty', 'degraded', 'error'].includes(o.strategyRanking.status), 'strategyRanking valid');
  assert.ok(o.aiRecommendations && ['ok', 'empty', 'degraded', 'error'].includes(o.aiRecommendations.status), 'aiRecommendations valid');
  assert.ok(o.lossFeedbackQueue && ['ok', 'empty', 'degraded', 'error'].includes(o.lossFeedbackQueue.status), 'lossFeedbackQueue valid');
  assert.ok(Array.isArray(o.nextRecommendedActions), 'nextRecommendedActions is an array');
  assert.equal(o.dataStatus.mode, 'paper_only');
  assert.equal(o.batchStatus.mode, 'paper_only');
  assert.equal(o.replayStatus.mode, 'paper_only');
  assert.equal(o.paperStatus.mode, 'paper_only');
  assert.equal(o.learningStatus.mode, 'paper_only');
  assert.equal(o.strategyRanking.mode, 'paper_only');
  assert.ok(o.batchSummary && typeof o.batchSummary === 'object', 'batchSummary present');
  assert.ok(['ok', 'empty', 'degraded', 'error'].includes(o.batchSummary.status), 'batchSummary status valid');
  assert.equal(o.batchSummary.source, 'strategyBatchTestService');
  assert.equal(o.batchSummary.mode, 'paper_only');
  assert.equal(o.batchSummary.canPlaceOrders, false);
  assert.equal(o.batchSummary.liveTradingEnabled, false);
  assert.equal(o.batchSummary.brokerEnabled, false);
  assert.ok(o.aiAnalystStatus && typeof o.aiAnalystStatus === 'object', 'aiAnalystStatus present');
  assert.equal(o.aiAnalystStatus.mode, 'paper_only');
  assert.equal(o.aiAnalystStatus.can_place_orders, false);
  assert.equal(o.aiAnalystStatus.live_trading_enabled, false);
  assert.ok(o.dataJobsSummary && typeof o.dataJobsSummary === 'object', 'dataJobsSummary present');
  assert.equal(o.dataJobsSummary.mode, 'paper_only');
  assert.equal(o.dataJobsSummary.can_place_orders, false);
  assert.equal(o.dataJobsSummary.live_trading_enabled, false);
  assert.ok(o.liveActivitySummary && typeof o.liveActivitySummary === 'object', 'liveActivitySummary present');
  assert.equal(o.liveActivitySummary.mode, 'paper_only');
  assert.equal(o.liveActivitySummary.can_place_orders, false);
  assert.equal(o.liveActivitySummary.live_trading_enabled, false);
  // Autopilot summaries (safe, disabled by default).
  assert.ok(o.batchAutopilotSummary && typeof o.batchAutopilotSummary === 'object', 'batchAutopilotSummary present');
  assert.equal(o.batchAutopilotSummary.mode, 'paper_only');
  assert.equal(o.batchAutopilotSummary.live_trading_enabled, false);
  assert.equal(o.batchAutopilotSummary.broker_enabled, false);
  assert.ok(o.replayAutopilotSummary && typeof o.replayAutopilotSummary === 'object', 'replayAutopilotSummary present');
  assert.equal(o.replayAutopilotSummary.mode, 'paper_only');
  assert.equal(o.replayAutopilotSummary.live_trading_enabled, false);
  assert.equal(o.replayAutopilotSummary.broker_enabled, false);

  // ── 7. normalizeRecentTest maps a real event and drops junk ─────────────────
  const norm = overview.normalizeRecentTest({
    timestamp: 't', event: 'run_completed', planId: 'p1', strategy_id: 'narrow_fakeout_reversal_v1',
    symbols: ['MSFT', 'QQQ'], timeframes: ['2m'], status: 'completed',
    summary: { totalTrades: 120, bestStrategy: 'narrow_fakeout_reversal_v1' },
  });
  assert.equal(norm.id, 'p1');
  assert.equal(norm.type, 'run_completed');
  assert.equal(norm.executed, true);
  assert.equal(norm.symbol, 'MSFT, QQQ');
  assert.equal(norm.timeframe, '2m');
  assert.equal(norm.tradesCount, 120);
  assert.equal(norm.recommendation, 'narrow_fakeout_reversal_v1');
  assert.equal(overview.normalizeRecentTest(123), null);
  assert.equal(overview.normalizeRecentTest([1, 2]), null);
  assert.equal(overview.normalizeRecentTest(null), null);

  // ── 8. batchSummary is read-only, stable, and fault-isolated ───────────────
  const emptyBatch = overview.buildBatchSummary({
    listBatchTests: () => ({ ok: true, batches: [], count: 0, actions_allowed: false, can_place_orders: false, live_trading_enabled: false, paper_only: true }),
    getLatestBatchComparison: () => ({ ok: true, batch: {} }),
  });
  assert.equal(emptyBatch.status, 'empty');
  assert.equal(emptyBatch.totalBatches, 0);
  assert.equal(emptyBatch.canPlaceOrders, false);
  assert.equal(emptyBatch.liveTradingEnabled, false);

  const degradedBatch = overview.buildBatchSummary({
    listBatchTests: () => ({
      ok: true,
      batches: [{
        id: 'b1',
        status: 'completed',
        config: { strategy_ids: ['s1'], timeframes: ['2m'], symbols: ['MSFT'] },
        progress: { completed: 1 },
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:01:00.000Z',
        actions_allowed: false,
        can_place_orders: false,
        live_trading_enabled: false,
        paper_only: true,
      }],
    }),
    getBatchTestResults: () => { throw new Error('missing results'); },
    getLatestBatchComparison: () => ({ ok: true, total_results: 0, best_overall: [], worst_overall: [] }),
  });
  assert.equal(degradedBatch.status, 'degraded');
  assert.equal(degradedBatch.totalBatches, 1);
  assert.equal(degradedBatch.completedBatches, 1);
  assert.equal(degradedBatch.latestBatch.id, 'b1');
  assert.equal(degradedBatch.latestBatch.canPlaceOrders, false);
  assert.equal(degradedBatch.latestBatch.liveTradingEnabled, false);

  const errorBatch = overview.buildBatchSummary({
    listBatchTests: () => { throw new Error('broken batch file'); },
  });
  assert.equal(errorBatch.status, 'error');
  assert.equal(errorBatch.totalBatches, 0);
  assert.equal(errorBatch.canPlaceOrders, false);
  assert.equal(errorBatch.liveTradingEnabled, false);

  const aiStatus = overview.summarizeAiAnalystStatus({
    provider: 'disabled',
    enabled: false,
    cacheEnabled: true,
    cacheTtlMs: 300000,
    latestExists: true,
    latestTimestamp: '2026-06-01T00:00:00.000Z',
    latestStatus: 'disabled',
    latestProvider: 'disabled',
    latestDurationMs: 3,
    logPathExists: true,
    logEventCount: 4,
  });
  assert.equal(aiStatus.provider, 'disabled');
  assert.equal(aiStatus.enabled, false);
  assert.equal(aiStatus.logEventCount, 4);
  assert.equal(aiStatus.mode, 'paper_only');
  assert.equal(aiStatus.can_place_orders, false);

  // summarizeAutopilotControl: condenses status, keeps safety, tolerates null.
  const batchCtl = overview.summarizeAutopilotControl({
    status: 'disabled', enabled: false, dryRunOnly: true, intervalMinutes: 360,
    maxPerDay: 2, lastRun: null, nextRun: null, todayRunCount: 0,
    lastBlockedReason: 'disabled', lastPlan: null, message: 'off', updatedAt: 't',
  }, 'batch');
  assert.equal(batchCtl.status, 'disabled');
  assert.equal(batchCtl.enabled, false);
  assert.equal(batchCtl.live_trading_enabled, false);
  assert.equal(batchCtl.broker_enabled, false);
  assert.equal('lastPlan' in batchCtl, true);

  const replayCtl = overview.summarizeAutopilotControl({
    status: 'idle', enabled: true, dryRunOnly: true, intervalMinutes: 360,
    maxPerDay: 3, lastRun: '2026-06-06T08:00:00.000Z', nextRun: '2026-06-06T14:00:00.000Z',
    todayRunCount: 1, lastBlockedReason: null, lastReplayPlan: { kind: 'x' }, lastReplayResult: null,
  }, 'replay');
  assert.equal(replayCtl.status, 'idle');
  assert.equal(replayCtl.latestTimestamp, '2026-06-06T08:00:00.000Z');
  assert.equal('lastReplayPlan' in replayCtl, true);
  assert.equal(replayCtl.can_place_orders, false);

  const nullCtl = overview.summarizeAutopilotControl(null, 'batch');
  assert.equal(nullCtl.status, 'empty');
  assert.equal(nullCtl.live_trading_enabled, false);

  // ── 9. empty / broken history never crashes; overview stays ok (HTTP 200) ───
  const fs = require('fs'); const os = require('os'); const path = require('path');
  function withHistory(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-hist-'));
    if (content !== null) fs.writeFileSync(path.join(dir, 'narrow-autopilot-history.jsonl'), content, 'utf8');
    process.env.NARROW_AUTOPILOT_DIR = dir;
    delete require.cache[require.resolve('./narrowTestAutopilotService')];
  }

  withHistory(null); // no history file at all
  let rt = overview.buildRecentTests(25);
  assert.equal(rt.recentTestsStatus.status, 'empty');
  assert.deepEqual(rt.recentTests, []);

  withHistory('123\n"notobj"\n{bad json\n'); // present but unusable → degraded
  rt = overview.buildRecentTests(25);
  assert.equal(rt.recentTestsStatus.status, 'degraded');
  assert.equal(rt.recentTests.length, 0);

  withHistory(JSON.stringify({ timestamp: 't', event: 'plan_created', planId: 'p9', strategy_id: 'narrow_breakout_v1', symbols: ['TSLA'], timeframes: ['2m'], status: 'planned', summary: null }) + '\n');
  rt = overview.buildRecentTests(25);
  assert.equal(rt.recentTestsStatus.status, 'ok');
  assert.equal(rt.recentTests.length, 1);
  assert.equal(rt.recentTests[0].id, 'p9');

  // overview still returns ok:true and safety unchanged with broken history env
  withHistory('garbage\n');
  const o2 = await overview.buildOverview();
  assert.equal(o2.ok, true);
  assert.equal(o2.live_trading_enabled, false);
  assert.equal(o2.can_place_orders, false);
  assert.ok(Array.isArray(o2.recentTests));

  delete process.env.NARROW_AUTOPILOT_DIR;
  delete require.cache[require.resolve('./narrowTestAutopilotService')];

  // ── 10. short cache: second call within TTL is served from cache ────────────
  overview.resetOverviewCache();
  const c1 = await overview.getCachedOverview();
  assert.equal(c1.cached, false, 'first call rebuilds');
  assert.equal(c1.ok, true);
  const c2 = await overview.getCachedOverview();
  assert.equal(c2.cached, true, 'second call within TTL is cached');
  // Safety flags survive the cache untouched.
  assert.equal(c2.mode, 'paper_only');
  assert.equal(c2.live_trading_enabled, false);
  assert.equal(c2.can_place_orders, false);
  assert.equal(c2.broker_enabled, false);
  // force bypasses the cache (so errors can never be hidden permanently).
  const c3 = await overview.getCachedOverview({ force: true });
  assert.equal(c3.cached, false, 'force rebuilds');
  overview.resetOverviewCache();

  console.log('# supervisorOverviewService tests passed.');
  // Some source modules hold open handles (e.g. Redis); exit explicitly so the
  // script-style test terminates instead of hanging on those handles.
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
