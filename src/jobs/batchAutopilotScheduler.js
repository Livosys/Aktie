'use strict';

/**
 * Batch Autopilot Scheduler — SAFE dry-run/plan trigger only.
 *
 * Thin timer wrapper around batchAutopilotService.runOnce(). All gating lives in
 * the service: it only ever produces a DRY-RUN plan preview, is capped by
 * max-per-day + cooldown, and NEVER executes a batch, places orders, enables a
 * broker or changes risk. This scheduler adds no new capability — it just calls
 * the already-gated runOnce on an interval when explicitly enabled via env.
 */

const service = require('../services/batchAutopilotService');

function startupDelayMs() {
  const n = Number(process.env.BATCH_AUTOPILOT_STARTUP_DELAY_SECONDS || 15);
  return Math.max(1, Math.min(3600, Number.isFinite(n) ? n : 15)) * 1000;
}

let intervalTimer = null;
let startupTimer = null;

// One scheduler tick. Delegates entirely to the gated service. Exported for tests.
function tick() {
  try {
    const res = service.runOnce({ trigger: 'scheduler' });
    if (res.blocked) {
      console.log(`[BatchAutopilotScheduler] Skipped (${res.blockedReason}) — paper_only, no execution`);
    } else if (res.planned) {
      console.log('[BatchAutopilotScheduler] Dry-run plan created — paper_only, no execution');
    }
    return res;
  } catch (err) {
    console.log(`[BatchAutopilotScheduler] tick error: ${err && err.message ? err.message : err}`);
    return { ok: false, blocked: true, blockedReason: 'tick_error' };
  }
}

function startBatchAutopilotScheduler() {
  const cfg = service.config();
  if (!cfg.enabled) {
    console.log('[BatchAutopilotScheduler] Disabled (ENABLE_BATCH_AUTOPILOT=false)');
    return null;
  }
  const intervalMs = cfg.intervalMinutes * 60 * 1000;
  console.log(`[BatchAutopilotScheduler] Starting dry-run/plan scheduler; interval=${cfg.intervalMinutes}min maxPerDay=${cfg.maxPerDay} dryRunOnly=${cfg.dryRunOnly}`);
  startupTimer = setTimeout(() => {
    tick();
    intervalTimer = setInterval(tick, intervalMs);
    if (intervalTimer.unref) intervalTimer.unref();
  }, startupDelayMs());
  if (startupTimer.unref) startupTimer.unref();
  return startupTimer;
}

function stopBatchAutopilotScheduler() {
  if (startupTimer) clearTimeout(startupTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startupTimer = null;
  intervalTimer = null;
}

module.exports = {
  startBatchAutopilotScheduler,
  stopBatchAutopilotScheduler,
  _internal: { tick },
};
