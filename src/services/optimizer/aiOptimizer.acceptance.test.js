'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const optimizerModule = require('./aiOptimizerService');
const optimizerInterface = require('./aiOptimizerInterface');
const aiMemory = require('../memory/aiMemoryService');
const strategyDna = require('../dna/strategyDnaService');
const familyTreeModule = require('../evolution/strategyFamilyTreeService');
const evolutionModule = require('../evolution/evolutionEngineService');

const SERVICES = path.join(__dirname, '..');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-optimizer-')), name);
}

function freshMemory() {
  return aiMemory.createAiMemory({ eventsFile: tmpFile('experiments.jsonl') });
}

function freshTree() {
  return familyTreeModule.createStrategyFamilyTree({ eventsFile: tmpFile('lineage.jsonl') });
}

function parentDna() {
  const all = strategyDna.listStrategyDna();
  assert.ok(all.length > 0, 'saknar strategy-DNA att optimera');
  return all[0];
}

function context(overrides = {}) {
  return {
    marketDnaHash: 'market-ai-optimizer',
    replayMode: 'strategy',
    executionModel: 'simulated_fill:cfg1',
    period: '2026-08-11..2026-08-14',
    symbols: ['MES', 'MNQ'],
    regimeKeys: ['flat/normal'],
    marketClassification: 'range',
    ...overrides,
  };
}

function libraryRef(overrides = {}) {
  return {
    source: 'strategy_library',
    resultType: 'replay',
    strategyId: 'native_futures_momentum_v1',
    libraryRunId: 'optimizer-known-run',
    eventType: 'REPLAY_RECORDED',
    ...overrides,
  };
}

function libraryRecord() {
  return {
    strategyScore: 42,
    confidenceScore: 38,
    executionScore: 71,
    productionScore: null,
    replayHistory: [{ trades: 16 }, { trades: 14 }],
    paperHistory: [],
    liveHistory: [],
  };
}

test('AI Optimizer är byggd men kör, köar och väljer ingenting', () => {
  const optimizer = optimizerModule.createAiOptimizer({ memory: freshMemory() });
  const description = optimizer.describe();

  assert.equal(description.ok, true);
  assert.equal(description.interface.implemented, true);
  assert.equal(description.capabilities.createsDnaProposals, true);
  assert.equal(description.capabilities.asksMemoryBeforeDna, true);
  assert.equal(description.capabilities.returnsExistingExperiment, true);
  assert.equal(description.capabilities.createsMultipleCandidates, true);
  assert.equal(description.capabilities.selectsWinner, false);
  assert.equal(description.capabilities.runsReplay, false);
  assert.equal(description.capabilities.enqueuesReplay, false);
  assert.equal(description.capabilities.mutatesLineage, false);
});

test('AI Optimizer frågar AI Memory innan kandidat-DNA byggs', () => {
  const calls = [];
  const memory = {
    experimentsForDna(hash) {
      calls.push(`memory:${hash}`);
      return [];
    },
    lookupOrPlan(spec) {
      calls.push(`gate:${spec.strategyDnaHash}`);
      return { cached: false, experimentKey: `exp:${spec.strategyDnaHash}` };
    },
    findExperiment() {
      return null;
    },
    getStatus() {
      return { ok: true };
    },
  };
  const dnaService = {
    mutateStrategyDna(dna, changes, opts) {
      calls.push(`mutate:${Object.keys(changes).join(',')}`);
      return strategyDna.mutateStrategyDna(dna, changes, opts);
    },
  };

  const result = optimizerModule.createAiOptimizer({ memory, dnaService }).propose({
    parentDna: parentDna(),
    context: context(),
    maxCandidates: 1,
    libraryRecord: libraryRecord(),
  });

  assert.equal(result.ok, true);
  assert.ok(calls[0].startsWith('memory:'), `första anropet var inte AI Memory: ${calls.join(' -> ')}`);
  assert.ok(calls.some((call) => call.startsWith('mutate:')), 'testet muterade aldrig en kandidat');
  assert.ok(
    calls.findIndex((call) => call.startsWith('memory:')) < calls.findIndex((call) => call.startsWith('mutate:')),
    `AI Memory frågades inte före DNA-kandidat: ${calls.join(' -> ')}`,
  );
});

