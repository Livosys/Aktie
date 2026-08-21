'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const learningModule = require('./learningEngineService');
const libraryModule = require('../library/strategyLibraryService');
const memoryModule = require('../memory/aiMemoryService');

const ROOT = path.resolve(__dirname, '../../..');
const NOW = '2026-08-18T12:00:00.000Z';
const STRATEGY_ID = 'momentum_alpha';
const REPLAY_RUN_ID = 'replay_mnq_trend_001';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function tempFile(dir, name) {
  return path.join(dir, name);
}

function createWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-engine-'));
  const library = libraryModule.createStrategyLibrary({
    eventsFile: tempFile(dir, 'strategy-library.jsonl'),
    registry: { listNativeStrategies: () => [] },
    now: () => NOW,
  });
  const memory = memoryModule.createAiMemory({
    eventsFile: tempFile(dir, 'ai-memory.jsonl'),
    now: () => NOW,
  });
  const brainCalls = [];
  const strategyBrain = {
    analyze({ library: seenLibrary }) {
      brainCalls.push(seenLibrary);
      return {
        ok: true,
        brainVersion: 'brain-test',
        strategies: [{
          strategyId: STRATEGY_ID,
          knowledgeScore: 78,
          gaps: [{ type: 'market_regime_gap', informationValue: 22 }],
          recommendation: { action: 'paper', reason: 'quality_above_threshold' },
        }],
        recommendations: { paper: [STRATEGY_ID] },
      };
    },
  };

  library.recordReplayRun({
    strategyId: STRATEGY_ID,
    runId: REPLAY_RUN_ID,
    mode: 'strategy',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-31T23:59:00.000Z',
    trades: 44,
    winRate: 63.6,
    strategyPnlUsd: 1425,
    profitFactor: 1.72,
    expectancyUsd: 32.38,
    maxDrawdownUsd: 315,
    avgWinUsd: 91,
    avgLossUsd: -54,
    strategyScore: 72,
    executionScore: 68,
    band: 'candidate',
    recoveryFactor: 4.52,
    sharpe: null,
    sharpeAvailable: false,
    marketClassification: 'trend_up',
    marketRegimeKey: 'up/normal',
    marketRegimeKeys: ['up/normal'],
    marketDnaHash: 'market_dna_trend_up_normal',
    qualified: true,
    at: NOW,
  });
  library.recordScore({ strategyId: STRATEGY_ID, scoreType: 'strategyScore', value: 72, at: NOW });
  library.recordScore({ strategyId: STRATEGY_ID, scoreType: 'executionScore', value: 68, at: NOW });
  library.recordScore({ strategyId: STRATEGY_ID, scoreType: 'confidenceScore', value: 61, at: NOW });

  memory.recordExperiment({
    strategyId: STRATEGY_ID,
    strategyDnaHash: 'strategy_dna_momentum_alpha_v1',
    parameterHash: 'parameters_a',
    marketDnaHash: 'market_dna_trend_up_normal',
    replayMode: 'strategy',
    executionModel: 'simulated_fill',
    strategyVersion: 'v1',
    period: { from: '2026-01-01', to: '2026-01-31' },
    symbols: ['MNQ'],
    runId: REPLAY_RUN_ID,
    requestedBy: 'replay_scheduler',
    regimeKeys: ['up/normal'],
  }, {
    source: 'strategy_library',
    resultType: 'replay',
    strategyId: STRATEGY_ID,
    libraryRunId: REPLAY_RUN_ID,
    eventType: 'REPLAY_RECORDED',
  }, { at: NOW });

  const engine = learningModule.createLearningEngine({
    eventsFile: tempFile(dir, 'learning-engine.jsonl'),
    strategyLibrary: library,
    aiMemory: memory,
    strategyBrain,
    now: () => NOW,
  });

  return { dir, library, memory, strategyBrain, brainCalls, engine };
}

test('same replay produces the same Learning Record and no duplicate records', () => {
  const world = createWorld();

  const first = world.engine.learnFromReplay({
    replayRunId: REPLAY_RUN_ID,
    strategyId: STRATEGY_ID,
    requestedBy: 'acceptance-test',
  });
  const second = world.engine.learnFromReplay({
    replayRunId: REPLAY_RUN_ID,
    strategyId: STRATEGY_ID,
    requestedBy: 'acceptance-test',
  });

  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.learningRecord, first.learningRecord);
  assert.equal(world.engine.getLearningRecords().length, 1);
  assert.equal(world.engine.getStrategyKnowledge(STRATEGY_ID).items.length, 1);

  const record = first.learningRecord;
  assert.equal(record.strategyId, STRATEGY_ID);
  assert.equal(record.dnaHash, 'strategy_dna_momentum_alpha_v1');
  assert.equal(record.marketDna.marketDnaHash, 'market_dna_trend_up_normal');
  assert.equal(record.replayMode, 'strategy');
  assert.equal(record.trades, 44);
  assert.equal(record.winrate, 63.6);
  assert.equal(record.drawdown, 315);
  assert.equal(record.profitFactor, 1.72);
  assert.equal(record.strategyScore, 72);
  assert.equal(record.executionScore, 68);
  assert.equal(record.confidenceScore, 61);
  assert.equal(record.succeeded, true);
  assert.equal(record.recommendedNextAction, learningModule.ACTIONS.APPROVAL);
});

