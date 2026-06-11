'use strict';

// Tests for the manual dry-run button safety guards used by
// POST /api/batch-autopilot/dry-run and POST /api/replay-autopilot/dry-run.
// These routes are thin wrappers around the autopilot services; this test
// verifies every safety layer they rely on:
//   1. findBlockedIntent rejects live/order intent in the request body.
//   2. service runOnce() never executes (executed:false) and is safety-stamped.
//   3. evaluateGate blocks execution when dryRunOnly is false.
//   4. the route response contract hard-codes executed:false + AUTOPILOT_SAFETY.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const batchTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-batch-'));
const replayTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-replay-'));
process.env.BATCH_AUTOPILOT_DIR = batchTmp;
process.env.REPLAY_AUTOPILOT_DIR = replayTmp;

const batchAutopilotService = require('./batchAutopilotService');
const replayAutopilotService = require('./replayAutopilotService');
const narrowTestAutopilot = require('./narrowTestAutopilotService');

// Mirror of AUTOPILOT_SAFETY in src/routes/api.js.
const AUTOPILOT_SAFETY = {
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
};

// Mirror of the route handler logic (kept in sync with api.js).
function dryRunRoute(service, body) {
  const safeBody = body && typeof body === 'object' ? body : {};
  const blockedIntent = narrowTestAutopilot.findBlockedIntent(safeBody);
  if (blockedIntent) {
    return {
      ok: false, blocked: true, executed: false, dryRun: true,
      ...AUTOPILOT_SAFETY,
      reasons: [`blocked_intent:${blockedIntent}`],
    };
  }
  const result = service.runOnce({ trigger: 'manual_dry_run_button' });
  return {
    ok: result.ok,
    ...AUTOPILOT_SAFETY,
    dryRun: true,
    executed: false,
    blocked: Boolean(result.blocked),
    blockedReason: result.blockedReason || null,
    plan: result.plan || null,
  };
}

function assertSafety(obj) {
  assert.equal(obj.mode, 'paper_only');
  assert.equal(obj.actions_allowed, false);
  assert.equal(obj.can_place_orders, false);
  assert.equal(obj.live_trading_enabled, false);
  assert.equal(obj.broker_enabled, false);
}

function resetBatchEnv() {
  delete process.env.BATCH_AUTOPILOT_DRY_RUN_ONLY;
  delete process.env.ENABLE_BATCH_AUTOPILOT;
}
function resetReplayEnv() {
  delete process.env.REPLAY_AUTOPILOT_DRY_RUN_ONLY;
  delete process.env.ENABLE_REPLAY_AUTOPILOT;
}

// 1. Service runOnce never executes and is safety-stamped (both services).
resetBatchEnv();
resetReplayEnv();
for (const svc of [batchAutopilotService, replayAutopilotService]) {
  const r = svc.runOnce({ trigger: 'test' });
  assert.equal(r.executed, false, 'runOnce must never execute');
  assertSafety(r);
}

// 2. findBlockedIntent catches live/order intent.
assert.ok(narrowTestAutopilot.findBlockedIntent({ live_trading_enabled: true }), 'live flag must be blocked');
assert.ok(narrowTestAutopilot.findBlockedIntent({ placeOrder: true, order: {} }), 'order intent must be blocked');
assert.ok(narrowTestAutopilot.findBlockedIntent({ mode: 'live' }), 'live value must be blocked');
assert.equal(narrowTestAutopilot.findBlockedIntent({}), null, 'empty body must pass');
assert.equal(narrowTestAutopilot.findBlockedIntent({ dryRun: true }), null, 'dry-run body must pass');

// 3. Route wrapper: empty body → planned dry-run, executed:false, safety locked.
for (const svc of [batchAutopilotService, replayAutopilotService]) {
  const res = dryRunRoute(svc, {});
  assert.equal(res.executed, false);
  assert.equal(res.dryRun, true);
  assertSafety(res);
}

// 4. Route wrapper: live/order intent → blocked, executed:false, safety locked.
for (const svc of [batchAutopilotService, replayAutopilotService]) {
  const res = dryRunRoute(svc, { broker: { connect: true } });
  assert.equal(res.blocked, true);
  assert.equal(res.executed, false);
  assert.ok(res.reasons[0].startsWith('blocked_intent:'));
  assertSafety(res);
}

// 5. Even when enabled, disabling dryRunOnly must NOT allow execution —
//    evaluateGate refuses with execution_not_supported_safe_mode.
process.env.ENABLE_BATCH_AUTOPILOT = 'true';
process.env.ENABLE_REPLAY_AUTOPILOT = 'true';
process.env.BATCH_AUTOPILOT_DRY_RUN_ONLY = 'false';
process.env.REPLAY_AUTOPILOT_DRY_RUN_ONLY = 'false';
{
  const gateB = batchAutopilotService.evaluateGate({});
  const gateR = replayAutopilotService.evaluateGate({});
  assert.equal(gateB.allowed, false, 'batch must not execute when dryRunOnly is false');
  assert.equal(gateB.blockedReason, 'execution_not_supported_safe_mode');
  assert.equal(gateR.allowed, false, 'replay must not execute when dryRunOnly is false');
  assert.equal(gateR.blockedReason, 'execution_not_supported_safe_mode');
}
resetBatchEnv();
resetReplayEnv();

// cleanup
try { fs.rmSync(batchTmp, { recursive: true, force: true }); } catch (_) {}
try { fs.rmSync(replayTmp, { recursive: true, force: true }); } catch (_) {}

console.log('# dryRunButtons tests passed.');