test('AI Optimizer returnerar befintligt experiment i stället för ny DNA-proposal', () => {
  const memory = freshMemory();
  const optimizer = optimizerModule.createAiOptimizer({ memory });
  const first = optimizer.propose({
    parentDna: parentDna(),
    context: context(),
    maxCandidates: 1,
    libraryRecord: libraryRecord(),
  });
  assert.equal(first.ok, true);
  assert.equal(first.proposals[0].status, 'new_dna_proposal');

  memory.recordExperiment(first.proposals[0].experimentSpec, libraryRef({ libraryRunId: 'optimizer-run-77' }), {
    lineage: first.proposals[0].dnaProposal.lineage,
  });

  const second = optimizer.propose({
    parentDna: parentDna(),
    context: context({ period: '2026-09-01..2026-09-04' }),
    maxCandidates: 1,
    libraryRecord: libraryRecord(),
  });

  assert.equal(second.ok, true);
  assert.equal(second.proposals[0].status, 'existing_experiment');
  assert.equal(second.proposals[0].cached, true);
  assert.equal(second.proposals[0].createsNewDna, false);
  assert.equal(second.proposals[0].dnaProposal, undefined);
  assert.equal(second.proposals[0].existingExperiment.result, undefined);
  assert.equal(second.proposals[0].existingExperiment.libraryRef.libraryRunId, 'optimizer-run-77');
});

test('AI Optimizer kan skapa flera DNA-kandidater men ingen vinnare', () => {
  const result = optimizerModule.createAiOptimizer({ memory: freshMemory() }).propose({
    parentDna: parentDna(),
    context: context(),
    maxCandidates: 4,
    target: 'strategyScore',
    libraryRecord: libraryRecord(),
  });

  assert.equal(result.ok, true);
  assert.ok(result.proposals.filter((row) => row.status === 'new_dna_proposal').length > 1);
  assert.equal(result.winner, null);
  assert.equal(result.capabilities.selectsWinner, false);
  assert.ok(result.proposals.every((row) => !('selected' in row)));
  assert.ok(result.proposals.every((row) => row.libraryEvidence.source === 'strategy_library'));
  assert.ok(result.proposals.every((row) => row.expectedTarget === 'strategyScore'));
  assert.ok(result.proposals.every((row) => row.memoryGate));
});

test('Evolution använder Optimizer men äger mutation och lineage', () => {
  const memory = freshMemory();
  const optimizer = optimizerModule.createAiOptimizer({ memory });
  const tree = freshTree();
  const engine = evolutionModule.createEvolutionEngine({ familyTree: tree, optimizer });
  const parent = parentDna();

  const created = engine.createOptimizedDnaCandidates({
    parentDna: parent,
    context: context(),
    maxCandidates: 2,
    libraryRecord: libraryRecord(),
  });

  assert.equal(created.ok, true, JSON.stringify(created));
  assert.ok(created.created.length > 0);
  assert.equal(created.winner, null);
  assert.equal(created.replayEngineKnown, false);
  assert.equal(created.optimizerAskedMemoryBeforeDna, true);
  assert.equal(tree.getNode(parent.dnaHash).strategyId, parent.strategyId);
  for (const row of created.created) {
    assert.equal(row.node.parent, parent.dnaHash);
    assert.equal(row.node.strategyId, null);
    assert.equal(row.node.mutationType, row.proposal.mutationType);
    assert.equal(row.node.dnaHash, row.dna.dnaHash);
  }

  const beforeCachedRun = tree.listNodes().length;
  memory.recordExperiment(created.created[0].proposal.experimentSpec, libraryRef({ libraryRunId: 'evolution-known-run' }), {
    lineage: created.created[0].dna.lineage,
  });
  // maxCandidates är brett nog att den redan prövade förändringen finns med i
  // urvalet. Snävare vore att pröva ORDNINGEN i stället för cachen: sedan
  // optimeraren väljer minst utforskad parameter först skulle en enda kandidat
  // avsiktligt hamna på en annan väg, och testet hade då mätt fel sak.
  const cached = engine.createOptimizedDnaCandidates({
    parentDna: parent,
    context: context({ period: '2026-10-01..2026-10-04' }),
    maxCandidates: 6,
    libraryRecord: libraryRecord(),
  });

  const knownDnaHash = created.created[0].dna.dnaHash;
  assert.equal(cached.ok, true);
  assert.ok(cached.existingExperiments.length >= 1, 'cacheträffen rapporterades inte');
  assert.ok(
    cached.created.every((row) => row.dna.dnaHash !== knownDnaHash),
    'cacheträff skapade ändå ny lineage-nod för ett känt experiment',
  );
  // Noder som redan finns skrivs aldrig om — trädet växer bara med genuint nya
  // genom.
  assert.ok(tree.listNodes().length >= beforeCachedRun);
});

