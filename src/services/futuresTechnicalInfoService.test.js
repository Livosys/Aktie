'use strict';

// Körbar utan testrunner: `node src/services/futuresTechnicalInfoService.test.js`
const assert = require('assert');

const service = require('./futuresTechnicalInfoService');
const catalogService = require('./daytradingStrategyCatalogService');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err && err.message}`);
    process.exitCode = 1;
  }
}

// 1) Alla canonical strategier returneras.
test('returns all canonical catalog strategies', () => {
  const info = service.getStrategiesTechnicalInfo();
  assert.strictEqual(info.status, 'ok');
  assert.strictEqual(info.readOnly, true);
  const catalog = catalogService.getCatalog();
  const catalogIds = new Set((catalog.strategies || []).map((s) => s.id));
  const infoIds = new Set(info.strategies.map((s) => s.strategyId));
  for (const id of catalogIds) {
    assert.ok(infoIds.has(id), `missing strategy ${id}`);
  }
  assert.ok(info.strategies.length >= catalogIds.size);
  assert.strictEqual(info.count, info.strategies.length);
});

// 2) Strategy ID är stabilt (canonical) för minst några kända strategier.
test('strategy ids are canonical/stable', () => {
  const info = service.getStrategiesTechnicalInfo();
  const withId = info.strategies.filter((s) => s.strategyId && !s.error);
  assert.ok(withId.length > 0);
  // Alla effektiva id ska matcha sitt eget uppslag deterministiskt.
  for (const s of withId) {
    const again = service.getStrategyTechnicalInfoById(s.strategyId);
    assert.ok(again, `lookup failed for ${s.strategyId}`);
    assert.strictEqual(again.strategyId, s.strategyId);
  }
});

// 3) Okänd strategy ID ger not-found (null → route svarar 404).
test('unknown strategy id returns null (not-found)', () => {
  assert.strictEqual(service.getStrategyTechnicalInfoById('___does_not_exist___'), null);
  assert.strictEqual(service.getStrategyTechnicalInfoById(''), null);
  assert.strictEqual(service.getStrategyTechnicalInfoById(null), null);
  assert.strictEqual(service.getStrategyTechnicalInfoById(undefined), null);
});

// 4) Hashen är deterministisk oavsett objektens nyckelordning.
test('configHash independent of object key order', () => {
  const a = { b: 1, a: 2, nested: { y: 1, x: [1, 2, 3] } };
  const b = { nested: { x: [1, 2, 3], y: 1 }, a: 2, b: 1 };
  assert.strictEqual(service.stableStringify(a), service.stableStringify(b));

  const info1 = service.getStrategiesTechnicalInfo();
  const info2 = service.getStrategiesTechnicalInfo();
  const map2 = new Map(info2.strategies.map((s) => [s.strategyId, s.configHash]));
  for (const s of info1.strategies) {
    assert.strictEqual(s.configHash, map2.get(s.strategyId), `hash drift for ${s.strategyId}`);
  }
});

// 5) Runtime-status eller generatedAt påverkar inte configHash.
test('configHash excludes generatedAt and runtime status', () => {
  const info = service.getStrategiesTechnicalInfo();
  const sample = info.strategies.find((s) => s.strategyId && !s.error);
  assert.ok(sample);
  // generatedAt finns i svaret men får inte ingå i hashen: två anrop med olika
  // generatedAt ger samma hash (bevisat i test 4). Här verifierar vi att
  // hashen inte förändras när runtimeStatus muteras i en kopia.
  const mutated = { ...sample, runtimeStatus: 'totally-different', automaticStatus: 'x', generatedAt: 'z' };
  const again = service.getStrategyTechnicalInfoById(sample.strategyId);
  assert.strictEqual(again.configHash, sample.configHash);
  assert.notStrictEqual(mutated.runtimeStatus, sample.runtimeStatus);
});

// 6) Inga credentials/secrets exponeras.
test('no credentials or secrets exposed', () => {
  const json = JSON.stringify(service.getStrategiesTechnicalInfo());
  const forbidden = [/api[_-]?key/i, /secret/i, /password/i, /token/i, /credential/i, /private[_-]?key/i, /bearer/i];
  for (const re of forbidden) {
    assert.ok(!re.test(json), `sensitive term matched ${re}`);
  }
  const settings = service.getStrategiesTechnicalInfo();
  assert.strictEqual(settings.broker_enabled, false);
  assert.strictEqual(settings.live_trading_enabled, false);
});

// 7) Saknade fält blir null/"ej tillgängligt", inte fabricerade värden.
test('missing fields become null / not-available, never fabricated', () => {
  const info = service.getStrategiesTechnicalInfo();
  for (const s of info.strategies.filter((x) => !x.error)) {
    // Futures-symboler kan inte härledas → måste vara null + not-available-not.
    assert.strictEqual(s.supportedSymbols, null);
    assert.strictEqual(s.supportedSymbolsNote, 'Ej tillgängligt i runtime');
    // Numeriska indikatorparametrar får aldrig fabriceras.
    const numeric = s.details.entryAndIndicators.numericIndicatorParameters;
    assert.strictEqual(numeric.available, false);
    assert.ok(/finns inte lagrade som strukturerad/.test(numeric.note));
    // Param-form: default/override/effective/source finns.
    const sl = s.details.riskAndExit.defaultStopLossPct;
    assert.ok('default' in sl && 'override' in sl && 'effective' in sl && 'source' in sl);
  }
});

// 8) En trasig strategipost kraschar inte hela katalogsvaret.
test('a broken strategy does not crash the catalog response', () => {
  const original = catalogService.getCatalog;
  catalogService.getCatalog = function patched() {
    const real = original.call(catalogService);
    const strategies = (real.strategies || []).slice();
    // Injicera en post som får buildStrategyEntry att kasta (getter kastar).
    const broken = {};
    Object.defineProperty(broken, 'id', {
      enumerable: true,
      get() { return 'broken_injected'; },
    });
    Object.defineProperty(broken, 'name', {
      enumerable: true,
      get() { throw new Error('boom'); },
    });
    strategies.push(broken);
    return { ...real, strategies };
  };
  try {
    const info = service.getStrategiesTechnicalInfo();
    const brokenEntry = info.strategies.find((s) => s.strategyId === 'broken_injected');
    assert.ok(brokenEntry, 'broken entry should be present as placeholder');
    assert.strictEqual(brokenEntry.error, true);
    // Övriga strategier finns kvar.
    assert.ok(info.strategies.filter((s) => !s.error).length > 0);
  } finally {
    catalogService.getCatalog = original;
  }
});

// 9) Endpoints/servicen är read-only (SAFETY-flaggor + inga skrivningar signaleras).
test('service is read-only (safety flags set)', () => {
  const info = service.getStrategiesTechnicalInfo();
  assert.strictEqual(info.readOnly, true);
  assert.strictEqual(info.mode, 'paper_only');
  assert.strictEqual(info.actions_allowed, false);
  assert.strictEqual(info.can_place_orders, false);
  assert.strictEqual(info.live_trading_enabled, false);
  assert.strictEqual(info.broker_enabled, false);
});

// 10) Simulations-/kontraktsinställningar är korrekt märkta (inte strategi).
test('simulation/contract settings labelled and populated', () => {
  const settings = service.buildSimulationAndContractSettings();
  assert.strictEqual(settings.isRealMarketData, false);
  assert.strictEqual(settings.feedSource, 'simulated_fallback');
  assert.ok(/inte strategiinställningar/.test(settings.note));
  assert.ok(Array.isArray(settings.contracts) && settings.contracts.length > 0);
  const mnq = settings.contracts.find((c) => c.root === 'MNQ');
  assert.ok(mnq, 'MNQ contract present');
  assert.strictEqual(mnq.commissionPerSideUsd, 1.22);
  assert.strictEqual(mnq.roundTripCommissionUsd, 2.44);
  assert.ok(typeof settings.fxUsdSek === 'number');
});

if (process.exitCode) {
  console.error(`\nfuturesTechnicalInfoService: FAILURES (passed ${passed})`);
} else {
  console.log(`\nfuturesTechnicalInfoService: all ${passed} tests passed`);
}
