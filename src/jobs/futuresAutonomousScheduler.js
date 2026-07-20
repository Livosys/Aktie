'use strict';

/**
 * Futures Autonomous Scheduler — drives the EXISTING IBKR Paper execution
 * pipeline on an interval during CME market hours.
 *
 * This scheduler adds NO business logic. Each tick calls two already-gated
 * production entrypoints, in sequence:
 *
 *   1) futuresPaperScannerService.runScannerOnce()               (producer, SYNC)
 *        IBKR CME data -> scanner -> candidate queue (+ execution-target
 *        reservation + scanner dedup). Fully synchronous, so it always
 *        completes and persists candidates.json BEFORE the consumer runs.
 *
 *   2) orchestrator.buildShadowExecution({ actualSubmit: true })  (consumer, ASYNC)
 *        candidate -> approval -> entry contract -> broker risk -> execution
 *        guard -> execution-target reservation -> intent idempotency ->
 *        adapter.submitPaperOrder() -> IBKR placeOrder.
 *
 * ALL trading decisions, safety gates, dedup and idempotency stay in the
 * existing services. This scheduler CANNOT bypass any of them:
 *   - Approval / entry-contract / broker-risk / 24-check execution guard
 *   - Execution-target reservation (candidate-level atomic lock)
 *   - Intent idempotency (order-level atomic lock)
 *   - Kill switch, paper-only, shadow-mode and submission flags
 *
 * The retired FAS5/FAS6 internal simulator is NOT used and NOT started. The
 * scheduler only ever produces candidates for the IBKR Paper adapter.
 *
 * Safety:
 *   - OFF by default (ENABLE_FUTURES_AUTONOMOUS_SCHEDULER=false).
 *   - unref'd timers (never keep the process alive on their own).
 *   - single-flight: overlapping ticks are ignored (one cycle at a time).
 *   - per-tick readiness gate; if any condition fails the cycle is skipped
 *     WITHOUT side effects (no scan, no submit).
 */

const scannerService = require('../services/futuresPaperScannerService');
const orchestratorService = require('../services/ibPaperExecutionOrchestratorService');
const configService = require('../services/ibPaperExecutionConfigService');
const marketHours = require('../services/futuresMarketHoursService');

const scanner = scannerService.defaultFuturesPaperScannerService;
const orchestrator = orchestratorService.defaultIbPaperExecutionOrchestratorService;

const LOG_PREFIX = '[FuturesAutonomousScheduler]';

// Paper-only invariants echoed on every tick result, mirroring the other
// schedulers' safety posture.
const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  paperOnly: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  can_place_orders: false, // this scheduler never places orders itself; the adapter does, behind the guard
  source: 'futures_autonomous_scheduler',
});

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

function isEnabled() {
  return envBool('ENABLE_FUTURES_AUTONOMOUS_SCHEDULER', false);
}

function intervalMs() {
  // Floor at 30s to prevent runaway scheduling.
  return Math.max(30, envInt('FUTURES_AUTONOMOUS_INTERVAL_SECONDS', 60)) * 1000;
}

function startupDelayMs() {
  const n = envInt('FUTURES_AUTONOMOUS_STARTUP_DELAY_SECONDS', 20);
  return Math.max(1, Math.min(3600, n)) * 1000;
}

let intervalTimer = null;
let startupTimer = null;
let running = false; // single-flight guard — one cycle at a time
let prevPositionKeys = new Set(); // for POSITION_OPENED / POSITION_CLOSED diffing
const loggedFills = new Set(); // dedup for ORDER_FILLED logs

function logEvent(event, detail = {}) {
  // One structured JSON line per event so future debugging is trivial to grep.
  try {
    console.log(`${LOG_PREFIX} ${event} ${JSON.stringify({ event, at: new Date().toISOString(), ...detail })}`);
  } catch (_) {
    console.log(`${LOG_PREFIX} ${event}`);
  }
}

