'use strict';

// `node src/services/canonical/canonicalSignal.test.js`
// Ren modellmodul — inga filer, ingen live-data, inga sidoeffekter.

const assert = require('assert');
const {
  createCanonicalSignal,
  validateCanonicalSignal,
  buildEvidence,
  FORBIDDEN_FIELDS,
  REQUIRED_FIELDS,
  EXTENSION_MEASURES,
  CANONICAL_SIGNAL_VERSION,
} = require('./canonicalSignal');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err && err.stack || err}`); process.exitCode = 1; }
}

function validInput(overrides = {}) {
  return {
    signalId: 'TSLA_2026-08-04T18:12:00.000Z',
    producerId: 'tradingos_decision_monitor',
    producerType: 'tradingos_decision_monitor',
    strategyId: 'ema_pullback_continuation',
    signalFamily: 'EMA_TREND_PULLBACK',
    signalSubtype: 'EMA_PULLBACK_UP',
    direction: 'LONG',
    symbol: 'MNQ',
    marketType: 'stocks',
    signalTimestamp: '2026-08-04T18:12:00.000Z',
    entry: 29876,
    stopLoss: 29822.22,
    takeProfit: 29950.69,
    ...overrides,
  };
}

console.log('canonicalSignal');

// ── Modellen bär endast fakta ────────────────────────────────────────────────

test('createCanonicalSignal ger giltig signal av giltig indata', () => {
  const signal = createCanonicalSignal(validInput());
  const result = validateCanonicalSignal(signal);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.strictEqual(signal.canonicalVersion, CANONICAL_SIGNAL_VERSION);
});

test('createCanonicalSignal STRIPPAR förbjudna fält som skickas in', () => {
  const input = validInput({
    status: 'caution',
    signalStatus: 'ready',
    priority: 'watch',
    entryReady: true,
    approved: true,
    canTrade: true,
    executionStatus: 'ok',
    producerEntryReadiness: { entryReady: true },
  });
  const signal = createCanonicalSignal(input);
  for (const field of FORBIDDEN_FIELDS) {
    assert.ok(!Object.prototype.hasOwnProperty.call(signal, field), `fältet ${field} läckte in i signalen`);
  }
  assert.strictEqual(validateCanonicalSignal(signal).ok, true);
});

test('signalen exponerar inget oväntat toppnivåfält', () => {
  const signal = createCanonicalSignal(validInput());
  const allowed = new Set([
    'canonicalVersion', 'signalId', 'producerId', 'producerType', 'strategyId',
    'signalFamily', 'signalSubtype', 'direction', 'symbol', 'marketType',
    'signalTimestamp', 'entry', 'stopLoss', 'takeProfit', 'evidence', 'metadata',
    'mode', 'actions_allowed', 'can_place_orders', 'live_trading_enabled',
    'broker_enabled', 'source',
  ]);
  for (const key of Object.keys(signal)) {
    assert.ok(allowed.has(key), `oväntat toppnivåfält: ${key}`);
  }
});

// ── Förbjudna advisoryfält avvisas ───────────────────────────────────────────

const FORBIDDEN_UNDER_TEST = [
  'ready', 'priority', 'status', 'signalStatus', 'watch', 'wait', 'avoid',
  'caution', 'entryReady', 'producerEntryReadiness', 'approved', 'canTrade',
  'executionStatus',
];

for (const field of FORBIDDEN_UNDER_TEST) {
  test(`validate avvisar förbjudet fält: ${field}`, () => {
    const signal = { ...createCanonicalSignal(validInput()), [field]: 'x' };
    const result = validateCanonicalSignal(signal);
    assert.strictEqual(result.ok, false, `${field} borde ha underkänts`);
    assert.ok(
      result.errors.includes(`forbidden_field:${field}`),
      `felmeddelandet pekar inte ut ${field}; fick ${JSON.stringify(result.errors)}`,
    );
  });
}

test('samtliga FORBIDDEN_FIELDS täcks av testlistan ovan', () => {
  for (const field of FORBIDDEN_FIELDS) {
    const covered = FORBIDDEN_UNDER_TEST.includes(field)
      || ['registryGatePending', 'executionGate'].includes(field);
    assert.ok(covered, `FORBIDDEN_FIELDS innehåller ${field} som inget test täcker`);
  }
});

test('flera förbjudna fält rapporteras var för sig', () => {
  const signal = { ...createCanonicalSignal(validInput()), status: 'x', priority: 'y', canTrade: true };
  const result = validateCanonicalSignal(signal);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.includes('forbidden_field:status'));
  assert.ok(result.errors.includes('forbidden_field:priority'));
  assert.ok(result.errors.includes('forbidden_field:canTrade'));
});

// ── Obligatoriska fält ───────────────────────────────────────────────────────

for (const field of REQUIRED_FIELDS) {
  test(`validate underkänner saknat obligatoriskt fält: ${field}`, () => {
    const signal = createCanonicalSignal(validInput());
    signal[field] = null;
    const result = validateCanonicalSignal(signal);
    assert.strictEqual(result.ok, false);
    assert.ok(
      result.errors.includes(`missing_required_field:${field}`),
      `felmeddelandet pekar inte ut ${field}; fick ${JSON.stringify(result.errors)}`,
    );
  });
}

test('strategyId = null är ett FEL, inte ett tillstånd', () => {
  const signal = createCanonicalSignal(validInput({ strategyId: null }));
  const result = validateCanonicalSignal(signal);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.includes('missing_required_field:strategyId'));
});

// ── Uppräkningar ─────────────────────────────────────────────────────────────

test('validate underkänner ogiltig direction', () => {
  const signal = createCanonicalSignal(validInput({ direction: 'SIDEWAYS' }));
  const result = validateCanonicalSignal(signal);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith('invalid_direction:')));
});

test('direction normaliseras till versaler', () => {
  assert.strictEqual(createCanonicalSignal(validInput({ direction: 'long' })).direction, 'LONG');
});

test('validate underkänner okänd producerType', () => {
  const signal = createCanonicalSignal(validInput({ producerType: 'nonsense' }));
  const result = validateCanonicalSignal(signal);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith('invalid_producer_type:')));
});

test('validate underkänner okänt extension-mått', () => {
  const signal = createCanonicalSignal(validInput());
  signal.evidence.extension.measure = 'gut_feeling';
  const result = validateCanonicalSignal(signal);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith('invalid_extension_measure:')));
});

test('båda kända extension-måtten accepteras', () => {
  for (const measure of EXTENSION_MEASURES) {
    const signal = createCanonicalSignal(validInput());
    signal.evidence.extension.measure = measure;
    assert.strictEqual(validateCanonicalSignal(signal).ok, true, `${measure} underkändes`);
  }
});

// ── Evidence: närvaro obligatorisk, innehåll valfritt ────────────────────────

test('evidence-grenarna är alltid närvarande även vid tom indata', () => {
  const evidence = buildEvidence({});
  for (const branch of ['extension', 'volume', 'timeframes', 'candle', 'context']) {
    assert.ok(Object.prototype.hasOwnProperty.call(evidence, branch), `saknar gren: ${branch}`);
  }
  assert.ok(Object.prototype.hasOwnProperty.call(evidence, 'confirmations'));
});

test('aldrig mätt ger null — inte false — så motorn kan skilja dem åt', () => {
  const evidence = buildEvidence({});
  assert.strictEqual(evidence.extension.level, null);
  assert.strictEqual(evidence.extension.value, null);
  assert.strictEqual(evidence.volume.rvol, null);
  assert.strictEqual(evidence.candle.closedCandleConfirmed, null);
  assert.strictEqual(evidence.confirmations, null, 'confirmations ska vara null när den aldrig utvärderats');
});

test('mätt och falsk skiljs från aldrig mätt', () => {
  const evidence = buildEvidence({ candle: { closedCandleConfirmed: false }, confirmations: [] });
  assert.strictEqual(evidence.candle.closedCandleConfirmed, false);
  assert.deepStrictEqual(evidence.confirmations, []);
});

test('icke-numeriska värden blir null, inte NaN', () => {
  const evidence = buildEvidence({ extension: { value: 'abc' }, volume: { rvol: undefined } });
  assert.strictEqual(evidence.extension.value, null);
  assert.strictEqual(evidence.volume.rvol, null);
});

test('confirmations kopieras, inte delas', () => {
  const source = ['two_minute_confirmation'];
  const evidence = buildEvidence({ confirmations: source });
  source.push('muterad');
  assert.deepStrictEqual(evidence.confirmations, ['two_minute_confirmation']);
});

console.log(`\ncanonicalSignal: ${passed} tester ok`);
