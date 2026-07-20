'use strict';

// Focused tests for the thin autonomous scheduler wrapper. These assert the
// safety-critical behaviour the scheduler itself owns: OFF by default,
// single-flight (no overlapping cycles), and readiness-gated skips that never
// submit and never mutate state. The scan/approval/risk/guard/adapter chain is
// covered by the underlying services' own tests and is deliberately not
// re-tested here (this wrapper must not duplicate their logic).

const assert = require('assert/strict');

function resetEnv() {
  delete process.env.ENABLE_FUTURES_AUTONOMOUS_SCHEDULER;
  delete process.env.FUTURES_AUTONOMOUS_INTERVAL_SECONDS;
  delete process.env.FUTURES_AUTONOMOUS_STARTUP_DELAY_SECONDS;
}

const sched = require('./futuresAutonomousScheduler');

(async function run() {
  // 1. Disabled by default: start() is a no-op (returns null, no timer).
  resetEnv();
  const handle = sched.startFuturesAutonomousScheduler();
  assert.equal(handle, null, 'disabled scheduler must not start a timer');

  // 2. Readiness gate: in a non-IB test process the execution runtime is not
  //    READY, so a tick MUST skip without submitting and without side effects.
  const res = await sched._internal.tick();
  assert.equal(res.ran, false, 'tick must not run the pipeline when not ready');
  assert.equal(res.skipped, true, 'tick must skip when not ready');
  assert.equal(res.submitted, false, 'tick must never submit when not ready');
  assert.notEqual(res.skipReason, 'already_running', 'first tick should skip on readiness, not concurrency');
  // Safety invariants echoed on every result.
  assert.equal(res.live_trading_enabled, false);
  assert.equal(res.can_place_orders, false);
  assert.equal(res.mode, 'ibkr_paper');

  // 3. Single-flight: a second tick launched while the first is still in flight
  //    must be ignored (one cycle at a time). running=true is set synchronously
  //    before the first await, so a synchronously-launched second call sees it.
  const p1 = sched._internal.tick();
  const p2 = sched._internal.tick();
  const [, r2] = await Promise.all([p1, p2]);
  assert.equal(r2.skipped, true, 'overlapping tick must be skipped');
  assert.equal(r2.skipReason, 'already_running', 'overlapping tick must report already_running');
  assert.equal(r2.submitted, false, 'overlapping tick must never submit');

  // 4. evaluateReadiness is read-only and reports a concrete blocking reason.
  const readiness = await sched._internal.evaluateReadiness(new Date());
  assert.equal(readiness.ready, false, 'not ready in a non-IB test process');
  assert.ok(readiness.skipEvent, 'a skip event/reason must be present');

  // 5. isEnabled reflects env dynamically.
  assert.equal(sched._internal.isEnabled(), false);
  process.env.ENABLE_FUTURES_AUTONOMOUS_SCHEDULER = 'true';
  assert.equal(sched._internal.isEnabled(), true);

  sched.stopFuturesAutonomousScheduler();
  resetEnv();
  console.log('# futuresAutonomousScheduler tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error('# futuresAutonomousScheduler tests FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
