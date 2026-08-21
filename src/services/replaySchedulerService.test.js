'use strict';

const assert = require('assert/strict');

const {
  createReplaySchedulerService,
} = require('./replaySchedulerService');

const NOW = '2026-08-17T12:00:00.000Z';

function strategy(id, extra = {}) {
  return {
    strategy_id: id,
    strategy_name: id,
    source: 'internal',
    status: 'paper_only',
    enabled: true,
    ...extra,
  };
}

function score(strategyId, extra = {}) {
  return {
    strategy_id: strategyId,
    confidence: 42,
    sample_size: 3,
    weaknesses: ['Behöver replay/batch-test'],
    recommended_action: 'Kör replay och samla mer data.',
    win_rate: 99,
    ...extra,
  };
}

function history(replay = 0, batch = 0, paper = 0) {
  return {
    history_summary: {
      paper_trades_count: paper,
      replay_tests_count: replay,
      batch_tests_count: batch,
      last_replay_at: replay ? '2026-07-01T00:00:00.000Z' : null,
    },
  };
}

const coverage = [
  { symbol: 'QQQ', data_quality: 'good', coverage_score: 90, usable_for_replay: true, days_covered: 30, candles_count: 4000 },
  { symbol: 'SPY', data_quality: 'medium', coverage_score: 65, usable_for_replay: true, days_covered: 10, candles_count: 1200 },
  { symbol: 'NVDA', data_quality: 'weak', coverage_score: 35, usable_for_replay: true, days_covered: 4, candles_count: 300 },
  { symbol: 'BTCUSDT', data_quality: 'good', coverage_score: 90, usable_for_replay: true, days_covered: 30, candles_count: 4000 },
  { symbol: 'ETHUSDT', data_quality: 'good', coverage_score: 90, usable_for_replay: true, days_covered: 30, candles_count: 4000 },
  { symbol: 'SOLUSDT', data_quality: 'missing', coverage_score: 0, usable_for_replay: false, days_covered: 0, candles_count: 0 },
];

function buildService() {
  return createReplaySchedulerService({
    now: () => NOW,
    registryService: { listStrategies: () => [] },
    scoreService: { getStrategyScores: () => ({ strategies: [] }) },
    historyService: { getStrategyHistory: () => null },
    coverageService: { getAllSymbolCoverage: () => ({ symbols: coverage }) },
    queueService: { appendMany: (jobs) => ({ ok: true, created: jobs.length, duplicates: 0, results: [] }), getStatus: () => ({ summary: {} }) },
  });
}

function requiredFields(job) {
  return [
    job.strategy,
    job.market_dna,
    job.replay_mode,
    job.period,
    job.execution_model,
    job.priority,
    job.reason,
    job.requested_by,
  ].every(Boolean);
}

