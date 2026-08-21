'use strict';

// ── Acceptanstest: Executable Research Hypothesis ────────────────────────────
//
// Lagret finns för att lösa en enda konflikt: AI Factory kan prioritera
// experiment men kunde inte FORMULERA något, eftersom de två forskningsobjekten
// saknar körbar semantik. Att välja semantiken och sedan rapportera utfallet som
// kunskap om konceptet vore att uppfinna en strategi och kalla den forskning.
//
// Hypoteslagret gör valet explicit, versionerat och förkastbart. Testerna
// bevakar de tre egenskaper som gör skillnaden verklig och inte kosmetisk:
//
//   · identiteten är deterministisk (samma regler ⇒ samma hash)
//   · varje värde bär HYPOTHESIS_ONLY och en källa
//   · hypotesen kan köras historiskt men kan ALDRIG nå paper eller runtime

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const hypotheses = require('./researchHypothesisService');
const evaluator = require('./researchHypothesisEvaluatorService');
const boundary = require('./researchDatasetBoundaryService');
const calendar = require('../../data/tradingDayCalendar');
const registry = require('../nativeFuturesStrategyRegistryService');
const strategyDna = require('../dna/strategyDnaService');

test('1. hypotesidentiteten är deterministisk och unik per hypotes', () => {
  const first = hypotheses.listHypotheses();
  const second = hypotheses.listHypotheses();
  assert.deepEqual(first, second, 'samma indata måste ge samma hypoteser');

  const hashes = first.map((row) => row.hypothesisHash);
  assert.equal(new Set(hashes).size, hashes.length, 'två hypoteser får aldrig dela hash');
  assert.ok(first.length >= 2, 'det ska finnas en avgränsad hypotesrymd');

  // Hashen räknas på SEMANTIKEN. Skrivs motiveringen om ska identiteten stå
  // still — annars kan AI Memory inte känna igen ett redan kört experiment.
  const sample = first[0];
  assert.equal(
    hypotheses.hypothesisHash(sample.semantics),
    sample.hypothesisHash,
    'hashen måste gå att räkna om ur semantiken ensam',
  );
});

test('2. varje värde är märkt HYPOTHESIS_ONLY och bär sin källa', () => {
  for (const hypothesis of hypotheses.listHypotheses()) {
    const entries = Object.entries(hypothesis.variableSources);
    assert.ok(entries.length > 0, `${hypothesis.researchStrategyId} saknar variabelkällor`);
    for (const [name, row] of entries) {
      assert.equal(row.marking, 'HYPOTHESIS_ONLY', `${hypothesis.researchStrategyId}.${name} är omärkt`);
      assert.notEqual(row.marking, 'VALIDATED', 'inget värde får kallas validerat före historisk evidens');
      assert.ok(row.source && row.source.length > 5, `${name} saknar källa`);
    }
    for (const key of ['stopLossPct', 'takeProfitR', 'holdingTimeMin']) {
      assert.equal(hypothesis.exit[key].status, 'FIXED_RESEARCH_CONSTANT',
        'exit ska vara konstanthållen, inte prövad, i den här experimentfamiljen');
    }
  }
});

test('3. livscykeln är en grind, inte en etikett', () => {
  assert.deepEqual(hypotheses.LIFECYCLE, [
    'STRATEGY_CONCEPT',
    'RESEARCH_SPECIFICATION',
    'EXECUTABLE_RESEARCH_HYPOTHESIS',
    'HISTORICALLY_RESEARCHED',
    'HISTORICALLY_VALIDATED_CANDIDATE',
    'EXECUTABLE_RUNTIME_STRATEGY',
    'PAPER_ELIGIBLE',
  ]);

  for (const stage of ['STRATEGY_CONCEPT', 'RESEARCH_SPECIFICATION']) {
    assert.equal(hypotheses.gatesFor(stage).replayAllowed, false, `${stage} får inte köras`);
  }
  const executable = hypotheses.gatesFor('EXECUTABLE_RESEARCH_HYPOTHESIS');
  assert.equal(executable.replayAllowed, true);
  assert.equal(executable.researchEvidenceAllowed, true);
  assert.equal(executable.runtimeEligible, false);
  assert.equal(executable.paperEligible, false);

  // Ett validerat historiskt utfall är fortfarande inte runtime. Steget dit är
  // en implementation, inte en befordran.
  assert.equal(hypotheses.gatesFor('HISTORICALLY_VALIDATED_CANDIDATE').runtimeEligible, false);
  assert.equal(hypotheses.gatesFor('HISTORICALLY_VALIDATED_CANDIDATE').paperEligible, false);
  assert.throws(() => hypotheses.gatesFor('NÅGOT_ANNAT'), /unknown_research_lifecycle_stage/);
});

