'use strict';

const path = require('path');
const { createEventLog } = require('../../data/eventLog');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  readOnly: true,
  source: 'ib_historical_backfill_progress_tracker',
});

const EVENT_TYPES = Object.freeze([
  'RUN_PLANNED',
  'RUN_STARTED',
  'RUN_PAUSED',
  'RUN_RESUMED',
  'SEGMENT_STARTED',
  'SEGMENT_COMPLETED',
  'SEGMENT_FAILED',
  'RUN_COMPLETED',
  'RUN_FAILED',
]);

const DEFAULT_FILE = path.resolve(__dirname, '../../../data/market-data/ib/backfill-progress.jsonl');

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function createIbHistoricalBackfillProgressTracker(options = {}) {
  const log = createEventLog({
    file: options.file || DEFAULT_FILE,
    keyField: 'runId',
    eventTypes: EVENT_TYPES,
    now: options.now,
    label: 'ib_historical_backfill_progress',
  });

  function historyFor(runId) {
    return log.historyFor(runId);
  }

  function getRunState(runId) {
    const rows = historyFor(runId);
    const completedSegmentIds = new Set();
    const failedSegments = new Map();
    const startedSegments = new Set();
    let status = 'new';
    let paused = false;
    let plan = null;
    let startedAt = null;
    let completedAt = null;
    let lastError = null;

    for (const event of rows) {
      if (event.type === 'RUN_PLANNED') {
        status = 'planned';
        plan = event.plan || plan;
      } else if (event.type === 'RUN_STARTED') {
        status = 'running';
        paused = false;
        startedAt = startedAt || event.recordedAt;
      } else if (event.type === 'RUN_PAUSED') {
        status = 'paused';
        paused = true;
      } else if (event.type === 'RUN_RESUMED') {
        status = 'running';
        paused = false;
      } else if (event.type === 'SEGMENT_STARTED') {
        startedSegments.add(event.segmentId);
        if (!paused && status !== 'completed') status = 'running';
      } else if (event.type === 'SEGMENT_COMPLETED') {
        completedSegmentIds.add(event.segmentId);
        failedSegments.delete(event.segmentId);
      } else if (event.type === 'SEGMENT_FAILED') {
        failedSegments.set(event.segmentId, event);
        lastError = event.error || event.reason || 'segment_failed';
        status = 'failed';
      } else if (event.type === 'RUN_COMPLETED') {
        status = 'completed';
        paused = false;
        completedAt = event.recordedAt;
      } else if (event.type === 'RUN_FAILED') {
        status = 'failed';
        lastError = event.error || event.reason || 'run_failed';
      }
    }

    return {
      runId,
      status,
      paused,
      plan,
      startedAt,
      completedAt,
      lastError,
      eventCount: rows.length,
      plannedSegmentIds: plan?.segmentIds || [],
      completedSegmentIds: [...completedSegmentIds].sort(),
      failedSegmentIds: [...failedSegments.keys()].sort(),
      failedSegments: [...failedSegments.entries()].reduce((out, [id, event]) => {
        out[id] = { error: event.error || null, retryable: event.retryable !== false };
        return out;
      }, {}),
      startedSegmentIds: [...startedSegments].sort(),
      lastRecordedAt: rows[rows.length - 1]?.recordedAt || null,
      safety: SAFETY,
    };
  }

  function hasEvent(runId, type, predicate = null) {
    return historyFor(runId)
      .some((event) => event.type === type && (typeof predicate === 'function' ? predicate(event) : true));
  }

  function recordRunPlanned(plan = {}) {
    const runId = text(plan.runId);
    if (!runId) throw new Error('backfill_progress_requires_runId');
    if (hasEvent(runId, 'RUN_PLANNED')) {
      return { ok: true, skipped: true, reason: 'run_already_planned' };
    }
    return log.append(runId, 'RUN_PLANNED', {
      correlationId: plan.correlationId || runId,
      plan: {
        plannerVersion: plan.plannerVersion || null,
        provider: plan.provider || null,
        roots: plan.roots || [],
        from: plan.from || null,
        to: plan.to || null,
        segmentIds: (plan.segments || []).map((segment) => segment.id),
        segmentCount: (plan.segments || []).length,
        blockers: plan.blockers || [],
        ok: plan.ok === true,
      },
      ...SAFETY,
    });
  }

  function startRun(plan = {}) {
    const runId = text(plan.runId);
    if (!runId) throw new Error('backfill_progress_requires_runId');
    if (hasEvent(runId, 'RUN_STARTED')) {
      return { ok: true, skipped: true, reason: 'run_already_started' };
    }
    return log.append(runId, 'RUN_STARTED', {
      correlationId: plan.correlationId || runId,
      ...SAFETY,
    });
  }

  function pause(runId, payload = {}) {
    const id = text(runId);
    if (!id) throw new Error('backfill_progress_requires_runId');
    return log.append(id, 'RUN_PAUSED', {
      correlationId: payload.correlationId || id,
      reason: payload.reason || 'manual_pause',
      ...SAFETY,
    });
  }

  function resume(runId, payload = {}) {
    const id = text(runId);
    if (!id) throw new Error('backfill_progress_requires_runId');
    return log.append(id, 'RUN_RESUMED', {
      correlationId: payload.correlationId || id,
      reason: payload.reason || 'manual_resume',
      ...SAFETY,
    });
  }

  function startSegment(segment = {}) {
    const runId = text(segment.runId);
    const segmentId = text(segment.id);
    if (!runId) throw new Error('backfill_progress_requires_runId');
    if (!segmentId) throw new Error('backfill_progress_requires_segmentId');
    return log.append(runId, 'SEGMENT_STARTED', {
      correlationId: segment.correlationId || runId,
      segmentId,
      root: segment.root || null,
      date: segment.date || null,
      contractKey: segment.contractKey || null,
      ...SAFETY,
    });
  }

  function completeSegment(segment = {}, result = {}) {
    const runId = text(segment.runId || result.runId);
    const segmentId = text(segment.id || result.segmentId);
    if (!runId) throw new Error('backfill_progress_requires_runId');
    if (!segmentId) throw new Error('backfill_progress_requires_segmentId');
    if (hasEvent(runId, 'SEGMENT_COMPLETED', (event) => event.segmentId === segmentId)) {
      return { ok: true, skipped: true, reason: 'segment_already_completed' };
    }
    return log.append(runId, 'SEGMENT_COMPLETED', {
      correlationId: segment.correlationId || result.correlationId || runId,
      segmentId,
      root: segment.root || result.root || null,
      date: segment.date || result.date || null,
      contractKey: segment.contractKey || result.contractKey || null,
      raw: result.raw || null,
      candles2m: result.candles2m || null,
      validationOk: result.validation?.ok === true,
      ...SAFETY,
    });
  }

  function failSegment(segment = {}, result = {}) {
    const runId = text(segment.runId || result.runId);
    const segmentId = text(segment.id || result.segmentId);
    if (!runId) throw new Error('backfill_progress_requires_runId');
    if (!segmentId) throw new Error('backfill_progress_requires_segmentId');
    return log.append(runId, 'SEGMENT_FAILED', {
      correlationId: segment.correlationId || result.correlationId || runId,
      segmentId,
      root: segment.root || result.root || null,
      date: segment.date || result.date || null,
      contractKey: segment.contractKey || result.contractKey || null,
      error: result.error || result.reason || 'segment_failed',
      retryable: result.retryable !== false,
      ...SAFETY,
    });
  }

  function completeRun(plan = {}, payload = {}) {
    const runId = text(plan.runId || payload.runId);
    if (!runId) throw new Error('backfill_progress_requires_runId');
    if (hasEvent(runId, 'RUN_COMPLETED')) {
      return { ok: true, skipped: true, reason: 'run_already_completed' };
    }
    return log.append(runId, 'RUN_COMPLETED', {
      correlationId: plan.correlationId || payload.correlationId || runId,
      completedSegmentCount: payload.completedSegmentCount || 0,
      ...SAFETY,
    });
  }

  function failRun(plan = {}, payload = {}) {
    const runId = text(plan.runId || payload.runId);
    if (!runId) throw new Error('backfill_progress_requires_runId');
    return log.append(runId, 'RUN_FAILED', {
      correlationId: plan.correlationId || payload.correlationId || runId,
      error: payload.error || payload.reason || 'run_failed',
      ...SAFETY,
    });
  }

  function nextPendingSegment(plan = {}) {
    const runId = text(plan.runId);
    if (!runId) return null;
    const state = getRunState(runId);
    if (state.paused || state.status === 'completed') return null;
    const done = new Set(state.completedSegmentIds);
    return (plan.segments || []).find((segment) => (
      !done.has(segment.id)
      && !(state.failedSegments?.[segment.id] && state.failedSegments[segment.id].retryable === false)
    )) || null;
  }

  function isSegmentCompleted(runId, segmentId) {
    return hasEvent(runId, 'SEGMENT_COMPLETED', (event) => event.segmentId === segmentId);
  }

  return {
    SAFETY,
    file: log.file,
    EVENT_TYPES,
    recordRunPlanned,
    startRun,
    pause,
    resume,
    startSegment,
    completeSegment,
    failSegment,
    completeRun,
    failRun,
    nextPendingSegment,
    isSegmentCompleted,
    getRunState,
    historyFor,
    auditTrail: log.auditTrail,
    stats: log.stats,
    _log: log,
  };
}

module.exports = {
  SAFETY,
  EVENT_TYPES,
  DEFAULT_FILE,
  createIbHistoricalBackfillProgressTracker,
};