test('Strategy Knowledge is append-only conclusions traced to replayRunId', () => {
  const world = createWorld();

  const result = world.engine.learnFromReplay({ replayRunId: REPLAY_RUN_ID, strategyId: STRATEGY_ID });
  const knowledge = world.engine.getStrategyKnowledge(STRATEGY_ID);

  assert.equal(result.ok, true);
  assert.equal(knowledge.ok, true);
  assert.equal(knowledge.appendOnly, true);
  assert.equal(knowledge.items.length, 1);
  assert.equal(knowledge.items[0].learningRecordId, result.learningRecord.learningRecordId);
  assert.equal(knowledge.items[0].replayRunId, REPLAY_RUN_ID);
  assert.equal(knowledge.items[0].strategyId, STRATEGY_ID);
  assert.equal(knowledge.items[0].conclusionCode, 'qualified_replay');
  assert.equal(knowledge.items[0].evidence.trades, 44);
});

test('Learning Engine does not mutate Strategy Library or AI Memory', () => {
  const world = createWorld();
  const libraryBefore = world.library.getAuditTrail({});
  const memoryBefore = world.memory.getAuditTrail({});

  const result = world.engine.learnFromReplay({ replayRunId: REPLAY_RUN_ID, strategyId: STRATEGY_ID });

  assert.equal(result.ok, true);
  assert.deepEqual(world.library.getAuditTrail({}), libraryBefore);
  assert.deepEqual(world.memory.getAuditTrail({}), memoryBefore);
  assert.equal(world.brainCalls.length, 1);
  assert.equal(world.brainCalls[0], world.library);
});

test('Factory Director can read Learning Summary', () => {
  const directorModule = require('../factory/factoryDirectorService');
  const calls = [];
  const director = directorModule.createFactoryDirector({
    now: () => NOW,
    strategyLibrary: { getStatus: () => ({ ok: true }), listStrategies: () => [] },
    aiMemory: { getStatus: () => ({ ok: true }) },
    strategyRuntime: { materialize: () => ({ ok: true, runtimeId: 'runtime_test' }) },
    replayScheduler: { getStatus: () => ({ ok: true }) },
    replayQueue: { getStatus: () => ({ ok: true, summary: { pending: 0, running: 0 } }) },
    backfillService: { progress: { stats: () => ({ events: 0 }) }, SAFETY: { readOnly: true } },
    aiOptimizer: { describe: () => ({ ok: true }) },
    evolutionEngine: { getStatus: () => ({ ok: true }) },
    approvalService: { getAutomationApprovals: () => ({ ok: true, waitingForApproval: [] }) },
    strategyBrain: { analyze: () => ({ ok: true, recommendations: {} }) },
    learningEngine: {
      getLearningSummary() {
        calls.push('learning.getLearningSummary');
        return {
          ok: true,
          recommendations: [{ strategyId: STRATEGY_ID, action: 'optimize', reason: 'loss_making_in_market' }],
        };
      },
    },
  });

  const result = director.decide({ runId: 'learning-summary-director', requestedBy: 'acceptance-test', now: NOW });

  assert.deepEqual(calls, ['learning.getLearningSummary']);
  assert.equal(result.decision.action, directorModule.ACTIONS.OPTIMIZER);
  assert.equal(result.decision.reason, 'learning_summary_requested_optimization');
});

test('Learning Engine source does not cross execution or mutation boundaries', () => {
  const source = stripComments(read('src/services/learning/learningEngineService.js'));
  const forbiddenImports = [
    /replayEngine/i,
    /replayQueue/i,
    /replayScheduler/i,
    /strategyRuntime/i,
    /nativeFuturesScanner/i,
    /paperTradingRuntime/i,
    /fillEngine/i,
    /optimizer/i,
    /evolution/i,
  ];
  for (const pattern of forbiddenImports) {
    assert.equal(pattern.test(source), false, String(pattern));
  }

  const forbiddenCalls = [
    /\.runOnce\s*\(/,
    /\.appendJob\s*\(/,
    /\.startJob\s*\(/,
    /\.completeJob\s*\(/,
    /\.failJob\s*\(/,
    /\.recordReplayRun\s*\(/,
    /\.recordScore\s*\(/,
    /\.recordExperiment\s*\(/,
    /\.propose\s*\(/,
    /\.evolve\s*\(/,
    /\.createOptimizedDnaCandidates\s*\(/,
    /\.execute\s*\(/,
    /\.approveStrategy\s*\(/,
  ];
  for (const pattern of forbiddenCalls) {
    assert.equal(pattern.test(source), false, String(pattern));
  }
});
