'use strict';

/**
 * Narrow Autopilot Research Queue.
 *
 * Default behavior is dry-run/status only. A scheduled research batch can only
 * run when ENABLE_NARROW_AUTOPILOT_EXECUTE=true and every paper-only safety
 * gate passes. The web API never calls the execution path.
 */

const fs = require('fs');
const path = require('path');

const narrowAutopilot = require('../services/narrowTestAutopilotService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const STATUS_FILE = path.join(
  path.resolve(process.env.NARROW_AUTOPILOT_DIR || path.resolve(__dirname, '../../data/autopilot')),
  'narrow-autopilot-research-queue-status.json',
);

let timer = null;
let running = false;
let nextRunAt = null;

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function config() {
  const intervalMinutes = clampInt(process.env.NARROW_AUTOPILOT_SCHEDULER_INTERVAL_MINUTES, 360, 15, 24 * 60);
  return {
    schedulerEnabled: bool(process.env.NARROW_AUTOPILOT_SCHEDULER_ENABLED, true),
    queueEnabled: true,
    executionEnabled: bool(process.env.ENABLE_NARROW_AUTOPILOT_EXECUTE, false),
    intervalMinutes,
    cooldownMinutes: clampInt(process.env.NARROW_AUTOPILOT_RESEARCH_COOLDOWN_MINUTES, intervalMinutes, 15, 24 * 60),
    startupDelaySeconds: clampInt(process.env.NARROW_AUTOPILOT_SCHEDULER_STARTUP_DELAY_SECONDS, 60, 10, 60 * 60),
    maxPerDay: clampInt(process.env.NARROW_AUTOPILOT_RESEARCH_MAX_PER_DAY, 1, 0, 20),
  };
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function dayKey(iso) {
  return String(iso || '').slice(0, 10);
}

function ensureDir() {
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
}

function readState() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeState(state) {
  ensureDir();
  fs.writeFileSync(STATUS_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
}

function todayRunCount(state, now = Date.now()) {
  const today = dayKey(nowIso(now));
  return dayKey(state.lastBatchRun) === today ? clampInt(state.todayRunCount, 0, 0, 999) : 0;
}

function cooldownActive(state, now = Date.now(), cfg = config()) {
  const until = state.cooldownUntil ? new Date(state.cooldownUntil).getTime() : null;
  return Number.isFinite(until) && until > now;
}

function compactPlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id || null,
    mode: plan.mode || SAFETY.mode,
    status: plan.status || null,
    strategy_id: plan.strategy_id || null,
    testType: plan.testType || null,
    selectedNarrowScoreBand: plan.selectedNarrowScoreBand || plan.filters?.narrowScoreBand || null,
    dateWindowSelected: plan.dateWindowSelected || null,
    alreadyTested: Boolean(plan.dateWindowSelected?.alreadyTested),
    symbols: Array.isArray(plan.symbols) ? plan.symbols : [],
    timeframes: Array.isArray(plan.timeframes) ? plan.timeframes : [],
    warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
  };
}

function compactResult(result) {
  if (!result) return null;
  return {
    ok: Boolean(result.ok),
    blocked: Boolean(result.blocked),
    dryRun: Boolean(result.dryRun),
    executed: Boolean(result.executed),
    duplicateSkipped: Boolean(result.duplicateSkipped),
    runStatus: result.runStatus || null,
    reasons: Array.isArray(result.reasons) ? result.reasons : [],
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    summary: result.summary || null,
    message_sv: result.message_sv || null,
  };
}

function baseStatus(now = Date.now()) {
  const cfg = config();
  const state = readState();
  return {
    ok: true,
    schedulerEnabled: cfg.schedulerEnabled,
    schedulerActive: timer !== null,
    queueEnabled: cfg.queueEnabled,
    executionEnabled: cfg.executionEnabled,
    dryRunOnly: !cfg.executionEnabled,
    intervalMinutes: cfg.intervalMinutes,
    maxPerDay: cfg.maxPerDay,
    todayRunCount: todayRunCount(state, now),
    cooldownUntil: state.cooldownUntil || null,
    cooldownActive: cooldownActive(state, now, cfg),
    running,
    nextRunAt,
    lastScheduledDryRun: state.lastScheduledDryRun || null,
    lastQueuedTest: state.lastQueuedTest || null,
    lastBatchRun: state.lastBatchRun || null,
    lastBatchResult: state.lastBatchResult || null,
    lastBlockedReason: state.lastBlockedReason || (!cfg.executionEnabled ? 'execution_disabled' : null),
    lastError: state.lastError || null,
    updatedAt: nowIso(now),
    ...SAFETY,
  };
}

function saveStatus(patch = {}, now = Date.now()) {
  const current = readState();
  const next = {
    ...current,
    ...patch,
    updatedAt: nowIso(now),
    ...SAFETY,
  };
  writeState(next);
  return getNarrowAutopilotSchedulerStatus({ now });
}