test('AI Optimizer importerar inte replay-, queue-, paper- eller native-kedjan', () => {
  const source = fs.readFileSync(path.join(SERVICES, 'optimizer', 'aiOptimizerService.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const imports = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  const forbidden = imports.filter((name) => /replay|queue|scheduler|scanner|paper|broker|ledger|fill/i.test(name));
  assert.deepEqual(forbidden, [], `AI Optimizer känner till förbjuden kedja: ${forbidden.join(', ')}`);
  assert.doesNotMatch(source, /\.run\s*\(/, 'AI Optimizer kör något');
  assert.doesNotMatch(source, /Math\.random\(/, 'AI Optimizer är slumpmässig');
});

test('Optimizer-kontraktet förbjuder fortfarande exekveringsmål', () => {
  for (const target of optimizerInterface.OPTIMIZATION_TARGETS) {
    assert.equal(optimizerInterface.validateTarget(target).ok, true);
  }
  for (const target of optimizerInterface.FORBIDDEN_TARGETS) {
    assert.equal(optimizerInterface.validateTarget(target).ok, false);
  }
});

// ── Vilken parameter prövas? ────────────────────────────────────────────────
//
// Planerna sorterades i bokstavsordning och skars sedan av maxCandidates. Med
// fabrikens standard (en kandidat) rörde varje mutation i systemets historia
// samma parameter i samma riktning: exit.takeProfitR nedåt. Resten av
// parameterrymden hade aldrig prövats.

test('minst utforskade parametern väljs först', () => {
  const optimizer = optimizerModule.createAiOptimizer({});
  const build = optimizer._internal.buildChangePlans;
  const parent = strategyDna.listStrategyDna()
    .find((dna) => 'exit.takeProfitR' in strategyDna.parametersOf(dna.genome)
      && 'risk.stopLossPct' in strategyDna.parametersOf(dna.genome));
  assert.ok(parent, 'ingen strategi med båda parametrarna att pröva mot');

  // Utan historik: bokstavsordning, precis som förut. Determinismen är kvar.
  const virgin = build(parent, { maxCandidates: 1 });
  assert.equal(virgin[0].path, 'exit.takeProfitR');

  // Med exit.takeProfitR redan prövad flyttas valet till den outforskade.
  const informed = build(parent, { maxCandidates: 1, exploredPaths: { 'exit.takeProfitR': 3 } });
  assert.equal(informed[0].path, 'risk.stopLossPct',
    'optimeraren valde en parameter den redan vet något om');
  assert.equal(informed[0].explored, 0);

  // Är allt lika mycket prövat faller ordningen tillbaka på bokstavsordning,
  // så samma indata alltid ger samma förslag.
  const tied = build(parent, { maxCandidates: 1, exploredPaths: { 'exit.takeProfitR': 2, 'risk.stopLossPct': 2 } });
  assert.equal(tied[0].path, 'exit.takeProfitR');
});

test('Evolution Engine räknar utforskade parametrar ur släktträdet', () => {
  const tree = familyTreeModule.createStrategyFamilyTree({ eventsFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'explored-')), 'lineage.jsonl') });
  const engine = evolutionModule.createEvolutionEngine({ familyTree: tree });
  engine.seedRegisteredStrategies();

  const parent = strategyDna.listStrategyDna()
    .find((dna) => 'exit.takeProfitR' in strategyDna.parametersOf(dna.genome));
  assert.deepEqual(engine._internal.exploredParameterPaths(parent.dnaHash), {},
    'en orörd rot ska inte ha några utforskade vägar');

  const evolved = engine.evolve({
    parentDna: parent,
    changes: { 'exit.takeProfitR': strategyDna.parametersOf(parent.genome)['exit.takeProfitR'] + 0.5 },
    mutationType: evolutionModule.MUTATION_TYPES.EXIT_EXTEND,
    branch: 'explored_test',
  });
  assert.equal(evolved.ok, true, JSON.stringify(evolved));

  // Räknas både uppåt och nedåt i släkten: en väg som prövats i en systergren
  // är inte outforskad.
  assert.equal(engine._internal.exploredParameterPaths(parent.dnaHash)['exit.takeProfitR'], 1);
  assert.equal(engine._internal.exploredParameterPaths(evolved.dna.dnaHash)['exit.takeProfitR'], 1);
});
