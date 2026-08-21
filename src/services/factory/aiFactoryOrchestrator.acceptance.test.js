'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const orchestratorModule = require('./aiFactoryOrchestratorService');
const queueModule = require('../replayQueueService');
const schedulerModule = require('../replaySchedulerService');
const aiMemory = require('../memory/aiMemoryService');
const aiOptimizer = require('../optimizer/aiOptimizerService');
const strategyDna = require('../dna/strategyDnaService');
const familyTreeModule = require('../evolution/strategyFamilyTreeService');
const evolutionModule = require('../evolution/evolutionEngineService');

const ROOT = path.resolve(__dirname, '../../..');
const NOW = '2026-08-18T10:00:00.000Z';
const PROTECTED_FILES = Object.freeze([
  'src/services/replay/nativeReplayEngineService.js',
  'src/services/nativeFuturesScannerService.js',
  'src/services/paperTradingRuntimeService.js',
]);

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-orchestrator-')), name);
}

function shaFile(rel) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, rel)))
    .digest('hex');
}

function protectedHashes() {
  return Object.fromEntries(PROTECTED_FILES.map((rel) => [rel, shaFile(rel)]));
}

function parentDna() {
  const dna = strategyDna.listStrategyDna()[0];
  assert.ok(dna?.dnaHash, 'test requires at least one strategy DNA');
  return dna;
}

function fakeBrain(parent, calls = []) {
  return {
    SAFETY: { readOnly: true },
    analyze() {
      calls.push('brain.analyze');
      return {
        ok: true,
        brainVersion: 'fake-brain-v1',
        nextReplay: {
          strategyId: parent.strategyId,
          dnaHash: parent.dnaHash,
          targetRegime: 'flat/normal',
          replayMode: 'optimizer',
          executionModel: 'simulated_fill',
          informationGain: 88,
        },
        strategies: [{
          strategyId: parent.strategyId,
          dnaHash: parent.dnaHash,
          knowledgeScore: 42,
          recommendation: { action: 're_test', reason: 'test_gap' },
          blindSpots: ['flat/normal'],
          gaps: [{ type: 'missing_market_dna', informationValue: 30 }],
        }],
        recommendations: { re_test: [parent.strategyId] },
        market: { availableRegimes: ['flat/normal'] },
      };
    },
  };
}

function fakeLibrary(parent) {
  return {
    getStrategy(id) {
      if (id !== parent.strategyId) return null;
      return {
        strategyId: parent.strategyId,
        strategyScore: 41,
        confidenceScore: 38,
        executionScore: 70,
        replayHistory: [{ trades: 21 }],
        paperHistory: [],
        liveHistory: [],
      };
    },
  };
}

function fakeEvolution(result, calls = []) {
  return {
    createOptimizedDnaCandidates(args) {
      calls.push({ method: 'evolution.createOptimizedDnaCandidates', args });
      return {
        ok: true,
        created: [{ dna: { dnaHash: 'candidate-a' }, proposal: { experimentSpec: { strategyDnaHash: 'candidate-a' } } }],
        existingExperiments: [],
        rejected: [],
        winner: null,
        optimizerAskedMemoryBeforeDna: true,
        ...result,
      };
    },
  };
}

function cycleInput(runId, overrides = {}) {
  return {
    runId,
    correlationId: `${runId}:corr`,
    now: NOW,
    marketDnaHash: 'market-factory-test',
    optimization: {
      marketDnaHash: 'market-factory-test',
      replayMode: 'optimizer',
      executionModel: 'simulated_fill:test',
      maxCandidates: 1,
    },
    executeQueue: false,
    ...overrides,
  };
}

test('same input gives identical deterministic orchestration plan', () => {
  const input = cycleInput('plan-run');
  const first = orchestratorModule.buildPlan(input);
  const second = orchestratorModule.buildPlan(input);

  assert.deepEqual(first, second);
  assert.equal(first.deterministic, true);
  assert.deepEqual(first.steps.map((step) => step.id), orchestratorModule.STEPS.map((step) => step.id));
  assert.equal(first.contracts.orchestratorContainsStrategyLogic, false);
  assert.equal(first.contracts.orchestratorContainsReplayLogic, false);
  assert.equal(first.contracts.strategyBrainSelectsKnowledgeGap, true);
  assert.equal(first.contracts.aiMemoryBeforeOptimization, true);
});