test('4. hypoteser når aldrig paper-vägen', () => {
  const paperPath = registry.listStrategyEvaluators().map((row) => row.strategyId);
  assert.equal(paperPath.length, 8, 'paper-vägen ska vara oförändrad: de åtta modulerna');
  assert.equal(paperPath.some(hypotheses.isResearchStrategyId), false);

  const withVariants = registry.listStrategyEvaluators({ includeVariants: true, includeEvolved: true });
  assert.equal(withVariants.some((row) => hypotheses.isResearchStrategyId(row.strategyId)), false,
    'inte heller varianter eller genom får dra in research');

  const withResearch = registry.listStrategyEvaluators({ includeResearch: true });
  assert.ok(withResearch.length > paperPath.length, 'flaggan ska faktiskt lägga till något');
  assert.equal(withResearch.filter((row) => hypotheses.isResearchStrategyId(row.strategyId)).length,
    hypotheses.listHypotheses().length);
});

test('5. varje beslut bär researchOnly hela vägen ut', () => {
  const hypothesis = hypotheses.listHypotheses()[0];
  // Ett blockerat beslut är den svåraste vägen: bär det INTE märkningen går en
  // research-rad inte att känna igen i en logg.
  const blocked = evaluator.evaluateResearchHypothesis(hypothesis, null);
  assert.equal(blocked.decision, 'BLOCKED');
  for (const decision of [blocked, evaluator.evaluateResearchHypothesis(hypothesis, { symbol: 'MNQ' })]) {
    assert.equal(decision.researchOnly, true);
    assert.equal(decision.paperEligible, false);
    assert.equal(decision.runtimeEligible, false);
    assert.equal(decision.hypothesisHash, hypothesis.hypothesisHash);
    assert.ok(hypotheses.isResearchStrategyId(decision.strategyId));
  }
});

test('6. hypotesen har egen Strategy DNA — annars finns inget dubblettskydd', () => {
  const rows = hypotheses.listHypotheses();
  const dna = rows.map((row) => strategyDna.getStrategyDna(row.researchStrategyId));
  assert.equal(dna.filter(Boolean).length, rows.length, 'varje hypotes måste ha DNA');
  assert.equal(new Set(dna.map((row) => row.dnaHash)).size, rows.length,
    'två hypoteser med olika semantik får aldrig dela dnaHash');
  assert.equal(new Set(dna.map((row) => row.parameterHash)).size, rows.length);
});

test('7b. handelsdagslogiken ligger i src/data, inte i research', () => {
  // Replay-kön behöver samma svar som research. Låg mappningen kvar i en modul
  // kallad "research" fick en produktionsväg importera research — och att
  // duplicera den hade varit värre: två uträkningar av samma mappning pekar
  // förr eller senare på olika dygn.
  for (const name of ['sharedDays', 'rthWindowFor', 'rthDateFor', 'contractKeyByRootForDay', 'listContracts']) {
    assert.equal(typeof calendar[name], 'function', `${name} saknas i kalendern`);
    assert.equal(boundary[name], undefined, `${name} finns kvar i research-modulen`);
  }
  // Research äger fortfarande sitt eget metodval.
  assert.equal(typeof boundary.buildSplit, 'function');

  const queue = fs.readFileSync(path.join(__dirname, '../replayQueueRunnerService.js'), 'utf8');
  assert.doesNotMatch(queue, /require\('[^']*researchDatasetBoundaryService'\)/,
    'replay-kön importerar fortfarande research-modulen');
  assert.match(queue, /require\('\.\.\/data\/tradingDayCalendar'\)/);
});

