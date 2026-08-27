'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EVENT_TYPES,
  createReplayQueueService,
} = require('./replayQueueService');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-queue-'));
const queueFile = path.join(tmp, 'events.jsonl');
let tick = 0;
const base = Date.parse('2026-08-17T10:00:00.000Z');
const service = createReplayQueueService({
  queueFile,
  now: () => new Date(base + (tick++ * 1000)).toISOString(),
});

function lines() {
  if (!fs.existsSync(queueFile)) return [];
  return fs.readFileSync(queueFile, 'utf8').trim().split('\n').filter(Boolean);
}

function sampleJob() {
  return {
    strategy: { id: 'narrow_state_expansion_long', name: 'Narrow State Expansion Long', source: 'internal', status: 'paper_only' },
    market_dna: {
      symbols: ['QQQ', 'SPY'],
      market_group: 'index',
      timeframe: '2m',
      dna_tags: ['narrow', 'compression'],
    },
    replay_mode: 'confidence',
    period: { start: '2026-07-20', end: '2026-08-17' },
    execution_model: { engine_mode: 'scan_only', timeframe: '2m' },
    priority: { score: 88, metric: 'information_gain', components: { missing_replay: 24 }, win_rate_used: false },
    reason: 'Confidence gap needs replay evidence.',
    requested_by: 'Strategy Brain',
  };
}

(function run() {
  const first = service.appendJob(sampleJob());
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.job.strategy.id, 'narrow_state_expansion_long');
  assert.deepEqual(Object.keys(first.job).filter((key) => [
    'strategy',
    'market_dna',
    'replay_mode',
    'period',
    'execution_model',
    'priority',
    'reason',
    'requested_by',
  ].includes(key)).sort(), [
    'execution_model',
    'market_dna',
    'period',
    'priority',
    'reason',
    'replay_mode',
    'requested_by',
    'strategy',
  ]);
  assert.equal(first.job.priority.metric, 'information_gain');
  assert.equal(first.job.priority.win_rate_used, false);
  assert.equal(first.job.scheduler_runs_replay, undefined);
  assert.equal(lines().length, 1);

  const originalFirstLine = lines()[0];
  const duplicate = service.appendJob(sampleJob());
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.created, false);
  assert.equal(lines().length, 1, 'duplicate append must not add a second event');
  assert.equal(lines()[0], originalFirstLine, 'duplicate detection must not rewrite existing JSONL');

  let status = service.getStatus();
  assert.equal(status.append_only, true);
  assert.equal(status.mutation_allowed, false);
  assert.equal(status.rewrite_allowed, false);
  assert.equal(status.summary.pending, 1);
  assert.equal(status.pending_jobs[0].id, first.job.id);

  const paused = service.pauseQueue('operator_pause', 'operator');
  assert.equal(paused.ok, true);
  status = service.getStatus();
  assert.equal(status.paused, true);
  assert.equal(service.nextPendingJob().blockedReason, 'replay_queue_paused');
  assert.equal(lines().length, 2);
  assert.equal(lines()[0], originalFirstLine, 'pause appends only');

  const resumed = service.resumeQueue('operator_resume', 'operator');
  assert.equal(resumed.ok, true);
  status = service.getStatus();
  assert.equal(status.paused, false);
  assert.equal(status.pending_jobs.length, 1);
  assert.equal(service.nextPendingJob().job.id, first.job.id);
  assert.equal(lines().length, 3);
  assert.equal(lines()[0], originalFirstLine, 'resume appends only');

  const reset = service.resetQueue('clear visible queue', 'operator');
  assert.equal(reset.ok, true);
  status = service.getStatus();
  assert.equal(status.summary.pending, 0, 'reset hides previous folded jobs');
  assert.equal(status.summary.raw_event_count, 4, 'reset keeps raw append-only history');
  assert.equal(lines()[0], originalFirstLine, 'reset appends only');

  const afterReset = service.appendJob(sampleJob());
  assert.equal(afterReset.created, true, 'same deterministic job can be re-appended after reset generation');
  assert.equal(afterReset.job.id, first.job.id);
  assert.equal(lines().length, 5);

  const events = service.readEvents();
  assert.deepEqual(events.map((event) => event.event_type), [
    EVENT_TYPES.JOB_APPENDED,
    EVENT_TYPES.QUEUE_PAUSED,
    EVENT_TYPES.QUEUE_RESUMED,
    EVENT_TYPES.QUEUE_RESET,
    EVENT_TYPES.JOB_APPENDED,
  ]);

  const deterministicAFile = path.join(tmp, 'deterministic-a.jsonl');
  const deterministicBFile = path.join(tmp, 'deterministic-b.jsonl');
  const deterministicA = createReplayQueueService({
    queueFile: deterministicAFile,
    now: () => '2026-08-17T15:00:00.000Z',
  });
  const deterministicB = createReplayQueueService({
    queueFile: deterministicBFile,
    now: () => '2026-08-17T15:00:00.000Z',
  });
  deterministicA.appendJob(sampleJob());
  deterministicB.appendJob(sampleJob());
  assert.equal(
    fs.readFileSync(deterministicAFile, 'utf8'),
    fs.readFileSync(deterministicBFile, 'utf8'),
    'same data and same clock must produce the same append-only queue event',
  );
  assert.deepEqual(
    deterministicA.getStatus().pending_jobs,
    deterministicB.getStatus().pending_jobs,
    'same data and same clock must produce the same queue view',
  );

  console.log('# replayQueueService tests passed.');
})();
