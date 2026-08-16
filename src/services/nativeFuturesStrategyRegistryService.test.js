'use strict';

// Registret binder ihop native-id (det som hamnar på trades, intents och
// broker-order) med legacy-id (det som strategiöversikt, approvals och
// performance är nycklade på). Utan kopplingen syns migrerade strategier inte
// i Futures Paper UI, och native-stämplade trades landar inte på någon rad.

const assert = require('assert');
const registry = require('./nativeFuturesStrategyRegistryService');
const normalizer = require('./strategyIdNormalizerService');
const catalog = require('./daytradingStrategyCatalogService');

const all = registry.listNativeStrategies();
const migrated = all.filter((row) => row.migrated);

// ---------------------------------------------- registrets innehåll
{
  assert.equal(all.length, 8, 'åtta native-strategier är registrerade hos providern');
  assert.equal(migrated.length, 7, 'sju är migrerade från legacy');

  const nativeOnly = all.filter((row) => !row.migrated);
  assert.deepEqual(
    nativeOnly.map((row) => row.strategyId),
    ['native_futures_momentum_v1'],
    'momentum är native från början och har ingen legacy-förlaga',
  );

  // Inga dubbletter i någon riktning.
  assert.equal(new Set(all.map((r) => r.strategyId)).size, all.length, 'unika native-id');
  assert.equal(
    new Set(migrated.map((r) => r.originStrategyId)).size,
    migrated.length,
    'varje legacy-id har högst en native-implementation',
  );
}

// ---------------------------------------------- varje ursprung finns på riktigt
{
  for (const row of migrated) {
    assert.ok(
      catalog.getStrategyById(row.originStrategyId),
      `${row.strategyId}: ursprunget ${row.originStrategyId} måste finnas i canonical-katalogen`,
    );
    assert.match(row.strategyId, /^native_futures_/, 'native-id har sitt prefix');
    assert.notEqual(row.strategyId, row.originStrategyId, 'native-id och legacy-id är skilda');
  }
}

// ---------------------------------------------- uppslag åt båda hållen
{
  assert.equal(
    registry.originStrategyIdFor('native_futures_trend_continuation_v1'),
    'trend_continuation',
  );
  assert.equal(registry.originStrategyIdFor('native_futures_momentum_v1'), null);
  assert.equal(registry.originStrategyIdFor('trend_continuation'), null, 'legacy-id är inte native');
  assert.equal(registry.originStrategyIdFor('finns_inte'), null);
  assert.equal(registry.originStrategyIdFor(null), null);

  assert.equal(registry.isNativeStrategyId('native_futures_trend_continuation_v1'), true);
  assert.equal(registry.isNativeStrategyId('trend_continuation'), false);

  const sole = registry.soleNativeStrategyForOrigin('trend_continuation');
  assert.equal(sole.strategyId, 'native_futures_trend_continuation_v1');
  assert.equal(sole.targetSignalFamily, 'REGULAR_PULLBACK');
  assert.equal(registry.soleNativeStrategyForOrigin('finns_inte'), null);
  assert.deepEqual(registry.nativeStrategiesForOrigin('finns_inte'), []);

  // Rundresa: native → legacy → native ger samma strategi.
  for (const row of migrated) {
    const back = registry.soleNativeStrategyForOrigin(registry.originStrategyIdFor(row.strategyId));
    assert.equal(back.strategyId, row.strategyId, `rundresa för ${row.strategyId}`);
  }
}

// ---------------------------------------------- normalizern löser native-id
{
  for (const row of migrated) {
    const res = normalizer.normalizeStrategyId(row.strategyId);
    assert.equal(res.status, 'native_futures_migration', row.strategyId);
    assert.equal(res.canonicalStrategyId, row.originStrategyId, row.strategyId);
    assert.equal(res.ambiguous, false);
    assert.deepEqual(res.possibleCanonicalIds, [row.originStrategyId]);
  }

  // Native utan förlaga får ALDRIG gissas till någon canonical strategi.
  const momentum = normalizer.normalizeStrategyId('native_futures_momentum_v1');
  assert.equal(momentum.status, 'native_futures_only');
  assert.equal(momentum.canonicalStrategyId, null);
  assert.deepEqual(momentum.possibleCanonicalIds, []);

  // Okända id:n påverkas inte.
  assert.equal(normalizer.normalizeStrategyId('native_futures_finns_inte_v1').status, 'unknown');
  assert.equal(normalizer.normalizeStrategyId('trend_continuation').status, 'canonical');

  // Förklaringstexten nämner ursprunget, så en människa kan följa kedjan.
  const explained = normalizer.explainStrategyId('native_futures_ema_pullback_continuation_v1');
  assert.match(explained.note, /ema_pullback_continuation/);
}

// ---------------------------------------------- registret är read-only
{
  assert.equal(registry.SAFETY.can_place_orders, false);
  assert.equal(registry.SAFETY.live_trading_enabled, false);
  assert.equal(Object.isFrozen(all), true, 'listan går inte att mutera utifrån');
  assert.equal(Object.isFrozen(all[0]), true, 'descriptorerna går inte att mutera utifrån');
}

console.log('nativeFuturesStrategyRegistryService.test.js passed');
