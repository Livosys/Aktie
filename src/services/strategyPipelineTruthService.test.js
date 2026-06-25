'use strict';

// Read-only test for strategyPipelineTruthService. Writes nothing, places no
// orders, never changes trading behaviour. Run: node <thisfile>

const assert = require('assert');
const svc = require('./strategyPipelineTruthService');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err.message}`); process.exitCode = 1; }
}

const truth = svc.buildStrategyPipelineTruth();

check('payload is paper-only and read-only', () => {
  assert.strictEqual(truth.ok, true);
  assert.strictEqual(truth.mode, 'paper_only');
  assert.strictEqual(truth.safety.mode, 'paper_only');
  assert.strictEqual(truth.safety.actions_allowed, false);
  assert.strictEqual(truth.safety.can_place_orders, false);
  assert.strictEqual(truth.safety.live_trading_enabled, false);
  assert.strictEqual(truth.safety.broker_enabled, false);
});

check('every strategy row carries the required pipeline fields', () => {
  assert.ok(Array.isArray(truth.strategies) && truth.strategies.length > 0);
  for (const r of truth.strategies) {
    for (const k of ['strategyId', 'approvalStatus', 'inCatalog', 'paperEnabled', 'signals', 'candidates', 'paperTrades', 'chainStop', 'chainStopSv']) {
      assert.ok(Object.prototype.hasOwnProperty.call(r, k), `missing ${k} on ${r.strategyId}`);
    }
    assert.ok(svc.CHAIN_STOP && Object.values(svc.CHAIN_STOP).includes(r.chainStop), `bad chainStop ${r.chainStop}`);
    assert.ok(['proposed', 'rejected', 'approved'].includes(r.approvalStatus));
    for (const wk of ['24h', '3d', '7d']) {
      assert.ok(Number.isFinite(r.signals[wk]) && r.signals[wk] >= 0);
      assert.ok(Number.isFinite(r.paperTrades[wk]) && r.paperTrades[wk] >= 0);
    }
  }
});

check('approved strategy with zero signals classifies as no_matching_signal_subtype', () => {
  const row = truth.strategies.find((r) => r.strategyId === 'vwap_failed_breakout_short');
  if (row && row.approved) {
    assert.strictEqual(row.signals['7d'], 0);
    assert.strictEqual(row.chainStop, svc.CHAIN_STOP.NO_MATCHING_SIGNAL_SUBTYPE);
  }
});

check('non-approved strategy that emits signals classifies as allowlist_block', () => {
  const row = truth.strategies.find((r) => !r.approved && r.signals['7d'] > 0);
  if (row) assert.strictEqual(row.chainStop, svc.CHAIN_STOP.ALLOWLIST_BLOCK);
});

check('approved strategy that trades is marked tradesOk / trades_ok', () => {
  const row = truth.strategies.find((r) => r.approved && r.paperTrades['7d'] > 0);
  if (row) {
    assert.strictEqual(row.tradesOk, true);
    assert.strictEqual(row.chainStop, svc.CHAIN_STOP.TRADES_OK);
  }
});

check('grouped views are consistent with rows', () => {
  assert.ok(truth.groups.approvedTrading.every((r) => r.approved && r.tradesOk));
  assert.ok(truth.groups.rejectedButEmitting.every((r) => !r.approved && r.emitsSignals));
});

console.log(`\nstrategyPipelineTruthService tests passed: ${passed} (exitCode=${process.exitCode || 0})`);
