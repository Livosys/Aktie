'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createReplayQueueService } = require('./replayQueueService');
const { createReplayQueueRunnerService } = require('./replayQueueRunnerService');

function sampleJob(idSuffix = 'alpha') {
  return {
    strategy: { id: `strategy_${idSuffix}`, name: `Strategy ${idSuffix}`, source: 'internal', status: 'paper_only' },
    market_dna: {
      symbols: ['QQQ', 'SPY'],
      market_group: 'index',
      timeframe: '2m',
      dna_tags: ['confidence'],
    },
    replay_mode: 'confidence',
    period: { start: '2026-07-20', end: '2026-08-17' },
    execution_model: { engine_mode: 'scan_only', timeframe: '2m' },
    priority: { score: 75, metric: 'information_gain', components: { low_confidence: 18 }, win_rate_used: false },
    reason: 'Runner integration test.',
    requested_by: 'Strategy Brain',
  };
}

function makeQueue(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  let tick = 0;
  const base = Date.parse('2026-08-17T13:00:00.000Z');
  return createReplayQueueService({
    queueFile: path.join(tmp, 'events.jsonl'),
    now: () => new Date(base + (tick++ * 1000)).toISOString(),
  });
}

(async function run() {
  {
    const queue = makeQueue('replay-runner-paused');
    const appended = queue.appendJob(sampleJob('paused'));
    assert.equal(appended.created, true);
    queue.pauseQueue('pause before runner', 'test');

    let engineCalls = 0;
    const runner = createReplayQueueRunnerService({
      queueService: queue,
      replayEngine: {
        async runReplay() {
          engineCalls += 1;
          throw new Error('should not run while paused');
        },
      },
      learningConnector: { recordReplayResult: () => ({ ok: true }) },
    });
    const result = await runner.runNextJob();
    assert.equal(result.executed, false);
    assert.equal(result.blockedReason, 'replay_queue_paused');
    assert.equal(engineCalls, 0, 'paused queue must not call replay engine');
  }

  {
    const queue = makeQueue('replay-runner-success');
    const appended = queue.appendJob(sampleJob('success'));
    const engineCalls = [];
    const memoryCalls = [];
    const runner = createReplayQueueRunnerService({
      queueService: queue,
      replayEngine: {
        async runReplay(args) {
          engineCalls.push(args);
          return {
            runId: 'run_existing_engine_1',
            summary: {
              runId: 'run_existing_engine_1',
              symbols: args.symbols,
              start: args.start,
              end: args.end,
              mode: args.mode,
              totalEvents: 12,
              avgTradeScore: 61.5,
              coverage: { replay_ready: args.symbols },
            },
          };
        },
      },
      learningConnector: {
        recordReplayResult(payload) {
          memoryCalls.push(payload);
          return { ok: true, event: { source: 'replay', event_id: payload.session_id } };
        },
      },
    });

    const result = await runner.runNextJob();
    assert.equal(result.ok, true);
    assert.equal(result.executed, true);
    assert.equal(result.memoryRecorded, true);
    assert.equal(engineCalls.length, 1, 'runner must call existing replay engine exactly once');
    assert.deepEqual(engineCalls[0], {
      symbols: ['QQQ', 'SPY'],
      start: '2026-07-20',
      end: '2026-08-17',
      mode: 'scan_only',
    });
    assert.equal(memoryCalls.length, 1, 'AI Memory/Learning Connector must be filled after job');
    assert.equal(memoryCalls[0].session_id, `replay_job:${appended.job.id}`);
    assert.equal(memoryCalls[0].strategy_id, 'strategy_success');
    assert.equal(memoryCalls[0].total_trades, 12);
    assert.equal(memoryCalls[0].mode, 'confidence');

    const status = queue.getStatus();
    assert.equal(status.summary.completed, 1);
    assert.equal(status.completed_jobs[0].run_id, 'run_existing_engine_1');
    assert.equal(status.completed_jobs[0].memory_recorded, true);
  }

  {
    const queue = makeQueue('replay-runner-failure');
    queue.appendJob(sampleJob('failure'));
    const memoryCalls = [];
    const runner = createReplayQueueRunnerService({
      queueService: queue,
      replayEngine: {
        async runReplay() {
          throw new Error('engine failed');
        },
      },
      learningConnector: {
        recordReplayResult(payload) {
          memoryCalls.push(payload);
          return { ok: true };
        },
      },
    });
    const result = await runner.runNextJob();
    assert.equal(result.ok, false);
    assert.equal(result.failed, true);
    assert.equal(result.memoryRecorded, true, 'failed jobs still produce a memory event');
    assert.equal(memoryCalls.length, 1);
    assert.equal(memoryCalls[0].extra.status, 'failed');
    assert.equal(queue.getStatus().summary.failed, 1);
  }

  {
    const sourceFiles = [
      'src/services/replayQueueService.js',
      'src/services/replaySchedulerService.js',
      'src/jobs/replayScheduler.js',
    ];
    for (const rel of sourceFiles) {
      const text = fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
      assert.equal(text.includes('../scanner/replayEngine'), false, `${rel} must not import replay engine`);
      assert.equal(text.includes('paperTradingRuntimeService'), false, `${rel} must not touch paper runtime`);
      assert.equal(text.includes('paperTradingAgent'), false, `${rel} must not touch paper agent`);
      assert.equal(text.includes('nativeFuturesScannerService'), false, `${rel} must not touch native scanner`);
      assert.equal(text.includes('futuresPaperScannerService'), false, `${rel} must not touch paper scanner`);
      assert.equal(text.includes('../scanner/scheduler'), false, `${rel} must not touch native scanner scheduler`);
    }
  }

  console.log('# replayQueueRunnerService tests passed.');
})();