(function run() {
  const service = buildService();
  const input = {
    now: NOW,
    config: { maxJobsPerRun: 50, periodDays: 30 },
    requestedBy: 'Strategy Brain',
    strategies: [
      strategy('confidence_alpha', { symbols: ['QQQ'] }),
      strategy('optimizer_beta', { symbols: ['SPY'], recommended_tests: ['parameter optimizer'] }),
    ],
    scores: [
      score('confidence_alpha', { confidence: 35, sample_size: 2, win_rate: 95 }),
      score('optimizer_beta', { confidence: 62, sample_size: 12, recommended_action: 'Kör batch parameter replay.', win_rate: 15 }),
    ],
    histories: {
      confidence_alpha: history(0, 0, 2),
      optimizer_beta: history(1, 0, 0),
    },
    coverage,
    knowledgeGaps: [
      { strategy_id: 'manual_gap', replay_mode: 'manual', severity: 'high', symbols: ['QQQ'], reason: 'Manual validation requested.' },
      { strategy_id: 'regression_gap', replay_mode: 'regression', severity: 'medium', symbols: ['QQQ'], reason: 'Regression check missing.' },
      { strategy_id: 'evolution_gap', replay_mode: 'evolution', severity: 'medium', symbols: ['SPY'], reason: 'Evolution branch lacks replay.' },
      { strategy_id: 'optimizer_gap', replay_mode: 'optimizer', severity: 'medium', symbols: ['SPY'], reason: 'Optimizer branch lacks replay.' },
      { strategy_id: 'coverage_gap', replay_mode: 'coverage', severity: 'critical', symbols: ['SOLUSDT'], reason: 'Coverage knowledge gap.' },
      { strategy_id: 'confidence_gap', replay_mode: 'confidence', severity: 'high', symbols: ['BTCUSDT'], reason: 'Confidence knowledge gap.' },
      { strategy_id: 'confidence_gap', replay_mode: 'confidence', severity: 'high', symbols: ['BTCUSDT'], reason: 'Confidence knowledge gap.' },
    ],
  };

  const planA = service.buildSchedule(input);
  const planB = service.buildSchedule(input);
  assert.deepEqual(planA, planB, 'same input and same clock must produce same queue plan');
  assert.equal(planA.scheduler_runs_replay, false);
  assert.equal(planA.prioritizes, 'information_gain');
  assert.equal(planA.win_rate_used_for_priority, false);
  assert.ok(planA.jobs.length >= 7);
  assert.ok(planA.jobs.every(requiredFields), 'every job must carry the replay job contract fields');
  assert.ok(planA.jobs.every((job) => job.priority.metric === 'information_gain'));
  assert.ok(planA.jobs.every((job) => job.priority.win_rate_used === false));

  const modes = new Set(planA.jobs.map((job) => job.replay_mode));
  for (const mode of ['manual', 'regression', 'evolution', 'optimizer', 'coverage', 'confidence']) {
    assert.ok(modes.has(mode), `expected ${mode} replay job`);
  }

  const confidenceGapJobs = planA.jobs.filter((job) => job.strategy.id === 'confidence_gap');
  assert.equal(confidenceGapJobs.length, 1, 'duplicate knowledge gaps must dedupe to one replay job');
  assert.equal(confidenceGapJobs[0].requested_by, 'Strategy Brain');

  const winRateHigh = service.buildSchedule({
    now: NOW,
    config: { maxJobsPerRun: 10, periodDays: 30 },
    strategies: [strategy('win_rate_mutation', { symbols: ['QQQ'] })],
    scores: [score('win_rate_mutation', { win_rate: 99, confidence: 40, sample_size: 1 })],
    histories: { win_rate_mutation: history(0, 0, 0) },
    coverage,
  });
  const winRateLow = service.buildSchedule({
    now: NOW,
    config: { maxJobsPerRun: 10, periodDays: 30 },
    strategies: [strategy('win_rate_mutation', { symbols: ['QQQ'] })],
    scores: [score('win_rate_mutation', { win_rate: 1, confidence: 40, sample_size: 1 })],
    histories: { win_rate_mutation: history(0, 0, 0) },
    coverage,
  });
  assert.deepEqual(winRateHigh.jobs[0].priority, winRateLow.jobs[0].priority, 'mutating win_rate must not mutate priority');
  assert.equal(winRateHigh.jobs[0].id, winRateLow.jobs[0].id, 'win_rate must not affect job identity');

  const lowSeverity = service.buildSchedule({
    now: NOW,
    config: { maxJobsPerRun: 10, periodDays: 30 },
    coverage,
    knowledgeGaps: [{ strategy_id: 'severity_mutation', replay_mode: 'confidence', severity: 'low', symbols: ['QQQ'], reason: 'Gap.' }],
  });
  const highSeverity = service.buildSchedule({
    now: NOW,
    config: { maxJobsPerRun: 10, periodDays: 30 },
    coverage,
    knowledgeGaps: [{ strategy_id: 'severity_mutation', replay_mode: 'confidence', severity: 'high', symbols: ['QQQ'], reason: 'Gap.' }],
  });
  assert.ok(
    highSeverity.jobs[0].priority.score > lowSeverity.jobs[0].priority.score,
    'mutating knowledge-gap severity must mutate information gain',
  );

  process.env.ENABLE_REPLAY_SCHEDULER = 'true';
  const appendCalls = [];
  const runService = createReplaySchedulerService({
    now: () => NOW,
    registryService: { listStrategies: () => input.strategies },
    scoreService: { getStrategyScores: () => ({ strategies: input.scores }) },
    historyService: { getStrategyHistory: (id) => input.histories[id] || null },
    coverageService: { getAllSymbolCoverage: () => ({ symbols: coverage }) },
    queueService: {
      appendMany(jobs) {
        appendCalls.push(jobs);
        return { ok: true, created: jobs.length, duplicates: 0, results: [] };
      },
      getStatus: () => ({ summary: {} }),
    },
  });
  const scheduled = runService.runOnce({ config: { maxJobsPerRun: 10, periodDays: 30 } });
  delete process.env.ENABLE_REPLAY_SCHEDULER;
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.scheduler_runs_replay, false);
  assert.equal(appendCalls.length, 1, 'scheduler must only append queue jobs');

  console.log('# replaySchedulerService tests passed.');
})();
