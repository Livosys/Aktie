'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const internalSimulationRetirement = require('./futuresInternalSimulationRetirementService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_paper_execution_target_reservation',
});

const VALID_TARGETS = Object.freeze(['ibkr_paper']);
const DEFAULT_DIR = path.resolve(__dirname, '../../data/futures-paper/execution-target-reservations');

// Reservations are a candidate-level, write-once dedup lock. The candidate they
// guard is pruned by the scanner at ~120s, and no runtime path ever reads an old
// reservation back for a decision (dedup/idempotency live in the scanner queue
// and the persistent intent store). Left alone the per-tick files accumulate
// without bound under 24/7 operation, so we opportunistically garbage-collect
// files older than a generous TTL — far beyond any live candidate or in-flight
// order window. Env-overridable; floored well above the candidate lifetime.
function reservationTtlMs() {
  const minutes = Number(process.env.FUTURES_RESERVATION_TTL_MINUTES);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 120;
  return Math.max(5, safe) * 60 * 1000; // never below 5 min
}
// Throttle the readdir so the sweep never runs on the hot path more than needed.
const SWEEP_THROTTLE_MS = 5 * 60 * 1000;

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeString(value) {
  return value == null ? '' : String(value).trim();
}

function reservationFileName(candidateId) {
  return `${crypto.createHash('sha256').update(String(candidateId || '')).digest('hex').slice(0, 40)}.json`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function createFuturesPaperExecutionTargetReservationService(options = {}) {
  const dir = options.dir || DEFAULT_DIR;
  let lastSweepAtMs = 0;

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Remove reservation files whose most recent timestamp is older than maxAgeMs.
  // Pure garbage collection: it only ever deletes files that no runtime path can
  // still reference. Fully guarded — a failure here must never affect a reserve.
  function sweepStaleReservations({ maxAgeMs = reservationTtlMs(), now = new Date() } = {}) {
    let removed = 0;
    let scanned = 0;
    const cutoff = new Date(now).getTime() - maxAgeMs;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      return { ok: true, removed: 0, scanned: 0 };
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      scanned += 1;
      const file = path.join(dir, name);
      const record = readJson(file);
      // Corrupt/unreadable files are safe to drop only if old on disk.
      const stampIso = record ? (record.updatedAt || record.reservedAt) : null;
      let stampMs = stampIso ? Date.parse(stampIso) : NaN;
      if (!Number.isFinite(stampMs)) {
        try { stampMs = fs.statSync(file).mtimeMs; } catch (_) { continue; }
      }
      if (stampMs < cutoff) {
        try { fs.unlinkSync(file); removed += 1; } catch (_) { /* concurrent removal — ignore */ }
      }
    }
    return { ok: true, removed, scanned };
  }

  // Throttled, non-fatal opportunistic sweep for the reserve hot path.
  function maybeSweep(now = new Date()) {
    const t = new Date(now).getTime();
    if (t - lastSweepAtMs < SWEEP_THROTTLE_MS) return;
    lastSweepAtMs = t;
    try { sweepStaleReservations({ now }); } catch (_) { /* never block a reservation */ }
  }

  function fileFor(candidateId) {
    return path.join(dir, reservationFileName(candidateId));
  }

  function getReservation(candidateId) {
    const id = safeString(candidateId);
    if (!id) return null;
    return readJson(fileFor(id));
  }

  function reserveExecutionTarget({
    lifecycleId = null,
    candidateId,
    signalId = null,
    intentId = null,
    executionId = null,
    idempotencyKey = null,
    executionTarget,
    strategyId = null,
    signalTimestamp = null,
    status = 'reserved',
    now = new Date(),
    metadata = {},
  } = {}) {
    const id = safeString(candidateId);
    const target = safeString(executionTarget);
    if (!id) return { ok: false, reserved: false, blocker: 'candidate_id_missing', ...SAFETY };
    if (target === 'internal_simulation') {
      return {
        ...internalSimulationRetirement.buildRetiredMutationResponse({ action: 'reserve_internal_simulation_execution_target' }),
        reserved: false,
        candidateId: id,
        executionTarget: target,
      };
    }
    if (!VALID_TARGETS.includes(target)) {
      return { ok: false, reserved: false, blocker: 'invalid_execution_target', candidateId: id, executionTarget: target || null, ...SAFETY };
    }
    ensureDir();
    maybeSweep(now); // opportunistic, throttled, non-fatal GC of stale reservations
    const file = fileFor(id);
    const record = {
      lifecycleId: safeString(lifecycleId) || null,
      candidateId: id,
      signalId: safeString(signalId) || null,
      intentId: safeString(intentId) || null,
      executionId: safeString(executionId) || null,
      idempotencyKey: safeString(idempotencyKey) || null,
      executionTarget: target,
      strategyId: safeString(strategyId) || null,
      signalTimestamp: safeString(signalTimestamp) || null,
      status: safeString(status) || 'reserved',
      reservedAt: nowIso(now),
      updatedAt: nowIso(now),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      ...SAFETY,
    };
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, reserved: true, record, ...SAFETY };
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        const existing = readJson(file);
        if (existing && existing.executionTarget === target) {
          return { ok: true, reserved: false, duplicate: true, record: existing, ...SAFETY };
        }
        return {
          ok: false,
          reserved: false,
          blocker: 'execution_target_already_reserved',
          existing: existing || null,
          candidateId: id,
          requestedExecutionTarget: target,
          ...SAFETY,
        };
      }
      return { ok: false, reserved: false, blocker: 'execution_target_reservation_failed', error: err.message, candidateId: id, ...SAFETY };
    }
  }

  function updateReservation(candidateId, patch = {}) {
    const id = safeString(candidateId);
    const current = getReservation(id);
    if (!current) return { ok: false, blocker: 'execution_target_reservation_missing', candidateId: id, ...SAFETY };
    const next = {
      ...current,
      ...patch,
      candidateId: current.candidateId,
      executionTarget: current.executionTarget,
      updatedAt: nowIso(patch.now || new Date()),
      ...SAFETY,
    };
    delete next.now;
    writeJsonAtomic(fileFor(id), next);
    return { ok: true, record: next, ...SAFETY };
  }

  function listReservations() {
    try {
      ensureDir();
      return fs.readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(dir, name)))
        .filter(Boolean)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    } catch (_) {
      return [];
    }
  }

  function resetForTests() {
    fs.rmSync(dir, { recursive: true, force: true });
    ensureDir();
  }

  return {
    SAFETY,
    VALID_TARGETS,
    dir,
    reserveExecutionTarget,
    updateReservation,
    getReservation,
    listReservations,
    sweepStaleReservations,
    resetForTests,
  };
}

const defaultFuturesPaperExecutionTargetReservationService = createFuturesPaperExecutionTargetReservationService();

module.exports = {
  SAFETY,
  VALID_TARGETS,
  createFuturesPaperExecutionTargetReservationService,
  defaultFuturesPaperExecutionTargetReservationService,
};
