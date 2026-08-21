'use strict';

// ── Hur många genom en cykel får skapa ───────────────────────────────────────
//
// Talet stod hårdkodat som 1 i orchestratorn. Optimeraren kan föreslå flera och
// har 6 som sitt eget standardvärde, men fabriken bad alltid om ett — och med
// sex timmar mellan cyklerna blev det fyra genom per dygn i bästa fall. Var det
// enda förslaget dessutom redan känt tillförde cykeln ingenting.
//
// Dessutom fick bara det FÖRSTA genomet en replay. Resten av cykelns arbete
// prövades aldrig, vilket gjorde en högre kandidatsiffra meningslös.
//
// Testerna kör mot ett eget släktträd. Produktionens rörs inte.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const evolutionModule = require('../evolution/evolutionEngineService');
const familyTreeModule = require('../evolution/strategyFamilyTreeService');
const optimizerModule = require('../optimizer/aiOptimizerService');
const strategyDna = require('../dna/strategyDnaService');
const scheduler = require('../replaySchedulerService');
const queue = require('../replayQueueService');

function freshEngine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throughput-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* städat nog */ } });
  const tree = familyTreeModule.createStrategyFamilyTree({ eventsFile: path.join(dir, 'tree.jsonl') });
  return { engine: evolutionModule.createEvolutionEngine({ familyTree: tree }), tree };
}

function rootDna() {
  return strategyDna.listStrategyDna().find((row) => row.strategyId === 'native_futures_momentum_v1');
}

function contextFor(parent) {
  return {
    marketDnaHash: 'm'.repeat(16),
    replayMode: 'strategy',
    executionModel: 'simulated_fill',
    strategyVersion: parent.strategyVersion,
    executedTimeframe: '2m',
  };
}

// ── kandidater per cykel ────────────────────────────────────────────────────

test('standardvärdet kommer från optimeraren, inte från en siffra i fabriken', () => {
  // Optimeraren äger begreppet. Står talet på två ställen glider de isär.
  assert.equal(optimizerModule.DEFAULT_MAX_CANDIDATES, 6);
});

test('en cykel skapar flera genom när flera parametrar är outforskade', (t) => {
  const { engine } = freshEngine(t);
  const parent = rootDna();
  const result = engine.createOptimizedDnaCandidates({
    parentDna: parent, context: contextFor(parent),
    maxCandidates: optimizerModule.DEFAULT_MAX_CANDIDATES, branch: 'test',
  });
  assert.ok(result.created.length > 1, `en cykel gav bara ${result.created.length} genom`);
  assert.ok(result.created.length <= optimizerModule.DEFAULT_MAX_CANDIDATES);
});

test('inga två genom i samma cykel delar parameteruppsättning', (t) => {
  const { engine } = freshEngine(t);
  const parent = rootDna();
  const result = engine.createOptimizedDnaCandidates({
    parentDna: parent, context: contextFor(parent), maxCandidates: 6, branch: 'test',
  });
  const hashes = result.created.map((row) => row.dna.parameterHash);
  assert.equal(new Set(hashes).size, hashes.length, 'två genom hade samma parameterHash');
  const dnaHashes = result.created.map((row) => row.dna.dnaHash);
  assert.equal(new Set(dnaHashes).size, dnaHashes.length, 'två genom hade samma dnaHash');
});

test('varje genom ändrar minst en parameter, alltså inga tomma mutationer', (t) => {
  const { engine } = freshEngine(t);
  const parent = rootDna();
  const result = engine.createOptimizedDnaCandidates({
    parentDna: parent, context: contextFor(parent), maxCandidates: 6, branch: 'test',
  });
  for (const row of result.created) {
    assert.ok(Object.keys(row.applied || {}).length > 0, 'ett genom utan ändring är inget att pröva');
    assert.notEqual(row.dna.dnaHash, parent.dnaHash);
  }
});

// ── ett replay-jobb per genom ───────────────────────────────────────────────

