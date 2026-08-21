'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const evaluationModule = require('./factoryEvaluationService');

const ROOT = path.resolve(__dirname, '../../..');
const NOW = '2026-08-18T12:00:00.000Z';

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-evaluation-'));
  return path.join(dir, name);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function forbidden(name) {
  return () => {
    throw new Error(`${name} must not be called by Factory Evaluation`);
  };
}

function baseSources(overrides = {}) {
  const strategies = [
    { strategyId: 'momentum_parent', currentDnaHash: 'dna_parent', lifecycle: 'candidate', strategyScore: 60, executionScore: 60, confidenceScore: 60 },
    { strategyId: 'momentum_child_good', currentDnaHash: 'dna_child_good', lifecycle: 'paper', strategyScore: 75, executionScore: 70, confidenceScore: 70 },
    { strategyId: 'momentum_child_bad', currentDnaHash: 'dna_child_bad', lifecycle: 'testing', strategyScore: 45, executionScore: 44, confidenceScore: 40 },
    { strategyId: 'dead_branch', currentDnaHash: 'dna_dead_root', lifecycle: 'retired', retired: true, strategyScore: 12, executionScore: 20, confidenceScore: 18 },
  ];
  const libraryEvents = [
    { type: 'REPLAY_RECORDED', strategyId: 'momentum_parent', runId: 'replay_1', strategyScore: 60, executionScore: 60, marketDnaHash: 'market_a' },
    { type: 'REPLAY_RECORDED', strategyId: 'momentum_child_good', runId: 'replay_2', strategyScore: 75, executionScore: 70, marketDnaHash: 'market_a' },
    { type: 'REPLAY_RECORDED', strategyId: 'momentum_child_bad', runId: 'replay_3', strategyScore: 45, executionScore: 44, marketDnaHash: 'market_b' },
    { type: 'LIFECYCLE_TRANSITION', strategyId: 'momentum_parent', to: 'candidate' },
    { type: 'LIFECYCLE_TRANSITION', strategyId: 'momentum_child_good', to: 'candidate' },
    { type: 'LIFECYCLE_TRANSITION', strategyId: 'momentum_child_good', to: 'paper' },
    { type: 'RETIRED', strategyId: 'dead_branch' },
  ];
  const experiments = [
    { experimentKey: 'experiment_1', observations: 2, identity: { strategyDnaHash: 'dna_parent' } },
    { experimentKey: 'experiment_2', observations: 1, identity: { strategyDnaHash: 'dna_child_good' } },
    { experimentKey: 'experiment_3', observations: 2, identity: { strategyDnaHash: 'dna_child_bad' } },
  ];
  const learningRecords = [
    { learningRecordId: 'learning_1', experimentKey: 'experiment_1', replayRunId: 'replay_1', strategyId: 'momentum_parent', dnaHash: 'dna_parent', strategyScore: 60, executionScore: 60, confidenceScore: 60, succeeded: true },
    { learningRecordId: 'learning_2', experimentKey: 'experiment_2', replayRunId: 'replay_2', strategyId: 'momentum_child_good', dnaHash: 'dna_child_good', strategyScore: 75, executionScore: 70, confidenceScore: 70, succeeded: true },
    { learningRecordId: 'learning_3', experimentKey: 'experiment_3', replayRunId: 'replay_3', strategyId: 'momentum_child_bad', dnaHash: 'dna_child_bad', strategyScore: 45, executionScore: 44, confidenceScore: 40, succeeded: false },
  ];
  const knowledge = [
    { knowledgeId: 'knowledge_1', replayRunId: 'replay_1', learningRecordId: 'learning_1' },
    { knowledgeId: 'knowledge_2', replayRunId: 'replay_2', learningRecordId: 'learning_2' },
    { knowledgeId: 'knowledge_3', replayRunId: 'replay_3', learningRecordId: 'learning_3' },
  ];
  const familyNodes = [
    { dnaHash: 'dna_parent', parent: null, generation: 0, branch: 'root', rootStrategyId: 'momentum_parent', retired: false },
    { dnaHash: 'dna_child_good', parent: 'dna_parent', generation: 1, branch: 'optimizer', rootStrategyId: 'momentum_parent', retired: false },
    { dnaHash: 'dna_child_bad', parent: 'dna_parent', generation: 1, branch: 'optimizer', rootStrategyId: 'momentum_parent', retired: false },
    { dnaHash: 'dna_dead_root', parent: null, generation: 0, branch: 'dead', rootStrategyId: 'dead_branch', retired: true },
    { dnaHash: 'dna_dead_child', parent: 'dna_dead_root', generation: 1, branch: 'dead', rootStrategyId: 'dead_branch', retired: true },
  ];

  return {
    strategyLibrary: {
      getStatus() { return { ok: true, strategies: strategies.length }; },
      listStrategies() { return strategies; },
      getAuditTrail() { return libraryEvents; },
      recordReplayRun: forbidden('Strategy Library recordReplayRun'),
      recordScore: forbidden('Strategy Library recordScore'),
      recordPaperTrade: forbidden('Strategy Library recordPaperTrade'),
      recordLiveTrade: forbidden('Strategy Library recordLiveTrade'),
      recordApproval: forbidden('Strategy Library recordApproval'),
    },
    aiMemory: {
      getStatus() { return { ok: true, experiments: experiments.length, repeats: 2 }; },
      listExperiments() { return experiments; },
      recordExperiment: forbidden('AI Memory recordExperiment'),
      supersede: forbidden('AI Memory supersede'),
    },
    learningEngine: {
      getLearningSummary() { return { ok: true, records: learningRecords.length, knowledgeItems: knowledge.length }; },
      getLearningRecords() { return learningRecords; },
      getStrategyKnowledge() { return { ok: true, items: knowledge }; },
      learnFromReplay: forbidden('Learning Engine learnFromReplay'),
    },
    replayQueue: {
      getStatus() {
        return {
          ok: true,
          completed_jobs: [{ id: 'job_1' }, { id: 'job_2' }, { id: 'job_3' }],
          pending_jobs: [],
          running_jobs: [],
          failed_jobs: [],
        };
      },
      readEvents() {
        return [
          { event_type: 'JOB_COMPLETED', job_id: 'job_1' },
          { event_type: 'JOB_COMPLETED', job_id: 'job_2' },
          { event_type: 'JOB_COMPLETED', job_id: 'job_3' },
        ];
      },
      appendJob: forbidden('Replay Queue appendJob'),
      startJob: forbidden('Replay Queue startJob'),
      completeJob: forbidden('Replay Queue completeJob'),
      failJob: forbidden('Replay Queue failJob'),
    },
    familyTree: {
      listNodes() { return familyNodes; },
      listBranches() {
        return [
          { branch: 'optimizer', nodes: 2, retired: 0, active: 2, fullyRetired: false },
          { branch: 'dead', nodes: 2, retired: 2, active: 0, fullyRetired: true },
        ];
      },
      getAuditTrail() {
        return [{ type: 'BRANCH_RETIRED', dnaHash: 'dna_dead_child' }];
      },
      addNode: forbidden('Family Tree addNode'),
      retireNode: forbidden('Family Tree retireNode'),
      retireBranch: forbidden('Family Tree retireBranch'),
      retireSubtree: forbidden('Family Tree retireSubtree'),
    },
    ...overrides,
  };
}

