'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const integrationModule = require('./factoryIntegrationService');

const NOW = '2026-08-18T12:00:00.000Z';

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-integration-'));
  return path.join(dir, name);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function outputComponent(name, output) {
  return {
    integrationCheck({ stepName }) {
      return typeof output === 'function' ? output(stepName) : clone(output);
    },
    _componentName: name,
  };
}

function deterministicTimer() {
  let tick = 0;
  return () => {
    tick += 5;
    return tick;
  };
}

function passingSources(overrides = {}) {
  const candles = [
    { timestamp: '2026-08-18T11:56:00.000Z', open: 100, high: 101, low: 99, close: 100.5 },
    { timestamp: '2026-08-18T11:58:00.000Z', open: 100.5, high: 102, low: 100, close: 101.5 },
  ];
  const strategies = [
    {
      strategyId: 'momentum_parent',
      currentDnaHash: 'dna_parent',
      currentMarketDnaHash: 'market_trend',
      lifecycle: 'candidate',
      strategyScore: 60,
      executionScore: 60,
      confidenceScore: 60,
    },
    {
      strategyId: 'momentum_child',
      currentDnaHash: 'dna_child',
      currentMarketDnaHash: 'market_trend',
      lifecycle: 'testing',
      strategyScore: 72,
      executionScore: 68,
      confidenceScore: 66,
    },
  ];
  const libraryEvents = [
    {
      type: 'REPLAY_RECORDED',
      strategyId: 'momentum_parent',
      runId: 'replay_1',
      marketDnaHash: 'market_trend',
      strategyScore: 60,
      executionScore: 60,
    },
    {
      type: 'REPLAY_RECORDED',
      strategyId: 'momentum_child',
      runId: 'replay_2',
      marketDnaHash: 'market_trend',
      strategyScore: 72,
      executionScore: 68,
    },
  ];
  const experiments = [
    {
      experimentKey: 'experiment_parent',
      identity: { strategyDnaHash: 'dna_parent', marketDnaHash: 'market_trend' },
      libraryRef: { strategyId: 'momentum_parent', libraryRunId: 'replay_1' },
      observations: 1,
    },
    {
      experimentKey: 'experiment_child',
      identity: { strategyDnaHash: 'dna_child', marketDnaHash: 'market_trend' },
      libraryRef: { strategyId: 'momentum_child', libraryRunId: 'replay_2' },
      observations: 1,
    },
  ];
  const learningRecords = [
    {
      learningRecordId: 'learning_parent',
      replayRunId: 'replay_1',
      experimentKey: 'experiment_parent',
      strategyId: 'momentum_parent',
      dnaHash: 'dna_parent',
      marketDna: { marketDnaHash: 'market_trend' },
      strategyScore: 60,
      executionScore: 60,
      confidenceScore: 60,
    },
  ];
  const nodes = [
    { dnaHash: 'dna_parent', parent: null, generation: 0, rootStrategyId: 'momentum_parent', retired: false },
    { dnaHash: 'dna_child', parent: 'dna_parent', generation: 1, rootStrategyId: 'momentum_parent', retired: false },
  ];

  return {
    ibHistoricalData: outputComponent('ib', {
      ok: true,
      bars: [{ timestamp: '2026-08-18T11:57:00.000Z', open: 100, high: 101, low: 99, close: 100.5 }],
      source: 'interactive_brokers',
    }),
    historicalPriceFeed: outputComponent('pricefeed', {
      ok: true,
      candles,
      source: 'ib_historical_store',
    }),
    replayEngine: outputComponent('replay', (stepName) => ({
      ok: true,
      runId: stepName === 'Replay Again' ? 'replay_2' : 'replay_1',
      summary: { totalEvents: 1, totalCandles: candles.length },
      source: 'native_replay_engine',
    })),
    fillEngine: outputComponent('fill', {
      ok: true,
      status: 'filled',
      fills: [{ orderId: 'order_1', price: 101, quantity: 1 }],
      source: 'fill_engine',
    }),
    strategyLibrary: outputComponent('library', {
      ok: true,
      strategies,
      events: libraryEvents,
      source: 'strategy_library',
    }),
    aiMemory: outputComponent('memory', {
      ok: true,
      experiments,
      source: 'ai_memory',
    }),
    learningEngine: outputComponent('learning', {
      ok: true,
      summary: { records: 1, knowledgeItems: 1 },
      learningRecords,
      knowledge: [{ knowledgeId: 'knowledge_parent', learningRecordId: 'learning_parent', replayRunId: 'replay_1' }],
      source: 'learning_engine',
    }),
    strategyBrain: outputComponent('brain', {
      ok: true,
      nextReplay: { strategyId: 'momentum_child', informationGain: 80 },
      recommendations: { optimize: ['momentum_child'] },
      source: 'strategy_brain',
    }),
    factoryDirector: outputComponent('director', {
      ok: true,
      decision: { action: 'REQUEST_REPLAY_SCHEDULER', reason: 'strategy_brain_found_knowledge_gap' },
      source: 'factory_director',
    }),
    replayQueue: outputComponent('queue', {
      ok: true,
      jobs: [
        { id: 'queue_job_1', status: 'completed', run_id: 'replay_1' },
        { id: 'queue_job_2', status: 'pending' },
      ],
      source: 'replay_queue',
    }),
    replayScheduler: outputComponent('scheduler', {
      ok: true,
      plan: { jobs: [{ id: 'queue_job_2', strategyId: 'momentum_child' }] },
      source: 'replay_scheduler',
    }),
    aiOptimizer: outputComponent('optimizer', {
      ok: true,
      proposals: [{ candidateDnaHash: 'dna_child', parentDnaHash: 'dna_parent' }],
      source: 'ai_optimizer',
    }),
    evolutionEngine: outputComponent('evolution', {
      ok: true,
      nodes,
      branches: [{ branch: 'optimizer', nodes: 1, retired: 0, fullyRetired: false }],
      source: 'evolution_engine',
    }),
    strategyRuntime: outputComponent('runtime', {
      ok: true,
      runtimeId: 'runtime_child',
      dnaHash: 'dna_child',
      source: 'strategy_runtime',
    }),
    familyTree: outputComponent('familyTree', { ok: true, nodes }),
    ...overrides,
  };
}

