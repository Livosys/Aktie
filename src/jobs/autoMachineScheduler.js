'use strict';
/**
 * Auto-Machine Scheduler
 *
 * Reads AUTO_MACHINE_* env vars and fires runAutoMachine() on a timer.
 * Only starts if AUTO_MACHINE_ENABLED=true.
 *
 * Safety guarantees:
 *   - Minimum interval floor: 5 minutes (prevents runaway scheduling)
 *   - Skips tick if pipeline is already running (no overlap)
 *   - DEFAULT: AUTO_MACHINE_ENABLED=false — must be explicitly opted in
 */

const { runAutoMachine, isRunning } = require('./autoMachine');

const ENABLED         = (process.env.AUTO_MACHINE_ENABLED || 'false').toLowerCase() === 'true';
const INTERVAL_MIN    = parseInt(process.env.AUTO_MACHINE_INTERVAL_MINUTES || '60', 10);
const LOOKBACK_DAYS   = parseInt(process.env.AUTO_MACHINE_LOOKBACK_DAYS    || '7',  10);
const GROUPS_RAW      = process.env.AUTO_MACHINE_GROUPS || 'stocks,crypto';
const GROUPS          = GROUPS_RAW.split(',').map((g) => g.trim()).filter(Boolean);

// Floor at 5 min to prevent accidental tight loops
const INTERVAL_MS = Math.max(INTERVAL_MIN, 5) * 60 * 1000;

let _timer      = null;
let _nextRunAt  = null; // ISO timestamp of next scheduled tick

async function tick() {
  // Advance next-run estimate immediately so the UI always shows a fresh estimate
  _nextRunAt = new Date(Date.now() + INTERVAL_MS).toISOString();

  if (isRunning()) {
    console.log('[AutoMachineScheduler] Tick skipped — pipeline already running');
    return;
  }
  console.log(`[AutoMachineScheduler] Scheduled tick — lookback=${LOOKBACK_DAYS}d groups=${GROUPS.join(',')}`);
  try {
    await runAutoMachine({ lookbackDays: LOOKBACK_DAYS, groups: GROUPS });
  } catch (err) {
    console.error('[AutoMachineScheduler] tick error:', err.message);
  }
}

function startAutoMachineScheduler() {
  if (!ENABLED) {
    console.log('[AutoMachineScheduler] Disabled (AUTO_MACHINE_ENABLED != true) — not starting');
    return;
  }
  if (_timer) return; // already active

  console.log(
    `[AutoMachineScheduler] Starting — interval=${INTERVAL_MIN}min lookback=${LOOKBACK_DAYS}d groups=${GROUPS.join(',')}`
  );

  // First tick fires after one full interval so the server finishes warming up first
  _nextRunAt = new Date(Date.now() + INTERVAL_MS).toISOString();
  _timer     = setInterval(tick, INTERVAL_MS);
}

function stopAutoMachineScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer     = null;
    _nextRunAt = null;
    console.log('[AutoMachineScheduler] Stopped');
  }
}

/**
 * Returns scheduler state — safe to call at any time.
 */
function getSchedulerStatus() {
  return {
    enabled:         ENABLED,
    schedulerActive: _timer !== null,
    intervalMinutes: INTERVAL_MIN,
    lookbackDays:    LOOKBACK_DAYS,
    groups:          GROUPS,
    nextRunEstimate: _nextRunAt,
    running:         isRunning(),
  };
}

module.exports = { startAutoMachineScheduler, stopAutoMachineScheduler, getSchedulerStatus };