test('tick logs every step append-only and resumes without rerunning completed steps', async () => {
  const parent = parentDna();
  const calls = [];
  let schedulerCalls = 0;
  const orchestrator = orchestratorModule.createAiFactoryOrchestrator({
    eventsFile: tmpFile('orchestrator.jsonl'),
    now: () => NOW,
    strategyBrain: fakeBrain(parent, calls),
    library: fakeLibrary(parent),
    evolutionEngine: fakeEvolution({}, calls),
    replayScheduler: {
      runOnce() {
        schedulerCalls += 1;
        if (schedulerCalls === 1) return { ok: false, reason: 'scheduler_temporarily_down' };
        return {
          ok: true,
          scheduled: true,
          scheduler_runs_replay: false,
          appended: { ok: true, created: 1, duplicates: 0, failed: 0, results: [{ created: true, job: { id: 'job-1' } }] },
          plan: { summary: { total_jobs: 1 }, jobs: [{ id: 'job-1' }] },
        };
      },
    },
    replayQueueRunner: { runNextJob: async () => ({ ok: true, executed: true, job: { id: 'job-1' }, replay: { runId: 'replay-1' } }) },
  });
  const input = cycleInput('resume-run', { executeQueue: true });

  assert.equal((await orchestrator.tick(input)).step, 'PLAN');
  assert.equal((await orchestrator.tick(input)).step, 'SELECT_KNOWLEDGE_GAP');
  assert.equal((await orchestrator.tick(input)).step, 'CREATE_DNA_GENERATION');

  const failed = await orchestrator.tick(input);
  assert.equal(failed.ok, false);
  assert.equal(failed.step, 'SCHEDULE_REPLAY');
  assert.equal(failed.error, 'scheduler_temporarily_down');
  assert.equal(calls.filter((row) => row === 'brain.analyze').length, 1);
  assert.equal(calls.filter((row) => row.method === 'evolution.createOptimizedDnaCandidates').length, 1);

  const resumed = await orchestrator.tick({ runId: input.runId });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.step, 'SCHEDULE_REPLAY');
  assert.equal(resumed.correlationId, input.correlationId);
  assert.equal(calls.filter((row) => row === 'brain.analyze').length, 1, 'resume reran Strategy Brain');
  assert.equal(calls.filter((row) => row.method === 'evolution.createOptimizedDnaCandidates').length, 1, 'resume reran Evolution');

  const complete = await orchestrator.runCycle({ runId: input.runId });
  assert.equal(complete.ok, true);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.state.completedSteps, orchestratorModule.STEPS.map((step) => step.id));

  const events = orchestrator.getAuditTrail({ limit: 100 });
  assert.ok(events.every((event) => event.runId === input.runId));
  assert.ok(events.every((event) => event.correlationId === input.correlationId));
  for (const step of orchestratorModule.STEPS) {
    assert.ok(events.some((event) => event.step === step.id && event.type === orchestratorModule.EVENT_TYPES.STEP_STARTED));
    assert.ok(events.some((event) => event.step === step.id && event.type === orchestratorModule.EVENT_TYPES.STEP_COMPLETED));
  }
});

