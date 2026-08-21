'use strict';

// ── Acceptanstest: Strategy DNA, AI Memory, Family Tree, Evolution Engine ────
//
// Ett test per punkt i kravlistan. De två viktigaste:
//
//   · att MARKET DNA och inte datum är minnesnyckeln — annars träffar minnet
//     aldrig och "fråga minnet först" blir en ceremoni utan verkan
//   · att replay, paper och native scanner är OPÅVERKADE — hela AI-lagret får
//     vara fel utan att en enda order påverkas

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const strategyDna = require('../dna/strategyDnaService');
const aiMemory = require('./aiMemoryService');
const familyTreeModule = require('../evolution/strategyFamilyTreeService');
const evolutionModule = require('../evolution/evolutionEngineService');
const optimizer = require('../optimizer/aiOptimizerInterface');
const registry = require('../nativeFuturesStrategyRegistryService');
const expandedRegistry = require('../strategyRegistryService');

const SERVICES = path.join(__dirname, '..');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-')), name);
}

function freshMemory() {
  return aiMemory.createAiMemory({ eventsFile: tmpFile('experiments.jsonl') });
}

function freshTree() {
  return familyTreeModule.createStrategyFamilyTree({ eventsFile: tmpFile('lineage.jsonl') });
}

// Ett komplett experiment. Populationen kommer ur registret — ingen strategi
// nämns vid namn någonstans i den här filen.
function anyStrategyDna(index = 0) {
  const all = strategyDna.listStrategyDna();
  assert.ok(all.length > index, 'registret har för få strategier för testet');
  return all[index];
}

function specFor(dna, overrides = {}) {
  return {
    strategyDnaHash: dna.dnaHash,
    parameterHash: dna.parameterHash,
    marketDnaHash: 'market-aaa',
    replayMode: 'strategy',
    executionModel: 'simulated_fill:cfg1',
    strategyVersion: dna.strategyVersion || 'v1',
    period: '2026-08-11..2026-08-14',
    symbols: ['MNQ', 'MES'],
    ...overrides,
  };
}

function refFor(dna, overrides = {}) {
  return {
    source: 'strategy_library',
    resultType: 'replay',
    strategyId: dna.strategyId || null,
    libraryRunId: 'library-run-1',
    eventType: 'REPLAY_RECORDED',
    ...overrides,
  };
}

// ── Strategy DNA ════════════════════════════════════════════════════════════