// Read-only readiness gate built entirely from the EXISTING execution status
// and config. Returns { ready, skipEvent, detail, session } — never mutates.
async function evaluateReadiness(now) {
  const flags = configService.getFlags();
  const killSwitch = configService.readKillSwitch();
  const session = marketHours.getCmeEquityIndexFuturesSessionState(now);
  const status = await orchestrator.buildExecutionStatus();

  // (1) Execution runtime READY  (7) runtime healthy
  if (status.runtimeState !== 'READY') {
    return { ready: false, skipEvent: 'RUNTIME_NOT_READY', detail: { runtimeState: status.runtimeState || null }, session, status };
  }
  // (2) IB gateway connected
  if (status.executionConnected !== true || status.nextValidIdReady !== true) {
    return { ready: false, skipEvent: 'IB_DISCONNECTED', detail: { executionConnected: status.executionConnected === true, nextValidIdReady: status.nextValidIdReady === true }, session, status };
  }
  // (3) Paper account verified + live account blocked
  if (status.paperAccountVerified !== true || status.liveAccountDetected === true) {
    return { ready: false, skipEvent: 'RUNTIME_NOT_READY', detail: { reason: 'paper_account_not_verified', paperAccountVerified: status.paperAccountVerified === true, liveAccountDetected: status.liveAccountDetected === true }, session, status };
  }
  // (4) CME session open
  if (session.isMarketOpen !== true || session.closedReason != null) {
    return { ready: false, skipEvent: 'MARKET_CLOSED', detail: { sessionId: session.sessionId || null, closedReason: session.closedReason || null }, session, status };
  }
  // (5) Kill switch off
  if (killSwitch.pauseNewEntries === true) {
    return { ready: false, skipEvent: 'KILL_SWITCH_ACTIVE', detail: { reason: killSwitch.reason || null }, session, status };
  }
  // (6) Submission flags valid — cannot submit while shadow mode is active or
  //     while execution/submission is disabled.
  if (flags.executionEnabled !== true) {
    return { ready: false, skipEvent: 'SUBMISSION_DISABLED', detail: { reason: 'ibkr_paper_execution_disabled', orderSubmissionMode: flags.orderSubmissionMode }, session, status };
  }
  if (flags.shadowMode === true) {
    return { ready: false, skipEvent: 'SHADOW_MODE_ACTIVE', detail: { orderSubmissionMode: flags.orderSubmissionMode }, session, status };
  }
  if (flags.submissionEnabled !== true) {
    return { ready: false, skipEvent: 'SUBMISSION_DISABLED', detail: { reason: 'order_submission_disabled', orderSubmissionMode: flags.orderSubmissionMode }, session, status };
  }

  return { ready: true, skipEvent: null, detail: { sessionId: session.sessionId, orderSubmissionMode: flags.orderSubmissionMode }, session, status };
}

// Observability only: derive fill/position lifecycle from the broker snapshot
// the pipeline already returns. Tolerant of shape; never throws, never decides.
function observeLifecycle(status) {
  try {
    const fills = Array.isArray(status?.brokerFills) ? status.brokerFills : [];
    for (const f of fills) {
      const id = String(f?.execId || f?.executionId || f?.permId || f?.orderId || '');
      if (!id || loggedFills.has(id)) continue;
      loggedFills.add(id);
      logEvent('ORDER_FILLED', { execId: id, symbol: f?.symbol || f?.localSymbol || null, side: f?.side || null, shares: f?.shares ?? f?.qty ?? null, price: f?.price ?? f?.avgPrice ?? null });
    }
    const positions = Array.isArray(status?.brokerPositions) ? status.brokerPositions : [];
    const curKeys = new Set();
    for (const p of positions) {
      const qty = Number(p?.position ?? p?.qty ?? p?.quantity ?? 0);
      if (!qty) continue;
      const key = String(p?.localSymbol || p?.symbol || p?.conId || '');
      if (!key) continue;
      curKeys.add(key);
      if (!prevPositionKeys.has(key)) {
        logEvent('POSITION_OPENED', { symbol: key, position: qty, avgCost: p?.avgCost ?? p?.averageCost ?? null });
      }
    }
    for (const key of prevPositionKeys) {
      if (!curKeys.has(key)) logEvent('POSITION_CLOSED', { symbol: key });
    }
    prevPositionKeys = curKeys;
  } catch (err) {
    logEvent('LIFECYCLE_OBSERVE_ERROR', { error: err && err.message ? err.message : String(err) });
  }
}