function createService(sources = {}) {
  return evaluationModule.createFactoryEvaluationService({
    eventsFile: tempFile('events.jsonl'),
    now: () => NOW,
    ...baseSources(sources),
  });
}

test('same source data gives the same deterministic Factory Score', () => {
  const service = createService();

  const first = service.evaluate({ now: NOW, requestedBy: 'acceptance-test' });
  const second = service.evaluate({ now: NOW, requestedBy: 'acceptance-test' });

  assert.deepEqual(first, second);
  assert.equal(first.factoryScore, 76);
  assert.equal(first.scoreFormula.usesStrategyScore, false);
  assert.equal(first.scoreFormula.usesReplayScore, false);
  assert.equal(first.counts.replaysRun, 3);
  assert.equal(first.counts.experimentsCreated, 3);
  assert.equal(first.counts.experimentsReusedFromMemory, 2);
  assert.equal(first.counts.mutationsCreated, 3);
  assert.equal(first.counts.mutationsImproved, 1);
  assert.equal(first.counts.mutationsWorsened, 1);
  assert.equal(first.counts.advancedToCandidate, 2);
  assert.equal(first.counts.advancedToPaper, 1);
  assert.equal(first.counts.advancedToLive, 0);
  assert.equal(first.counts.retiredStrategies, 1);
  assert.equal(first.counts.extinctStrategies, 1);
});

