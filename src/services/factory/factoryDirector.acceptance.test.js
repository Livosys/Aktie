'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const directorModule = require('./factoryDirectorService');

const ROOT = path.resolve(__dirname, '../../..');
const NOW = '2026-08-18T12:00:00.000Z';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function baseStatus(overrides = {}) {
  return {
    generatedAt: NOW,
    safety: { ok: true },
    replayQueue: { ok: true, summary: { pending: 0, running: 0, paused: false } },
    replayScheduler: { ok: true },
    backfill: { ok: true, status: 'idle' },
    brain: { ok: true, recommendations: {} },
    aiOptimizer: { ok: true },
    evolution: { ok: true },
    approval: { ok: true, waitingForApproval: [] },
    strategyLibrary: { ok: true },
    aiMemory: { ok: true },
    learning: { ok: true, recommendations: [] },
    strategyRuntime: { ok: true, runtimeId: 'runtime_test' },
    ...overrides,
  };
}

function decide(systemStatus, extra = {}) {
  const director = directorModule.createFactoryDirector({ now: () => NOW });
  return director.decide({
    runId: 'director-test-run',
    requestedBy: 'acceptance-test',
    now: NOW,
    systemStatus,
    ...extra,
  });
}

test('same system status gives the same single decision', () => {
  const status = baseStatus({
    brain: {
      ok: true,
      nextReplay: {
        strategyId: 'mnq_breakout',
        informationGain: 88,
        reason: 'missing_market_dna',
      },
      recommendations: { re_test: ['mnq_breakout'] },
    },
  });

  const first = decide(status);
  const second = decide(status);

  assert.deepEqual(first, second);
  assert.equal(first.oneDecision, true);
  assert.equal(Array.isArray(first.decisions), false);
  assert.equal(first.decision.action, directorModule.ACTIONS.KNOWLEDGE_GAP);
  assert.equal(first.decision.status, 'recommended');
});

test('director always selects exactly one next action in priority order', () => {
  const cases = [
    {
      name: 'safety',
      status: baseStatus({ safety: { ok: false, reason: 'manual_safety_stop' } }),
      action: directorModule.ACTIONS.SAFETY,
      priority: 1,
    },
    {
      name: 'backfill',
      status: baseStatus({ backfill: { ok: true, status: 'pending', pendingSegments: 4 } }),
      action: directorModule.ACTIONS.BACKFILL,
      priority: 2,
    },
    {
      name: 'knowledge gap',
      status: baseStatus({ brain: { ok: true, nextReplay: { strategyId: 's1', informationGain: 20 } } }),
      action: directorModule.ACTIONS.KNOWLEDGE_GAP,
      priority: 3,
    },
    {
      name: 'replay',
      status: baseStatus({ replayQueue: { ok: true, summary: { pending: 1, running: 0 } } }),
      action: directorModule.ACTIONS.REPLAY,
      priority: 4,
    },
    {
      name: 'optimizer',
      status: baseStatus({ brain: { ok: true, recommendations: { optimize: ['weak_strategy'] } } }),
      action: directorModule.ACTIONS.OPTIMIZER,
      priority: 5,
    },
    {
      name: 'evolution',
      status: baseStatus({ aiOptimizer: { ok: true, candidates: 2 } }),
      action: directorModule.ACTIONS.EVOLUTION,
      priority: 6,
    },
    {
      name: 'approval',
      status: baseStatus({ approval: { ok: true, waitingForApproval: [{ id: 'candidate_a' }] } }),
      action: directorModule.ACTIONS.APPROVAL,
      priority: 7,
    },
    {
      name: 'idle',
      status: baseStatus(),
      action: directorModule.ACTIONS.IDLE,
      priority: 8,
    },
  ];

  for (const row of cases) {
    const result = decide(row.status, { runId: `director-${row.name}` });
    assert.equal(result.decision.action, row.action, row.name);
    assert.equal(result.decision.priority, row.priority, row.name);
    assert.equal(typeof result.decision.decisionId, 'string');
    assert.equal(result.decision.status, 'recommended');
  }

  const crowded = decide(baseStatus({
    backfill: { ok: true, needsBackfill: true },
    brain: { ok: true, nextReplay: { strategyId: 's1', informationGain: 90 } },
    replayQueue: { ok: true, summary: { pending: 3, running: 0 } },
    aiOptimizer: { ok: true, pending: true },
    evolution: { ok: true, pending: true },
    approval: { ok: true, waitingForApproval: [{ id: 'candidate_a' }] },
  }));
  assert.equal(crowded.decision.action, directorModule.ACTIONS.BACKFILL);
  assert.equal(crowded.oneDecision, true);
});

test('factory director can read learning summary recommendations', () => {
  const result = decide(baseStatus({
    learning: {
      ok: true,
      recommendations: [{
        strategyId: 'learning_candidate',
        action: 'optimize',
        reason: 'loss_making_in_market',
      }],
    },
  }), { runId: 'director-learning-summary' });

  assert.equal(result.decision.action, directorModule.ACTIONS.OPTIMIZER);
  assert.equal(result.decision.reason, 'learning_summary_requested_optimization');
  assert.deepEqual(result.decision.evidence.strategyIds, ['learning_candidate']);
});

