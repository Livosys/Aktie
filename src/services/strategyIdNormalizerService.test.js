'use strict';

const assert = require('assert/strict');
const svc = require('./strategyIdNormalizerService');

// 1) Exact canonical id returns canonical.
{
  const r = svc.normalizeStrategyId('ema_pullback_continuation');
  assert.equal(r.status, 'canonical');
  assert.equal(r.canonicalStrategyId, 'ema_pullback_continuation');
  assert.equal(r.ambiguous, false);
  assert.equal(r.reason, 'exact_canonical_match');
}

// 2) ema_pullback -> ema_pullback_continuation (legacy alias).
{
  const r = svc.normalizeStrategyId('ema_pullback');
  assert.equal(r.status, 'legacy_alias');
  assert.equal(r.canonicalStrategyId, 'ema_pullback_continuation');
  assert.equal(r.ambiguous, false);
  assert.deepEqual(r.possibleCanonicalIds, ['ema_pullback_continuation']);
}

// 3) vwap_momentum -> vwap_momentum_long (legacy alias).
{
  const r = svc.normalizeStrategyId('vwap_momentum');
  assert.equal(r.status, 'legacy_alias');
  assert.equal(r.canonicalStrategyId, 'vwap_momentum_long');
}

// 4) narrow_state is ambiguous (never auto-resolved).
{
  const r = svc.normalizeStrategyId('narrow_state');
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.ambiguous, true);
  assert.equal(r.canonicalStrategyId, null);
  assert.ok(r.possibleCanonicalIds.length > 1, 'ambiguous must list multiple candidates');
  assert.equal(r.reason, 'legacy_key_matches_multiple_canonical_strategies');
}

// 5) volume_spike is ambiguous (two canonical volume_spike_* strategies).
{
  const r = svc.normalizeStrategyId('volume_spike');
  assert.equal(r.status, 'ambiguous');
  assert.ok(r.possibleCanonicalIds.includes('volume_spike_momentum'));
  assert.ok(r.possibleCanonicalIds.includes('volume_spike_continuation'));
}

// 6) Unknown strategy -> unknown.
{
  const r = svc.normalizeStrategyId('unknown_strategy');
  assert.equal(r.status, 'unknown');
  assert.equal(r.canonicalStrategyId, null);
  assert.equal(r.reason, 'not_found_in_canonical_or_legacy_aliases');
}

// 7) Empty / null / undefined input handled safely.
for (const bad of [null, undefined, '', '   ']) {
  const r = svc.normalizeStrategyId(bad);
  assert.equal(r.status, 'unknown');
  assert.equal(r.canonicalStrategyId, null);
  assert.equal(r.ambiguous, false);
  assert.equal(r.reason, 'empty_or_invalid_input');
}

// 8) Candidate ids actually exist in the canonical catalog (no phantom ids).
{
  const report = svc.buildStrategyNormalizationReport();
  const canonicalSet = new Set(
    report.mappings.filter((m) => m.status === 'canonical').map((m) => m.canonicalStrategyId),
  );
  for (const m of report.mappings) {
    for (const id of m.possibleCanonicalIds) {
      assert.ok(canonicalSet.has(id), `possible id ${id} must be a real canonical strategy`);
    }
  }
}

// 9) Convenience getters.
assert.equal(svc.getCanonicalStrategyId('vwap_rejection'), 'vwap_rejection_short');
assert.equal(svc.getCanonicalStrategyId('narrow_state'), null); // ambiguous => null
assert.equal(svc.explainStrategyId('ema_pullback').note !== null, true);

// 10) Report shape + summary counts are coherent.
{
  const report = svc.buildStrategyNormalizationReport();
  assert.equal(report.canonicalSource, 'daytradingStrategyCatalogService');
  assert.equal(report.registryRole, 'overlay');
  assert.equal(report.legacyRole, 'preset_adapter');
  assert.ok(report.summary.canonicalCount >= 30, 'expected the full canonical catalog');
  assert.ok(report.summary.ambiguousCount >= 1);
  assert.ok(report.summary.legacyAliasCount >= 1);
}

// 11) SAFETY is locked and never affected.
{
  assert.equal(svc.SAFETY.mode, 'paper_only');
  assert.equal(svc.SAFETY.actions_allowed, false);
  assert.equal(svc.SAFETY.can_place_orders, false);
  assert.equal(svc.SAFETY.live_trading_enabled, false);
  assert.equal(svc.SAFETY.broker_enabled, false);
  const report = svc.buildStrategyNormalizationReport();
  assert.equal(report.safety.actions_allowed, false);
  assert.equal(report.safety.can_place_orders, false);
  assert.equal(report.safety.live_trading_enabled, false);
  assert.equal(report.safety.broker_enabled, false);
}

console.log('# strategyIdNormalizerService tests passed.');
