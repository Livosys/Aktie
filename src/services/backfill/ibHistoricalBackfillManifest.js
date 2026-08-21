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
  source: 'ib_historical_backfill_manifest',
});

const EVENT_TYPES = Object.freeze([
  'PLAN_RECORDED',
  'SEGMENT_RECORDED',
  'VALIDATION_RECORDED',
  'BLOCKER_RECORDED',
]);

const DEFAULT_FILE = path.resolve(__dirname, '../../../data/market-data/ib/backfill-manifest.jsonl');

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function eventHashablePlan(plan = {}) {
  return {
    plannerVersion: plan.plannerVersion || null,
    provider: plan.provider || null,
    disallowedProviders: plan.disallowedProviders || [],
    roots: plan.roots || [],
    from: plan.from || null,
    to: plan.to || null,
    barSize: plan.barSize || null,
    duration: plan.duration || null,
    session: plan.session || null,
    timezone: plan.timezone || null,
    deterministic: plan.deterministic === true,
    contractSegments: plan.contractSegments || [],
    segmentIds: (plan.segments || []).map((segment) => segment.id),
    blockers: plan.blockers || [],
  };
}

function createIbHistoricalBackfillManifest(options = {}) {
  const log = createEventLog({
    file: options.file || DEFAULT_FILE,
    keyField: 'runId',
    eventTypes: EVENT_TYPES,
    now: options.now,
    label: 'ib_historical_backfill_manifest',
  });

  function hasEvent(runId, type, predicate = null) {
    return log.historyFor(runId, { types: [type] })
      .some((event) => (typeof predicate === 'function' ? predicate(event) : true));
  }

  function recordPlan(plan = {}) {
    const runId = text(plan.runId);
    if (!runId) throw new Error('backfill_manifest_requires_runId');
    if (hasEvent(runId, 'PLAN_RECORDED')) {
      return { ok: true, skipped: true, reason: 'plan_already_recorded' };
    }
    return log.append(runId, 'PLAN_RECORDED', {
      correlationId: plan.correlationId || runId,
      ok: plan.ok === true,
      plan: eventHashablePlan(plan),
      segmentCount: (plan.segments || []).length,
      blockerCount: (plan.blockers || []).length,
      ...SAFETY,
    });
  }

  function recordSegment(segment = {}, result = {}) {
    const runId = text(segment.runId || result.runId);
    if (!runId) throw new Error('backfill_manifest_requires_runId');
    const segmentId = text(segment.id || result.segmentId);
    if (!segmentId) throw new Error('backfill_manifest_requires_segmentId');
    return log.append(runId, 'SEGMENT_RECORDED', {
      correlationId: segment.correlationId || result.correlationId || runId,
      segmentId,
      root: segment.root || result.root || null,
      date: segment.date || result.date || null,
      contractKey: segment.contractKey || result.contractKey || null,
      raw: result.raw || null,
      candles2m: result.candles2m || null,
      downloader: result.downloader || null,
      status: result.ok === true ? 'completed' : 'failed',
      error: result.ok === true ? null : (result.error || result.reason || 'segment_failed'),
      ...SAFETY,
    });
  }

  function recordValidation(segment = {}, validation = {}) {
    const runId = text(segment.runId || validation.runId);
    if (!runId) throw new Error('backfill_manifest_requires_runId');
    const segmentId = text(segment.id || validation.segmentId);
    if (!segmentId) throw new Error('backfill_manifest_requires_segmentId');
    return log.append(runId, 'VALIDATION_RECORDED', {
      correlationId: segment.correlationId || validation.correlationId || runId,
      segmentId,
      root: segment.root || validation.root || null,
      date: segment.date || validation.date || null,
      contractKey: segment.contractKey || validation.contractKey || null,
      ok: validation.ok === true,
      raw: validation.raw || null,
      aggregation: validation.aggregation || null,
      errors: validation.errors || [],
      warnings: validation.warnings || [],
      ...SAFETY,
    });
  }

  function recordBlocker(runIdOrPlan, blocker = {}) {
    const plan = typeof runIdOrPlan === 'object' && runIdOrPlan ? runIdOrPlan : null;
    const runId = text(plan?.runId || runIdOrPlan);
    if (!runId) throw new Error('backfill_manifest_requires_runId');
    return log.append(runId, 'BLOCKER_RECORDED', {
      correlationId: plan?.correlationId || blocker.correlationId || runId,
      reason: blocker.reason || plan?.reason || 'backfill_blocked',
      blocker,
      ...SAFETY,
    });
  }

  function historyFor(runId) {
    return log.historyFor(runId);
  }

  function summary(runId) {
    const rows = historyFor(runId);
    return {
      runId,
      events: rows.length,
      planRecorded: rows.some((event) => event.type === 'PLAN_RECORDED'),
      segmentsRecorded: rows.filter((event) => event.type === 'SEGMENT_RECORDED').length,
      validationsRecorded: rows.filter((event) => event.type === 'VALIDATION_RECORDED').length,
      blockersRecorded: rows.filter((event) => event.type === 'BLOCKER_RECORDED').length,
      lastRecordedAt: rows[rows.length - 1]?.recordedAt || null,
      safety: SAFETY,
    };
  }

  return {
    SAFETY,
    file: log.file,
    EVENT_TYPES,
    recordPlan,
    recordSegment,
    recordValidation,
    recordBlocker,
    historyFor,
    summary,
    auditTrail: log.auditTrail,
    stats: log.stats,
    _log: log,
  };
}

module.exports = {
  SAFETY,
  EVENT_TYPES,
  DEFAULT_FILE,
  createIbHistoricalBackfillManifest,
};
