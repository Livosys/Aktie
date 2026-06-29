'use strict';

const assert = require('assert');
const svc = require('./interactiveBrokersDirectionResolverService');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// 1. Explicit side wins, high confidence.
test('explicit BUY side resolves to BUY/allowed', () => {
  const r = svc.resolveDirection({ symbol: 'AAPL', strategyId: 'x', side: 'BUY' });
  assert.strictEqual(r.direction, 'BUY');
  assert.strictEqual(r.side, 'BUY');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.confidence, 'high');
  assert.strictEqual(r.blocker, null);
});

test('explicit short direction resolves to SELL', () => {
  const r = svc.resolveDirection({ symbol: 'MSFT', strategyId: 'x', direction: 'short' });
  assert.strictEqual(r.direction, 'SELL');
  assert.strictEqual(r.longShort, 'short');
  assert.strictEqual(r.allowed, true);
});

// 2. Strategy-id deterministic suffix.
test('vwap_failed_breakout_short resolves to SELL with no explicit side', () => {
  const r = svc.resolveDirection({ symbol: 'QQQ', strategyId: 'vwap_failed_breakout_short' });
  assert.strictEqual(r.direction, 'SELL');
  assert.strictEqual(r.source, 'strategy_id_suffix');
  assert.strictEqual(r.allowed, true);
});

test('vwap_rejection_short resolves to SELL', () => {
  const r = svc.resolveDirection({ symbol: 'QQQ', strategyId: 'vwap_rejection_short' });
  assert.strictEqual(r.direction, 'SELL');
});

// 3. Continuation + trend bias.
test('trend_continuation + bullish resolves to BUY', () => {
  const r = svc.resolveDirection({ symbol: 'NVDA', strategyId: 'trend_continuation', trendBias: 'bullish' });
  assert.strictEqual(r.direction, 'BUY');
  assert.strictEqual(r.source, 'continuation_with_trend');
  assert.strictEqual(r.confidence, 'medium');
});

test('ema_pullback_continuation + bullish resolves to BUY', () => {
  const r = svc.resolveDirection({ symbol: 'AAPL', strategyId: 'ema_pullback_continuation', trend: 'uptrend' });
  assert.strictEqual(r.direction, 'BUY');
});

test('continuation + bearish resolves to SELL', () => {
  const r = svc.resolveDirection({ symbol: 'TSLA', strategyId: 'momentum_continuation', trendBias: 'bearish' });
  assert.strictEqual(r.direction, 'SELL');
});

test('continuation WITHOUT trend bias is UNKNOWN/blocked', () => {
  const r = svc.resolveDirection({ symbol: 'AMD', strategyId: 'trend_continuation' });
  assert.strictEqual(r.direction, 'UNKNOWN');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.blocker, 'direction_not_verified');
});

// 4. Reversal/fakeout requires explicit verifiable side.
test('narrow_fakeout_reversal_v1 without reversal side is UNKNOWN/blocked', () => {
  const r = svc.resolveDirection({ symbol: 'MSFT', strategyId: 'narrow_fakeout_reversal_v1' });
  assert.strictEqual(r.direction, 'UNKNOWN');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.blocker, 'direction_not_verified');
});

test('narrow_fakeout_reversal_v1 WITH explicit reversalSide resolves and is verified', () => {
  const r = svc.resolveDirection({ symbol: 'MSFT', strategyId: 'narrow_fakeout_reversal_v1', reversalSide: 'BUY' });
  assert.strictEqual(r.direction, 'BUY');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.source, 'explicit_reversal_side');
});

// 5. Conflicting explicit fields -> BLOCKED.
test('conflicting explicit fields resolve to BLOCKED', () => {
  const r = svc.resolveDirection({ symbol: 'AAPL', strategyId: 'x', side: 'BUY', action: 'SELL' });
  assert.strictEqual(r.direction, 'BLOCKED');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.blocker, 'direction_conflict');
});

// 6. Empty / neutral -> UNKNOWN.
test('no signal at all is UNKNOWN/blocked', () => {
  const r = svc.resolveDirection({ symbol: 'AAPL' });
  assert.strictEqual(r.direction, 'UNKNOWN');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.blocker, 'direction_not_verified');
});

// 7. Never guesses from a neutral/uncertain bias token.
test('neutral trend token does not produce a direction', () => {
  const r = svc.resolveDirection({ symbol: 'AAPL', strategyId: 'trend_continuation', trendBias: 'neutral' });
  assert.strictEqual(r.direction, 'UNKNOWN');
});

// 8. Batch resolver summary.
test('resolveDirections summarizes correctly', () => {
  const out = svc.resolveDirections([
    { symbol: 'A', strategyId: 'x', side: 'BUY' },
    { symbol: 'B', strategyId: 'vwap_failed_breakout_short' },
    { symbol: 'C', strategyId: 'narrow_fakeout_reversal_v1' },
    { symbol: 'D', strategyId: 'x', side: 'BUY', action: 'SELL' },
  ]);
  assert.strictEqual(out.summary.total, 4);
  assert.strictEqual(out.summary.buy, 1);
  assert.strictEqual(out.summary.sell, 1);
  assert.strictEqual(out.summary.unknown, 1);
  assert.strictEqual(out.summary.blocked, 1);
  assert.strictEqual(out.summary.verified, 2);
});

// 9. Safety flags always false.
test('safety flags are always false', () => {
  const r = svc.resolveDirection({ symbol: 'A', side: 'BUY' });
  assert.strictEqual(r.safety.actions_allowed, false);
  assert.strictEqual(r.safety.can_place_orders, false);
  assert.strictEqual(r.safety.live_trading_enabled, false);
  assert.strictEqual(r.safety.broker_enabled, false);
});

console.log(`\ninteractiveBrokersDirectionResolverService: ${passed} tests passed`);
