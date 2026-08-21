'use strict';

// ── Generation 2 hela vägen ──────────────────────────────────────────────────
//
// Ett barnbarn är inte en variant av roten. Det bär FÖRÄLDERNS mutation plus
// sin egen, och det är just den ackumuleringen som gör evolution till något
// annat än en parametersvep: barnet ärver det föräldern redan visat.
//
// Testerna låser fyra saker som var och en tyst hade förstört evidensen:
//
//   · barnet kör med sina EGNA parametrar, inte förälderns och inte basens
//   · två syskon hålls isär hela vägen — genom, jobb och experimentidentitet
//   · körningen laddar bara det genom som begärdes
//   · affärerna bokförs på barnets eget id, så evidensen hamnar rätt
//
// Läser produktionens släktträd men SKRIVER ingenting: motorn är fri från
// fil-IO, och bokföringen sker i barnprocessen som testet inte startar.

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('./nativeFuturesStrategyRegistryService');
const evolutionModule = require('./evolution/evolutionEngineService');
const familyTree = require('./evolution/strategyFamilyTreeService').defaultStrategyFamilyTree;
const scheduler = require('./replaySchedulerService');
const queue = require('./replayQueueService');
const memory = require('./memory/aiMemoryService');

const engine = evolutionModule.createEvolutionEngine();

/** Två syskon i generation 2 med samma förälder, eller null. */
function siblingPair() {
  const gen2 = familyTree.listNodes().filter((node) => node.generation === 2 && node.retired !== true);
  const byParent = new Map();
  for (const node of gen2) {
    const bucket = byParent.get(node.parent) || [];
    bucket.push(node);
    byParent.set(node.parent, bucket);
  }
  for (const [parent, children] of byParent) {
    const runnable = children.filter((node) => registry.describeRequestedGenomes([node.dnaHash])[0].loaded);
    if (runnable.length >= 2) return { parent, a: runnable[0], b: runnable[1] };
  }
  return null;
}

function descriptorFor(dnaHash) {
  return registry.listNativeStrategies({ includeBase: false, genomeHashes: [dnaHash] })[0] || null;
}

function jobFor(dnaHash) {
  const descriptor = descriptorFor(dnaHash);
  const gap = {
    strategyId: descriptor.rootStrategyId,
    mode: 'confidence',
    genome: {
      dnaHash,
      strategyId: descriptor.strategyId,
      rootStrategyId: descriptor.rootStrategyId,
      generation: descriptor.generation,
      options: descriptor.defaultOptions,
    },
  };
  const built = scheduler.defaultReplaySchedulerService.buildSchedule({
    knowledgeGaps: [gap], now: new Date('2026-08-20T12:00:00.000Z').toISOString(),
  });
  return queue._internal.normalizeJob(built.jobs[0]).job;
}

function specFor(dnaHash) {
  const descriptor = descriptorFor(dnaHash);
  const dna = engine.dnaForNode(dnaHash);
  return {
    strategyDnaHash: dna.dnaHash,
    parameterHash: dna.parameterHash,
    marketDnaHash: 'm'.repeat(16),
    replayMode: 'strategy',
    executionModel: 'simulated_fill',
    strategyVersion: descriptor.strategyVersion,
    declaredTimeframe: memory.NO_DECLARED_TIMEFRAME,
    executedTimeframe: '2m',
  };
}

test('generation 2 finns och går att köra', (t) => {
  const pair = siblingPair();
  if (!pair) return t.skip('släktträdet har inga två körbara syskon i generation 2');
  assert.equal(familyTree.getNode(pair.a.dnaHash).generation, 2);
  assert.equal(familyTree.getNode(pair.b.dnaHash).generation, 2);
});

test('barnet bär förälderns mutation OCH sin egen', (t) => {
  const pair = siblingPair();
  if (!pair) return t.skip('inga syskon i generation 2');
  const child = descriptorFor(pair.a.dnaHash);
  const parent = descriptorFor(pair.parent);
  const base = registry.listNativeStrategies().find((row) => row.strategyId === child.rootStrategyId);
  assert.ok(base, 'roten saknas i registret');

  const parentChanged = Object.keys(base.defaultOptions)
    .filter((key) => base.defaultOptions[key] !== parent.defaultOptions[key]);
  assert.ok(parentChanged.length, 'föräldern skiljer sig inte från basen — testet mäter ingenting');

  // Förälderns ändring MÅSTE finnas kvar i barnet. Gick den förlorad vore
  // generation 2 bara ännu en enstegsmutation av roten.
  for (const key of parentChanged) {
    assert.equal(child.defaultOptions[key], parent.defaultOptions[key],
      `barnet tappade förälderns ändring av ${key}`);
  }
  // Och barnet måste ha ändrat något EGET utöver det.
  assert.notDeepEqual(child.defaultOptions, parent.defaultOptions);
});

test('två syskon har olika parametrar, olika identitet och olika experimentnyckel', (t) => {
  const pair = siblingPair();
  if (!pair) return t.skip('inga syskon i generation 2');
  const a = descriptorFor(pair.a.dnaHash);
  const b = descriptorFor(pair.b.dnaHash);

  assert.notEqual(a.strategyId, b.strategyId);
  assert.notDeepEqual(a.defaultOptions, b.defaultOptions);

  const specA = specFor(pair.a.dnaHash);
  const specB = specFor(pair.b.dnaHash);
  assert.notEqual(specA.parameterHash, specB.parameterHash, 'syskonen delar parameterHash');
  assert.notEqual(specA.strategyDnaHash, specB.strategyDnaHash);
  // Dubblettskyddet får aldrig blanda ihop dem: samma nyckel hade betytt att
  // det andra syskonets körning aldrig ansågs behövas.
  assert.notEqual(memory.experimentKey(specA), memory.experimentKey(specB));
});

test('varje syskon får sitt eget replay-jobb', (t) => {
  const pair = siblingPair();
  if (!pair) return t.skip('inga syskon i generation 2');
  const a = jobFor(pair.a.dnaHash);
  const b = jobFor(pair.b.dnaHash);
  assert.equal(a.genome.dna_hash, pair.a.dnaHash);
  assert.equal(b.genome.dna_hash, pair.b.dnaHash);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.fingerprint, b.fingerprint);
  // Jobbet bär parametrarna, inte bara identiteten.
  assert.notDeepEqual(a.genome.options, b.genome.options);
});

test('en körning laddar bara det genom som begärdes', (t) => {
  const pair = siblingPair();
  if (!pair) return t.skip('inga syskon i generation 2');
  const loaded = registry.listStrategyEvaluators({
    includeBase: false, includeVariants: false, includeEvolved: false,
    genomeHashes: [pair.a.dnaHash],
  });
  assert.equal(loaded.length, 1);
  assert.ok(loaded[0].strategyId.endsWith(pair.a.dnaHash));
  // Syskonet får inte följa med på köpet.
  assert.ok(!loaded.some((row) => row.strategyId.includes(pair.b.dnaHash)));
});

test('vyn skiljer på begärt och faktiskt kört genom', () => {
  const status = require('./factory/aiFactoryLoopStatusService');
  const ran = status._internal.summarizeStep('HISTORICAL_REPLAY', {
    executed: true, replayRunId: 'run1',
    requestedGenome: 'abc123', executedGenomes: ['root@abc123'],
  });
  assert.match(ran, /genom root@abc123/);

  const missed = status._internal.summarizeStep('HISTORICAL_REPLAY', {
    executed: true, replayRunId: 'run1',
    requestedGenome: 'abc123', executedGenomes: ['root@något_annat'],
  });
  assert.match(missed, /kördes INTE/);
});
