'use strict';

/**
 * Narrow Autopilot Scheduler (Level 1)
 *
 * Runs scheduled Narrow Autopilot DRY-RUN planning only. It never executes a
 * batch, never places orders, never enables a broker, and never changes risk.
 *
 * Future Level 2 auto-execute must stay behind an explicit env gate such as:
 * ENABLE_NARROW_AUTOPILOT_EXECUTE=true
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

const DATA_DIR = path.resolve(process.env.NARROW_AUTOPILOT_DIR || path.resolve(__dirname, '../../data/autopilot'));
const STATUS_FILE = path.join(DATA_DIR, 'narrow-autopilot-scheduler-status.json');

const ENABLED = String(process.env.NARROW_AUTOPILOT_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
const INTERVAL_MINUTES = clampInt(process.env.NARROW_AUTOPILOT_SCHEDULER_INTERVAL_MINUTES, 360, 15, 24 * 60);
const COOLDOWN_MINUTES = clampInt(process.env.NARROW_AUTOPILOT_SCHEDULER_COOLDOWN_MINUTES, INTERVAL_MINUTES, 15, 24 * 60);
const STARTUP_DELAY_SECONDS = clampInt(process.env.NARROW_AUTOPILOT_SCHEDULER_STARTUP_DELAY_SECONDS, 60, 10, 60 * 60);

const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;
const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1000;
const STARTUP_DELAY_MS = STARTUP_DELAY_SECONDS * 1000;

let timer = null;
let running = false;
let nextRunAt = null;
let inMemoryStatus = null;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function nowIso() {
  return new Date().toISOString();
}

function isoFromNow(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function compactPlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id || null,
    status: plan.status || null,
    strategy_id: plan.strategy_id || null,
    testType: plan.testType || null,
    selectedNarrowScoreBand: plan.selectedNarrowScoreBand || null,
    dateWindowSelected: plan.dateWindowSelected || null,
    symbols: Array.isArray(plan.symbols) ? plan.symbols : [],
    timeframes: Array.isArray(plan.timeframes) ? plan.timeframes : [],
    alreadyTested: Boolean(plan.dateWindowSelected?.alreadyTested),
    warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
  };
}

function compactRecommendation(result) {
  return result?.plan ? {
    strategy_id: result.plan.strategy_id || null,
    selectedNarrowScoreBand: result.plan.selectedNarrowScoreBand || null,
    dateWindowSelected: result.plan.dateWindowSelected || null,
    reason: result.plan.reason || null,
    priority: result.plan.priority || null,
  } : null;
}

function cooldownUntilFrom(status) {
  const raw = status?.cooldownUntil || null;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

function isCooldownActive(status = getStoredStatus()) {
  const until = cooldownUntilFrom(status);
  return until !== null && until > Date.now();
}

function defaultStatus() {
  return {
    ok: true,
    enabled: ENABLED,
    schedulerActive: false,
    dryRunOnly: true,
    executionEnabled: false,
    executionEnvGate: 'ENABLE_NARROW_AUTOPILOT_EXECUTE=true',
    intervalMinutes: INTERVAL_MINUTES,
    cooldownMinutes: COOLDOWN_MINUTES,
    startupDelaySeconds: STARTUP_DELAY_SECONDS,
    running: false,
    nextRunAt,
    lastRunAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastScheduledDryRun: null,
    lastRecommendedTest: null,
    blockedReason: null,
    cooldownUntil: null,
    cooldownActive: false,
    lastError: null,
    updatedAt: nowIso(),
    ...SAFETY,
  };
}

function getStoredStatus() {
  const stored = readJson(STATUS_FILE, null);
  return {
    ...defaultStatus(),
    ...(stored || {}),
    enabled: ENABLED,
    schedulerActive: timer !== null,
    dryRunOnly: true,
    executionEnabled: false,
    intervalMinutes: INTERVAL_MINUTES,
    cooldownMinutes: COOLDOWN_MINUTES,
    startupDelaySeconds: STARTUP_DELAY_SECONDS,
    running,
    nextRunAt,
    cooldownActive: isCooldownActive(stored || inMemoryStatus || {}),
    ...SAFETY,
  };
}

function saveStatus(patch = {}) {
  const status = {
    ...getStoredStatus(),
    ...patch,
    enabled: ENABLED,
    schedulerActive: timer !== null,
    dryRunOnly: true,
    executionEnabled: false,
    running,
    nextRunAt,
    cooldownActive: isCooldownActive(patch) || isCooldownActive(getStoredStatus()),
    updatedAt: nowIso(),
    ...SAFETY,
  };
  inMemoryStatus = status;
  writeJson(STATUS_FILE, status);
  return status;
}

function blockedStatus(reason) {
  return saveStatus({
    blockedReason: reason,
    lastError: null,
  });
}

function scheduleNext(delayMs) {
  if (!ENABLED) return;
  if (timer) clearTimeout(timer);
  nextRunAt = isoFromNow(delayMs);
  saveStatus({ nextRunAt });
  timer = setTimeout(async () => {
    await runScheduledDryRun('scheduler');
    scheduleNext(INTERVAL_MS);
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

async function runScheduledDryRun(trigger = 'manual_scheduler') {
  if (!ENABLED) return blockedStatus('scheduler_disabled');
  if (running) return blockedStatus('already_running');

  const current = getStoredStatus();
  if (isCooldownActive(current)) {
    return blockedStatus(`cooldown_until:${current.cooldownUntil}`);
  }

  running = true;
  const startedAt = nowIso();
  saveStatus({
    running: true,
    lastStartedAt: startedAt,
    blockedReason: null,
    lastError: null,
  });

  try {
    const result = narrowAutopilot.runNarrowAutopilotOnce({ dryRun: true });
    const completedAt = nowIso();
    const cooldownUntil = new Date(Date.now() + COOLDOWN_MS).toISOString();
    const reasons = Array.isArray(result.reasons) ? result.reasons : [];
    const blockedReason = result.blocked ? (reasons.join(',') || 'dry_run_blocked') : null;

    running = false;
    return saveStatus({
      running: false,
      lastRunAt: completedAt,
      lastCompletedAt: completedAt,
      lastScheduledDryRun: {
        trigger,
        dryRun: true,
        ok: Boolean(result.ok),
        blocked: Boolean(result.blocked),
        executed: false,
        mode: result.mode || SAFETY.mode,
        reasons,
        message_sv: result.message_sv || null,
        plan: compactPlan(result.plan),
      },
      lastRecommendedTest: compactRecommendation(result),
      blockedReason,
      cooldownUntil,
      cooldownActive: true,
      lastError: null,
    });
  } catch (err) {
    running = false;
    return saveStatus({
      running: false,
      lastCompletedAt: nowIso(),
      blockedReason: `scheduler_error:${err.message}`,
      lastError: err.message,
    });
  }
}

function startNarrowAutopilotScheduler() {
  if (!ENABLED) {
    nextRunAt = null;
    saveStatus({ nextRunAt, blockedReason: 'scheduler_disabled' });
    console.log('[NarrowAutopilotScheduler] Disabled (NARROW_AUTOPILOT_SCHEDULER_ENABLED=false)');
    return;
  }
  if (timer) return;
  console.log(`[NarrowAutopilotScheduler] Starting dry-run scheduler; interval=${INTERVAL_MINUTES}min cooldown=${COOLDOWN_MINUTES}min`);
  scheduleNext(STARTUP_DELAY_MS);
}

function stopNarrowAutopilotScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
  nextRunAt = null;
  saveStatus({ nextRunAt });
  console.log('[NarrowAutopilotScheduler] Stopped');
}

function getNarrowAutopilotSchedulerStatus() {
  return getStoredStatus();
}

module.exports = {
  SAFETY,
  startNarrowAutopilotScheduler,
  stopNarrowAutopilotScheduler,
  getNarrowAutopilotSchedulerStatus,
  runScheduledDryRun,
};