function gateResearchRun({ dryRunResult, now = Date.now(), state = readState(), autopilot = narrowAutopilot } = {}) {
  const cfg = config();
  const reasons = [];
  if (!cfg.executionEnabled) reasons.push('execution_disabled');
  if (cooldownActive(state, now, cfg)) reasons.push(`cooldown_until:${state.cooldownUntil}`);
  if (cfg.maxPerDay > 0 && todayRunCount(state, now) >= cfg.maxPerDay) reasons.push('max_per_day_reached');
  if (!dryRunResult || dryRunResult.dryRun !== true) reasons.push('dry_run_plan_missing');
  if (dryRunResult?.blocked) reasons.push('dry_run_plan_blocked');
  if (dryRunResult?.executed) reasons.push('dry_run_unexpectedly_executed');

  const plan = dryRunResult?.plan || null;
  const validation = plan ? autopilot.validateNarrowAutopilotPlan(plan) : null;
  const eligibility = plan ? autopilot.validateResearchQueueEligibility(plan, validation) : null;
  if (eligibility?.blocked) reasons.push(...eligibility.reasons);

  return {
    ok: reasons.length === 0,
    blocked: reasons.length > 0,
    reasons: [...new Set(reasons)],
    plan: eligibility?.normalizedPlan || plan,
    ...SAFETY,
  };
}

function runScheduledResearchCycle({ trigger = 'scheduler', now = Date.now(), autopilot = narrowAutopilot } = {}) {
  if (running) return saveStatus({ lastBlockedReason: 'already_running' }, now);
  running = true;
  saveStatus({ running: true, lastBlockedReason: null, lastError: null }, now);

  try {
    const dryRunResult = autopilot.runNarrowAutopilotOnce({ dryRun: true });
    const state = readState();
    const gate = gateResearchRun({ dryRunResult, now, state, autopilot });
    const dryRunStatus = {
      trigger,
      at: nowIso(now),
      ok: Boolean(dryRunResult.ok),
      blocked: Boolean(dryRunResult.blocked),
      executed: false,
      reasons: dryRunResult.reasons || [],
      plan: compactPlan(dryRunResult.plan),
    };

    if (!gate.ok) {
      running = false;
      return saveStatus({
        running: false,
        lastScheduledDryRun: dryRunStatus,
        lastBlockedReason: gate.reasons.join(',') || 'research_gate_blocked',
      }, now);
    }

    const batchResult = autopilot.runNarrowAutopilotOnce({ dryRun: false });
    const completedAt = nowIso(now);
    const cfg = config();
    const nextRunCount = todayRunCount(state, now) + (batchResult.executed || batchResult.duplicateSkipped ? 1 : 0);
    const cooldownUntil = new Date(now + cfg.cooldownMinutes * 60 * 1000).toISOString();

    running = false;
    return saveStatus({
      running: false,
      lastScheduledDryRun: dryRunStatus,
      lastQueuedTest: {
        at: completedAt,
        trigger,
        plan: compactPlan(gate.plan),
      },
      lastBatchRun: completedAt,
      lastBatchResult: compactResult(batchResult),
      lastBlockedReason: batchResult.ok ? null : (batchResult.reasons || batchResult.warnings || ['batch_failed']).join(','),
      todayRunCount: nextRunCount,
      cooldownUntil,
    }, now);
  } catch (err) {
    running = false;
    return saveStatus({
      running: false,
      lastBlockedReason: `scheduler_error:${err.message}`,
      lastError: err.message,
    }, now);
  }
}

function scheduleNext(delayMs) {
  if (timer) clearTimeout(timer);
  nextRunAt = new Date(Date.now() + delayMs).toISOString();
  timer = setTimeout(() => {
    runScheduledResearchCycle({ trigger: 'scheduler' });
    scheduleNext(config().intervalMinutes * 60 * 1000);
  }, delayMs);
  if (timer.unref) timer.unref();
  saveStatus({ nextRunAt });
}

function startNarrowAutopilotScheduler() {
  const cfg = config();
  if (!cfg.schedulerEnabled) {
    nextRunAt = null;
    saveStatus({ nextRunAt, lastBlockedReason: 'scheduler_disabled' });
    return null;
  }
  if (timer) return timer;
  scheduleNext(cfg.startupDelaySeconds * 1000);
  return timer;
}

function stopNarrowAutopilotScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
  nextRunAt = null;
  saveStatus({ nextRunAt });
}

function getNarrowAutopilotSchedulerStatus({ now = Date.now() } = {}) {
  return baseStatus(now);
}

module.exports = {
  SAFETY,
  config,
  getNarrowAutopilotSchedulerStatus,
  startNarrowAutopilotScheduler,
  stopNarrowAutopilotScheduler,
  runScheduledResearchCycle,
  gateResearchRun,
  _internal: { readState, writeState, todayRunCount, cooldownActive, statusFile: () => STATUS_FILE },
};
