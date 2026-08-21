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
 *        candidate -> broker risk -> execution guard -> execution-target
 *        reservation -> intent idempotency -> adapter.submitPaperOrder()
 *        -> IBKR placeOrder.
 *
 * ALL technical safety gates, dedup and idempotency stay in the existing
 * services. This scheduler CANNOT bypass any of them:
 *   - Broker-risk / execution guard
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
const libraryRecorderModule = require('../services/library/strategyLibraryRecorderService');

const scanner = scannerService.defaultFuturesPaperScannerService;
const orchestrator = orchestratorService.defaultIbPaperExecutionOrchestratorService;
const libraryRecorder = libraryRecorderModule.createStrategyLibraryRecorder();

const LOG_PREFIX = '[FuturesAutonomousScheduler]';

// Paper-only invariants echoed on every tick result, mirroring the other
// schedulers' safety posture.
const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  executionTarget: 'ibkr_paper',
  environment: 'paper',
  paperOnly: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  can_place_orders: false, // this scheduler never places orders itself; the adapter does, behind the guard
  source: 'futures_autonomous_scheduler',
});

const executionTarget = configService.getActiveExecutionTarget();
const environment = configService.getExpectedEnvironment(executionTarget);
const safety = {
  ...SAFETY,
  ...configService.buildExecutionSafety(executionTarget),
  can_place_orders: false, // this scheduler never places orders itself; the adapter does, behind the guard
  source: 'futures_autonomous_scheduler',
};

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
  const n = envInt('FUTURES_AUTONOMOUS_STARTUP_DELAY_SECONDS', 60);
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
    console.log(`${LOG_PREFIX} ${event} ${JSON.stringify({ event, at: new Date().toISOString(), executionTarget, environment, ...detail })}`);
  } catch (_) {
    console.log(`${LOG_PREFIX} ${event}`);
  }
}

