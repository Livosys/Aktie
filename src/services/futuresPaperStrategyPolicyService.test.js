'use strict';

const assert = require('assert/strict');
const policy = require('./futuresPaperStrategyPolicyService');

const mapped = policy.resolveIdentity('native_futures_ema_pullback_continuation_v1');
assert.equal(mapped.nativeStrategyId, 'native_futures_ema_pullback_continuation_v1');
assert.equal(mapped.canonicalStrategyId, 'ema_pullback_continuation');
assert.equal(mapped.nativeOnly, false);

const approved = policy.evaluateStrategy('native_futures_ema_pullback_continuation_v1', { fresh: true });
assert.equal(approved.allowed, true);
assert.equal(approved.identity.canonicalStrategyId, 'ema_pullback_continuation');
assert.equal(approved.live_trading_enabled, false);

const nativeOnly = policy.evaluateStrategy('native_futures_momentum_v1', { fresh: true });
assert.equal(nativeOnly.allowed, false);
assert.equal(nativeOnly.blockedReason, 'native_strategy_has_no_canonical_approval_identity');

const unknown = policy.evaluateStrategy('not-a-futures-strategy', { fresh: true });
assert.equal(unknown.allowed, false);
assert.equal(unknown.blockedReason, 'strategy_not_registered_for_futures');
console.log('futuresPaperStrategyPolicyService.test.js passed');
