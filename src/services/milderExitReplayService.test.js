'use strict';

// ---------------------------------------------------------------------------
// Read-only test/runner for milderExitReplayService.
// Run:  node src/services/milderExitReplayService.test.js
//
// It (1) asserts the service is side-effect-free and safe, (2) validates the
// approximation model on synthetic trades, then (3) prints the live comparison
// table against the recorded paper trades. It writes nothing and places no
// orders. Exits non-zero on any failed assertion.
// ---------------------------------------------------------------------------

const assert = require('assert');
const svc = require('./milderExitReplayService');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err.message}`); process.exitCode = 1; }
}

console.log('milderExitReplayService — read-only tests\n');

// --- safety contract ---------------------------------------------------------
check('SAFETY flags are locked to paper_only / no orders', () => {
  assert.strictEqual(svc.SAFETY.mode, 'paper_only');
  assert.strictEqual(svc.SAFETY.actions_allowed, false);
  assert.strictEqual(svc.SAFETY.can_place_orders, false);
  assert.strictEqual(svc.SAFETY.live_trading_enabled, false);
  assert.strictEqual(svc.SAFETY.broker_enabled, false);
  assert.strictEqual(svc.SAFETY.changes_runtime_default, false);
});

check('module exposes no order/broker/state-mutating function', () => {
  const banned = /placeOrder|submitOrder|submitPaperOrder|submitBracketOrderGroup|writeFile|appendFile|execute/i;
  for (const key of Object.keys(svc)) {
    assert.ok(!banned.test(key), `unexpected exported symbol: ${key}`);
  }
});

// --- model validation on synthetic trades -----------------------------------
// Build a trade object in the recorded shape, then normalize.
function mk(over) {
  return svc.normalizeTrade(Object.assign({
    tradeId: 't', symbol: 'TEST', direction: 'long', statusAtEntry: 'watch',
    strategy: 'REGULAR_PULLBACK', signalSubtype: 'REGULAR_PULLBACK', signalFamily: 'REGULAR_PULLBACK',
    exitReason: 'EXIT_ENGINE_TIGHTENED_STOP', exitReasonCode: 'tightened_stop', exitSource: 'exit_engine_v1',
    pnlPct: 0.0, maxFavorablePct: 0.0, maxAdversePct: 0.0, targetPct: 0.25, stopPct: 0.20,
    duration_seconds: 300, closed_at: '2026-06-20T10:00:00.000Z',
  }, over));
}

check('baseline returns the recorded pnl unchanged', () => {
  const t = mk({ pnlPct: 0.07, maxFavorablePct: 0.15 });
  const r = svc.simulateTradeUnderProfile(t, 'baseline');
  assert.strictEqual(r.pnl, 0.07);
});

check('mild profile captures full target when MFE >= target', () => {
  const t = mk({ pnlPct: 0.02, maxFavorablePct: 0.30, maxAdversePct: -0.05, targetPct: 0.25 });
  const r = svc.simulateTradeUnderProfile(t, 'mild_exit_v1');
  assert.strictEqual(r.bucket, 'target');
  assert.strictEqual(r.pnl, 0.25);
});

check('mild_exit_v1: recorded BE scratch with high MFE improves vs baseline', () => {
  // engine cut at +0.01, but MFE reached +0.30 -> v1 should reach target 0.25
  const t = mk({ pnlPct: 0.01, maxFavorablePct: 0.30, maxAdversePct: -0.03 });
  const base = svc.simulateTradeUnderProfile(t, 'baseline').pnl;
  const v1 = svc.simulateTradeUnderProfile(t, 'mild_exit_v1').pnl;
  assert.ok(v1 > base, `expected v1(${v1}) > baseline(${base})`);
});

check('not-armed small-favorable trade that breached stop -> stop loss', () => {
  const t = mk({ pnlPct: -0.18, maxFavorablePct: 0.05, maxAdversePct: -0.22, stopPct: 0.20 });
  const r = svc.simulateTradeUnderProfile(t, 'mild_exit_v1');
  assert.strictEqual(r.bucket, 'stop');
  assert.strictEqual(r.pnl, -0.20);
});

check('trailing give-back: armed but no target -> partial profit at peak - giveback', () => {
  // MFE 0.18 >= arm 0.18, no target reached; trail = 0.18 - 0.12 = 0.06
  const t = mk({ pnlPct: 0.01, maxFavorablePct: 0.18, maxAdversePct: -0.04, targetPct: 0.40 });
  const r = svc.simulateTradeUnderProfile(t, 'mild_exit_v1');
  assert.strictEqual(r.bucket, 'trail_profit');
  assert.strictEqual(r.pnl, 0.06);
});

check('mild_exit_v2 near-target captures when v1 would not', () => {
  // MFE 0.22, target 0.25 -> v1 nearTargetCapture=1.0 (no near capture), v2=0.85 (0.2125) captures
  const t = mk({ pnlPct: 0.02, maxFavorablePct: 0.22, maxAdversePct: -0.04, targetPct: 0.25 });
  const v1 = svc.simulateTradeUnderProfile(t, 'mild_exit_v1');
  const v2 = svc.simulateTradeUnderProfile(t, 'mild_exit_v2');
  assert.notStrictEqual(v2.bucket, 'target');
  assert.strictEqual(v2.bucket, 'near_target');
  assert.ok(v2.pnl > 0.20 && v2.pnl <= 0.2125 + 1e-9);
  assert.notStrictEqual(v1.bucket, 'near_target');
});

check('ambiguous trade (MFE>=target AND MAE<=-stop) is flagged', () => {
  const t = mk({ pnlPct: 0.0, maxFavorablePct: 0.30, maxAdversePct: -0.25, targetPct: 0.25, stopPct: 0.20 });
  const r = svc.simulateTradeUnderProfile(t, 'mild_exit_v1');
  assert.strictEqual(r.ambiguous, true);
});

check('entry filter removes caution+REGULAR_PULLBACK trades', () => {
  const cohort = mk({ statusAtEntry: 'caution', signalSubtype: 'REGULAR_PULLBACK' });
  assert.strictEqual(svc.isCautionRegularPullback(cohort), true);
});

check('runComparison is deterministic (same result twice)', () => {
  const a = svc.runComparison();
  const b = svc.runComparison();
  assert.deepStrictEqual(a.profiles.mild_exit_v1.summary, b.profiles.mild_exit_v1.summary);
});

// --- live run against recorded data -----------------------------------------
console.log('\n' + '='.repeat(60));
const result = svc.runComparison();
console.log(svc.formatReport(result));

console.log('\n' + '='.repeat(60));
console.log(`Tests passed: ${passed}  (exitCode=${process.exitCode || 0})`);
