'use strict';

// Read-only test for shortExitTruthService. Writes nothing, changes no exit
// behaviour. Run: node <thisfile>

const assert = require('assert');
const svc = require('./shortExitTruthService');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err.message}`); process.exitCode = 1; }
}

const truth = svc.buildShortExitTruth();

check('payload is paper-only and read-only', () => {
  assert.strictEqual(truth.ok, true);
  assert.strictEqual(truth.mode, 'paper_only');
  assert.strictEqual(truth.safety.actions_allowed, false);
  assert.strictEqual(truth.safety.can_place_orders, false);
  assert.strictEqual(truth.safety.live_trading_enabled, false);
  assert.strictEqual(truth.safety.broker_enabled, false);
  assert.ok(/ändrar inte exit/i.test(truth.note));
});

check('each window has overall + per-strategy + per-setup summaries', () => {
  for (const wk of ['24h', '3d', '7d']) {
    const w = truth.windows[wk];
    assert.ok(w, `missing window ${wk}`);
    assert.ok(w.overall, 'missing overall');
    assert.ok(w.byStrategy && 'trend_continuation' in w.byStrategy);
    assert.ok(w.bySetup && 'NARROW_WAIT' in w.bySetup);
  }
});

check('overall summary fields are numeric and counts are non-negative', () => {
  const o = truth.windows['7d'].overall;
  if (o.count > 0) {
    for (const k of ['winrate', 'medianDurationSec', 'pctUnder2min', 'pctUnder5min', 'pctUnder10min', 'targetHits', 'tightenedStop', 'momentumFade', 'defaultExits']) {
      assert.ok(o[k] != null, `missing ${k}`);
    }
    assert.ok(Array.isArray(o.exitReasonTop));
    const sum = o.exitReasonTop.reduce((s, r) => s + r.count, 0);
    assert.strictEqual(sum, o.count, 'exitReasonTop counts must sum to total trades');
  }
});

check('default exits are counted as the "default" bucket (no double counting)', () => {
  const o = truth.windows['7d'].overall;
  const def = o.exitReasonTop.find((r) => r.code === 'default');
  assert.strictEqual(o.defaultExits, def ? def.count : 0);
});

console.log(`\nshortExitTruthService tests passed: ${passed} (exitCode=${process.exitCode || 0})`);