test('recordEvaluation is append-only and does not create duplicate summaries', () => {
  const service = createService();

  const first = service.recordEvaluation({ now: NOW, requestedBy: 'acceptance-test' });
  const duplicate = service.recordEvaluation({ now: NOW, requestedBy: 'acceptance-test' });

  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.evaluation, first.evaluation);
  assert.equal(service.getHistory().length, 1);

  const rawLines = fs.readFileSync(service.eventsFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(rawLines.length, 1);
  assert.equal(JSON.parse(rawLines[0]).type, evaluationModule.EVENT_TYPES.FACTORY_EVALUATION_RECORDED);
});

test('a changed source snapshot appends a new evaluation without rewriting the old one', () => {
  const service = createService();
  const first = service.recordEvaluation({ now: NOW, requestedBy: 'acceptance-test' });
  const before = fs.readFileSync(service.eventsFile, 'utf8');

  const changed = createService({
    learningEngine: {
      getLearningSummary() { return { ok: true, records: 4, knowledgeItems: 4 }; },
      getLearningRecords() {
        return [
          { learningRecordId: 'learning_1', experimentKey: 'experiment_1', replayRunId: 'replay_1', strategyId: 'momentum_parent', dnaHash: 'dna_parent', strategyScore: 60, executionScore: 60, confidenceScore: 60 },
          { learningRecordId: 'learning_2', experimentKey: 'experiment_2', replayRunId: 'replay_2', strategyId: 'momentum_child_good', dnaHash: 'dna_child_good', strategyScore: 75, executionScore: 70, confidenceScore: 70 },
          { learningRecordId: 'learning_3', experimentKey: 'experiment_3', replayRunId: 'replay_3', strategyId: 'momentum_child_bad', dnaHash: 'dna_child_bad', strategyScore: 45, executionScore: 44, confidenceScore: 40 },
          { learningRecordId: 'learning_4', experimentKey: 'experiment_4', replayRunId: 'replay_4', strategyId: 'new_learning', dnaHash: 'dna_new', strategyScore: 66, executionScore: 64, confidenceScore: 62 },
        ];
      },
      getStrategyKnowledge() {
        return {
          ok: true,
          items: [
            { knowledgeId: 'knowledge_1' },
            { knowledgeId: 'knowledge_2' },
            { knowledgeId: 'knowledge_3' },
            { knowledgeId: 'knowledge_4' },
          ],
        };
      },
      learnFromReplay: forbidden('Learning Engine learnFromReplay'),
    },
  });

  fs.copyFileSync(service.eventsFile, changed.eventsFile);
  const second = changed.recordEvaluation({ now: NOW, requestedBy: 'acceptance-test' });
  const after = fs.readFileSync(changed.eventsFile, 'utf8');

  assert.equal(second.created, true);
  assert.notEqual(second.evaluation.evaluationId, first.evaluation.evaluationId);
  assert.equal(after.startsWith(before), true);
  assert.equal(after.trim().split('\n').filter(Boolean).length, 2);
});

test('Factory Evaluation source only reads factory data and never calls pipeline work', () => {
  const source = stripComments(read('src/services/evaluation/factoryEvaluationService.js'));
  const forbiddenImports = [
    /replayEngine/i,
    /paperTradingRuntime/i,
    /factoryDirector/i,
    /strategyBrain/i,
    /aiOptimizer/i,
    /evolutionEngine/i,
    /nativeFuturesScanner/i,
    /fillEngine/i,
  ];
  for (const pattern of forbiddenImports) {
    assert.equal(pattern.test(source), false, String(pattern));
  }

  const forbiddenCalls = [
    /\.runOnce\s*\(/,
    /\.appendJob\s*\(/,
    /\.appendMany\s*\(/,
    /\.startJob\s*\(/,
    /\.completeJob\s*\(/,
    /\.failJob\s*\(/,
    /\.recordReplayRun\s*\(/,
    /\.recordScore\s*\(/,
    /\.recordExperiment\s*\(/,
    /\.learnFromReplay\s*\(/,
    /\.decide\s*\(/,
    /\.propose\s*\(/,
    /\.evolve\s*\(/,
    /\.createOptimizedDnaCandidates\s*\(/,
    /\.execute\s*\(/,
    /\.approveStrategy\s*\(/,
    /\.addNode\s*\(/,
    /\.retireNode\s*\(/,
    /\.retireBranch\s*\(/,
    /\.retireSubtree\s*\(/,
  ];
  for (const pattern of forbiddenCalls) {
    assert.equal(pattern.test(source), false, String(pattern));
  }
});