test('Replay Scheduler and Replay Queue prevent duplicate replay jobs', async () => {
  const parent = parentDna();
  const queue = queueModule.createReplayQueueService({
    queueFile: tmpFile('queue.jsonl'),
    now: () => NOW,
  });
  const scheduler = schedulerModule.createReplaySchedulerService({
    now: () => NOW,
    registryService: { listStrategies: () => [] },
    scoreService: { getStrategyScores: () => ({ strategies: [] }) },
    historyService: { getStrategyHistory: () => null },
    coverageService: { getAllSymbolCoverage: () => ({ symbols: [] }) },
    queueService: queue,
  });
  const orchestrator = orchestratorModule.createAiFactoryOrchestrator({
    eventsFile: tmpFile('orchestrator.jsonl'),
    now: () => NOW,
    strategyBrain: fakeBrain(parent),
    library: fakeLibrary(parent),
    evolutionEngine: fakeEvolution({}),
    replayScheduler: scheduler,
    replayQueueRunner: { runNextJob: async () => { throw new Error('executeQueue=false should not run'); } },
  });

  const first = await orchestrator.runCycle(cycleInput('dedupe-run-a'));
  assert.equal(first.ok, true);
  assert.equal(queue.getStatus().summary.pending, 1);
  assert.equal(queue.readEvents().length, 1);

  const second = await orchestrator.runCycle(cycleInput('dedupe-run-b'));
  assert.equal(second.ok, true);
  assert.equal(queue.getStatus().summary.pending, 1);
  assert.equal(queue.readEvents().length, 1, 'duplicate queue job appended a second event');
});

