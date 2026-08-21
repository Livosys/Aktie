'use strict';

// ── Förutsättningen måste stå i testet, inte i .env ─────────────────────────
//
// Testet mäter driftens strategiuniversum, och i drift styr den manuella
// listan runtime (PAPER_MANUAL_STRATEGY_LIST_ENABLED=true i .env). Testet
// laddade aldrig .env, så readiness räknade 0 i stället för 5 — och utfallet
// berodde på om körningen råkade ha variabeln satt.
//
// Ett test som ger olika svar beroende på skalets miljö mäter inte koden.
// Förutsättningen sätts därför här, uttryckligen, före första require:
// modulerna läser flaggan när de laddas.
process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'true';

const assert = require('assert/strict');
const catalog = require('./daytradingStrategyCatalogService').getCatalog().strategies;
const readiness = require('./strategyReadinessService').getStrategyReadiness({ noCache: true });
const enabled = require('./paperEnabledStrategiesService').buildPaperStrategyList({ fresh: true });
const registry = require('./nativeFuturesStrategyRegistryService');
const policy = require('./futuresPaperStrategyPolicyService');
const library = require('./library/strategyLibraryService').defaultStrategyLibrary;
const config = require('./ibPaperExecutionConfigService');

const READY_NOW = new Set([
  'ema_pullback_continuation',
  'narrow_breakout',
  'narrow_fakeout_reversal_v1',
  'narrow_state_expansion_long',
  'vwap_volume_breakout_long',
]);
const WRONG_MARKET = new Set([
  'crypto_fast_momentum', 'crypto_momentum_scalper', 'gap_continuation', 'gap_fade',
  'index_confirmed_long', 'index_confirmed_short', 'index_supported_momentum_long',
  'opening_range_breakout', 'opening_range_fakeout', 'opening_range_retest_long',
]);
const INTENTIONALLY_DISABLED = new Set(['news_volatility_watch', 'trend_continuation', 'vwap_failed_breakout_short']);
const DUPLICATES = new Set(['narrow_breakout_v1', 'narrow_state_fakeout_reversal']);
const MAJOR_WORK = new Set([
  'ema_breakdown', 'high_volatility_reversal', 'low_volatility_breakout', 'mean_reversion_vwap',
  'narrow_vwap_mean_reversion_v1', 'pullback_to_vwap_long', 'resistance_rejection', 'support_bounce',
  'trend_exhaustion_short', 'volume_spike_continuation', 'volume_spike_momentum',
  'vwap_momentum_long', 'vwap_rejection_short',
]);

const allExpected = new Set([...READY_NOW, ...WRONG_MARKET, ...INTENTIONALLY_DISABLED, ...DUPLICATES, ...MAJOR_WORK]);
assert.equal(catalog.length, 33);
assert.equal(allExpected.size, 33);
assert.deepEqual(new Set(catalog.map((row) => row.id)), allExpected);
assert.equal(readiness.summary.readyForPaper, 5);
assert.equal(enabled.summary.enabled, 5);

for (const id of READY_NOW) {
  const decision = policy.evaluateStrategy(id, { fresh: true });
  assert.equal(decision.allowed, true, `${id} must pass the canonical paper policy`);
  assert.ok(decision.identity.nativeStrategyId, `${id} must have native identity`);
  assert.ok(decision.approval.entryContractReady, `${id} must have entry contract`);
  assert.ok(registry.soleNativeStrategyForOrigin(id), `${id} must have semantic native mapping`);
  const nativeId = registry.soleNativeStrategyForOrigin(id).strategyId;
  const record = library.getStrategy(nativeId);
  assert.ok(record, `${nativeId} must exist in Strategy Library`);
  assert.ok((record.paperHistory || []).length > 0, `${nativeId} must have paper evidence`);
}

for (const id of INTENTIONALLY_DISABLED) {
  assert.equal(enabled.strategies.find((row) => row.strategyId === id)?.enabledForPaper, false, `${id} remains disabled`);
}

const paperSafety = config.buildExecutionSafety('ibkr_paper');
const liveSafety = config.buildExecutionSafety('ibkr_live');
for (const safety of [paperSafety, liveSafety]) {
  assert.equal(safety.live_trading_enabled, false);
  assert.equal(safety.live_broker_enabled, false);
  assert.equal(safety.live_order_submission_enabled, false);
  assert.equal(safety.live_account_orders_allowed, false);
  assert.equal(safety.real_orders_blocked, true);
}

console.log('futuresPaperStrategyUniverse.acceptance.test.js passed');
