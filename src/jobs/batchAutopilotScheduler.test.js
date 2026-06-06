'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-sched-'));
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

const sched = require('./batchAutopilotScheduler');

(function run() {
  // 1. Disabled: start() is a no-op (returns null, no timer).
  resetEnv();
  clearState();
  const handle = sched.startBatchAutopilotScheduler();
  assert.equal(handle, null);

  // 2. Disabled tick delegates to gated service → blocked 'disabled', no execution.
  let res = sched._internal.tick();
  assert.equal(res.blocked, true);
  assert.equal(res.blockedReason, 'disabled');
  assert.equal(res.executed, false);
  assert.equal(res.live_trading_enabled, false);
  assert.equal(res.can_place_orders, false);

  // 3. Enabled + dry-run: tick produces a plan, never executes.
  process.env.ENABLE_BATCH_AUTOPILOT = 'true';
  clearState();
  res = sched._internal.tick();
  assert.equal(res.planned, true);
  assert.equal(res.executed, false);
  assert.equal(res.blocked, false);
  assert.equal(res.mode, 'paper_only');
  assert.equal(res.broker_enabled, false);

  // 4. Second immediate tick is gated by cooldown (no runaway execution).
  res = sched._internal.tick();
  assert.equal(res.blocked, true);
  assert.equal(res.blockedReason, 'cooldown_active');

  sched.stopBatchAutopilotScheduler();
  resetEnv();
  console.log('# batchAutopilotScheduler tests passed.');
  process.exit(0);
})();