test('DNA härleds ur registret och koden, aldrig ur en handskriven tabell', () => {
  const all = strategyDna.listStrategyDna();
  // Populationen är unionen av de två registren. Native-registret bidrar med de
  // strategier som faktiskt har kod; katalogregistret med alla registrerade
  // parameteruppsättningar. Ingen av dem är en handskriven tabell.
  const nativeRegistry = require('../nativeFuturesStrategyRegistryService');
  const population = new Set([
    ...expandedRegistry.listStrategies().map((row) => row.strategy_id || row.strategyId),
    ...nativeRegistry.listNativeStrategies({ includeVariants: true }).map((row) => row.strategyId),
  ]);
  assert.equal(all.length, population.size, 'DNA-populationen speglar inte registren');

  for (const dna of all) {
    assert.ok(dna.dnaHash && dna.parameterHash);
    assert.deepEqual(dna.blocks, strategyDna.DNA_BLOCKS);
    assert.equal(dna.blocks.length, 13, 'alla tretton block ska finnas i schemat');
    assert.equal(dna.lineage.generation, 0);
    assert.equal(dna.lineage.parent, null);
    // Varje strategi ska ha minst ett muterbart block, annars går den inte att
    // utveckla och Evolution Engine är verkningslös på den.
    assert.ok(dna.mutableBlocks.length > 0, `${dna.strategyId} har inget muterbart block`);
  }

  // Källkodsregel: ingen strategi får nämnas vid namn i DNA-modulen.
  const source = fs.readFileSync(path.join(SERVICES, 'dna', 'strategyDnaService.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(source, /native_futures_\w+_v\d/, 'DNA-modulen har en egen strategilista');
  assert.match(source, /require\('\.\.\/strategyRegistryService'\)/);
});

test('DNA-hashen är kanonisk: samma genom ger samma hash', () => {
  const dna = anyStrategyDna();
  const again = strategyDna.getStrategyDna(dna.strategyId);
  assert.equal(again.dnaHash, dna.dnaHash);
  assert.equal(again.parameterHash, dna.parameterHash);

  // Nyckelordning får inte spela roll.
  const shuffled = strategyDna._internal.finalizeDna({
    ...dna,
    genome: Object.fromEntries(Object.entries(dna.genome).reverse()),
  });
  assert.equal(shuffled.dnaHash, dna.dnaHash, 'fältordningen påverkade hashen');
});

test('bara deklarerade block får muteras', () => {
  const dna = anyStrategyDna();
  const mutableBlock = dna.mutableBlocks.find((name) => Object.values(dna.genome[name].values || {}).some((value) => typeof value === 'number'));
  const parameter = mutableBlock
    ? Object.keys(dna.genome[mutableBlock].values).find((key) => typeof dna.genome[mutableBlock].values[key] === 'number')
    : null;
  assert.ok(mutableBlock, 'inga numeriska muterbara block hittades');
  assert.ok(parameter, 'inga numeriska parametrar hittades');

  const ok = strategyDna.mutateStrategyDna(dna, {
    [`${mutableBlock}.${parameter}`]: dna.genome[mutableBlock].values[parameter] + 1,
  });
  assert.equal(ok.ok, true);
  assert.notEqual(ok.dna.dnaHash, dna.dnaHash, 'en mutation ändrade inte hashen');

  // Ett härlett block beskriver koden. Att mutera det vore att mutera en
  // gissning, och nästa härledning skulle skriva tillbaka värdet.
  const inferredBlock = dna.inferredBlocks.find((name) => name !== 'activeBlocks');
  if (inferredBlock) {
    const rejected = strategyDna.mutateStrategyDna(dna, { [`${inferredBlock}.used`]: false });
    assert.equal(rejected.ok, false);
    assert.match(rejected.rejected[0].reason, /block_not_mutable/);
  }

  // Okänd parameter och fel typ avvisas också, med skäl.
  const bad = strategyDna.mutateStrategyDna(dna, {
    [`${mutableBlock}.finns_inte`]: 1,
    [`${mutableBlock}.${parameter}`]: 'en sträng',
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.rejected.length, 2);
});

// ── AI Memory: hashen ═══════════════════════════════════════════════════════

test('identiska experiment ger identisk hash', () => {
  const dna = anyStrategyDna();
  const a = aiMemory.experimentKey(specFor(dna));
  const b = aiMemory.experimentKey(specFor(dna));
  assert.equal(a, b);

  // Härkomstfälten får INTE påverka nyckeln.
  const otherProvenance = aiMemory.experimentKey(specFor(dna, {
    period: '2026-01-01..2026-01-05', symbols: ['MES'], runId: 'annat',
  }));
  assert.equal(otherProvenance, a, 'ett härkomstfält läckte in i identiteten');
});

test('olika DNA ger olika hash', () => {
  const first = anyStrategyDna(0);
  const second = anyStrategyDna(1);
  assert.notEqual(first.dnaHash, second.dnaHash, 'två strategier delade genom');
  assert.notEqual(aiMemory.experimentKey(specFor(first)), aiMemory.experimentKey(specFor(second)));

  // Även en ren parameterändring ska ge ett nytt experiment.
  const block = first.mutableBlocks[0];
  const parameter = Object.keys(first.genome[block].values)[0];
  const mutated = strategyDna.mutateStrategyDna(first, {
    [`${block}.${parameter}`]: first.genome[block].values[parameter] + 5,
  });
  assert.notEqual(
    aiMemory.experimentKey(specFor(mutated.dna)),
    aiMemory.experimentKey(specFor(first)),
    'en muterad parameter räknades som samma experiment',
  );
});

test('olika Market DNA ger olika hash', () => {
  const dna = anyStrategyDna();
  const inRange = aiMemory.experimentKey(specFor(dna, { marketDnaHash: 'market-range' }));
  const inTrend = aiMemory.experimentKey(specFor(dna, { marketDnaHash: 'market-trend' }));
  assert.notEqual(inRange, inTrend, 'två marknadsprofiler räknades som samma marknad');

  // Replaymodell och exekveringsmodell skiljer också.
  assert.notEqual(
    aiMemory.experimentKey(specFor(dna, { replayMode: 'portfolio' })),
    aiMemory.experimentKey(specFor(dna)),
  );
  assert.notEqual(
    aiMemory.experimentKey(specFor(dna, { executionModel: 'perfect_fill' })),
    aiMemory.experimentKey(specFor(dna)),
  );
});

test('ett ofullständigt experiment avvisas i stället för att hashas', () => {
  const dna = anyStrategyDna();
  // Utan Market DNA går experimentet inte att återanvända, och att tyst hasha
  // ett null hade gjort ALLA sådana experiment till samma experiment.
  assert.throws(
    () => aiMemory.experimentKey(specFor(dna, { marketDnaHash: null })),
    /ai_memory_incomplete_experiment_key:marketDnaHash/,
  );
});

test('AI Memory kräver Library-referens och lagrar aldrig resultatfält', () => {
  const memory = freshMemory();
  const dna = anyStrategyDna();
  const spec = specFor(dna);

  assert.throws(
    () => memory.recordExperiment(spec),
    /ai_memory_requires_library_ref/,
  );

  memory.recordExperiment(spec, {
    ...refFor(dna, { libraryRunId: 'result-in-library' }),
    strategyScore: 99,
    winRate: 75,
  });

  const event = JSON.parse(fs.readFileSync(memory.eventsFile, 'utf8').trim());
  assert.ok(!('result' in event), 'råhändelsen innehåller fortfarande result');
  for (const field of aiMemory.REMOVED_RESULT_FIELDS) {
    assert.ok(!(field in event), `råhändelsen innehåller fortfarande ${field}`);
    assert.ok(!(field in event.libraryRef), `libraryRef innehåller fortfarande ${field}`);
  }
  assert.equal(event.libraryRef.libraryRunId, 'result-in-library');
});

test('legacy-händelser med result strippas till experimentindex vid läsning', () => {
  const memory = freshMemory();
  const dna = anyStrategyDna();
  const spec = specFor(dna, { runId: 'legacy-run' });
  const key = aiMemory.experimentKey(spec);
  const identity = Object.fromEntries(aiMemory.IDENTITY_FIELDS.map((field) => [field, spec[field]]));

  memory._internal.log.append(key, memory.EVENT_TYPES.EXPERIMENT_RECORDED, {
    identity,
    result: { strategyScore: 88, winRate: 61 },
    period: spec.period,
    symbols: spec.symbols,
    runId: spec.runId,
    requestedBy: 'legacy',
    marketClassification: 'range',
  });

  const record = memory.findExperiment(spec);
  assert.equal(record.result, undefined);
  assert.equal(record.libraryRef.libraryRunId, 'legacy-run');

  const event = memory.getHistory(key)[0];
  assert.equal(event.result, undefined);
  for (const field of aiMemory.REMOVED_RESULT_FIELDS) {
    assert.ok(!(field in event), `legacy-event exponerar fortfarande ${field}`);
  }
});

// ── AI Memory: återanvändning ═══════════════════════════════════════════════

test('olika period med samma Market DNA återanvänder experimentet', () => {
  const memory = freshMemory();
  const dna = anyStrategyDna();

  const august = specFor(dna, { period: '2026-08-11..2026-08-14', runId: 'aug' });
  const september = specFor(dna, { period: '2026-09-01..2026-09-04', runId: 'sep' });

  // Första gången: okänt, måste köras.
  const first = memory.lookupOrPlan(august);
  assert.equal(first.cached, false);

  memory.recordExperiment(august, refFor(dna, { libraryRunId: 'aug' }));

  // En ANNAN period, samma marknadsprofil: experimentet finns redan.
  const second = memory.lookupOrPlan(september);
  assert.equal(second.cached, true, 'minnet kände inte igen samma marknad i en annan period');
  assert.equal(second.result, undefined, 'AI Memory exponerar fortfarande resultat');
  assert.equal(second.libraryRef.libraryRunId, 'aug');
  assert.deepEqual(second.seenIn, ['2026-08-11..2026-08-14']);
  assert.equal(second.experimentKey, first.experimentKey);

  // En annan MARKNAD är däremot ett nytt experiment.
  const otherMarket = memory.lookupOrPlan(specFor(dna, { marketDnaHash: 'market-bbb' }));
  assert.equal(otherMarket.cached, false);
});

test('minnet räknar upprepningar i stället för att dölja dem', () => {
  const memory = freshMemory();
  const dna = anyStrategyDna();
  const spec = specFor(dna);

  memory.recordExperiment(spec, refFor(dna, { libraryRunId: 'first-result' }));
  memory.recordExperiment(spec, refFor(dna, { libraryRunId: 'second-result' }), {});

  const record = memory.findExperiment(spec);
  assert.equal(record.observations, 2);
  // Första referensen gäller: en andra inspelning är en upprepning och inte en
  // revidering av var resultatet först bokfördes.
  assert.equal(record.result, undefined, 'AI Memory behöll ett resultatfält');
  assert.equal(record.libraryRef.libraryRunId, 'first-result',
    'en omkörning skrev över den ursprungliga Library-referensen');
  assert.equal(memory.getStatus().repeats, 1,
    'upprepningen syns inte i statusen — då märks det aldrig att någon inte frågar minnet');
});

test('optimeringsgrinden hindrar dubbelkörning', () => {
  const memory = freshMemory();
  const dna = anyStrategyDna();
  const spec = specFor(dna);

  const before = optimizer.gateThroughMemory(memory, spec);
  assert.equal(before.run, true);
  assert.equal(before.reason, 'not_seen_before');

  memory.recordExperiment(spec, refFor(dna, { libraryRunId: 'known-run' }));

  const after = optimizer.gateThroughMemory(memory, specFor(dna, { period: 'en helt annan vecka' }));
  assert.equal(after.run, false, 'grinden släppte igenom en körning som redan var gjord');
  assert.equal(after.reason, 'already_known');
  assert.equal(after.result, undefined, 'grinden läckte resultat från AI Memory');
  assert.equal(after.libraryRef.libraryRunId, 'known-run');
});

test('minnet kan svara på härkomstfrågorna', () => {
  const memory = freshMemory();
  const dna = anyStrategyDna();
  const block = dna.mutableBlocks[0];
  const parameter = Object.keys(dna.genome[block].values)[0];
  const mutated = strategyDna.mutateStrategyDna(dna, {
    [`${block}.${parameter}`]: dna.genome[block].values[parameter] + 2,
  }, { mutationType: 'risk_loosen', branch: 'test_branch' });

  memory.recordExperiment(specFor(mutated.dna), refFor(mutated.dna, { libraryRunId: 'mutation-run' }), {
    lineage: mutated.dna.lineage,
  });
  const record = memory.findExperiment(specFor(mutated.dna));

  assert.equal(record.lineage.parent, dna.dnaHash, 'vilken strategi var förälder');
  assert.equal(record.lineage.mutationType, 'risk_loosen', 'vilken mutation skapade detta');
  assert.equal(record.lineage.generation, 1);
  assert.equal(record.identity.marketDnaHash, 'market-aaa', 'vilken marknad');
  assert.equal(record.provenance[0].period, '2026-08-11..2026-08-14', 'vilken period');
  assert.equal(record.identity.replayMode, 'strategy', 'vilken replaymodell');
  assert.equal(record.libraryRef.libraryRunId, 'mutation-run', 'var resultatet finns');
  assert.equal(record.result, undefined, 'AI Memory lagrar fortfarande resultat');
});

// ── Family Tree ═════════════════════════════════════════════════════════════

test('Family Tree byggs korrekt och generationen räknas rätt', () => {
  const tree = freshTree();
  const engine = evolutionModule.createEvolutionEngine({ familyTree: tree });
  engine.seedRegisteredStrategies();
  // Seedningen följer DNA-populationen, som är unionen av katalogregistret och
  // native-registret — inte katalogregistret ensamt.
  assert.equal(tree.listNodes().length, strategyDna.listStrategyDna().length);

  let current = anyStrategyDna();
  const chain = [current.dnaHash];
  for (let generation = 1; generation <= 3; generation += 1) {
    const block = current.mutableBlocks[0];
    const parameter = Object.keys(current.genome[block].values)[0];
    const result = engine.evolve({
      parentDna: current,
      changes: { [`${block}.${parameter}`]: current.genome[block].values[parameter] + generation },
      mutationType: evolutionModule.MUTATION_TYPES.PARAMETER,
      branch: 'lineage_test',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.generation, generation, 'generationen räknades fel');
    assert.equal(result.node.parent, current.dnaHash, 'föräldern pekade fel');
    assert.equal(result.node.branch, 'lineage_test');
    assert.equal(result.node.rootStrategyId, current.lineage.rootStrategyId || current.strategyId);
    // Ett muterat genom är inte en registrerad strategi.
    assert.equal(result.node.strategyId, null);
    chain.push(result.dna.dnaHash);
    current = result.dna;
  }

  // Parent/child åt båda hållen.
  const ancestry = tree.ancestryOf(current.dnaHash).map((node) => node.dnaHash);
  assert.deepEqual(ancestry, chain, 'släktkedjan stämmer inte');
  assert.deepEqual(tree.childrenOf(chain[0]).map((n) => n.dnaHash), [chain[1]]);
  assert.deepEqual(
    tree.descendantsOf(chain[0]).map((n) => n.dnaHash).sort(),
    chain.slice(1).sort(),
  );
  assert.equal(tree.getNode(chain[0]).generation, 0, 'roten är generation noll');
});

test('generationen härleds ur trädet, inte ur anroparen', () => {
  const tree = freshTree();
  const root = anyStrategyDna();
  tree.addNode({ dnaHash: root.dnaHash, strategyId: root.strategyId, branch: 'root' });
  // Anroparen skickar in en generation — trädet ska ignorera den och räkna själv.
  tree.addNode({ dnaHash: 'child-1', parent: root.dnaHash, generation: 99, branch: 'root' });
  assert.equal(tree.getNode('child-1').generation, 1, 'en påhittad generation togs på tro');

  // Ett barn till en okänd förälder avvisas.
  const orphan = tree.addNode({ dnaHash: 'orphan', parent: 'finns-inte' });
  assert.equal(orphan.ok, false);
  assert.match(orphan.reason, /^unknown_parent/);
});

test('en hel gren kan pensioneras utan att något tas bort', () => {
  const tree = freshTree();
  const engine = evolutionModule.createEvolutionEngine({ familyTree: tree });
  engine.seedRegisteredStrategies();

  let current = anyStrategyDna();
  const branchNodes = [];
  for (let i = 1; i <= 3; i += 1) {
    const block = current.mutableBlocks[0];
    const parameter = Object.keys(current.genome[block].values)[0];
    const result = engine.evolve({
      parentDna: current,
      changes: { [`${block}.${parameter}`]: current.genome[block].values[parameter] + i },
      mutationType: evolutionModule.MUTATION_TYPES.PARAMETER,
      branch: 'dead_end',
    });
    branchNodes.push(result.dna.dnaHash);
    current = result.dna;
  }

  const nodesBefore = tree.listNodes().length;
  const retired = tree.retireBranch('dead_end', { reason: 'ingen edge i någon regim' });
  assert.equal(retired.ok, true);
  assert.equal(retired.retired.length, 3);

  // Ingenting togs bort — noderna finns kvar, märkta.
  assert.equal(tree.listNodes().length, nodesBefore);
  for (const hash of branchNodes) {
    const node = tree.getNode(hash);
    assert.equal(node.retired, true);
    assert.equal(node.retiredWithBranch, true);
    assert.equal(node.retiredReason, 'ingen edge i någon regim');
    assert.ok(node.parent || node.generation === 0, 'släktskapet raderades av pensioneringen');
  }
  const branch = tree.listBranches().find((row) => row.branch === 'dead_end');
  assert.equal(branch.fullyRetired, true);

  // En pensionerad gren får inte få nya barn bakvägen.
  const blocked = engine.evolve({
    parentDna: current,
    changes: { [`${current.mutableBlocks[0]}.${Object.keys(current.genome[current.mutableBlocks[0]].values)[0]}`]: 42 },
    mutationType: evolutionModule.MUTATION_TYPES.PARAMETER,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'parent_is_retired');

  // Pensionering kräver skäl.
  assert.equal(tree.retireBranch('root', {}).reason, 'retirement_requires_reason');
});

// ── Evolution Engine gör bara DNA ═══════════════════════════════════════════

test('Evolution Engine kör ingen replay och väljer ingen vinnare', () => {
  const tree = freshTree();
  const engine = evolutionModule.createEvolutionEngine({ familyTree: tree });
  const status = engine.getStatus();
  assert.deepEqual(status.capabilities, {
    createsDna: true,
    storesLineage: true,
    usesOptimizer: true,
    runsReplay: false,
    ownsOptimization: false,
    selectsWinner: false,
    scoresStrategies: false,
  });

  const source = fs.readFileSync(path.join(SERVICES, 'evolution', 'evolutionEngineService.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  // Leta IMPORTER, inte ord. Första versionen matchade på /replay/i och föll på
  // sin egen `runsReplay: false` — alltså på deklarationen att den inte gör det
  // testet letade efter.
  const imports = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  const forbidden = imports.filter((name) => /replay|fillEngine|brokerRisk|Scanner|Ledger|priceFeed/i.test(name));
  assert.deepEqual(forbidden, [],
    `Evolution Engine importerar exekveringskedjan: ${forbidden.join(', ')}`);
  // Och den anropar ingen motor.
  assert.doesNotMatch(source, /\.run\s*\(/, 'Evolution Engine kör något');
  assert.doesNotMatch(source, /native_futures_\w+_v\d/, 'Evolution Engine har en egen strategilista');
  assert.doesNotMatch(source, /Math\.random\(/, 'evolutionen är slumpmässig och därmed oreproducerbar');
});

// ── Optimizer-kontraktet ════════════════════════════════════════════════════

test('Optimizer-kontraktet förbjuder genvägarna', () => {
  const description = optimizer.describeInterface();
  assert.equal(description.implemented, false);

  // Måtten som får optimeras mot innehåller inget exekveringsmått.
  for (const target of optimizer.OPTIMIZATION_TARGETS) {
    assert.equal(optimizer.validateTarget(target).ok, true);
  }
  for (const target of optimizer.FORBIDDEN_TARGETS) {
    const check = optimizer.validateTarget(target);
    assert.equal(check.ok, false, `${target} tilläts som optimeringsmål`);
    assert.ok(check.reason, 'förbudet saknar motivering');
  }

  // Ett förslag måste peka på DNA, inte på en strategi.
  const withStrategyId = optimizer.validateProposal({
    parentDnaHash: 'abc', changes: { 'risk.stopLossPct': 0.3 }, mutationType: 'parameter',
    rationale: 'test', expectedTarget: 'strategyScore', strategyId: 'något',
  });
  assert.equal(withStrategyId.ok, false);
  assert.ok(withStrategyId.errors.includes('proposal_must_target_dna_not_strategy_id'));

  const valid = optimizer.validateProposal({
    parentDnaHash: 'abc', changes: { 'risk.stopLossPct': 0.3 }, mutationType: 'parameter',
    rationale: 'test', expectedTarget: 'strategyScore',
  });
  assert.deepEqual(valid, { ok: true, errors: [] });
});

// ── Replay, Paper och Native Scanner är opåverkade ══════════════════════════

test('varken replay, paper, scanner eller riskmotor känner till AI-lagret', () => {
  // Källkodsregel. Hela AI-lagret får vara fel utan att en order påverkas — men
  // bara så länge exekveringskedjan inte importerar det.
  const chain = [
    ['replay', 'nativeReplayEngineService.js'],
    ['replay', 'replayBookAllocator.js'],
    ['.', 'nativeFuturesScannerService.js'],
    ['.', 'ibPaperBrokerRiskService.js'],
    ['.', 'ibPaperExecutionOrchestratorService.js'],
    ['canonical', 'nativeFuturesSignalProvider.js'],
    ['execution', 'simulatedFillEngine.js'],
    ['execution', 'perfectFillEngine.js'],
    ['trade', 'tradeLedgerService.js'],
  ];
  const forbidden = /require\('[^']*\/(dna|memory|evolution|optimizer)\//;

  for (const [dir, file] of chain) {
    const source = fs.readFileSync(path.join(SERVICES, dir, file), 'utf8');
    assert.doesNotMatch(source, forbidden,
      `${file} importerar AI-lagret — då kan ett fel i AI påverka exekveringen`);
  }
});

test('strategimodulerna exponerar sina parametrar utan att ändra beteende', () => {
  // DEFAULT_OPTIONS exporterades för att DNA ska kunna härledas ur koden. Det
  // ska vara ett rent tillägg: samma objekt som strategin själv använder.
  for (const descriptor of registry.listNativeStrategies()) {
    assert.ok(descriptor.defaultOptions && typeof descriptor.defaultOptions === 'object',
      `${descriptor.strategyId} exponerar inga parametrar`);
    assert.ok(Object.keys(descriptor.defaultOptions).length > 0,
      `${descriptor.strategyId} har tomma parametrar`);
    // tickSize finns i alla åtta och är det som binder dem till instrumentet.
    assert.ok('tickSize' in descriptor.defaultOptions);
  }

  // Evaluatorerna är oförändrade: registret ger fortfarande exakt en per
  // strategi, i samma ordning.
  assert.equal(registry.listStrategyEvaluators().length, registry.listNativeStrategies().length);
  assert.deepEqual(
    registry.listStrategyEvaluators().map((row) => row.strategyId),
    registry.listNativeStrategies().map((row) => row.strategyId),
  );
});

test('strategi-DNA räknas på ett enda ställe', () => {
  // Biblioteket räknade tidigare sin egen hash. Två svar på "har strategin
  // ändrats" är i praktiken noll svar.
  const librarySource = fs.readFileSync(path.join(SERVICES, 'library', 'strategyLibraryService.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(librarySource, /function computeStrategyDnaHash/,
    'biblioteket räknar fortfarande en egen DNA-hash');
  assert.match(librarySource, /require\('\.\.\/dna\/strategyDnaService'\)/,
    'biblioteket hämtar inte DNA-hashen från DNA-modulen');

  // Och de tre permanenta minnena delar samma logg-mekanik.
  for (const [dir, file] of [
    ['memory', 'aiMemoryService.js'],
    ['evolution', 'strategyFamilyTreeService.js'],
  ]) {
    const source = fs.readFileSync(path.join(SERVICES, dir, file), 'utf8');
    assert.match(source, /require\('\.\.\/\.\.\/data\/eventLog'\)/,
      `${file} har en egen kopia av append-only-loggen`);
  }
});

test('minnets loggar skriver aldrig över historik', () => {
  const memory = freshMemory();
  const dna = anyStrategyDna();
  const file = memory.eventsFile;

  const snapshots = [];
  for (let i = 0; i < 4; i += 1) {
    snapshots.push(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    memory.recordExperiment(
      specFor(dna, { marketDnaHash: `market-${i}` }),
      refFor(dna, { libraryRunId: `run-${i}` }),
    );
    const current = fs.readFileSync(file, 'utf8');
    assert.ok(current.startsWith(snapshots.at(-1)), 'en tidigare rad ändrades');
    assert.ok(current.length > snapshots.at(-1).length);
  }
  // Revisionsordningen är monoton.
  const trail = memory.getAuditTrail();
  const times = trail.map((row) => Date.parse(row.recordedAt));
  assert.ok(times.every(Number.isFinite));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});
