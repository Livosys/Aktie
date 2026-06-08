'use strict';

/**
 * Batch Autopilot — SAFE, DISABLED-BY-DEFAULT scheduler grund.
 *
 * This module only describes and gates a future batch-planning autopilot. It is
 * read-only with respect to trading: it never places orders, never enables a
 * broker, never changes risk, never auto-applies a strategy and never starts a
 * real batch execution. Phase 1 (the only phase implemented) can at most produce
 * a DRY-RUN plan preview when explicitly enabled via env.
 *
 * Safety gates (all required before anything could ever run):
 *   ENABLE_BATCH_AUTOPILOT=true        (default false → fully off)
 *   BATCH_AUTOPILOT_DRY_RUN_ONLY=true  (default true  → never execute)
 *
 * Real execution is intentionally NOT implemented. Even with dryRunOnly=false the
 * gate returns a blocked reason, so this service can never start a batch.
 */

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const EXECUTION_ENV_GATE = 'ENABLE_BATCH_AUTOPILOT_EXECUTE=true (not implemented — execution is intentionally unavailable)';

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// Config is read dynamically (not at load time) so the gate always reflects the
// current environment and is easy to test.
function config() {
  return {
    enabled: bool(process.env.ENABLE_BATCH_AUTOPILOT, false),
    dryRunOnly: bool(process.env.BATCH_AUTOPILOT_DRY_RUN_ONLY, true),
    intervalMinutes: clampInt(process.env.BATCH_AUTOPILOT_INTERVAL_MINUTES, 360, 15, 24 * 60),
    maxPerDay: clampInt(process.env.BATCH_AUTOPILOT_MAX_PER_DAY, 2, 0, 50),
  };
}

function dataDir() {
  return process.env.BATCH_AUTOPILOT_DIR
    ? path.resolve(process.env.BATCH_AUTOPILOT_DIR)
    : path.resolve(__dirname, '../../data/autopilot');
}
function statusFile() { return path.join(dataDir(), 'batch-autopilot-status.json'); }

function nowIso(now = Date.now()) { return new Date(now).toISOString(); }
function dayKey(iso) { return String(iso || '').slice(0, 10); }

