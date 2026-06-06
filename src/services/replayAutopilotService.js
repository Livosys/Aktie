'use strict';

/**
 * Replay Autopilot — SAFE, DISABLED-BY-DEFAULT scheduler grund.
 *
 * Mirrors batchAutopilotService: read-only with respect to trading. It never
 * places orders, never enables a broker, never changes risk, never auto-applies
 * a strategy and never starts a real replay execution. Phase 1 (the only phase
 * implemented) can at most produce a DRY-RUN replay plan preview when explicitly
 * enabled via env.
 *
 * Safety gates (all required before anything could ever run):
 *   ENABLE_REPLAY_AUTOPILOT=true        (default false → fully off)
 *   REPLAY_AUTOPILOT_DRY_RUN_ONLY=true  (default true  → never execute)
 *
 * Real execution is intentionally NOT implemented.
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

const EXECUTION_ENV_GATE = 'ENABLE_REPLAY_AUTOPILOT_EXECUTE=true (not implemented — execution is intentionally unavailable)';

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
  return {
    enabled: bool(process.env.ENABLE_REPLAY_AUTOPILOT, false),
    dryRunOnly: bool(process.env.REPLAY_AUTOPILOT_DRY_RUN_ONLY, true),
    intervalMinutes: clampInt(process.env.REPLAY_AUTOPILOT_INTERVAL_MINUTES, 360, 15, 24 * 60),
    maxPerDay: clampInt(process.env.REPLAY_AUTOPILOT_MAX_PER_DAY, 3, 0, 50),
  };
}

function dataDir() {
  return process.env.REPLAY_AUTOPILOT_DIR
    ? path.resolve(process.env.REPLAY_AUTOPILOT_DIR)
    : path.resolve(__dirname, '../../data/autopilot');
}
function statusFile() { return path.join(dataDir(), 'replay-autopilot-status.json'); }

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

function todayCounters(state, now) {
  const today = dayKey(nowIso(now));
  if (!state || dayKey(state.lastRunDay) !== today) return { todayRunCount: 0, day: today };
  return { todayRunCount: clampInt(state.todayRunCount, 0, 0, 9999), day: today };
}

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
    lastReplayPlan: state?.lastReplayPlan || null,
    lastReplayResult: state?.lastReplayResult || null,
    lastBlockedReason: cfg.enabled ? (state?.lastBlockedReason || gate.blockedReason || null) : 'disabled',
    todayRunCount,
    message: cfg.enabled
      ? 'Replay-autopilot är förberedd och kör endast säkra dry-run-planer.'
      : 'Replay-autopilot är förberedd men avstängd (ENABLE_REPLAY_AUTOPILOT=false).',
    updatedAt: nowIso(now),
    ...SAFETY,
  };
}

function safeRequire(modPath) {
  try { return require(modPath); } catch (_) { return null; }
}

// Build a read-only replay plan preview. NEVER starts a replay session.
function buildPlanPreview(replayService) {
  const svc = replayService || safeRequire('./replayIntelligenceService');
  const base = {
    kind: 'replay_dry_run_plan',
    createdAt: nowIso(),
    note: 'Endast förslag. Ingen replay startas automatiskt.',
    ...SAFETY,
  };
  try {
    let knownSessions = null;
    if (svc && typeof svc.listSessions === 'function') {
      const listed = svc.listSessions();
      knownSessions = Array.isArray(listed?.sessions) ? listed.sessions.length
        : (Array.isArray(listed) ? listed.length : null);
    }
    return {
      ...base,
      knownSessions,
      recommendation: knownSessions
        ? 'Granska senaste replay-resultat innan en ny replay planeras manuellt.'
        : 'Ingen replayhistorik ännu. Samla mer paper/batch-data först.',
    };
  } catch (_) {
    return { ...base, knownSessions: null, recommendation: 'Replaydata kunde inte läsas (read-only).' };
  }
}

function runOnce({ now = Date.now(), trigger = 'manual', replayService = null } = {}) {
  const gate = evaluateGate({ now });
  if (!gate.allowed) {
    const state = readState() || {};
    writeState({ ...state, lastBlockedReason: gate.blockedReason, lastBlockedAt: nowIso(now) });
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

  const plan = buildPlanPreview(replayService);
  const prev = readState();
  const { todayRunCount, day } = todayCounters(prev, now);
  writeState({
    lastRun: nowIso(now),
    lastRunDay: day,
    todayRunCount: todayRunCount + 1,
    lastReplayPlan: plan,
    lastReplayResult: prev?.lastReplayResult || null,
    lastBlockedReason: null,
    updatedAt: nowIso(now),
  });
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
