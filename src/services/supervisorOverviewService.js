'use strict';

const narrowAutopilot = require('./narrowTestAutopilotService');
const narrowAutopilotScheduler = require('../jobs/narrowAutopilotScheduler');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return { ...fallback, error: err.message };
  }
}

function summarizeNarrowAutopilot({ autopilotStatus = null, schedulerStatus = null } = {}) {
  const autopilot = autopilotStatus?.autopilot || null;
  const scheduler = schedulerStatus || null;
  return {
    ok: Boolean(autopilotStatus?.ok !== false && schedulerStatus?.ok !== false),
    planningEnabled: Boolean(autopilot?.enabled),
    dryRunDefault: autopilot ? Boolean(autopilot.dryRunDefault) : true,
    queueEnabled: scheduler ? Boolean(scheduler.queueEnabled) : false,
    executionEnabled: scheduler ? Boolean(scheduler.executionEnabled) : false,
    schedulerActive: scheduler ? Boolean(scheduler.schedulerActive) : false,
    lastQueuedTest: scheduler?.lastQueuedTest || null,
    lastBatchRun: scheduler?.lastBatchRun || null,
    lastBatchResult: scheduler?.lastBatchResult || null,
    lastBlockedReason: scheduler?.lastBlockedReason || null,
    maxPerDay: scheduler?.maxPerDay ?? null,
    todayRunCount: scheduler?.todayRunCount ?? 0,
    cooldownUntil: scheduler?.cooldownUntil || null,
    currentPlan: autopilot?.currentPlan || null,
    recommendedNextTest: autopilot?.recommendedNextTest || null,
    planValidation: autopilot?.planValidation || null,
    researchQueueEligibility: autopilot?.researchQueueEligibility || null,
    ...SAFETY,
  };
}

function buildSupervisorOverview() {
  const autopilotStatus = safeCall(
    () => narrowAutopilot.getNarrowAutopilotStatus(),
    { ok: false, autopilot: null, ...SAFETY },
  );
  const schedulerStatus = safeCall(
    () => narrowAutopilotScheduler.getNarrowAutopilotSchedulerStatus(),
    { ok: false, queueEnabled: false, executionEnabled: false, ...SAFETY },
  );

  return {
    ok: true,
    narrowAutopilot: summarizeNarrowAutopilot({ autopilotStatus, schedulerStatus }),
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  summarizeNarrowAutopilot,
  buildSupervisorOverview,
};
