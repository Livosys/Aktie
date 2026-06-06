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

  console.log('# supervisorOverviewService tests passed.');
  // Some source modules hold open handles (e.g. Redis); exit explicitly so the
  // script-style test terminates instead of hanging on those handles.
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
