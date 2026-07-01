'use strict';

// Read-only unit tests for the IB Paper setup builder. No order path is ever
// exercised: the builder is pure logic and never sends/arms/queues an order.

const assert = require('assert');
const svc = require('./interactiveBrokersPaperSetupBuilderService');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const BUY_READY = {
  symbol: 'GOOGL',
  strategyId: 'narrow_breakout',
  side: 'BUY',
  entryPrice: 100,
  stopLoss: 99,
  takeProfit: 103,
  marketGroup: 'mag7',
};
const SELL_READY = {
  symbol: 'META',
  strategyId: 'vwap_failed_breakout_short',
  side: 'SELL',
  entryPrice: 100,
  stopLoss: 101,
  takeProfit: 97,
  marketGroup: 'mag7',
};

// 1. Pure watch-signal (no direction, no prices) -> blocked.
test('watch signal without direction/prices is blocked', () => {
  const r = svc.buildSetup({ symbol: 'META', strategyId: 'trend_continuation', marketGroup: 'mag7' });
  assert.strictEqual(r.setupReady, false);
  assert.ok(r.blockers.includes('direction_not_verified'));
  assert.ok(r.blockers.includes('candidate_is_watch_signal_not_trade_setup'));
  assert.strictEqual(r.diagnostics.reason, 'candidate_is_watch_signal_not_trade_setup');
});

// 2. UNCERTAIN direction -> blocked (never guessed).
test('UNCERTAIN direction is blocked', () => {
  const r = svc.buildSetup({
    symbol: 'QQQ', strategyId: 'trend_continuation',
    direction: 'UNCERTAIN', nextMoveBias: 'UNCERTAIN', marketGroup: 'nasdaq100',
  });
  assert.strictEqual(r.setupReady, false);
  assert.ok(r.blockers.includes('direction_not_verified'));
});

// 3. BUY + full bracket -> setupReady.
test('BUY with entry+stop+take is setupReady', () => {
  const r = svc.buildSetup(BUY_READY);
  assert.strictEqual(r.setupReady, true, JSON.stringify(r.blockers));
  assert.strictEqual(r.side, 'BUY');
  assert.strictEqual(r.entryPrice, 100);
  assert.strictEqual(r.stopLossPrice, 99);
  assert.strictEqual(r.takeProfitPrice, 103);
  assert.strictEqual(r.quantity, 1);
  assert.strictEqual(r.bracketReady, true);
  assert.deepStrictEqual(r.blockers, []);
});

// 4. SELL + full bracket -> setupReady.
test('SELL with entry+stop+take is setupReady', () => {
  const r = svc.buildSetup(SELL_READY);
  assert.strictEqual(r.setupReady, true, JSON.stringify(r.blockers));
  assert.strictEqual(r.side, 'SELL');
  assert.strictEqual(r.bracketReady, true);
});

// 5. BUY stop must be below entry.
test('BUY stop above entry is blocked', () => {
  const r = svc.buildSetup({ ...BUY_READY, stopLoss: 101 });
  assert.strictEqual(r.setupReady, false);
  assert.ok(r.blockers.includes('stop_loss_invalid_side'));
});

// 6. SELL stop must be above entry.
test('SELL stop below entry is blocked', () => {
  const r = svc.buildSetup({ ...SELL_READY, stopLoss: 99 });
  assert.strictEqual(r.setupReady, false);
  assert.ok(r.blockers.includes('stop_loss_invalid_side'));
});

// 7. BUY take must be above entry.
test('BUY take at/below entry is blocked', () => {
  const r = svc.buildSetup({ ...BUY_READY, takeProfit: 100 });
  assert.strictEqual(r.setupReady, false);
  assert.ok(r.blockers.includes('take_profit_invalid'));
});

// 8. SELL take must be below entry.
test('SELL take at/above entry is blocked', () => {
  const r = svc.buildSetup({ ...SELL_READY, takeProfit: 100 });
  assert.strictEqual(r.setupReady, false);
  assert.ok(r.blockers.includes('take_profit_invalid'));
});

// 9. Missing stop -> blocked.
test('missing stop loss is blocked', () => {
  const r = svc.buildSetup({ ...BUY_READY, stopLoss: undefined });
  assert.strictEqual(r.setupReady, false);
  assert.ok(r.blockers.includes('missing_stop_loss'));
  assert.ok(r.blockers.includes('bracket_required_missing'));
});

// 10. Missing take -> blocked.
test('missing take profit is blocked', () => {
  const r = svc.buildSetup({ ...BUY_READY, takeProfit: undefined });
  assert.strictEqual(r.setupReady, false);
  assert.ok(r.blockers.includes('missing_take_profit'));
});

