'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-autopilot-'));
process.env.BATCH_AUTOPILOT_DIR = tmp;

function resetEnv() {
  delete process.env.ENABLE_BATCH_AUTOPILOT;
  delete process.env.BATCH_AUTOPILOT_DRY_RUN_ONLY;
  delete process.env.BATCH_AUTOPILOT_INTERVAL_MINUTES;
  delete process.env.BATCH_AUTOPILOT_MAX_PER_DAY;
}
function clearState() {
  try { fs.unlinkSync(path.join(tmp, 'batch-autopilot-status.json')); } catch (_) {}
}

const svc = require('./batchAutopilotService');

function assertSafety(obj) {
  assert.equal(obj.mode, 'paper_only');
  assert.equal(obj.actions_allowed, false);
  assert.equal(obj.can_place_orders, false);
  assert.equal(obj.live_trading_enabled, false);
  assert.equal(obj.broker_enabled, false);
}

(function run() {
  // 1. Default disabled.
  resetEnv();
  clearState();
  let status = svc.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.status, 'disabled');
  assert.equal(status.nextRun, null);
  assert.equal(status.lastBlockedReason, 'disabled');
  assertSafety(status);

  // 2. dryRunOnly defaults to true even when enabled.
  process.env.ENABLE_BATCH_AUTOPILOT = 'true';
  status = svc.getStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.dryRunOnly, true);
  assert.equal(status.executionEnabled, false);
  assertSafety(status);

  // 3. Safety flags are always false; gate blocks when disabled.
  resetEnv();
  clearState();
  let gate = svc.evaluateGate();
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockedReason, 'disabled');

  // 6. No batch starts when disabled (runOnce blocks, no execution, no plan).
  let called = 0;
  const spyService = { listBatchTests() { called += 1; return { batches: [] }; } };
  let result = svc.runOnce({ batchService: spyService });
  assert.equal(result.blocked, true);
  assert.equal(result.executed, false);
  assert.equal(result.planned, false);
  assert.equal(result.blockedReason, 'disabled');
  assert.equal(called, 0); // batch service never consulted when disabled
  assertSafety(result);

  // Enabled + dry-run: produces a plan but never executes.
  process.env.ENABLE_BATCH_AUTOPILOT = 'true';
  process.env.BATCH_AUTOPILOT_MAX_PER_DAY = '2';
  process.env.BATCH_AUTOPILOT_INTERVAL_MINUTES = '60';
  clearState();
  const t0 = Date.parse('2026-06-06T08:00:00.000Z');
  result = svc.runOnce({ now: t0, batchService: spyService });
  assert.equal(result.planned, true);
  assert.equal(result.executed, false);
  assert.equal(result.blocked, false);
  assert.ok(result.plan && result.plan.kind === 'batch_dry_run_plan');
  assertSafety(result.plan);

  // 5. Cooldown blocks an immediate second run.
  gate = svc.evaluateGate({ now: t0 + 60 * 1000 });
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockedReason, 'cooldown_active');

  // 4. Max per day: after interval passes, count still caps at maxPerDay.
  const t1 = t0 + 61 * 60 * 1000; // past 60-min interval, same day
  result = svc.runOnce({ now: t1, batchService: spyService });
  assert.equal(result.planned, true);
  status = svc.getStatus({ now: t1 });
  assert.equal(status.todayRunCount, 2);
  // Third attempt same day is blocked by max per day.
  const t2 = t1 + 61 * 60 * 1000;
  gate = svc.evaluateGate({ now: t2 });
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockedReason, 'max_per_day_reached');

  // Counter resets on a new day.
  const tNextDay = Date.parse('2026-06-07T08:00:00.000Z');
  status = svc.getStatus({ now: tNextDay });
  assert.equal(status.todayRunCount, 0);

  // Execution mode (dryRunOnly=false) is never allowed.
  process.env.BATCH_AUTOPILOT_DRY_RUN_ONLY = 'false';
  clearState();
  gate = svc.evaluateGate({ now: t0 });
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockedReason, 'execution_not_supported_safe_mode');

  resetEnv();
  console.log('# batchAutopilotService tests passed.');
  process.exit(0);
})();