function readState() {
  try {
    const file = statusFile();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(statusFile(), JSON.stringify(state, null, 2) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

// Resolve the persisted run counters for "today" (resets across day boundaries).
function todayCounters(state, now) {
  const today = dayKey(nowIso(now));
  if (!state || dayKey(state.lastRunDay) !== today) return { todayRunCount: 0, day: today };
  return { todayRunCount: clampInt(state.todayRunCount, 0, 0, 9999), day: today };
}

/**
 * Pure gate decision. Never executes anything. Returns whether a (dry-run) plan
 * step would be allowed and, if not, a stable blocked reason.
 */
function evaluateGate({ state = readState(), now = Date.now() } = {}) {
  const cfg = config();
  if (!cfg.enabled) return { allowed: false, blockedReason: 'disabled' };
  if (!cfg.dryRunOnly) return { allowed: false, blockedReason: 'execution_not_supported_safe_mode' };

  const { todayRunCount } = todayCounters(state, now);
  if (cfg.maxPerDay > 0 && todayRunCount >= cfg.maxPerDay) {
    return { allowed: false, blockedReason: 'max_per_day_reached' };
  }
  const lastRunMs = state?.lastRun ? new Date(state.lastRun).getTime() : null;
  if (lastRunMs && Number.isFinite(lastRunMs)) {
    const cooldownMs = cfg.intervalMinutes * 60 * 1000;
    if (now - lastRunMs < cooldownMs) return { allowed: false, blockedReason: 'cooldown_active' };
  }
  return { allowed: true, blockedReason: null };
}

function nextRunFrom(state, now) {
  const cfg = config();
  if (!cfg.enabled) return null;
  const lastRunMs = state?.lastRun ? new Date(state.lastRun).getTime() : null;
  const base = Number.isFinite(lastRunMs) ? lastRunMs : now;
  return nowIso(base + cfg.intervalMinutes * 60 * 1000);
}

function getStatus({ now = Date.now() } = {}) {
  const cfg = config();
  const state = readState();
  const { todayRunCount } = todayCounters(state, now);
  const gate = evaluateGate({ state, now });
  const status = !cfg.enabled ? 'disabled' : (gate.allowed ? 'idle' : 'waiting');
  return {
    ok: true,
    status,
    enabled: cfg.enabled,
    dryRunOnly: cfg.dryRunOnly,
    executionEnabled: false,
    executionEnvGate: EXECUTION_ENV_GATE,
    intervalMinutes: cfg.intervalMinutes,
    maxPerDay: cfg.maxPerDay,
    lastRun: state?.lastRun || null,
    nextRun: cfg.enabled ? nextRunFrom(state, now) : null,
    lastPlan: state?.lastPlan || null,
    lastBlockedReason: cfg.enabled ? (state?.lastBlockedReason || gate.blockedReason || null) : 'disabled',
    todayRunCount,
    message: cfg.enabled
      ? 'Batch-autopilot är förberedd och kör endast säkra dry-run-planer.'
      : 'Batch-autopilot är förberedd men avstängd (ENABLE_BATCH_AUTOPILOT=false).',
    updatedAt: nowIso(now),
    ...SAFETY,
  };
}

// Build a read-only batch plan preview. NEVER starts a batch. Returns a plain
// recommendation object that a human could choose to act on manually.
function buildPlanPreview(batchService) {
  const svc = batchService || safeRequire('./strategyBatchTestService');
  const base = {
    kind: 'batch_dry_run_plan',
    createdAt: nowIso(),
    note: 'Endast förslag. Ingen batch startas automatiskt.',
    ...SAFETY,
  };
  try {
    if (svc && typeof svc.listBatchTests === 'function') {
      const listed = svc.listBatchTests();
      const batches = Array.isArray(listed?.batches) ? listed.batches : [];
      return {
        ...base,
        knownBatches: batches.length,
        recommendation: batches.length
          ? 'Granska senaste batchresultat innan en ny batch planeras manuellt.'
          : 'Ingen batchhistorik ännu. Samla mer paper/replay-data först.',
      };
    }
  } catch (_) { /* fault-isolated */ }
  return { ...base, knownBatches: null, recommendation: 'Batchdata kunde inte läsas (read-only).' };
}

function safeRequire(modPath) {
  try { return require(modPath); } catch (_) { return null; }
}

/**
 * The only "run" entrypoint. It is fully gated: when disabled or not in dry-run
 * mode it records a blocked reason and changes nothing. When allowed it produces
 * a DRY-RUN plan preview and advances counters. It NEVER executes a batch.
 */
function runOnce({ now = Date.now(), trigger = 'manual', batchService = null } = {}) {
  const gate = evaluateGate({ now });
  if (!gate.allowed) {
    const state = readState() || {};
    const patched = { ...state, lastBlockedReason: gate.blockedReason, lastBlockedAt: nowIso(now) };
    writeState(patched);
    return {
      ok: true,
      executed: false,
      planned: false,
      blocked: true,
      blockedReason: gate.blockedReason,
      trigger,
      ...SAFETY,
    };
  }

  const plan = buildPlanPreview(batchService);
  const prev = readState();
  const { todayRunCount, day } = todayCounters(prev, now);
  const newState = {
    lastRun: nowIso(now),
    lastRunDay: day,
    todayRunCount: todayRunCount + 1,
    lastPlan: plan,
    lastBlockedReason: null,
    updatedAt: nowIso(now),
  };
  writeState(newState);
  return {
    ok: true,
    executed: false, // dry-run only, by design
    planned: true,
    blocked: false,
    blockedReason: null,
    plan,
    trigger,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  config,
  evaluateGate,
  getStatus,
  buildPlanPreview,
  runOnce,
  _internal: { todayCounters, nextRunFrom, readState, writeState, statusFile },
};