test('known AI Memory experiment skips scheduling and queue execution', async () => {
  const parent = parentDna();
  const memory = aiMemory.createAiMemory({ eventsFile: tmpFile('memory.jsonl'), now: () => NOW });
  const optimizer = aiOptimizer.createAiOptimizer({ memory });
  const context = {
    marketDnaHash: 'market-factory-known',
    replayMode: 'optimizer',
    executionModel: 'simulated_fill:test',
    period: '2026-08-11..2026-08-14',
    symbols: ['MES'],
    regimeKeys: ['flat/normal'],
  };
  const proposal = optimizer.propose({
    parentDna: parent,
    context,
    maxCandidates: 1,
    libraryRecord: fakeLibrary(parent).getStrategy(parent.strategyId),
  });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.proposals[0].status, 'new_dna_proposal');
  memory.recordExperiment(proposal.proposals[0].experimentSpec, {
    source: 'strategy_library',
    resultType: 'replay',
    strategyId: parent.strategyId,
    libraryRunId: 'factory-known-run',
    eventType: 'REPLAY_RECORDED',
  }, {
    lineage: proposal.proposals[0].dnaProposal.lineage,
  });

  let schedulerCalls = 0;
  let runnerCalls = 0;
  const evolution = evolutionModule.createEvolutionEngine({
    familyTree: familyTreeModule.createStrategyFamilyTree({ eventsFile: tmpFile('lineage.jsonl'), now: () => NOW }),
    optimizer,
  });
  const orchestrator = orchestratorModule.createAiFactoryOrchestrator({
    eventsFile: tmpFile('orchestrator.jsonl'),
    now: () => NOW,
    memory,
    strategyBrain: fakeBrain(parent),
    library: fakeLibrary(parent),
    evolutionEngine: evolution,
    replayScheduler: {
      runOnce() {
        schedulerCalls += 1;
        return { ok: true, scheduled: true, appended: { created: 1, duplicates: 0, results: [] } };
      },
    },
    replayQueueRunner: {
      async runNextJob() {
        runnerCalls += 1;
        return { ok: true, executed: true };
      },
    },
  });

  const result = await orchestrator.runCycle(cycleInput('known-experiment-run', {
    executeQueue: true,
    optimization: {
      ...context,
      maxCandidates: 1,
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(schedulerCalls, 0, 'known experiment should not reach Replay Scheduler');
  assert.equal(runnerCalls, 0, 'known experiment should not reach Replay Queue');
  const generation = result.state.completed.CREATE_DNA_GENERATION.result;
  assert.equal(generation.optimizerAskedMemoryBeforeDna, true);
  assert.equal(generation.created.length, 0);
  assert.equal(generation.existingExperiments.length, 1);
  assert.equal(result.state.completed.SCHEDULE_REPLAY.result.reason, 'experiment_already_known_in_ai_memory');
  assert.equal(memory.getStatus().repeats, 0, 'orchestrator reran a known experiment');
});

test('protected runtime files are byte-identical before and after orchestrator cycle', async () => {
  const before = protectedHashes();
  const parent = parentDna();
  const orchestrator = orchestratorModule.createAiFactoryOrchestrator({
    eventsFile: tmpFile('orchestrator.jsonl'),
    now: () => NOW,
    strategyBrain: fakeBrain(parent),
    library: fakeLibrary(parent),
    evolutionEngine: fakeEvolution({}),
    replayScheduler: {
      runOnce() {
        return {
          ok: true,
          scheduled: true,
          scheduler_runs_replay: false,
          appended: { ok: true, created: 0, duplicates: 1, failed: 0, results: [{ duplicate: true, job: { id: 'job-existing' } }] },
          plan: { summary: { total_jobs: 1 }, jobs: [{ id: 'job-existing' }] },
        };
      },
    },
    replayQueueRunner: { runNextJob: async () => { throw new Error('no job should be executed'); } },
  });
  const result = await orchestrator.runCycle(cycleInput('byte-identical-run'));
  assert.equal(result.ok, true);
  assert.deepEqual(protectedHashes(), before);
});

test('only the Orchestrator imports the whole AI factory workflow', () => {
  const source = fs.readFileSync(path.join(__dirname, 'aiFactoryOrchestratorService.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(source, /nativeReplayEngineService|scanner\/replayEngine|nativeFuturesScannerService|paperTradingRuntimeService/);
  assert.match(source, /strategyBrainService/);
  assert.match(source, /evolutionEngineService/);
  assert.match(source, /replaySchedulerService/);
  assert.match(source, /replayQueueRunnerService/);

  const componentFiles = [
    'src/services/brain/strategyBrainService.js',
    'src/services/optimizer/aiOptimizerService.js',
    'src/services/evolution/evolutionEngineService.js',
    'src/services/replaySchedulerService.js',
    'src/services/replayQueueService.js',
  ];
  for (const rel of componentFiles) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(text, /aiFactoryOrchestratorService/, `${rel} knows the Orchestrator`);
  }
});

// ── Fabriken väljer en lucka den kan stänga ─────────────────────────────────
//
// Utan det här urvalet livelockar cykeln: hjärnan rangordnar efter
// informationsvinst, den högsta vinsten har alltid den minst kända strategin,
// och efter registersynken är de minst kända strategierna katalogposter utan
// evaluator. Den valda strategin kunde då aldrig producera ett resultat, luckan
// var lika stor efteråt, och nästa cykel valde samma strategi igen.
test('SELECT_KNOWLEDGE_GAP väljer högsta prioriterade lucka som går att köra', async () => {
  const analysis = {
    ok: true,
    brainVersion: 'test',
    strategies: [],
    recommendations: {},
    market: null,
    nextReplay: { strategyId: 'catalog_only_strategy', informationGain: 100 },
    priority: [
      { strategyId: 'catalog_only_strategy', informationGain: 100 },
      { strategyId: 'another_catalog_strategy', informationGain: 90 },
      { strategyId: 'executable_strategy', informationGain: 42 },
    ],
  };

  const orchestrator = orchestratorModule.createAiFactoryOrchestrator({
    eventsFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-gap-')), 'events.jsonl'),
    strategyBrain: { analyze: () => analysis },
    isExecutableStrategy: (id) => id === 'executable_strategy',
  });

  await orchestrator.tick({ cycleKey: 'gap-test' });
  const selected = await orchestrator.tick({ cycleKey: 'gap-test' });
  assert.equal(selected.step, 'SELECT_KNOWLEDGE_GAP');
  assert.equal(selected.result.nextReplay.strategyId, 'executable_strategy',
    'fabriken valde en lucka den inte kan stänga');

  // Finns ingen körbar lucka faller valet tillbaka på hjärnans eget svar —
  // beteendet degraderar, det försvinner inte.
  const fallback = orchestratorModule.createAiFactoryOrchestrator({
    eventsFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-gap2-')), 'events.jsonl'),
    strategyBrain: { analyze: () => analysis },
    isExecutableStrategy: () => false,
  });
  await fallback.tick({ cycleKey: 'gap-fallback' });
  const degraded = await fallback.tick({ cycleKey: 'gap-fallback' });
  assert.equal(degraded.result.nextReplay.strategyId, 'catalog_only_strategy');
});