test('7. datamängdens gräns är kontraktsspecifik, inte rotläst', () => {
  const described = boundary.describeBoundary();
  assert.equal(described.dataAccessMode, 'exact_contract');
  assert.deepEqual(described.roots, ['MNQ', 'MES']);
  assert.ok(described.sharedDayCount > 0);
  for (const root of described.roots) {
    assert.ok(described.contracts[root].length > 0, `${root} saknar kontrakt`);
    for (const contract of described.contracts[root]) {
      assert.match(contract.contractKey, /^[A-Z]+:\d+:\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('8. research/validation-splitten är läckagefri och inte slumpad', () => {
  const split = boundary.buildSplit();
  assert.equal(split.ok, true);
  assert.equal(split.randomSplit, false);
  assert.equal(split.splitMethod, 'contract_adjusted_temporal');
  assert.equal(split.dataAccessMode, 'exact_contract');
  assert.deepEqual(split.dayOverlap, [], 'inget dygn får ligga i båda halvorna');
  assert.deepEqual(split.contractOverlap, [], 'inget kontrakt får ligga i båda halvorna');
  assert.ok(split.research.dayCount > 0 && split.validation.dayCount > 0);
  assert.ok(split.research.to < split.validation.from, 'research måste ligga före validation i tid');
  assert.equal(split.research.dayCount + split.validation.dayCount, split.sharedDayCount);
});

test('9. handelsdagen är inte kalenderdatumet — fönstret måste peka rätt', () => {
  const window = calendar.rthWindowFor('2026-01-14');
  assert.equal(window.date, '2026-01-15');
  assert.equal(window.from, '2026-01-15T13:00:00.000Z');
  assert.equal(window.to, '2026-01-15T17:00:00.000Z');
});

// ── Cykel 1:s identiteter är låsta ──────────────────────────────────────────
//
// Det här testet finns för att ett faktiskt fel inträffade: när cykel 2 lades
// till fick semantikobjektet nya fält (cycle, entryModel, breakoutToleranceAtr),
// och eftersom hashen räknas på semantiken ändrades DÄRMED varje cykel-1-hash.
// Cykel 1:s experiment ligger redan bokförda i AI Memory med de gamla
// identiteterna — en glidning här gör dem oigenkännliga, dubblettskyddet
// verkningslöst och evidensen omöjlig att koppla till sin hypotes.
//
// Talen är avsiktligt hårdkodade. Det är hela poängen: de får aldrig räknas om.
const CYCLE1_FROZEN = Object.freeze({
  research__low_volatility_breakout__H001: '2cc86f0ef4af3a0b',
  research__low_volatility_breakout__H002: '9b4cc4657e9c35be',
  research__low_volatility_breakout__H003: 'bfed53221e189d5a',
  research__low_volatility_breakout__H004: 'c5276c96e726713b',
  research__low_volatility_breakout__H005: '99dce2b7924d3bd9',
  research__low_volatility_breakout__H006: '211d9348955f4dcb',
  research__volume_spike_momentum__H001: '9d7908fb9edf7681',
  research__volume_spike_momentum__H002: '8701c6b7372e37e8',
  research__volume_spike_momentum__H003: '0dff4b574b0a3a8c',
  research__volume_spike_momentum__H004: '6e1917fec51957b4',
  research__volume_spike_momentum__H005: 'ff60be86606da231',
  research__volume_spike_momentum__H006: '1aa9b99ea394a734',
});

test('11. cykel 1:s hypotesidentiteter får aldrig räknas om', () => {
  const cycle1 = hypotheses.listHypotheses(null, { cycle: hypotheses.CYCLES.ONE });
  assert.equal(cycle1.length, Object.keys(CYCLE1_FROZEN).length);
  for (const row of cycle1) {
    assert.equal(row.hypothesisHash, CYCLE1_FROZEN[row.researchStrategyId],
      `${row.researchStrategyId} har bytt identitet — cykel 1:s bokförda experiment blir oigenkännliga`);
  }
});

test('12. att lägga till en cykel får inte flytta en befintlig DNA-identitet', () => {
  // Samma fälla en nivå ned: Strategy DNA härleds ur defaultOptions, och
  // experimentnyckeln bär både dnaHash och parameterHash.
  const all = hypotheses.listHypotheses();
  const dna = all.map((row) => ({ id: row.researchStrategyId, ...strategyDna.getStrategyDna(row.researchStrategyId) }));
  assert.equal(new Set(dna.map((row) => row.dnaHash)).size, all.length,
    'varje hypotes måste ha unik dnaHash, annars slås två experiment ihop');
  assert.equal(new Set(dna.map((row) => row.parameterHash)).size, all.length);
  // Och strategyVersion bär hypotesens hash, så identiteten går att läsa ur
  // en biblioteksrad utan uppslagning.
  for (const row of all) {
    const descriptor = registry.getNativeStrategy(row.researchStrategyId);
    assert.match(descriptor.strategyVersion, new RegExp(`:${row.hypothesisHash}$`));
  }
});

test('13. cykelfiltret kör bara den cykel som efterfrågas', () => {
  const two = hypotheses.listHypotheses(null, { cycle: hypotheses.CYCLES.TWO });
  assert.ok(two.length > 0);
  assert.equal(two.every((row) => row.cycle === hypotheses.CYCLES.TWO), true);

  const evaluators = registry.listStrategyEvaluators({
    includeResearch: true, includeBase: false, researchCycle: hypotheses.CYCLES.TWO,
  });
  assert.equal(evaluators.length, two.length, 'en avslutad cykel ska inte köras igen i en ny cykels batch');
  assert.throws(() => hypotheses.listHypotheses(null, { cycle: 'cycle9' }), /unknown_research_cycle/);
});

test('14. pullback-entryn tittar aldrig framåt', () => {
  // Regeln får bara läsa barer som redan är stängda. Ett lookahead här hade
  // gett ett bättre instiegspris som inte finns i verkligheten — och hela
  // poängen med hypotesen är just instiegspriset.
  const source = fs.readFileSync(path.join(__dirname, 'researchHypothesisEvaluatorService.js'), 'utf8');
  const body = source.slice(source.indexOf('function evaluatePullbackEntry'));
  const fn = body.slice(0, body.indexOf('\nfunction '));
  assert.doesNotMatch(fn, /getBarsBetween|barsForFill|future|slice\(candles\.length\s*\+/,
    'pullback-regeln får inte läsa barer efter beslutspunkten');

  // spikeAt räknar om indikatorerna på ett KORTARE fönster. Skulle den
  // återanvända dagens värden vore spikens relativa volym mätt mot en period
  // som innehåller spiken själv.
  const spikeSource = source.slice(source.indexOf('function spikeAt'));
  assert.match(spikeSource.slice(0, spikeSource.indexOf('\nfunction ')),
    /candles\.slice\(0, candles\.length - k\)/);
});

test('15. en hypotes utvärderar bara i sin egen timeframe', () => {
  const hypothesis = hypotheses.listHypotheses().find((row) => row.semantics.timeframe === '5m');
  if (!hypothesis) return;
  const decision = evaluator.evaluateResearchHypothesis(hypothesis, {
    symbol: 'MNQ', timeframe: '2m', candles: [], latestCandle: null,
  });
  assert.notEqual(decision.decision, 'SIGNAL');
});

test('10. inget strateginamn läcker in i generiska moduler', () => {
  const generic = [
    '../brain/strategyBrainService.js',
    '../optimizer/aiOptimizerService.js',
    '../evolution/evolutionEngineService.js',
    '../replay/nativeReplayEngineService.js',
    '../nativeFuturesStrategyRegistryService.js',
  ];
  for (const relative of generic) {
    const source = fs.readFileSync(path.join(__dirname, relative), 'utf8')
      .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    for (const strategyId of hypotheses.STRATEGY_IDS) {
      assert.doesNotMatch(source, new RegExp(strategyId),
        `${relative} nämner ${strategyId} — strategisemantik hör hemma i hypotesen, inte i en generisk modul`);
    }
    assert.doesNotMatch(source, /H00\d['"]/, `${relative} nämner ett hypotesnummer`);
  }
});

console.log('researchHypothesis.acceptance.test.js loaded');