function createService(overrides = {}) {
  return integrationModule.createFactoryIntegrationService({
    eventsFile: tempFile('events.jsonl'),
    now: () => NOW,
    timer: deterministicTimer(),
    ...passingSources(overrides),
  });
}

test('whole factory chain runs and returns deterministic integration result', async () => {
  const service = createService();
  const input = {
    integrationRunId: 'integration_full_chain',
    correlationId: 'correlation_full_chain',
    now: NOW,
    requestedBy: 'acceptance-test',
  };

  const first = await service.runIntegration(input);
  const second = await service.runIntegration(input);

  assert.deepEqual(second, first);
  assert.equal(first.ok, true);
  assert.equal(first.status, integrationModule.RUN_STATUS.PASS);
  assert.equal(first.steps.length, integrationModule.STEPS.length);
  assert.deepEqual(first.steps.map((step) => step.stepName), integrationModule.STEPS.map((step) => step.name));
  assert.equal(first.references.status, integrationModule.STEP_STATUS.PASS);

  for (const step of first.steps) {
    assert.equal(step.status, integrationModule.STEP_STATUS.PASS, step.stepName);
    assert.equal(typeof step.durationMs, 'number');
    assert.equal(typeof step.objectCount, 'number');
    assert.ok(step.dataSource, step.stepName);
    assert.equal(step.input.integrationRunId, input.integrationRunId);
    assert.equal(step.input.correlationId, input.correlationId);
  }

  assert.equal(first.factoryHealth['Replay Engine'], 'PASS');
  assert.equal(first.factoryHealth['Strategy Library'], 'PASS');
  assert.equal(first.factoryHealth['AI Memory'], 'PASS');
  assert.equal(first.factoryHealth['Learning Engine'], 'PASS');
  assert.equal(first.factoryHealth['Strategy Brain'], 'PASS');
  assert.equal(first.factoryHealth['Factory Director'], 'PASS');
  assert.equal(first.factoryHealth['Replay Queue'], 'PASS');
  assert.equal(first.factoryHealth['Replay Scheduler'], 'PASS');
  assert.equal(first.factoryHealth['AI Optimizer'], 'PASS');
  assert.equal(first.factoryHealth['Evolution Engine'], 'PASS');
  assert.equal(first.factoryHealth['Strategy Runtime'], 'PASS');
});

