'use strict';

const replayQueue = require('./replayQueueService');
const replayEngine = require('../scanner/replayEngine');
const learningConnector = require('./learningConnectorService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  paper_only: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function safeString(value, fallback = '') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function replayArgsFromJob(job = {}) {
  const symbols = safeArray(job.market_dna?.symbols)
    .map((symbol) => safeString(symbol).toUpperCase())
    .filter(Boolean);
  return {
    symbols,
    start: safeString(job.period?.start),
    end: safeString(job.period?.end),
    mode: safeString(job.execution_model?.engine_mode || 'scan_only', 'scan_only'),
  };
}

function memoryPayloadFromJob(job = {}, result = {}, status = 'completed', error = null) {
  const summary = result.summary || {};
  const symbols = safeArray(summary.symbols).length ? summary.symbols : safeArray(job.market_dna?.symbols);
  return {
    session_id: `replay_job:${job.id}`,
    source: 'replayQueue',
    strategy_id: job.strategy?.id || null,
    strategy_name: job.strategy?.name || null,
    symbol: symbols[0] || 'MULTI',
    symbols,
    timeframe: job.execution_model?.timeframe || job.market_dna?.timeframe || '2m',
    replay_window: `${job.period?.start || ''} -> ${job.period?.end || ''}`,
    total_trades: safeNumber(summary.totalEvents, 0),
    avg_trade_score: summary.avgTradeScore ?? null,
    mode: job.replay_mode || 'manual',
    outcome: status === 'failed' ? 'unknown' : undefined,
    extra: {
      job_id: job.id,
      replay_mode: job.replay_mode,
      requested_by: job.requested_by,
      status,
      run_id: result.runId || null,
      error: error ? safeString(error) : null,
    },
  };
}

function recordJobMemory(job, result, status, error, connector) {
  if (!connector || typeof connector.recordReplayResult !== 'function') {
    return { ok: false, error: 'learning_connector_unavailable', ...SAFETY };
  }
  try {
    const recorded = connector.recordReplayResult(memoryPayloadFromJob(job, result, status, error));
    return {
      ok: recorded?.ok !== false,
      result: recorded,
      ...SAFETY,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
      ...SAFETY,
    };
  }
}

function createReplayQueueRunnerService(options = {}) {
  const queueService = options.queueService || replayQueue.defaultReplayQueueService;
  const engine = options.replayEngine || replayEngine;
  const connector = options.learningConnector || learningConnector;
  const workerId = safeString(options.workerId || 'replay_queue_runner');

  async function runNextJob() {
    const next = queueService.nextPendingJob();
    if (!next.ok || next.blocked || !next.job) {
      return {
        ok: next.ok,
        executed: false,
        blocked: true,
        blockedReason: next.blockedReason || next.error || 'no_replay_job_available',
        job: null,
        ...SAFETY,
      };
    }

    const started = queueService.startJob(next.job.id, { workerId });
    if (!started.ok) {
      return {
        ok: false,
        executed: false,
        blocked: true,
        blockedReason: started.error,
        job: next.job,
        ...SAFETY,
      };
    }

    const job = started.job || next.job;
    try {
      if (!engine || typeof engine.runReplay !== 'function') {
        throw new Error('replay_engine_unavailable');
      }
      const args = replayArgsFromJob(job);
      const result = await engine.runReplay(args);
      const memory = recordJobMemory(job, result, 'completed', null, connector);
      const completed = queueService.completeJob(job.id, {
        runId: result?.runId || null,
        replaySummary: result?.summary || null,
        memoryRecorded: memory.ok === true,
      });
      return {
        ok: completed.ok,
        executed: true,
        job: completed.job,
        replay: result,
        memoryRecorded: memory.ok === true,
        memory,
        ...SAFETY,
      };
    } catch (err) {
      const memory = recordJobMemory(job, {}, 'failed', err.message || String(err), connector);
      const failed = queueService.failJob(job.id, {
        error: err.message || String(err),
        memoryRecorded: memory.ok === true,
      });
      return {
        ok: false,
        executed: true,
        failed: true,
        job: failed.job || job,
        error: err.message || String(err),
        memoryRecorded: memory.ok === true,
        memory,
        ...SAFETY,
      };
    }
  }

  return {
    SAFETY,
    runNextJob,
    _internal: {
      replayArgsFromJob,
      memoryPayloadFromJob,
    },
  };
}

const defaultReplayQueueRunnerService = createReplayQueueRunnerService();

module.exports = {
  SAFETY,
  createReplayQueueRunnerService,
  defaultReplayQueueRunnerService,
  _internal: {
    replayArgsFromJob,
    memoryPayloadFromJob,
    recordJobMemory,
  },
};
