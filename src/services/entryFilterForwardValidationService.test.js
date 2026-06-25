'use strict';

// ---------------------------------------------------------------------------
// Read-only test/runner for entryFilterForwardValidationService.
//   node src/services/entryFilterForwardValidationService.test.js
//   node src/services/entryFilterForwardValidationService.test.js --since=2026-06-23T00:00:00Z
//
// Asserts safety + flag semantics, then prints the live forward-validation
// report. Writes nothing, places no orders, never touches the gate.
// ---------------------------------------------------------------------------

const assert = require('assert');
const svc = require('./entryFilterForwardValidationService');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err.message}`); process.exitCode = 1; }
}

console.log('entryFilterForwardValidationService — read-only tests\n');

check('SAFETY: paper_only, observe-only, gate untouched', () => {
  assert.strictEqual(svc.SAFETY.mode, 'paper_only');
  assert.strictEqual(svc.SAFETY.can_place_orders, false);
  assert.strictEqual(svc.SAFETY.live_trading_enabled, false);
  assert.strictEqual(svc.SAFETY.broker_enabled, false);
  assert.strictEqual(svc.SAFETY.blocks_entries, false);
  assert.strictEqual(svc.SAFETY.reads_or_sets_gate, false);
});

check('module exposes no order/gate/state-mutating symbol', () => {
  const banned = /placeOrder|submitOrder|submitBracketOrderGroup|writeFile|appendFile|setGate|enableGate|GATE_ENABLED/i;
  for (const key of Object.keys(svc)) assert.ok(!banned.test(key), `unexpected export: ${key}`);
});

check('wouldSkip = caution + REGULAR_PULLBACK only', () => {
  const a = svc.deriveSignals({ statusAtEntry: 'caution', signalSubtype: 'REGULAR_PULLBACK', pnlPct: -0.1 });
  const b = svc.deriveSignals({ statusAtEntry: 'watch', signalSubtype: 'REGULAR_PULLBACK', pnlPct: 0.1 });
  const c = svc.deriveSignals({ statusAtEntry: 'caution', signalSubtype: 'NARROW_WAIT', pnlPct: 0.1 });
  assert.strictEqual(a.wouldSkip, true);
  assert.strictEqual(b.wouldSkip, false, 'watch must not be flagged');
  assert.strictEqual(c.wouldSkip, false, 'caution+other-setup must not be flagged');
});

check('secondary NARROW_WAIT flag is independent of primary', () => {
  const c = svc.deriveSignals({ statusAtEntry: 'watch', signalSubtype: 'NARROW_WAIT', pnlPct: 0.1 });
  assert.strictEqual(c.wouldSkipNarrowWait, true);
  assert.strictEqual(c.wouldSkip, false);
});

check('isWin honors result field then falls back to pnl', () => {
  assert.strictEqual(svc.deriveSignals({ result: 'WIN', pnlPct: -0.01 }).isWin, true);
  assert.strictEqual(svc.deriveSignals({ result: 'LOSS', pnlPct: 0.01 }).isWin, false);
  assert.strictEqual(svc.deriveSignals({ pnlPct: 0.02 }).isWin, true);
});

check('evaluateWindow net effect: skipping a losing cohort lifts kept avgPnl', () => {
  const sigs = [
    svc.deriveSignals({ statusAtEntry: 'caution', signalSubtype: 'REGULAR_PULLBACK', result: 'LOSS', pnlPct: -0.20 }),
    svc.deriveSignals({ statusAtEntry: 'caution', signalSubtype: 'REGULAR_PULLBACK', result: 'LOSS', pnlPct: -0.10 }),
    svc.deriveSignals({ statusAtEntry: 'watch', signalSubtype: 'REGULAR_PULLBACK', result: 'WIN', pnlPct: 0.30 }),
  ];
  const w = svc.evaluateWindow(sigs, 'unit');
  assert.ok(w.kept.avgPnl > w.all.avgPnl, 'kept avgPnl should exceed all avgPnl');
  assert.ok(w.netEffect.totalPnlForgone < 0, 'forgone pnl should be negative (good to skip)');
});

check('verdict reports insufficient data for tiny cohort', () => {
  const sigs = [svc.deriveSignals({ statusAtEntry: 'caution', signalSubtype: 'REGULAR_PULLBACK', pnlPct: -0.1 })];
  const w = svc.evaluateWindow(sigs, 'unit');
  assert.ok(/OTILLRÄCKLIG/.test(w.verdict));
});

check('runForwardValidation is deterministic with fixed --since', () => {
  const a = svc.runForwardValidation({ since: '2026-06-23T00:00:00Z' });
  const b = svc.runForwardValidation({ since: '2026-06-23T00:00:00Z' });
  assert.deepStrictEqual(a.windows.forward.all, b.windows.forward.all);
});

// --- evaluateEntryForwardPreview (runtime preview-only) ----------------------
check('preview NARROW_WAIT flags avoid/skip high severity but NEVER blocks', () => {
  const p = svc.evaluateEntryForwardPreview({ statusAtEntry: 'caution', signalSubtype: 'NARROW_WAIT' });
  assert.strictEqual(p.wouldAvoidByEntryFilter, true);
  assert.strictEqual(p.wouldSkipByEntryFilter, true);
  assert.strictEqual(p.severity, 'high');
  assert.strictEqual(p.reasonCode, 'narrow_wait_underperforms_forward_validation');
  assert.strictEqual(p.runtimeBlocked, false);
  assert.strictEqual(p.gateEnabled, false);
});

check('preview caution+REGULAR_PULLBACK is monitor-only, never skip/avoid/block', () => {
  const p = svc.evaluateEntryForwardPreview({ statusAtEntry: 'caution', signalSubtype: 'REGULAR_PULLBACK' });
  assert.strictEqual(p.wouldAvoidByEntryFilter, false);
  assert.strictEqual(p.wouldSkipByEntryFilter, false);
  assert.strictEqual(p.wouldRequire2mConfirmation, false);
  assert.strictEqual(p.reasonCode, 'caution_regular_pullback_monitor_only');
  assert.strictEqual(p.cohort, 'caution_regular_pullback');
  assert.strictEqual(p.runtimeBlocked, false);
});

check('preview unflagged cohort is neutral and never blocks', () => {
  const p = svc.evaluateEntryForwardPreview({ statusAtEntry: 'watch', signalSubtype: 'NARROW_BULL_ENTRY' });
  assert.strictEqual(p.wouldAvoidByEntryFilter, false);
  assert.strictEqual(p.wouldSkipByEntryFilter, false);
  assert.strictEqual(p.cohort, 'unflagged');
  assert.strictEqual(p.runtimeBlocked, false);
  assert.strictEqual(p.gateEnabled, false);
});

check('preview gateEnabled=false and runtimeBlocked=false for ALL inputs', () => {
  for (const raw of [
    {}, { statusAtEntry: 'caution', signalSubtype: 'NARROW_WAIT' },
    { statusAtEntry: 'caution', signalSubtype: 'REGULAR_PULLBACK' },
    { statusAtEntry: 'watch', signalSubtype: 'REGULAR_PULLBACK' },
    { statusAtEntry: 'caution', strategyName: 'Trend Continuation' },
  ]) {
    const p = svc.evaluateEntryForwardPreview(raw);
    assert.strictEqual(p.gateEnabled, false);
    assert.strictEqual(p.runtimeBlocked, false);
    assert.strictEqual(p.enabled, true);
    assert.ok(typeof p.evaluatedAt === 'string');
  }
});

// --- live run ---------------------------------------------------------------
const sinceArg = (process.argv.find((a) => a.startsWith('--since=')) || '').split('=')[1];
console.log('\n' + '='.repeat(60));
const result = svc.runForwardValidation(sinceArg ? { since: sinceArg } : {});
console.log(svc.formatReport(result));

console.log('\n' + '='.repeat(60));
console.log(`Tests passed: ${passed}  (exitCode=${process.exitCode || 0})`);
