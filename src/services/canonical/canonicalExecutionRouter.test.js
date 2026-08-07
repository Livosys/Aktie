'use strict';

// `node src/services/canonical/canonicalExecutionRouter.test.js`
//
// Routern är FAS 8:s enda beslutsväg. Testerna bevisar tre saker:
//   1. Beslutet kommer från Execution Readiness Engine — inte från kontraktet.
//   2. Den bakåtkompatibla ytan (allowed / reasonCode / entryContractVersion)
//      har oförändrade värdemängder, så nedströms inte kan påverkas.
//   3. Routern ger samma beslut OCH samma reasonCode som dagens kontrakt på
//      frysta produktionskandidater.

const assert = require('assert');
const router = require('./canonicalExecutionRouter');
const engine = require('./executionReadinessEngine');
const adapters = require('./canonicalSignalAdapters');
const entryContracts = require('../paperStrategyEntryContractService');
const fixtures = require('./__fixtures__/productionCandidates.json');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err && err.stack || err}`); process.exitCode = 1; }
}

const FUTURES_CONTEXT = { marketType: 'futures', session: 'globex', sessionId: 'globex', isMarketOpen: true };

// ── 1. Beslutet ägs av motorn ───────────────────────────────────────────────

console.log('  -- beslutskälla --');

test('allowed följer motorns verdict, inte kontraktets', () => {
  for (const fixture of fixtures) {
    const now = new Date(fixture.createdAt);
    const decision = router.routeExecutionReadiness({
      strategyId: fixture.candidate.strategyId, candidate: fixture.candidate, now,
    });
    assert.strictEqual(
      decision.allowed,
      decision.readiness.verdict === engine.VERDICTS.EXECUTABLE,
      'allowed härleds inte ur motorns verdict',
    );
    assert.strictEqual(decision.decisionSource, 'execution_readiness_engine');
  }
});

test('readiness bär motorns egen canonical-kod och version', () => {
  const fixture = fixtures.find((f) => f.expectedVerdict === 'NOT_EXECUTABLE');
  assert.ok(fixture, 'fixture-uppsättningen saknar ett blockerat fall');
  const decision = router.routeExecutionReadiness({
    strategyId: fixture.candidate.strategyId,
    candidate: fixture.candidate,
    now: new Date(fixture.createdAt),
  });
  assert.strictEqual(decision.readiness.reasonCode, fixture.expectedReason);
  assert.strictEqual(decision.readiness.engineVersion, 'execution-readiness-v1');
  assert.ok(Array.isArray(decision.readiness.evidenceGaps));
});

// ── 2. Bakåtkompatibel yta ──────────────────────────────────────────────────

console.log('  -- bakåtkompatibel yta --');

test('reasonCode ligger kvar i dagens värdemängd', () => {
  const legacyCodes = new Set(Object.keys(engine.LEGACY_REASON_MAP));
  for (const fixture of fixtures) {
    const decision = router.routeExecutionReadiness({
      strategyId: fixture.candidate.strategyId,
      candidate: fixture.candidate,
      now: new Date(fixture.createdAt),
    });
    if (decision.reasonCode === null) continue;
    assert.ok(legacyCodes.has(decision.reasonCode), `okänd reasonCode: ${decision.reasonCode}`);
  }
});

test('inversen är entydig — varje legacy-kod mappar tillbaka till sig själv', () => {
  for (const [legacy, canonical] of Object.entries(engine.LEGACY_REASON_MAP)) {
    assert.strictEqual(
      router.CANONICAL_TO_LEGACY_REASON[canonical], legacy,
      `LEGACY_REASON_MAP är inte injektiv vid ${legacy}`,
    );
  }
});

test('entryContractVersion är oförändrad konstant', () => {
  const decision = router.routeExecutionReadiness({
    strategyId: 'ema_pullback_continuation', candidate: {}, now: new Date(),
  });
  assert.strictEqual(decision.entryContractVersion, entryContracts.PAPER_ENTRY_CONTRACT_VERSION);
});

test('identity följer canonical-beslut och readiness-wrapper', () => {
  const decision = router.routeExecutionReadiness({
    strategyId: 'ema_pullback_continuation',
    candidate: {
      lifecycleId: 'life-router-1',
      candidateId: 'cand-router-1',
      signalId: 'sig-router-1',
      strategyId: 'ema_pullback_continuation',
      signalFamily: 'EMA_TREND_PULLBACK',
      signalSubtype: 'EMA_PULLBACK_UP',
      direction: 'long',
      symbol: 'MNQ',
      marketType: 'futures',
      signalTimestamp: '2026-08-07T12:00:00.000Z',
      source: 'trading_os_signal_adapter',
      signalSource: 'trading_os',
    },
    now: new Date('2026-08-07T12:00:30.000Z'),
    marketContext: FUTURES_CONTEXT,
  });
  assert.strictEqual(decision.lifecycleId, 'life-router-1');
  assert.strictEqual(decision.candidateId, 'cand-router-1');
  assert.strictEqual(decision.signalId, 'sig-router-1');
  assert.strictEqual(decision.readiness.lifecycleId, 'life-router-1');
  assert.strictEqual(decision.readiness.candidateId, 'cand-router-1');
  assert.strictEqual(decision.readiness.signalId, 'sig-router-1');
  assert.strictEqual(decision.canonicalSignal.lifecycleId, 'life-router-1');
});

test('allowed är alltid boolean och reasonCode null när den släpper igenom', () => {
  const allowedFixture = fixtures.find((f) => f.expectedOldAllowed === true);
  assert.ok(allowedFixture, 'fixture-uppsättningen saknar ett godkänt fall');
  const decision = router.routeExecutionReadiness({
    strategyId: allowedFixture.candidate.strategyId,
    candidate: allowedFixture.candidate,
    now: new Date(allowedFixture.createdAt),
  });
  assert.strictEqual(decision.allowed, true);
  assert.strictEqual(decision.reasonCode, null);
  assert.strictEqual(decision.reason, null);
});

// ── 3. Producentupplösning ──────────────────────────────────────────────────

console.log('  -- producentupplösning --');

test('märkt native futures ger native-adaptern utan fallback', () => {
  const decision = router.routeExecutionReadiness({
    strategyId: 'mnq_globex_momentum_v1',
    candidate: { strategyId: 'mnq_globex_momentum_v1', signalSource: 'futures_native_mnq_candles' },
    now: new Date(),
    marketContext: FUTURES_CONTEXT,
  });
  assert.strictEqual(decision.readiness.producerType, 'futures_native');
  assert.strictEqual(decision.readiness.producerFallback, false);
});

test('märkt trading_os ger TradingOS-adaptern utan fallback', () => {
  const decision = router.routeExecutionReadiness({
    strategyId: 'narrow_breakout',
    candidate: { strategyId: 'narrow_breakout', signalSource: 'trading_os' },
    now: new Date(),
    marketContext: FUTURES_CONTEXT,
  });
  assert.strictEqual(decision.readiness.producerType, 'tradingos_decision_monitor');
  assert.strictEqual(decision.readiness.producerFallback, false);
});

test('omärkt producent faller tillbaka på TradingOS och FLAGGAS', () => {
  const candidate = { strategyId: 'narrow_breakout', source: 'futures_paper_scanner' };
  assert.strictEqual(adapters.adapterFor(candidate), null, 'förutsättningen har ändrats: adapterFor gissar nu');
  const decision = router.routeExecutionReadiness({
    strategyId: 'narrow_breakout', candidate, now: new Date(), marketContext: FUTURES_CONTEXT,
  });
  assert.strictEqual(decision.readiness.producerType, 'tradingos_decision_monitor');
  assert.strictEqual(decision.readiness.producerFallback, true);
});

test('explicit strategyId vinner över kandidatens — samma företräde som kontraktet', () => {
  const candidate = { strategyId: 'narrow_breakout', signalSource: 'trading_os' };
  const decision = router.routeExecutionReadiness({
    strategyId: 'ema_pullback_continuation', candidate, now: new Date(), marketContext: FUTURES_CONTEXT,
  });
  assert.strictEqual(decision.strategyId, 'ema_pullback_continuation');
  assert.strictEqual(decision.canonicalSignal.strategyId, 'ema_pullback_continuation');
  assert.strictEqual(decision.readiness.policyId, 'contract:ema_pullback_continuation');
});

// ── 4. Identitet mot dagens kontrakt ────────────────────────────────────────

console.log('  -- identitet mot paperStrategyEntryContractService --');

test('samma beslut OCH samma reasonCode på frysta produktionskandidater', () => {
  for (const fixture of fixtures) {
    const now = new Date(fixture.createdAt);
    const legacy = entryContracts.evaluatePaperEntryContract({
      strategyId: fixture.candidate.strategyId, candidate: fixture.candidate, now,
    });
    const routed = router.routeExecutionReadiness({
      strategyId: fixture.candidate.strategyId, candidate: fixture.candidate, now,
    });
    assert.strictEqual(
      routed.allowed, legacy.allowed === true,
      `beslutet skiljer sig för ${fixture.candidate.candidateId}`,
    );
    assert.strictEqual(
      routed.reasonCode, legacy.reasonCode,
      `reasonCode skiljer sig för ${fixture.candidate.candidateId}`,
    );
    assert.strictEqual(routed.entryContractVersion, legacy.entryContractVersion);
  }
});

// Mutationstest: skulle identitetstestet ovan alls kunna falla? Om routern
// slutade läsa motorn och alltid sa ja måste testet gå sönder.
console.log('  -- mutationstest --');

test('identitetstestet faller om beslutet frikopplas från motorn', () => {
  const blocked = fixtures.find((f) => f.expectedOldAllowed === false);
  assert.ok(blocked, 'fixture-uppsättningen saknar ett blockerat fall');
  const now = new Date(blocked.createdAt);
  const legacy = entryContracts.evaluatePaperEntryContract({
    strategyId: blocked.candidate.strategyId, candidate: blocked.candidate, now,
  });
  assert.strictEqual(legacy.allowed, false);
  const routed = router.routeExecutionReadiness({
    strategyId: blocked.candidate.strategyId, candidate: blocked.candidate, now,
  });
  // Ett "alltid true" hade gett allowed=true här — testet ovan hade fallit.
  assert.strictEqual(routed.allowed, false);
  assert.notStrictEqual(routed.reasonCode, null);
});

console.log(`\n${passed} test(er) passerade`);
