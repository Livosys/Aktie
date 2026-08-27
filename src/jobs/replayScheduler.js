'use strict';

/**
 * Replay Scheduler timer wrapper.
 *
 * The scheduler never executes replay. It only asks replaySchedulerService to
 * create append-only Replay Queue jobs. Replay execution is owned by the queue
 * runner and the existing Replay Engine.
 */

const service = require('../services/replaySchedulerService').defaultReplaySchedulerService;

function startupDelayMs() {
  const n = Number(process.env.REPLAY_SCHEDULER_STARTUP_DELAY_SECONDS || 30);
  return Math.max(1, Math.min(3600, Number.isFinite(n) ? n : 30)) * 1000;
}

let intervalTimer = null;
let startupTimer = null;

function tick() {
  try {
    const res = service.runOnce({ trigger: 'scheduler' });
    if (res.blocked) {
      console.log(`[ReplayScheduler] Skipped (${res.blockedReason}) — queue-only, no replay execution`);
    } else {
      const created = res.appended?.created || 0;
      const duplicates = res.appended?.duplicates || 0;
      console.log(`[ReplayScheduler] Queued ${created} replay jobs (${duplicates} duplicates) — no replay execution`);
    }
    return res;
  } catch (err) {
    console.log(`[ReplayScheduler] tick error: ${err && err.message ? err.message : err}`);
    return { ok: false, blocked: true, blockedReason: 'tick_error' };
  }
}

function startReplayScheduler() {
  const cfg = service.config();
  if (!cfg.enabled) {
    console.log('[ReplayScheduler] Disabled (ENABLE_REPLAY_SCHEDULER=false)');
    return null;
  }
  if (startupTimer || intervalTimer) return startupTimer || intervalTimer;
  const intervalMs = cfg.intervalMinutes * 60 * 1000;
  console.log(`[ReplayScheduler] Starting queue-only scheduler; interval=${cfg.intervalMinutes}min maxJobsPerRun=${cfg.maxJobsPerRun}`);
  startupTimer = setTimeout(() => {
    tick();
    intervalTimer = setInterval(tick, intervalMs);
    if (intervalTimer.unref) intervalTimer.unref();
  }, startupDelayMs());
  if (startupTimer.unref) startupTimer.unref();
  return startupTimer;
}

function stopReplayScheduler() {
  if (startupTimer) clearTimeout(startupTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startupTimer = null;
  intervalTimer = null;
}

module.exports = {
  startReplayScheduler,
  stopReplayScheduler,
  _internal: { tick },
};
