'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-autopilot-'));
process.env.REPLAY_AUTOPILOT_DIR = tmp;

function resetEnv() {
  delete process.env.ENABLE_REPLAY_AUTOPILOT;
  delete process.env.REPLAY_AUTOPILOT_DRY_RUN_ONLY;
  delete process.env.REPLAY_AUTOPILOT_INTERVAL_MINUTES;
  delete process.env.REPLAY_AUTOPILOT_MAX_PER_DAY;
}
function clearState() {
  try { fs.unlinkSync(path.join(tmp, 'replay-autopilot-status.json')); } catch (_) {}
}

const svc = require('./replayAutopilotService');

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
  assert.equal(status.lastBlockedReason, 'disabled');
  assertSafety(status);

  // 2. dryRunOnly default true; 3. safety flags false even when enabled.
  process.env.ENABLE_REPLAY_AUTOPILOT = 'true';
  status = svc.getStatus();
  assert.equal(status.dryRunOnly, true);
  assert.equal(status.executionEnabled, false);
  assert.equal(status.maxPerDay, 3); // documented default
  assertSafety(status);

  // 5. Missing replay history does not crash; nextRun/lastRun have clear fallbacks.
  resetEnv();
  clearState();
  status = svc.getStatus();
  assert.equal(status.lastRun, null);
  assert.equal(status.nextRun, null); // disabled → null
  assert.equal(status.lastReplayPlan, null);
  assert.equal(status.lastReplayResult, null);

  // buildPlanPreview with a service that throws → safe fallback, no crash.
  const throwingService = { listSessions() { throw new Error('boom'); } };
  const preview = svc.buildPlanPreview(throwingService);
  assert.equal(preview.kind, 'replay_dry_run_plan');
  assertSafety(preview);

  // No replay starts when disabled.
  let called = 0;
  const spyService = { listSessions() { called += 1; return { sessions: [] }; } };
  let result = svc.runOnce({ replayService: spyService });
  assert.equal(result.blocked, true);
  assert.equal(result.executed, false);
  assert.equal(result.planned, false);
  assert.equal(called, 0);
  assertSafety(result);

  // Enabled + dry-run: plan produced, never executed; cooldown + max-per-day enforced.
  process.env.ENABLE_REPLAY_AUTOPILOT = 'true';
  process.env.REPLAY_AUTOPILOT_INTERVAL_MINUTES = '60';
  process.env.REPLAY_AUTOPILOT_MAX_PER_DAY = '1';
  clearState();
  const t0 = Date.parse('2026-06-06T08:00:00.000Z');
  result = svc.runOnce({ now: t0, replayService: spyService });
  assert.equal(result.planned, true);
  assert.equal(result.executed, false);
  assertSafety(result.plan);

  // maxPerDay=1 → next attempt blocked even after interval.
  const tLater = t0 + 61 * 60 * 1000;
  const gate = svc.evaluateGate({ now: tLater });
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockedReason, 'max_per_day_reached');

  // Status shows lastRun/nextRun populated when enabled.
  status = svc.getStatus({ now: t0 });
  assert.ok(status.lastRun);
  assert.ok(status.nextRun);
  assert.ok(status.lastReplayPlan);

  resetEnv();
  console.log('# replayAutopilotService tests passed.');
  process.exit(0);
})();
