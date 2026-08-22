'use strict';

/**
 * AI Factory tick.
 *
 * ── Vad den här filen gjorde förut ──────────────────────────────────────────
 *
 * Den bad replaySchedulerService skapa köjobb och gjorde ingenting mer. Kön
 * fylldes alltså — men ingen tömde den, och ingen av de moduler som skulle
 * använda resultatet blev någonsin anropad. Kön stod på noll händelser i drift,
 * och Strategy Library hade åtta poster skrivna av en engångskörning.
 *
 * ── Vad den gör nu ──────────────────────────────────────────────────────────
 *
 * Den kör AI Factory Orchestrators fulla cykel. Orchestratorn fanns redan,
 * fullt implementerad, med sex steg och en append-only-logg — men utan en enda
 * anropare utanför sina egna tester. Den här filen är den anroparen.
 *
 *   PLAN → SELECT_KNOWLEDGE_GAP → CREATE_DNA_GENERATION
 *        → SCHEDULE_REPLAY → EXECUTE_QUEUE → COMPLETE
 *
 * Ingen ny scheduler: samma fil, samma env-flagga, samma intervall och samma
 * uppstartsfördröjning som förut. Schemaläggningen ligger kvar där den låg —
 * den är numera steg fyra av sex i stället för hela arbetet.
 *
 * Replay körs fortfarande i en barnprocess (runNativeReplayWorker.js), så en
 * cykel blockerar aldrig serverns event-loop.
 */

const service = require('../services/replaySchedulerService').defaultReplaySchedulerService;
const orchestratorModule = require('../services/factory/aiFactoryOrchestratorService');

function startupDelayMs() {
  const n = Number(process.env.REPLAY_SCHEDULER_STARTUP_DELAY_SECONDS || 30);
  return Math.max(1, Math.min(3600, Number.isFinite(n) ? n : 30)) * 1000;
}

let intervalTimer = null;
let startupTimer = null;

// En cykel i taget. Intervallet är timmar och en cykel är sekunder, så det här
// ska aldrig slå till — men om en körning fastnar ska nästa tick vänta i
// stället för att starta en andra parallell cykel mot samma append-only-logg.
let inFlight = false;
let lastCycleStartAt = null;
const CYCLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max per cycle

// Nyckeln som gör varje cykel till en egen körning i orchestratorns logg.
// Samma nyckel återanvänds tills cykeln är klar: orchestratorn återupptar då
// från det senast lyckade steget i stället för att börja om.
let cycleKey = null;

async function tick({ orchestrator = orchestratorModule.defaultAiFactoryOrchestrator, now = () => new Date() } = {}) {
  const currentTime = new Date(now()).getTime();

  // Watchdog: detect stale cycles and force recovery
  if (inFlight && lastCycleStartAt && (currentTime - lastCycleStartAt) > CYCLE_TIMEOUT_MS) {
    console.log(`[FactoryTick] CRITICAL: Cycle stale for ${(currentTime - lastCycleStartAt) / 1000 / 60}min — forcing recovery`);
    inFlight = false; // Force reset to allow next cycle
    cycleKey = null;
  }

  if (inFlight) {
    const ageMin = lastCycleStartAt ? (currentTime - lastCycleStartAt) / 1000 / 60 : 0;
    console.log(`[FactoryTick] Skipped — cycle in flight for ${ageMin.toFixed(1)}min`);
    return { ok: true, skipped: true, reason: 'cycle_in_flight', ageMinutes: ageMin };
  }

  inFlight = true;
  lastCycleStartAt = currentTime;

  try {
    if (!cycleKey) cycleKey = new Date(now()).toISOString();

    // Timeout wrapper: force failure if cycle exceeds safe runtime
    const cyclePromise = orchestrator.runCycle({ cycleKey });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('cycle_timeout_exceeded')), CYCLE_TIMEOUT_MS)
    );
    const result = await Promise.race([cyclePromise, timeoutPromise]);

    const summary = result.state?.completed?.COMPLETE?.result?.summary || null;
    if (result.ok && result.complete) {
      cycleKey = null;
      console.log(
        `[FactoryTick] Cycle complete — dna=${summary?.dnaCreated ?? 0}`
        + ` jobs=${summary?.replayJobsCreated ?? 0}`
        + ` replay=${summary?.replayExecuted === true}`
        + ` gap=${summary?.knowledgeGap?.strategyId || 'none'}`,
      );
    } else if (!result.ok) {
      const failed = result.state?.failed || null;
      console.log(`[FactoryTick] Cycle halted at ${failed?.step || 'unknown'} (${failed?.error || 'unknown_error'}) — resumes next tick`);
    }
    return result;
  } catch (err) {
    console.log(`[FactoryTick] tick error: ${err && err.message ? err.message : err}`);
    return { ok: false, blocked: true, blockedReason: 'tick_error', error: err?.message };
  } finally {
    inFlight = false;
    lastCycleStartAt = null;
  }
}

function startReplayScheduler() {
  const cfg = service.config();
  if (!cfg.enabled) {
    console.log('[FactoryTick] Disabled (ENABLE_REPLAY_SCHEDULER=false)');
    return null;
  }
  if (startupTimer || intervalTimer) return startupTimer || intervalTimer;
  const intervalMs = cfg.intervalMinutes * 60 * 1000;
  console.log(`[FactoryTick] Starting AI Factory cycle; interval=${cfg.intervalMinutes}min`);
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
  cycleKey = null;
  inFlight = false;
}

module.exports = {
  startReplayScheduler,
  stopReplayScheduler,
  _internal: { tick, resetCycle: () => { cycleKey = null; inFlight = false; } },
};