test('director reads allowed services but never performs their work', () => {
  const calls = [];
  const forbidden = (name) => () => {
    throw new Error(`${name} must not be called by Factory Director`);
  };
  const director = directorModule.createFactoryDirector({
    now: () => NOW,
    strategyLibrary: {
      getStatus() { calls.push('library.getStatus'); return { ok: true }; },
      listStrategies() { return []; },
    },
    aiMemory: {
      getStatus() { calls.push('memory.getStatus'); return { ok: true }; },
    },
    strategyRuntime: {
      materialize() { calls.push('runtime.materialize'); return { ok: true, runtimeId: 'runtime_fake' }; },
      execute: forbidden('runtime.execute'),
    },
    replayScheduler: {
      getStatus() { calls.push('scheduler.getStatus'); return { ok: true }; },
      runOnce: forbidden('scheduler.runOnce'),
    },
    replayQueue: {
      getStatus() { calls.push('queue.getStatus'); return { ok: true, summary: { pending: 0, running: 0 } }; },
      appendJob: forbidden('queue.appendJob'),
      startJob: forbidden('queue.startJob'),
      completeJob: forbidden('queue.completeJob'),
    },
    backfillService: {
      SAFETY: { readOnly: true },
      progress: {
        stats() { calls.push('backfill.progress.stats'); return { events: 0 }; },
      },
      tick: forbidden('backfill.tick'),
      runBackfill: forbidden('backfill.runBackfill'),
    },
    aiOptimizer: {
      describe() { calls.push('optimizer.describe'); return { ok: true }; },
      propose: forbidden('optimizer.propose'),
    },
    evolutionEngine: {
      getStatus() { calls.push('evolution.getStatus'); return { ok: true }; },
      evolve: forbidden('evolution.evolve'),
      createOptimizedDnaCandidates: forbidden('evolution.createOptimizedDnaCandidates'),
    },
    learningEngine: {
      getLearningSummary() { calls.push('learning.getLearningSummary'); return { ok: true, recommendations: [] }; },
      learnFromReplay: forbidden('learning.learnFromReplay'),
    },
    approvalService: {
      getAutomationApprovals() { calls.push('approval.getAutomationApprovals'); return { ok: true, waitingForApproval: [] }; },
      approveStrategy: forbidden('approval.approveStrategy'),
      rejectStrategy: forbidden('approval.rejectStrategy'),
    },
    strategyBrain: {
      analyze() {
        calls.push('brain.analyze');
        return { ok: true, recommendations: { optimize: ['weak_strategy'] } };
      },
    },
    marketIntelligence: {
      buildMarketIntelligence: forbidden('marketIntelligence.buildMarketIntelligence'),
    },
  });

  const result = director.decide({ runId: 'service-read-test', requestedBy: 'acceptance-test', now: NOW });

  assert.equal(result.decision.action, directorModule.ACTIONS.OPTIMIZER);
  assert.deepEqual(calls.sort(), [
    'approval.getAutomationApprovals',
    'backfill.progress.stats',
    'brain.analyze',
    'evolution.getStatus',
    'library.getStatus',
    'learning.getLearningSummary',
    'memory.getStatus',
    'optimizer.describe',
    'queue.getStatus',
    'runtime.materialize',
    'scheduler.getStatus',
  ].sort());
});

test('factory director source imports only allowed services and no execution boundaries', () => {
  const source = stripComments(read('src/services/factory/factoryDirectorService.js'));
  const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
  const allowedRequires = new Set([
    'crypto',
    '../brain/strategyBrainService',
    '../strategyRuntimeService',
    '../replaySchedulerService',
    '../replayQueueService',
    '../backfill/ibHistoricalBackfillService',
    '../optimizer/aiOptimizerService',
    '../evolution/evolutionEngineService',
    '../library/strategyLibraryService',
    '../memory/aiMemoryService',
    '../learning/learningEngineService',
    '../automationApprovalService',
    '../market/marketIntelligenceService',
  ]);
  for (const entry of requires) {
    assert.equal(allowedRequires.has(entry), true, `unexpected require: ${entry}`);
  }

  for (const forbiddenImport of [
    /replayEngine/,
    /nativeFuturesScanner/,
    /paperTradingRuntime/,
    /fillEngine/,
    /historicalPriceFeed/,
    /Evaluator/i,
    /\.\.\/scanner\//,
  ]) {
    assert.equal(forbiddenImport.test(source), false, String(forbiddenImport));
  }

  for (const forbiddenCall of [
    /\.runOnce\s*\(/,
    /\.appendJob\s*\(/,
    /\.appendMany\s*\(/,
    /\.startJob\s*\(/,
    /\.completeJob\s*\(/,
    /\.failJob\s*\(/,
    /\.pauseQueue\s*\(/,
    /\.resumeQueue\s*\(/,
    /\.resetQueue\s*\(/,
    /\.execute\s*\(/,
    /\.propose\s*\(/,
    /\.evolve\s*\(/,
    /\.createOptimizedDnaCandidates\s*\(/,
    /\.tick\s*\(/,
    /\.runBackfill\s*\(/,
    /\.approveStrategy\s*\(/,
    /\.rejectStrategy\s*\(/,
  ]) {
    assert.equal(forbiddenCall.test(source), false, String(forbiddenCall));
  }
});

test('factory director API surface is read-only GET only', () => {
  const source = stripComments(read('src/routes/api.js'));
  for (const route of [
    '/factory/director',
    '/factory/decision',
    '/factory/next',
    '/factory/status',
  ]) {
    assert.match(source, new RegExp(`router\\.get\\(['"]${route}`));
    assert.doesNotMatch(source, new RegExp(`router\\.(post|delete|put|patch)\\(['"]${route}`));
  }
});
