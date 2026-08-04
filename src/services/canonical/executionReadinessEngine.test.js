'use strict';

// `node src/services/canonical/executionReadinessEngine.test.js`
// Motorn är ren funktion. Regressionsdelen läser en fryst fixture-fil med
// verkliga produktionskandidater — aldrig live-data.

const assert = require('assert');
const engine = require('./executionReadinessEngine');
const adapters = require('./canonicalSignalAdapters');
const { createCanonicalSignal } = require('./canonicalSignal');
const entryContracts = require('../paperStrategyEntryContractService');
const fixtures = require('./__fixtures__/productionCandidates.json');

const { VERDICTS, REASONS } = engine;

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err && err.stack || err}`); process.exitCode = 1; }
}

const NOW = new Date('2026-08-04T18:14:22.000Z');

// Basfall: en signal som passerar ALLA grindar för ema_pullback_continuation.
// Varje test nedan bryter exakt en sak och kontrollerar att rätt reasonCode
// faller ut. Går basfallet sönder faller hela sviten — avsiktligt.
function baseSignal(overrides = {}, evidenceOverrides = {}) {
  return createCanonicalSignal({
    signalId: 'TSLA_2026-08-04T18:12:00.000Z',
    producerId: 'tradingos_decision_monitor',
    producerType: 'tradingos_decision_monitor',
    strategyId: 'ema_pullback_continuation',
    signalFamily: 'EMA_TREND_PULLBACK',
    signalSubtype: 'EMA_PULLBACK_UP',
    direction: 'LONG',
    symbol: 'MNQ',
    marketType: 'stocks',
    signalTimestamp: '2026-08-04T18:14:00.000Z',
    entry: 29876,
    stopLoss: 29822.22,
    takeProfit: 29950.69,
    evidence: {
      extension: { measure: 'price_to_zone_atr', value: 0.4, level: 'none' },
      volume: { rvol: 1.2, state: 'normal' },
      timeframes: { tf2m: 'bullish', agreementCount: 5 },
      candle: { closedCandleConfirmed: true, candleTimestamp: '2026-08-04T18:12:00.000Z', signalAgeMs: 22000 },
      confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'ema_pullback_reclaim', 'volume_confirmation'],
      // OBS: spread FÖRE context, annars ersätter en partiell context-override
      // hela objektet och tar med sig session/dataFreshness i fallet.
      ...evidenceOverrides,
      context: {
        dataFreshness: 'LIVE', session: 'us_rth', sessionTokens: ['us_rth'], isRth: true, marketClosed: false,
        emaContextPresent: true, vwapContextPresent: true, trendIntact: true,
        lateOrExtended: false, observationTextOnly: false,
        ...(evidenceOverrides.context || {}),
      },
    },
    ...overrides,
  });
}

function evaluate(signal, { advisory = 'active', policy = null, now = NOW } = {}) {
  return engine.evaluate({ canonicalSignal: signal, legacyAdvisory: advisory, now, policy });
}

console.log('executionReadinessEngine');

// ── Basfallet ────────────────────────────────────────────────────────────────

test('BASFALL: en fullständig signal blir EXECUTABLE', () => {
  const r = evaluate(baseSignal());
  assert.strictEqual(r.verdict, VERDICTS.EXECUTABLE, `blockerades på ${r.reasonCode}`);
  assert.strictEqual(r.reasonCode, null);
  assert.strictEqual(r.policyId, 'contract:ema_pullback_continuation');
});

test('verdict, reasonCode, policyId och evaluatedAt finns alltid', () => {
  const r = evaluate(baseSignal());
  for (const key of ['verdict', 'reasonCode', 'policyId', 'evaluatedAt', 'engineVersion', 'evidenceGaps']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, key), `saknar ${key}`);
  }
});

// ── Struktur ─────────────────────────────────────────────────────────────────

test('saknad strategyId → STRUCTURE_MISSING_STRATEGY_ID', () => {
  const r = evaluate(baseSignal({ strategyId: null }));
  assert.strictEqual(r.verdict, VERDICTS.NOT_EXECUTABLE);
  assert.strictEqual(r.reasonCode, REASONS.STRUCTURE_MISSING_STRATEGY_ID);
});

test('strategi utan kontrakt → STRUCTURE_MISSING_POLICY', () => {
  const r = evaluate(baseSignal({ strategyId: 'trend_continuation' }));
  assert.strictEqual(r.reasonCode, REASONS.STRUCTURE_MISSING_POLICY);
});

test('allowedSubtypes: fel subtyp → STRUCTURE_SUBTYPE_NOT_ALLOWED', () => {
  const r = evaluate(baseSignal({ signalSubtype: 'NARROW_WAIT' }));
  assert.strictEqual(r.reasonCode, REASONS.STRUCTURE_SUBTYPE_NOT_ALLOWED);
  assert.strictEqual(r.detail.observed, 'NARROW_WAIT');
});

test('allowedDirections: SHORT på long-only-kontrakt → STRUCTURE_DIRECTION_NOT_ALLOWED', () => {
  const r = evaluate(baseSignal({ direction: 'SHORT' }));
  assert.strictEqual(r.reasonCode, REASONS.STRUCTURE_DIRECTION_NOT_ALLOWED);
});

test('allowedDirections: båda riktningar tillåts av narrow_breakout', () => {
  const long = evaluate(baseSignal({ strategyId: 'narrow_breakout', signalSubtype: 'NARROW_BULL_ENTRY', direction: 'LONG' }));
  const short = evaluate(baseSignal({ strategyId: 'narrow_breakout', signalSubtype: 'NARROW_BEAR_ENTRY', direction: 'SHORT' }));
  assert.notStrictEqual(long.reasonCode, REASONS.STRUCTURE_DIRECTION_NOT_ALLOWED);
  assert.notStrictEqual(short.reasonCode, REASONS.STRUCTURE_DIRECTION_NOT_ALLOWED);
});

test('marketType: futures-signal på stocks-kontrakt → STRUCTURE_MARKET_TYPE_MISMATCH', () => {
  const r = evaluate(baseSignal({
    strategyId: 'vwap_volume_breakout_long', signalSubtype: 'VWAP_RECLAIM_UP', marketType: 'futures',
  }, {
    confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'vwap_reclaim_confirmation', 'volume_confirmation'],
    context: { session: 'rth', sessionTokens: ['rth'] },
  }));
  assert.strictEqual(r.reasonCode, REASONS.STRUCTURE_MARKET_TYPE_MISMATCH);
});

// ── Producentomdöme (deprekerat) ─────────────────────────────────────────────

for (const [advisory, expected] of [
  ['watch', REASONS.QUALITY_ADVISORY_WATCH],
  ['observe', REASONS.QUALITY_ADVISORY_WATCH],
  ['caution', REASONS.QUALITY_ADVISORY_CAUTION],
  ['wait', REASONS.QUALITY_ADVISORY_NOT_READY],
  ['avoid', REASONS.QUALITY_ADVISORY_NOT_READY],
  ['', REASONS.QUALITY_ADVISORY_NOT_READY],
]) {
  test(`advisory "${advisory}" → ${expected}`, () => {
    assert.strictEqual(evaluate(baseSignal(), { advisory }).reasonCode, expected);
  });
}

for (const advisory of ['active', 'ready', 'confirmed', 'entry_ready', 'queued']) {
  test(`advisory "${advisory}" passerar grinden`, () => {
    assert.strictEqual(evaluate(baseSignal(), { advisory }).verdict, VERDICTS.EXECUTABLE);
  });
}

// ── Färskhet ─────────────────────────────────────────────────────────────────

test('maxSignalAge: ålder över gränsen → CONTEXT_DATA_STALE', () => {
  const r = evaluate(baseSignal({}, { candle: { closedCandleConfirmed: true, signalAgeMs: 999999 } }));
  assert.strictEqual(r.reasonCode, REASONS.CONTEXT_DATA_STALE);
  assert.strictEqual(r.detail.maxSignalAgeMs, 180000);
});

test('maxSignalAge: precis under gränsen passerar', () => {
  const r = evaluate(baseSignal({}, { candle: { closedCandleConfirmed: true, signalAgeMs: 179999 } }));
  assert.strictEqual(r.verdict, VERDICTS.EXECUTABLE);
});

test('maxSignalAge: exakt på gränsen passerar (>, inte >=)', () => {
  const r = evaluate(baseSignal({}, { candle: { closedCandleConfirmed: true, signalAgeMs: 180000 } }));
  assert.strictEqual(r.verdict, VERDICTS.EXECUTABLE);
});

test('saknad signalålder → CONTEXT_DATA_STALE', () => {
  const r = evaluate(baseSignal({}, { candle: { closedCandleConfirmed: true, signalAgeMs: null } }));
  assert.strictEqual(r.reasonCode, REASONS.CONTEXT_DATA_STALE);
  assert.strictEqual(r.detail.missingSignalTimestamp, true);
});

for (const freshness of ['STALE', 'DELAYED', 'MISSING', 'UNKNOWN']) {
  test(`dataFreshness "${freshness}" → CONTEXT_DATA_STALE`, () => {
    const r = evaluate(baseSignal({}, { context: { dataFreshness: freshness } }));
    assert.strictEqual(r.reasonCode, REASONS.CONTEXT_DATA_STALE);
  });
}

test('mnq_globex har 15 min åldersfönster — ärvt ur kontraktet', () => {
  const policy = engine.policyForStrategy('mnq_globex_momentum_v1');
  assert.strictEqual(policy.maxSignalAgeMs, 900000);
});

// ── Session och marknadsläge ─────────────────────────────────────────────────

test('marketClosed → CONTEXT_MARKET_CLOSED', () => {
  const r = evaluate(baseSignal({}, { context: { marketClosed: true } }));
  assert.strictEqual(r.reasonCode, REASONS.CONTEXT_MARKET_CLOSED);
});

test('requiredSessions: otillåten session → STRUCTURE_SESSION_NOT_ALLOWED', () => {
  const r = evaluate(baseSignal({
    strategyId: 'vwap_volume_breakout_long', signalSubtype: 'VWAP_RECLAIM_UP',
  }, {
    confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'vwap_reclaim_confirmation', 'volume_confirmation'],
    context: { session: 'asia', sessionTokens: ['asia'], isRth: false },
  }));
  assert.strictEqual(r.reasonCode, REASONS.STRUCTURE_SESSION_NOT_ALLOWED);
});

test('requiresMarketOpen=false ⇒ sessionen grindas inte', () => {
  const r = evaluate(baseSignal({}, { context: { session: 'asia', sessionTokens: ['asia'], isRth: false } }));
  assert.strictEqual(engine.policyForStrategy('ema_pullback_continuation').requiresMarketOpen, false);
  assert.strictEqual(r.verdict, VERDICTS.EXECUTABLE);
});

// ── Bekräftelser ─────────────────────────────────────────────────────────────

test('requiresClosedCandle: ej stängd candle → QUALITY_CLOSED_CANDLE_MISSING', () => {
  const r = evaluate(baseSignal({}, { candle: { closedCandleConfirmed: false, signalAgeMs: 22000 } }));
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_CLOSED_CANDLE_MISSING);
});

test('requiredConfirmations: saknad ema_pullback_reclaim → QUALITY_EMA_CONFIRMATION_MISSING', () => {
  const r = evaluate(baseSignal({}, {
    confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'volume_confirmation'],
  }));
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_EMA_CONFIRMATION_MISSING);
});

test('requiresEmaContext: saknad ema-kontext → QUALITY_EMA_CONFIRMATION_MISSING', () => {
  const r = evaluate(baseSignal({}, { context: { emaContextPresent: false } }));
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_EMA_CONFIRMATION_MISSING);
  assert.strictEqual(r.detail.missingEmaContext, true);
});

test('requiresEmaContext: bruten trend → QUALITY_EMA_CONFIRMATION_MISSING', () => {
  const r = evaluate(baseSignal({}, { context: { trendIntact: false } }));
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_EMA_CONFIRMATION_MISSING);
  assert.strictEqual(r.detail.brokenTrend, true);
});

test('requiredConfirmations: saknad 2m på narrow_breakout → QUALITY_TWO_MINUTE_MISSING', () => {
  const r = evaluate(baseSignal({
    strategyId: 'narrow_breakout', signalSubtype: 'NARROW_BULL_ENTRY',
  }, { confirmations: ['closed_candle_confirmation'] }));
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_TWO_MINUTE_MISSING);
});

test('requiresVwapContext: saknad vwap-kontext → QUALITY_VWAP_CONFIRMATION_MISSING', () => {
  const r = evaluate(baseSignal({
    strategyId: 'vwap_volume_breakout_long', signalSubtype: 'VWAP_RECLAIM_UP',
  }, {
    confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'volume_confirmation'],
    context: { vwapContextPresent: false, session: 'rth', sessionTokens: ['rth'] },
  }));
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_VWAP_CONFIRMATION_MISSING);
});

test('requiredConfirmations: saknad vwap_reclaim → QUALITY_VWAP_CONFIRMATION_MISSING', () => {
  const r = evaluate(baseSignal({
    strategyId: 'vwap_volume_breakout_long', signalSubtype: 'VWAP_RECLAIM_UP',
  }, {
    confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'volume_confirmation'],
    context: { session: 'rth', sessionTokens: ['rth'] },
  }));
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_VWAP_CONFIRMATION_MISSING);
});

// ── Volympolicy ──────────────────────────────────────────────────────────────

test('volumePolicy: saknad volymbekräftelse → QUALITY_VOLUME_BELOW_POLICY', () => {
  const r = evaluate(baseSignal({}, {
    confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'ema_pullback_reclaim'],
  }));
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_VOLUME_BELOW_POLICY);
});

test('volumePolicy=null (mnq_globex) grindar inte volym', () => {
  assert.strictEqual(engine.policyForStrategy('mnq_globex_momentum_v1').volumePolicy, null);
  const r = evaluate(baseSignal({
    strategyId: 'mnq_globex_momentum_v1', signalSubtype: 'GLOBEX_MOMENTUM', marketType: 'futures',
  }, {
    confirmations: ['closed_candle_confirmation'],
    context: { session: 'us_rth', sessionTokens: ['us_rth'], isRth: true },
  }), { advisory: 'ready' });
  assert.strictEqual(r.verdict, VERDICTS.EXECUTABLE, `blockerades på ${r.reasonCode}`);
});

// ── Extension ────────────────────────────────────────────────────────────────

test('extensionPolicy: lateOrExtended=true → QUALITY_LATE_OR_EXTENDED', () => {
  const r = evaluate(baseSignal({}, { context: { lateOrExtended: true } }));
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_LATE_OR_EXTENDED);
});

test('extensionPolicy=allow ⇒ lateOrExtended blockerar inte', () => {
  const policy = { ...engine.policyForStrategy('ema_pullback_continuation'), lateEntryPolicy: 'allow', extendedMovePolicy: 'allow' };
  const r = evaluate(baseSignal({}, { context: { lateOrExtended: true } }), { policy });
  assert.strictEqual(r.verdict, VERDICTS.EXECUTABLE);
});

test('observationTextOnly → QUALITY_OBSERVATION_TEXT_ONLY', () => {
  const r = evaluate(baseSignal({}, { context: { observationTextOnly: true } }));
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_OBSERVATION_TEXT_ONLY);
});

// ── INSUFFICIENT_EVIDENCE ────────────────────────────────────────────────────

test('evidensluckor rapporteras men blockerar inte vid policy "permit"', () => {
  const r = evaluate(baseSignal({}, {
    extension: { measure: 'latest_range_multiple', value: null, level: null },
    volume: { rvol: null, state: null },
    timeframes: { tf2m: null, agreementCount: null },
  }));
  assert.strictEqual(r.verdict, VERDICTS.EXECUTABLE);
  assert.ok(r.evidenceGaps.includes('extension_level_never_measured'));
  assert.ok(r.evidenceGaps.includes('timeframe_agreement_never_measured'));
  assert.ok(r.evidenceGaps.includes('volume_rvol_never_measured'));
});

test('evidenceGapPolicy="block" ger INSUFFICIENT_EVIDENCE', () => {
  const policy = { ...engine.policyForStrategy('ema_pullback_continuation'), evidenceGapPolicy: 'block' };
  const r = evaluate(baseSignal({}, {
    extension: { measure: 'price_to_zone_atr', value: null, level: null },
  }), { policy });
  assert.strictEqual(r.verdict, VERDICTS.INSUFFICIENT_EVIDENCE);
  assert.ok(String(r.reasonCode).startsWith('EVIDENCE_GAP:'));
});

test('inga evidensluckor när allt är mätt', () => {
  assert.deepStrictEqual(evaluate(baseSignal()).evidenceGaps, []);
});

// ── Grindordning ─────────────────────────────────────────────────────────────

test('struktur grindas FÖRE advisory — annars blir orsaken oanvändbar', () => {
  const r = evaluate(baseSignal({ signalSubtype: 'NARROW_WAIT' }), { advisory: 'caution' });
  assert.strictEqual(r.reasonCode, REASONS.STRUCTURE_SUBTYPE_NOT_ALLOWED);
});

test('advisory grindas FÖRE färskhet', () => {
  const r = evaluate(baseSignal({}, { candle: { closedCandleConfirmed: true, signalAgeMs: 999999 } }), { advisory: 'caution' });
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_ADVISORY_CAUTION);
});

// ── Regression mot dagens kontraktsmotor ─────────────────────────────────────

console.log('  -- regression mot paperStrategyEntryContractService --');

test(`fixture-filen täcker ${fixtures.length} verdict/reasonCode-kombinationer`, () => {
  assert.ok(fixtures.length >= 8, `för få fixtures: ${fixtures.length}`);
  const verdicts = new Set(fixtures.map((f) => f.expectedVerdict));
  assert.ok(verdicts.has('EXECUTABLE'));
  assert.ok(verdicts.has('NOT_EXECUTABLE'));
});

for (const fixture of fixtures) {
  const label = `${fixture.expectedVerdict}/${fixture.expectedReason || '-'} (${fixture.candidate.strategyId})`;
  test(`regression: ${label}`, () => {
    const now = new Date(fixture.createdAt);
    const source = String(fixture.candidate.signalSource || fixture.candidate.source || '').toLowerCase();
    const adapter = source.includes('futures_native') ? adapters.nativeCanonicalAdapter : adapters.tradingOsCanonicalAdapter;
    const canonical = adapter(fixture.candidate, { now });

    const advisory = fixture.candidate.signalStatus || fixture.candidate.status || fixture.candidate.priority || '';
    const actual = engine.evaluate({ canonicalSignal: canonical, legacyAdvisory: advisory, now });

    assert.strictEqual(actual.verdict, fixture.expectedVerdict, 'verdict avviker');
    assert.strictEqual(actual.reasonCode, fixture.expectedReason, 'reasonCode avviker');

    // Samma beslut som dagens motor, på samma indata.
    const legacy = entryContracts.evaluatePaperEntryContract({
      strategyId: fixture.candidate.strategyId, candidate: fixture.candidate, now,
    });
    assert.strictEqual(
      actual.verdict === VERDICTS.EXECUTABLE, legacy.allowed === true,
      `beslutet skiljer sig från paperStrategyEntryContractService (legacy=${legacy.reasonCode})`,
    );
    if (legacy.reasonCode) {
      assert.strictEqual(
        engine.LEGACY_REASON_MAP[legacy.reasonCode], actual.reasonCode,
        `orsakskoden mappar inte mot ${legacy.reasonCode}`,
      );
    }
  });
}

test('LEGACY_REASON_MAP täcker samtliga reasonCodes fixtures uppvisar', () => {
  for (const fixture of fixtures) {
    const now = new Date(fixture.createdAt);
    const legacy = entryContracts.evaluatePaperEntryContract({
      strategyId: fixture.candidate.strategyId, candidate: fixture.candidate, now,
    });
    if (legacy.reasonCode) {
      assert.ok(engine.LEGACY_REASON_MAP[legacy.reasonCode], `omappad legacy-kod: ${legacy.reasonCode}`);
    }
  }
});

// ── Mutationstest: faller testerna när motorn ignorerar en policy? ───────────

console.log('  -- mutationstest (policyn måste ha effekt) --');

const MUTATIONS = [
  ['maxSignalAgeMs sänkt till 1', (p) => ({ ...p, maxSignalAgeMs: 1 }), REASONS.CONTEXT_DATA_STALE],
  ['allowedSubtypes tömd', (p) => ({ ...p, allowedSubtypes: [] }), REASONS.STRUCTURE_SUBTYPE_NOT_ALLOWED],
  ['allowedDirections tömd', (p) => ({ ...p, allowedDirections: [] }), REASONS.STRUCTURE_DIRECTION_NOT_ALLOWED],
  ['requiredConfirmations + vwap', (p) => ({ ...p, requiredConfirmations: [...p.requiredConfirmations, 'vwap_reclaim_confirmation'] }), REASONS.QUALITY_VWAP_CONFIRMATION_MISSING],
  ['requiresMarketOpen + omöjlig session', (p) => ({ ...p, requiresMarketOpen: true, allowedSessions: ['mars'] }), REASONS.STRUCTURE_SESSION_NOT_ALLOWED],
  ['marketType tvingad till futures-krav', (p) => ({ ...p, marketType: 'stocks' }), null],
  ['requiresClosedCandle på signal utan candle', (p) => ({ ...p, requiresClosedCandle: true }), REASONS.QUALITY_CLOSED_CANDLE_MISSING],
];

for (const [name, mutate, expectedReason] of MUTATIONS) {
  test(`mutation: ${name}`, () => {
    const basePolicy = engine.policyForStrategy('ema_pullback_continuation');
    const mutated = mutate({ ...basePolicy });

    if (name.startsWith('requiresClosedCandle')) {
      const signal = baseSignal({}, { candle: { closedCandleConfirmed: false, signalAgeMs: 22000 } });
      const r = evaluate(signal, { policy: mutated });
      assert.strictEqual(r.reasonCode, expectedReason);
      return;
    }
    if (name.startsWith('marketType')) {
      const r = evaluate(baseSignal({ marketType: 'futures' }), { policy: mutated });
      assert.strictEqual(r.reasonCode, REASONS.STRUCTURE_MARKET_TYPE_MISMATCH);
      return;
    }
    const before = evaluate(baseSignal(), { policy: basePolicy });
    const after = evaluate(baseSignal(), { policy: mutated });
    assert.strictEqual(before.verdict, VERDICTS.EXECUTABLE, 'basfallet var inte körbart');
    assert.strictEqual(after.verdict, VERDICTS.NOT_EXECUTABLE, 'mutationen hade INGEN effekt — motorn ignorerar policyn');
    assert.strictEqual(after.reasonCode, expectedReason);
  });
}

test('mutation: identisk policy ger identiskt resultat (ingen falsk känslighet)', () => {
  const p = engine.policyForStrategy('ema_pullback_continuation');
  const a = evaluate(baseSignal(), { policy: p });
  const b = evaluate(baseSignal(), { policy: { ...p } });
  assert.strictEqual(a.verdict, b.verdict);
  assert.strictEqual(a.reasonCode, b.reasonCode);
});

// ── Robusthet ────────────────────────────────────────────────────────────────

test('tom indata kraschar inte', () => {
  const r = engine.evaluate({});
  assert.strictEqual(r.verdict, VERDICTS.NOT_EXECUTABLE);
  assert.strictEqual(r.reasonCode, REASONS.STRUCTURE_MISSING_STRATEGY_ID);
});

test('motorn muterar aldrig signalen', () => {
  const signal = baseSignal();
  const before = JSON.stringify(signal);
  evaluate(signal);
  assert.strictEqual(JSON.stringify(signal), before);
});

test('motorn läser aldrig ett förbjudet fält från signalen', () => {
  const signal = baseSignal();
  signal.signalStatus = 'ready';
  signal.priority = 'active';
  const r = evaluate(signal, { advisory: 'caution' });
  assert.strictEqual(r.reasonCode, REASONS.QUALITY_ADVISORY_CAUTION,
    'motorn plockade upp status från signalen i stället för legacyAdvisory');
});

console.log(`\nexecutionReadinessEngine: ${passed} tester ok`);

// ── Sessionsbryggan (tillagd efter FAS 6-granskning) ─────────────────────────

test('us_rth-kandidat matchar aktiekontraktets RTH-vokabulär', () => {
  const policy = { ...engine.policyForStrategy('vwap_volume_breakout_long') };
  assert.deepStrictEqual(policy.allowedSessions, ['regular', 'rth', 'nyse', 'nasdaq', 'us_stocks']);
  const r = evaluate(baseSignal({
    strategyId: 'vwap_volume_breakout_long', signalSubtype: 'VWAP_RECLAIM_UP',
  }, {
    confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'vwap_reclaim_confirmation', 'volume_confirmation'],
    context: { session: 'globex', sessionTokens: ['globex', 'us_rth'], isRth: true },
  }));
  assert.strictEqual(r.verdict, VERDICTS.EXECUTABLE, `blockerades på ${r.reasonCode}`);
});

test('isRth=true räcker även utan us_rth-token', () => {
  const r = evaluate(baseSignal({
    strategyId: 'vwap_volume_breakout_long', signalSubtype: 'VWAP_RECLAIM_UP',
  }, {
    confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'vwap_reclaim_confirmation', 'volume_confirmation'],
    context: { session: 'globex', sessionTokens: ['globex'], isRth: true },
  }));
  assert.strictEqual(r.verdict, VERDICTS.EXECUTABLE, `blockerades på ${r.reasonCode}`);
});

test('sessionTokens jämförs som MÄNGD, inte som enskilt fält', () => {
  const r = evaluate(baseSignal({
    strategyId: 'vwap_volume_breakout_long', signalSubtype: 'VWAP_RECLAIM_UP',
  }, {
    confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'vwap_reclaim_confirmation', 'volume_confirmation'],
    context: { session: 'globex', sessionTokens: ['globex', 'nasdaq'], isRth: false },
  }));
  assert.strictEqual(r.verdict, VERDICTS.EXECUTABLE, 'andra token i mängden ignorerades');
});

test('tom sessionsmängd blockerar inte (speglar kontraktets :350)', () => {
  const r = evaluate(baseSignal({
    strategyId: 'vwap_volume_breakout_long', signalSubtype: 'VWAP_RECLAIM_UP',
  }, {
    confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'vwap_reclaim_confirmation', 'volume_confirmation'],
    context: { session: null, sessionTokens: [], isRth: null },
  }));
  assert.strictEqual(r.verdict, VERDICTS.EXECUTABLE);
});

test('helt främmande session blockerar fortfarande', () => {
  const r = evaluate(baseSignal({
    strategyId: 'vwap_volume_breakout_long', signalSubtype: 'VWAP_RECLAIM_UP',
  }, {
    confirmations: ['two_minute_confirmation', 'closed_candle_confirmation', 'vwap_reclaim_confirmation', 'volume_confirmation'],
    context: { session: 'asia', sessionTokens: ['asia'], isRth: false },
  }));
  assert.strictEqual(r.reasonCode, REASONS.STRUCTURE_SESSION_NOT_ALLOWED);
});

console.log(`\nexecutionReadinessEngine (inkl. sessionsbrygga): ${passed} tester ok`);
