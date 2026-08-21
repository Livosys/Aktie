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

// ---------------------------------------------- registrerade parametervarianter
{
  // Utan flaggan är listan ordagrant densamma som förut. Paper-vägen kallar så.
  assert.equal(registry.listStrategyEvaluators().length, all.length);
  assert.equal(registry.listNativeStrategies().length, all.length);

  const withVariants = registry.listNativeStrategies({ includeVariants: true });
  const evaluators = registry.listStrategyEvaluators({ includeVariants: true });
  assert.equal(evaluators.length, withVariants.length,
    'varje registrerad variant måste ha exakt en evaluator');
  assert.ok(withVariants.length > all.length,
    'registret innehåller varianter men ingen av dem blev körbar');

  // Varje id måste vara unikt. Två evaluators med samma id ger identiska
  // signal-id, och replay kastar då tyst alla utom den första.
  const ids = evaluators.map((row) => row.strategyId);
  assert.equal(new Set(ids).size, ids.length, 'dubblerat strategy-id bland evaluators');

  const variants = withVariants.filter((row) => row.variantId);
  for (const row of variants) {
    // Varianten är registrets id, inte ett tredje namnrum.
    assert.match(row.strategyId, /__/, row.strategyId);
    assert.ok(row.baseStrategyId, `${row.strategyId} saknar basmodul`);
    assert.ok(registry.getNativeStrategy(row.baseStrategyId), `${row.baseStrategyId} finns inte`);
    assert.equal(registry.isNativeStrategyId(row.strategyId), true, row.strategyId);

    // Parametrarna ska komma från registret/DNA, inte från modulens defaults.
    const base = registry.getNativeStrategy(row.baseStrategyId);
    const differs = Object.entries(row.defaultOptions)
      .some(([key, value]) => base.defaultOptions[key] !== value);
    assert.ok(differs, `${row.strategyId} har samma parametrar som sin bas — då är den en dubblett`);
  }
}

// ---------------------------------------------- varianten kör basens kod
{
  const evaluators = registry.listStrategyEvaluators({ includeVariants: true });
  const variant = registry.listNativeStrategies({ includeVariants: true })
    .find((row) => row.variantId);
  const row = evaluators.find((entry) => entry.strategyId === variant.strategyId);

  // En tom snapshot ger NO_SIGNAL i varje strategi. Poängen här är inte
  // beslutet utan IDENTITETEN: registret stämplar om beslutet till variantens
  // id, annars blir alla varianters signal-id identiska.
  const decision = row.evaluate({}, { now: new Date('2026-08-18T14:00:00.000Z') });
  if (decision && typeof decision === 'object' && decision.strategyId) {
    assert.equal(decision.strategyId, variant.strategyId,
      'variantens beslut bär basens id — signal-id skulle kollidera');
  }
}

// ---------------------------------------------- muterade genom är körbara
{
  // Ett genom i släktträdet måste kunna prövas, annars producerar Evolution
  // Engine bara föräldralösa noder.
  const { evolvedOptionsFor, EVOLVED_ID_SEPARATOR } = registry._internal;

  // En strategi som faktiskt deklarerar takeProfitR — momentumstrategin har
  // ett eget parameternamn (rewardMultiple) och hade gjort testet meningslöst.
  const base = all.find((row) => 'takeProfitR' in row.defaultOptions);
  assert.ok(base, 'ingen strategi deklarerar takeProfitR');
  const fakeTree = {
    ancestryOf: () => [
      { dnaHash: 'root', mutation: null },
      { dnaHash: 'child', mutation: { changes: { 'exit.takeProfitR': 9.5, 'entry.familyName': 'Ignoreras' } } },
    ],
  };
  const options = evolvedOptionsFor(fakeTree, { dnaHash: 'child' }, base.defaultOptions, Object.keys(base.defaultOptions));
  assert.equal(options.takeProfitR, 9.5, 'ackumulerad ändring nådde inte fram');
  assert.equal(options.familyName, undefined, 'en beskrivande etikett är inte en parameter');
  assert.equal(options.tickSize, base.defaultOptions.tickSize, 'orörda parametrar ska behållas');

  // En ändring strategin inte kan läsa ska inte ge ett körbart genom.
  const noop = evolvedOptionsFor(
    { ancestryOf: () => [{ dnaHash: 'child', mutation: { changes: { 'entry.marketLabel': 'Index' } } }] },
    { dnaHash: 'child' },
    base.defaultOptions,
    Object.keys(base.defaultOptions),
  );
  assert.equal(noop, null);

  assert.equal(EVOLVED_ID_SEPARATOR, '@');
  // Utan flaggan finns inga muterade genom i listan.
  assert.equal(
    registry.listStrategyEvaluators({ includeVariants: true }).some((row) => row.strategyId.includes('@')),
    false,
  );
}

console.log('nativeFuturesStrategyRegistryService.test.js passed');