test('varje skapat genom får ett eget replay-jobb', (t) => {
  const { engine } = freshEngine(t);
  const parent = rootDna();
  const result = engine.createOptimizedDnaCandidates({
    parentDna: parent, context: contextFor(parent), maxCandidates: 4, branch: 'test',
  });
  assert.ok(result.created.length > 1);

  const gaps = result.created.map((row) => ({
    strategyId: parent.strategyId,
    mode: 'confidence',
    genome: {
      dnaHash: row.dna.dnaHash,
      strategyId: parent.strategyId,
      rootStrategyId: parent.strategyId,
      generation: row.generation,
      options: {},
    },
  }));

  const built = scheduler.defaultReplaySchedulerService.buildSchedule({
    knowledgeGaps: gaps,
    now: new Date('2026-08-20T12:00:00.000Z').toISOString(),
    config: { maxJobsPerRun: gaps.length },
  });
  const jobs = built.jobs.map((job) => queue._internal.normalizeJob(job).job);
  assert.equal(jobs.length, gaps.length, 'alla genom fick inte varsitt jobb');

  // Separata identiteter hela vägen — annars slås körningarna ihop i kön.
  assert.equal(new Set(jobs.map((job) => job.id)).size, jobs.length);
  assert.equal(new Set(jobs.map((job) => job.fingerprint)).size, jobs.length);
  assert.equal(new Set(jobs.map((job) => job.genome.dna_hash)).size, jobs.length);
});

test('utan genom byggs fortfarande ett vanligt jobb', () => {
  const built = scheduler.defaultReplaySchedulerService.buildSchedule({
    knowledgeGaps: [{ strategyId: 'native_futures_momentum_v1', mode: 'confidence' }],
    now: new Date('2026-08-20T12:00:00.000Z').toISOString(),
    // Taket måste sättas. buildSchedule fyller annars på med jobb för
    // registerstrategier som saknar replay-historik — se nästa test.
    config: { maxJobsPerRun: 1 },
  });
  assert.equal(built.jobs.length, 1);
  assert.equal(queue._internal.normalizeJob(built.jobs[0]).job.genome, null);
});

test('taket måste vara exakt antalet genom, annars smyger andra jobb in', () => {
  const now = new Date('2026-08-20T12:00:00.000Z').toISOString();
  const gaps = [1, 2, 3].map((i) => ({
    strategyId: 'native_futures_momentum_v1',
    mode: 'confidence',
    genome: { dnaHash: `g${i}`.padEnd(16, '0'), options: {} },
  }));

  // Så som orchestratorn gör: taket = antalet genom.
  const exact = scheduler.defaultReplaySchedulerService.buildSchedule({
    knowledgeGaps: gaps, now, config: { maxJobsPerRun: gaps.length },
  });
  assert.equal(exact.jobs.length, gaps.length);
  assert.ok(exact.jobs.every((job) => job.genome), 'ett jobb utan genom kom med');

  // Ett HÖGRE tak fyller på med jobb cykeln inte bad om. Det är därför taket
  // inte får sättas till en konstant.
  const loose = scheduler.defaultReplaySchedulerService.buildSchedule({
    knowledgeGaps: gaps, now, config: { maxJobsPerRun: gaps.length + 3 },
  });
  assert.ok(loose.jobs.filter((job) => !job.genome).length > 0);
});

// ── inte brute force ────────────────────────────────────────────────────────

test('cykeln utforskar de minst prövade parametrarna först', (t) => {
  const { engine } = freshEngine(t);
  const parent = rootDna();
  const opts = { parentDna: parent, context: contextFor(parent), maxCandidates: 2, branch: 'test' };
  const first = engine.createOptimizedDnaCandidates(opts);
  const second = engine.createOptimizedDnaCandidates(opts);

  const firstPaths = first.created.flatMap((row) => Object.keys(row.applied || {}));
  const secondPaths = second.created.flatMap((row) => Object.keys(row.applied || {}));
  assert.equal(
    firstPaths.filter((row) => secondPaths.includes(row)).length, 0,
    'samma parameter muterades igen trots outforskade kvar — det är brute force, inte urval',
  );
});