// Read-only readiness gate built entirely from the EXISTING execution status
// and config. Returns { ready, skipEvent, detail, session } — never mutates.
async function evaluateReadiness(now) {
  const flags = configService.getFlags({ executionTarget });
  const killSwitch = configService.readKillSwitch();
  const session = marketHours.getCmeEquityIndexFuturesSessionState(now);
  const status = await orchestrator.buildExecutionStatus();
  const targetAccountVerified = executionTarget === 'ibkr_live'
    ? status.liveAccountVerified === true
    : status.paperAccountVerified === true;
  const wrongAccountDetected = executionTarget === 'ibkr_live'
    ? status.paperAccountDetected === true
    : status.liveAccountDetected === true;

  // (1) Execution runtime READY  (7) runtime healthy
  if (status.runtimeState !== 'READY') {
    return { ready: false, skipEvent: 'RUNTIME_NOT_READY', detail: { runtimeState: status.runtimeState || null }, session, status };
  }
  // (2) IB gateway connected
  if (status.executionConnected !== true || status.nextValidIdReady !== true) {
    return { ready: false, skipEvent: 'IB_DISCONNECTED', detail: { executionConnected: status.executionConnected === true, nextValidIdReady: status.nextValidIdReady === true }, session, status };
  }
  // (3) Target account verified + opposite account blocked.
  if (targetAccountVerified !== true || wrongAccountDetected === true) {
    return {
      ready: false,
      skipEvent: 'RUNTIME_NOT_READY',
      detail: {
        reason: executionTarget === 'ibkr_live' ? 'live_account_not_verified' : 'paper_account_not_verified',
        executionTarget,
        paperAccountVerified: status.paperAccountVerified === true,
        liveAccountVerified: status.liveAccountVerified === true,
        paperAccountDetected: status.paperAccountDetected === true,
        liveAccountDetected: status.liveAccountDetected === true,
      },
      session,
      status,
    };
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
    return {
      ready: false,
      skipEvent: 'SUBMISSION_DISABLED',
      detail: {
        reason: executionTarget === 'ibkr_live' ? 'ibkr_live_execution_disabled' : 'ibkr_paper_execution_disabled',
        executionTarget,
        orderSubmissionMode: flags.orderSubmissionMode,
      },
      session,
      status,
    };
  }
  if (flags.shadowMode === true) {
    return { ready: false, skipEvent: 'SHADOW_MODE_ACTIVE', detail: { orderSubmissionMode: flags.orderSubmissionMode }, session, status };
  }
  if (flags.submissionEnabled !== true) {
    return { ready: false, skipEvent: 'SUBMISSION_DISABLED', detail: { reason: 'order_submission_disabled', orderSubmissionMode: flags.orderSubmissionMode }, session, status };
  }

  return { ready: true, skipEvent: null, detail: { sessionId: session.sessionId, executionTarget, orderSubmissionMode: flags.orderSubmissionMode }, session, status };
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
    return { ok: true, ran: false, skipped: true, skipReason: 'already_running', submitted: false, ...safety };
  }
  running = true; // set BEFORE any await so a synchronously-launched overlapping tick is ignored
  const startedAtMs = Date.now();
  logEvent('TICK_STARTED', { executionTarget, environment });
  try {
    const now = new Date();

    // Readiness gate — skip WITHOUT side effects if anything fails.
    const readiness = await evaluateReadiness(now);
    if (!readiness.ready) {
      logEvent(readiness.skipEvent, readiness.detail);
      logEvent('TICK_FINISHED', { skipped: true, skipReason: readiness.skipEvent, durationMs: Date.now() - startedAtMs });
      return { ok: true, ran: false, skipped: true, skipReason: readiness.skipEvent, submitted: false, ...safety };
    }

    // (3) PRODUCER — synchronous; completes and persists the queue before we await the consumer.
    const scan = scanner.runScannerOnce({ now });
    const candidatesCreated = Number(scan?.scan?.candidatesCreated ?? scan?.candidatesCreated ?? 0);

    // (4-5) CLAIM/CONSUME — behandla så många kandidater per tick som taket
    // tillåter, sekventiellt.
    //
    // Taket satt tidigare i Math.min(2, ...), en kvarleva från när paper bar
    // högst en position per rot. Med ett tak på tio betydde det att tio aldrig
    // kunde nås: högst två inskickningar per tick, och scannern tickar var
    // annan minut.
    //
    // Gränsen är nu taket självt. Det är säkert därför att varje kandidat ändå
    // går genom Broker Risk i buildShadowExecution — exponeringen kontrolleras
    // där, per order, mot verklig kontraktsräkning. Loopen avgör bara hur många
    // gånger frågan hinner ställas.
    const tickLimit = Math.max(1, Number(configService.getPilotLimits({ executionTarget }).maxOpenPositions) || 1);
    const submissions = [];
    const processedRoots = new Set();
    let claimedCandidate = null;
    let result = null;
    for (let attempt = 0; attempt < tickLimit; attempt += 1) {
      const claim = scanner.claimCandidateForIbkrPaper({ now, claimedBy: 'futures_autonomous_scheduler' });
      const candidate = claim?.candidate || null;
      if (!candidate) break;
      claimedCandidate = candidate;
      let candidateResult = null;
      let executionError = null;
      const candidateRoot = String(candidate.root || candidate.symbol || candidate.futuresSymbol || '').toUpperCase();
      // Roten spärrades tidigare efter första kandidaten i ticken, med
      // blockeraren same_symbol_pending_paper_entry. Den grinden finns inte
      // längre i Broker Risk, och att behålla en kopia av den här hade betytt
      // att schemaläggaren tillämpade en regel som riskmodellen inte längre
      // känner till — precis den sortens tyst dubblering som gör att ett system
      // rapporterar en gräns och tillämpar en annan.
      //
      // Roten bokförs fortfarande, för att svaret ska kunna visa hur ticken
      // fördelade sig.
      processedRoots.add(candidateRoot);
      try {
        if (!candidateResult) {
          candidateResult = await orchestrator.buildShadowExecution({ candidate, actualSubmit: true, now });
        }
      } catch (err) {
        executionError = err;
        candidateResult = { ok: false, status: 'ERROR', blockedReason: 'orchestrator_error', error: err && err.message ? err.message : String(err) };
      } finally {
        scanner.completeClaimedCandidate({
          candidateId: candidate.candidateId || null,
          candidate,
          now,
          completedBy: 'futures_autonomous_scheduler',
          outcome: executionError ? 'error' : (candidateResult?.submitResult?.submitted === true ? 'submitted' : (candidateResult?.blockedReason || candidateResult?.status || 'completed')),
          details: {
            resultStatus: candidateResult?.status || null,
            blockedReason: candidateResult?.blockedReason || null,
            submitted: candidateResult?.submitResult?.submitted === true,
          },
        });
      }
      result = candidateResult;
      submissions.push({
        strategyId: candidate.strategyId || null,
        canonicalStrategyId: candidate.canonicalStrategyId || candidate.strategyId || null,
        root: candidate.root || candidate.symbol || null,
        candidateId: candidate.candidateId || null,
        submitted: candidateResult?.submitResult?.submitted === true,
        blockedReason: candidateResult?.blockedReason || null,
      });
      if (candidateResult?.submitResult?.submitted === true) {
        logEvent('ORDER_SUBMITTED', {
          executionTarget,
          strategyId: candidate.strategyId || null,
          root: candidate.root || null,
          parentOrderId: candidateResult?.submitResult?.parentOrderId ?? null,
          orderRef: candidateResult?.normalizedOrder?.orderRef || null,
          idempotencyKey: candidateResult?.intent?.idempotencyKey || null,
        });
      } else {
        logEvent('ORDER_REJECTED', { blocker: candidateResult?.submitResult?.blocker || candidateResult?.blockedReason || null });
      }
    }

    // Interpret the consumer's own return values (no re-derivation of its logic).
    const blockedReason = result?.blockedReason || null;
    const submitted = result?.submitResult?.submitted === true;

    if (!submissions.length || blockedReason === 'no_strategy_candidate' || result?.status === 'READY_WAITING_FOR_SIGNAL') {
      logEvent('NO_CANDIDATE', { candidatesCreated });
    }

    // Observe fill/position lifecycle from the fresh broker snapshot.
    observeLifecycle(await orchestrator.buildExecutionStatus({ force: true }));
    // Closed paper trades are folded into Strategy Library idempotently. This
    // is a read-from-ledger sync, not a new execution path or a live write.
    const paperLearning = libraryRecorder.ingestExecutionHistory({ target: 'paper', at: now.toISOString() });

    logEvent('TICK_FINISHED', { skipped: false, candidatesCreated, submitted, submissions, blockedReason, paperLearning, durationMs: Date.now() - startedAtMs });
    return { ok: true, ran: true, skipped: false, submitted, submittedCount: submissions.filter((row) => row.submitted).length, submissions, blockedReason, candidatesCreated, paperLearning, ...safety };
  } catch (err) {
    logEvent('TICK_ERROR', { error: err && err.message ? err.message : String(err) });
    logEvent('TICK_FINISHED', { skipped: false, error: true, durationMs: Date.now() - startedAtMs });
    return { ok: false, ran: true, skipped: false, submitted: false, error: err && err.message ? err.message : String(err), ...safety };
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