// One scheduler cycle. Single-flight: overlapping ticks are ignored. Producer
// (sync) fully completes before the consumer (async) starts. Exported for tests.
async function tick() {
  if (running) {
    logEvent('TICK_SKIPPED', { skipReason: 'already_running' });
    return { ok: true, ran: false, skipped: true, skipReason: 'already_running', submitted: false, ...SAFETY };
  }
  running = true; // set BEFORE any await so a synchronously-launched overlapping tick is ignored
  const startedAtMs = Date.now();
  logEvent('TICK_STARTED', {});
  try {
    const now = new Date();

    // Readiness gate — skip WITHOUT side effects if anything fails.
    const readiness = await evaluateReadiness(now);
    if (!readiness.ready) {
      logEvent(readiness.skipEvent, readiness.detail);
      logEvent('TICK_FINISHED', { skipped: true, skipReason: readiness.skipEvent, durationMs: Date.now() - startedAtMs });
      return { ok: true, ran: false, skipped: true, skipReason: readiness.skipEvent, submitted: false, ...SAFETY };
    }

    // (3) PRODUCER — synchronous; completes and persists the queue before we await the consumer.
    const scan = scanner.runScannerOnce({ now });
    const candidatesCreated = Number(scan?.scan?.candidatesCreated ?? scan?.candidatesCreated ?? 0);

    // (5) CONSUMER — drives the existing approval/risk/guard/reservation/intent/adapter chain.
    const result = await orchestrator.buildShadowExecution({ actualSubmit: true, now });

    // Interpret the consumer's own return values (no re-derivation of its logic).
    const blockedReason = result?.blockedReason || null;
    const submitted = result?.submitResult?.submitted === true;

    if (!result?.candidate || blockedReason === 'no_strategy_candidate' || result?.status === 'READY_WAITING_FOR_SIGNAL') {
      logEvent('NO_CANDIDATE', { candidatesCreated });
    } else if (submitted) {
      logEvent('ORDER_SUBMITTED', {
        strategyId: result?.candidate?.strategyId || null,
        root: result?.candidate?.root || null,
        parentOrderId: result?.submitResult?.parentOrderId ?? null,
        orderRef: result?.normalizedOrder?.orderRef || null,
        idempotencyKey: result?.intent?.idempotencyKey || null,
      });
    } else if (result?.submitResult && result?.submitResult?.submitted !== true) {
      logEvent('ORDER_REJECTED', { blocker: result?.submitResult?.blocker || blockedReason || null });
    } else {
      logEvent('GUARD_BLOCKED', { blockedReason, blockers: Array.isArray(result?.blockers) ? result.blockers : [] });
    }

    // Observe fill/position lifecycle from the fresh broker snapshot.
    observeLifecycle(await orchestrator.buildExecutionStatus({ force: true }));

    logEvent('TICK_FINISHED', { skipped: false, candidatesCreated, submitted, blockedReason, durationMs: Date.now() - startedAtMs });
    return { ok: true, ran: true, skipped: false, submitted, blockedReason, candidatesCreated, ...SAFETY };
  } catch (err) {
    logEvent('TICK_ERROR', { error: err && err.message ? err.message : String(err) });
    logEvent('TICK_FINISHED', { skipped: false, error: true, durationMs: Date.now() - startedAtMs });
    return { ok: false, ran: true, skipped: false, submitted: false, error: err && err.message ? err.message : String(err), ...SAFETY };
  } finally {
    running = false;
  }
}

function startFuturesAutonomousScheduler() {
  if (!isEnabled()) {
    console.log(`${LOG_PREFIX} Disabled (ENABLE_FUTURES_AUTONOMOUS_SCHEDULER != true) — not starting`);
    return null;
  }
  if (intervalTimer || startupTimer) return startupTimer || intervalTimer; // already active
  const ms = intervalMs();
  logEvent('SCHEDULER_STARTED', { intervalSeconds: ms / 1000, startupDelaySeconds: startupDelayMs() / 1000 });
  // First tick fires after a short startup delay so the runtime finishes warming up.
  startupTimer = setTimeout(() => {
    tick();
    intervalTimer = setInterval(tick, ms);
    if (intervalTimer.unref) intervalTimer.unref();
  }, startupDelayMs());
  if (startupTimer.unref) startupTimer.unref();
  return startupTimer;
}

function stopFuturesAutonomousScheduler() {
  if (startupTimer) clearTimeout(startupTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startupTimer = null;
  intervalTimer = null;
  logEvent('SCHEDULER_STOPPED', {});
}

module.exports = {
  SAFETY,
  startFuturesAutonomousScheduler,
  stopFuturesAutonomousScheduler,
  _internal: { tick, evaluateReadiness, isEnabled },
};