// 11. Entry-only -> blocked (never a naked entry).
test('entry-only is blocked', () => {
  const r = svc.buildSetup({ ...BUY_READY, stopLoss: undefined, takeProfit: undefined });
  assert.strictEqual(r.setupReady, false);
  assert.ok(r.blockers.includes('missing_stop_loss'));
  assert.ok(r.blockers.includes('missing_take_profit'));
  assert.ok(r.blockers.includes('bracket_required_missing'));
});

// 12. QQQ/ETF blocked when includeEtf=false; allowed to pass the asset gate when true.
test('QQQ/ETF blocked when includeEtf=false', () => {
  const cand = { ...BUY_READY, symbol: 'QQQ', assetGroup: 'etfQqq' };
  const blocked = svc.buildSetup(cand, { includeEtf: false });
  assert.strictEqual(blocked.setupReady, false);
  assert.ok(blocked.blockers.includes('qqq_etf_blocked'));
  const allowed = svc.buildSetup(cand, { includeEtf: true });
  assert.ok(!allowed.blockers.includes('qqq_etf_blocked'));
  assert.strictEqual(allowed.setupReady, true, JSON.stringify(allowed.blockers));
});

// 13. Crypto always blocked (even with a full bracket + explicit side).
test('crypto is always blocked', () => {
  const r = svc.buildSetup({ ...BUY_READY, symbol: 'BTCUSD', assetGroup: 'crypto', isCrypto: true }, { includeEtf: true });
  assert.strictEqual(r.setupReady, false);
  assert.ok(r.blockers.includes('crypto_blocked'));
});

// 14. No order-path surface exists (no placeOrder/cancel/submit/arm/execute).
test('no order-execution functions are exported', () => {
  const forbidden = ['placeOrder', 'cancelOrder', 'submit', 'submitOrder', 'arm', 'execute', 'paperExecute', 'sendOrder', 'retry'];
  for (const key of Object.keys(svc)) {
    assert.ok(!forbidden.includes(key), `unexpected export: ${key}`);
  }
  for (const name of forbidden) {
    assert.strictEqual(typeof svc[name], 'undefined', `must not expose ${name}`);
  }
});

// 15. Safety flags are always locked false on every result.
test('safety is locked false on every result', () => {
  for (const r of [svc.buildSetup(BUY_READY), svc.buildSetup({}), svc.buildSetup(SELL_READY)]) {
    assert.strictEqual(r.safety.mode, 'paper_only');
    assert.strictEqual(r.safety.actions_allowed, false);
    assert.strictEqual(r.safety.can_place_orders, false);
    assert.strictEqual(r.safety.live_trading_enabled, false);
    assert.strictEqual(r.safety.broker_enabled, false);
  }
});

// 16. Rule-derived bracket requires opt-in AND real inputs; never invents by default.
test('rule derivation stays off by default, works only with real inputs opt-in', () => {
  const base = { symbol: 'GOOGL', strategyId: 'narrow_breakout', side: 'BUY', marketGroup: 'mag7' };
  // Default (no opt-in): no explicit prices -> stays blocked, invents nothing.
  const off = svc.buildSetup({ ...base, currentPrice: 200 });
  assert.strictEqual(off.setupReady, false);
  assert.ok(off.blockers.includes('missing_entry_price'));
  // Opt-in but missing rule params -> still blocked.
  const missing = svc.buildSetup({ ...base, currentPrice: 200 }, { allowRuleDerivedBracket: true });
  assert.strictEqual(missing.setupReady, false);
  // Opt-in with real reference price + configured rules -> deterministic bracket.
  const on = svc.buildSetup(
    { ...base },
    { allowRuleDerivedBracket: true, referencePrice: 200, stopLossPct: 1, takeProfitRMultiple: 2 },
  );
  assert.strictEqual(on.setupReady, true, JSON.stringify(on.blockers));
  assert.strictEqual(on.entryPrice, 200);
  assert.strictEqual(on.stopLossPrice, 198); // 200 - 1%
  assert.strictEqual(on.takeProfitPrice, 204); // +2R
  assert.strictEqual(on.diagnostics.setupSource, 'rule_derived');
});

// 17. Conflicting explicit direction -> direction_conflict (never guessed).
test('conflicting direction is blocked with direction_conflict', () => {
  const r = svc.buildSetup({ ...BUY_READY, side: 'BUY', action: 'SELL' });
  assert.strictEqual(r.setupReady, false);
  assert.ok(r.blockers.includes('direction_conflict'));
});

console.log(`\nAll ${passed} setup-builder tests passed.`);
