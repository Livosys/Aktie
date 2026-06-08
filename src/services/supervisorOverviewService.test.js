'use strict';

const assert = require('assert/strict');

const service = require('./supervisorOverviewService');

{
  const summary = service.summarizeNarrowAutopilot({
    autopilotStatus: {
      ok: true,
      autopilot: {
        enabled: true,
        dryRunDefault: true,
        currentPlan: { id: 'plan_1', mode: 'paper_only' },
        recommendedNextTest: { strategy_id: 'narrow_fakeout_reversal_v1' },
        planValidation: { ok: true, blocked: false, reasons: [] },
      },
    },
    schedulerStatus: {
      ok: true,
      queueEnabled: true,
      executionEnabled: false,
      schedulerActive: true,
      lastQueuedTest: { plan: { id: 'plan_1' } },
      lastBatchRun: null,
      lastBatchResult: null,
      lastBlockedReason: 'execution_disabled',
      maxPerDay: 1,
      todayRunCount: 0,
      cooldownUntil: null,
    },
  });

  assert.equal(summary.planningEnabled, true, 'planning status exposed');
  assert.equal(summary.queueEnabled, true, 'queue status exposed');
  assert.equal(summary.executionEnabled, false, 'execution remains disabled');
  assert.equal(summary.lastBlockedReason, 'execution_disabled', 'blocked reason exposed');
  assert.equal(summary.actions_allowed, false, 'actions safety false');
  assert.equal(summary.can_place_orders, false, 'order safety false');
  assert.equal(summary.live_trading_enabled, false, 'live safety false');
  assert.equal(summary.broker_enabled, false, 'broker safety false');
}

{
  const overview = service.buildSupervisorOverview();
  assert.equal(overview.ok, true, 'overview builds');
  assert.equal(overview.mode, 'paper_only', 'overview paper_only');
  assert.equal(overview.actions_allowed, false, 'overview actions false');
  assert.equal(overview.can_place_orders, false, 'overview orders false');
  assert.equal(overview.live_trading_enabled, false, 'overview live false');
  assert.equal(overview.broker_enabled, false, 'overview broker false');
  assert.ok(overview.narrowAutopilot, 'overview includes narrow autopilot');
}

console.log('Supervisor overview tests passed.');