test('integration log is append-only', async () => {
  const service = createService();

  await service.runIntegration({ integrationRunId: 'integration_append_1', now: NOW });
  const before = fs.readFileSync(service.eventsFile, 'utf8');
  await service.runIntegration({ integrationRunId: 'integration_append_2', now: NOW });
  const after = fs.readFileSync(service.eventsFile, 'utf8');

  assert.equal(after.startsWith(before), true);
  assert.equal(after.trim().split('\n').filter(Boolean).length, integrationModule.STEPS.length * 2 + 6);
});

test('integration stops at the first failed step and reports the root step', async () => {
  const service = createService({
    historicalPriceFeed: outputComponent('pricefeed', {
      ok: false,
      reason: 'no_historical_candles',
      source: 'ib_historical_store',
    }),
  });

  const result = await service.runIntegration({ integrationRunId: 'integration_failure', now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.status, integrationModule.RUN_STATUS.FAILED);
  assert.equal(result.failedStep, 'Historical PriceFeed');
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].reason, 'no_historical_candles');
});

test('reference integrity fails on broken libraryRef and reports exact issue', async () => {
  const service = createService({
    aiMemory: outputComponent('memory', {
      ok: true,
      experiments: [{
        experimentKey: 'experiment_broken',
        identity: { strategyDnaHash: 'dna_parent', marketDnaHash: 'market_trend' },
        libraryRef: { strategyId: 'momentum_parent', libraryRunId: 'missing_replay' },
      }],
      source: 'ai_memory',
    }),
    learningEngine: outputComponent('learning', {
      ok: true,
      learningRecords: [],
      knowledge: [],
      source: 'learning_engine',
    }),
  });

  const result = await service.runIntegration({ integrationRunId: 'integration_broken_ref', now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.status, integrationModule.RUN_STATUS.FAILED);
  assert.equal(result.failedStep, 'REFERENCE_INTEGRITY');
  assert.match(result.references.issues.join(','), /broken_libraryRef:experiment_broken:missing_replay/);
});

test('reference verifier catches broken experimentKey, lineage, DNA, MarketDNA and queue jobs', () => {
  const steps = integrationModule.STEPS.map((step) => ({ stepName: step.name, status: 'PASS', output: { ok: true } }));
  const setOutput = (name, output) => {
    steps.find((step) => step.stepName === name).output = output;
  };
  setOutput('Replay Engine', { ok: true, runId: 'replay_known' });
  setOutput('Strategy Library', {
    ok: true,
    strategies: [{ strategyId: 's1', currentDnaHash: 'dna_known', currentMarketDnaHash: 'market_known' }],
    events: [{ type: 'REPLAY_RECORDED', strategyId: 's1', runId: 'replay_known', marketDnaHash: 'market_known' }],
  });
  setOutput('AI Memory', {
    ok: true,
    experiments: [{
      experimentKey: 'experiment_known',
      identity: { strategyDnaHash: 'dna_missing', marketDnaHash: 'market_missing' },
      libraryRef: { strategyId: 's1', libraryRunId: 'replay_known' },
    }],
  });
  setOutput('Learning Engine', {
    ok: true,
    learningRecords: [{ learningRecordId: 'learning_bad', experimentKey: 'experiment_missing', dnaHash: 'dna_known', marketDna: { marketDnaHash: 'market_known' } }],
  });
  setOutput('Replay Queue', {
    ok: true,
    jobs: [{ id: 'queue_bad', status: 'completed', run_id: 'replay_missing' }],
  });
  setOutput('Evolution Engine', {
    ok: true,
    nodes: [{ dnaHash: 'dna_child', parent: 'dna_parent_missing' }],
  });

  const references = integrationModule._internal.verifyReferences(steps);

  assert.equal(references.status, integrationModule.STEP_STATUS.FAILED);
  const issues = references.issues.join(',');
  assert.match(issues, /broken_experimentKey:learning_bad:experiment_missing/);
  assert.match(issues, /broken_lineage:dna_child->dna_parent_missing/);
  assert.match(issues, /broken_dna_reference:dna_missing/);
  assert.match(issues, /broken_market_dna_reference:market_missing/);
  assert.match(issues, /broken_replay_queue_job:queue_bad:unknown_run_id:replay_missing/);
});
