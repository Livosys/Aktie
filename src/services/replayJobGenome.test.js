'use strict';

// ── Replay-jobbet bär genomet ────────────────────────────────────────────────
//
// En fabrikscykel muterar fram ett genom och schemalägger sedan en replay. De
// två stegen var obesläktade: jobbet beskrev en STRATEGI, aldrig det genom som
// just skapats för att prövas. Två konsekvenser, båda tysta:
//
//   1. Köns avtryck kunde inte skilja ett jobb för ett nytt genom från det
//      redan avslutade jobbet för samma kunskapslucka. Cykeln fick
//      `duplicates: 1, created: 0` och EXECUTE_QUEUE hoppade över. Varje gång.
//
//   2. Körningen tog registrets evolverade genom "de EVOLVED_LIMIT nyaste".
//      Hade tillräckligt många nyare hunnit skapas prövades aldrig det genom
//      jobbet fanns för — och evidensen skrevs mot en strategi som inte kördes.
//
// Testerna nedan låser bägge.

const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('./replaySchedulerService');
const queue = require('./replayQueueService');
const registry = require('./nativeFuturesStrategyRegistryService');
const tree = require('./evolution/strategyFamilyTreeService').defaultStrategyFamilyTree;

const GAP = Object.freeze({ strategyId: 'native_futures_momentum_v1', mode: 'confidence' });

function genomeInput(dnaHash) {
  return {
    dnaHash,
    strategyId: 'native_futures_momentum_v1',
    rootStrategyId: 'native_futures_momentum_v1',
    parentDnaHash: 'd31f38afa400eca9',
    generation: 1,
    options: { minBodyPoints: 8, minBodyToRangeRatio: 0.405 },
  };
}

function jobFor(gap) {
  const now = new Date('2026-08-20T12:00:00.000Z').toISOString();
  const built = scheduler.defaultReplaySchedulerService.buildSchedule({ knowledgeGaps: [gap], now });
  assert.ok(built.jobs.length, 'schemaläggaren byggde inget jobb');
  return queue._internal.normalizeJob(built.jobs[0]).job;
}

/** Ett genom som FAKTISKT går att köra, eller null om trädet saknar ett. */
function runnableGenomeHash() {
  const rows = registry.describeRequestedGenomes(
    tree.listNodes()
      .filter((node) => node.retired !== true && node.generation > 0 && node.parent)
      .map((node) => node.dnaHash),
  );
  return rows.find((row) => row.loaded)?.dnaHash || null;
}

// ── jobbets identitet ───────────────────────────────────────────────────────

test('ett jobb utan genom ser ut precis som förut', () => {
  const job = jobFor(GAP);
  assert.equal(job.genome, null);
});

test('genomet följer med hela vägen från kunskapslucka till jobb', () => {
  const job = jobFor({ ...GAP, genome: genomeInput('618ad20267b196e3') });
  assert.equal(job.genome.dna_hash, '618ad20267b196e3');
  assert.equal(job.genome.root_strategy_id, 'native_futures_momentum_v1');
  assert.equal(job.genome.parent_dna_hash, 'd31f38afa400eca9');
  assert.equal(job.genome.generation, 1);
  // Parametrarna finns med så att jobbet går att läsa utan släktträdet.
  assert.equal(job.genome.options.minBodyToRangeRatio, 0.405);
});

test('två olika genom är två olika jobb — dubblettdödläget kan inte återuppstå', () => {
  const a = jobFor({ ...GAP, genome: genomeInput('aaaaaaaaaaaaaaaa') });
  const b = jobFor({ ...GAP, genome: genomeInput('bbbbbbbbbbbbbbbb') });
  const none = jobFor(GAP);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.fingerprint, none.fingerprint);
});

test('samma genom ger samma jobb — dubblettskyddet försvagas inte', () => {
  const a = jobFor({ ...GAP, genome: genomeInput('cccccccccccccccc') });
  const b = jobFor({ ...GAP, genome: genomeInput('cccccccccccccccc') });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.id, b.id);
});

test('endast tal släpps in som parametrar', () => {
  const job = jobFor({
    ...GAP,
    genome: { ...genomeInput('dddddddddddddddd'), options: { good: 1.5, bad: 'inte-ett-tal', alsoBad: null } },
  });
  assert.deepEqual(job.genome.options, { good: 1.5 });
});

test('ett genom utan hash är inget genom', () => {
  const job = jobFor({ ...GAP, genome: { strategyId: 'x', options: { a: 1 } } });
  assert.equal(job.genome, null);
});

// ── registret laddar det begärda genomet ────────────────────────────────────

test('ett uttryckligen begärt genom går förbi taket för evolverade genom', (t) => {
  const hash = runnableGenomeHash();
  if (!hash) return t.skip('släktträdet har inget körbart genom');

  // includeEvolved AV: utan den uttryckliga begäran finns inget genom alls.
  const withoutRequest = registry.listStrategyEvaluators({ includeBase: false, includeEvolved: false });
  assert.equal(withoutRequest.length, 0);

  const withRequest = registry.listStrategyEvaluators({
    includeBase: false, includeEvolved: false, genomeHashes: [hash],
  });
  assert.equal(withRequest.length, 1, 'det begärda genomet laddades inte');
  assert.ok(withRequest[0].strategyId.includes(hash));
});

test('genomet bär andra parametrar än sin bas — annars är det inget att pröva', (t) => {
  const hash = runnableGenomeHash();
  if (!hash) return t.skip('släktträdet har inget körbart genom');
  const evolved = registry.listNativeStrategies({ includeBase: false, genomeHashes: [hash] })[0];
  const base = registry.listNativeStrategies().find((row) => row.strategyId === evolved.rootStrategyId);
  assert.ok(base, 'genomets rot saknas i registret');
  assert.notDeepEqual(evolved.defaultOptions, base.defaultOptions);
});

test('ett begärt genom räknas aldrig två gånger', (t) => {
  const hash = runnableGenomeHash();
  if (!hash) return t.skip('släktträdet har inget körbart genom');
  const rows = registry.listStrategyEvaluators({
    includeBase: false, includeEvolved: true, genomeHashes: [hash],
  });
  const ids = rows.map((row) => row.strategyId);
  assert.equal(new Set(ids).size, ids.length, 'samma strategi kördes två gånger');
});

test('ett genom som inte går att köra redovisas som ett svar, inte som tystnad', () => {
  const rows = registry.describeRequestedGenomes(['finns-inte-i-tradet']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].loaded, false);
  assert.equal(rows[0].reason, 'genome_not_in_family_tree');
});

test('utan begäran är registret oförändrat', () => {
  assert.equal(
    registry.listStrategyEvaluators({ genomeHashes: [] }).length,
    registry.listStrategyEvaluators().length,
  );
});
