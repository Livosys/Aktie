'use strict';

// ── AI Optimizer ────────────────────────────────────────────────────────────
//
// Optimeraren skapar DNA-förslag. Den kör ingenting, köar ingenting och väljer
// ingen vinnare.
//
// Gränsen är avsiktlig:
//
//   Strategy Library  säger vad som hänt
//   AI Memory         säger vad som redan är prövat
//   AI Optimizer      föreslår DNA-kandidater
//   Evolution Engine  äger mutation och lineage
//   Replay Scheduler  väljer experiment
//   Replay Queue      exekverar jobb
//   Replay Engine     är helt okänd här

const optimizerInterface = require('./aiOptimizerInterface');
const aiMemoryModule = require('../memory/aiMemoryService');
const strategyDna = require('../dna/strategyDnaService');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'ai_optimizer',
});

const OPTIMIZER_VERSION = 'ai-optimizer-v1';
const DEFAULT_MAX_CANDIDATES = 6;

const PARAMETER_RULES = Object.freeze({
  'risk.stopLossPct': { down: 'risk_tighten', up: 'risk_loosen', stepPct: 0.1, min: 0.01 },
  'risk.minStopDistancePoints': { down: 'risk_tighten', up: 'risk_loosen', stepPct: 0.1, min: 0.25 },
  'exit.takeProfitR': { down: 'exit_shorten', up: 'exit_extend', stepPct: 0.1, min: 0.1 },
  'exit.rewardMultiple': { down: 'exit_shorten', up: 'exit_extend', stepPct: 0.1, min: 0.1 },
  'entry.minBodyPoints': { down: 'entry_relax', up: 'entry_stricten', stepPct: 0.1, min: 0.25 },
  'entry.minBodyToRangeRatio': { down: 'entry_relax', up: 'entry_stricten', stepPct: 0.1, min: 0.01 },
});

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function round(value, decimals = 6) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function evidenceFromLibrary(record = null) {
  if (!record || typeof record !== 'object') {
    return {
      source: 'strategy_library',
      available: false,
    };
  }
  return {
    source: 'strategy_library',
    available: true,
    strategyScore: record.strategyScore ?? null,
    confidenceScore: record.confidenceScore ?? null,
    executionScore: record.executionScore ?? null,
    productionScore: record.productionScore ?? null,
    replayRuns: Array.isArray(record.replayHistory) ? record.replayHistory.length : null,
    replayTrades: Array.isArray(record.replayHistory)
      ? record.replayHistory.reduce((total, row) => total + (Number(row.trades) || 0), 0)
      : null,
    paperTrades: Array.isArray(record.paperHistory) ? record.paperHistory.length : null,
    liveTrades: Array.isArray(record.liveHistory) ? record.liveHistory.length : null,
  };
}

function requireMemory(memory) {
  const missing = ['lookupOrPlan', 'experimentsForDna'].filter((method) => typeof memory?.[method] !== 'function');
  if (missing.length) return { ok: false, reason: `ai_optimizer_memory_method_required:${missing.join(',')}` };
  return { ok: true };
}

function normalizeContext(context = {}) {
  const marketDnaHash = text(context.marketDnaHash || context.market?.dnaHash);
  if (!marketDnaHash) return { ok: false, reason: 'market_dna_required' };

  const replayMode = text(context.replayMode) || 'strategy';
  const executionModel = text(context.executionModel) || 'simulated_fill';
  const strategyVersion = text(context.strategyVersion) || 'unknown';

  // ── Timeframe in i kontexten ──────────────────────────────────────────────
  //
  // Fälten vitlistades tidigare bort här, vilket gjorde genomsläppet i
  // experimentSpecFor till död kod: optimeraren kunde aldrig producera en
  // v2-identitet hur anroparen än fyllde kontexten.
  //
  // executedTimeframe måste komma från den replay-konfiguration som FAKTISKT
  // kommer att köra experimentet — replaySchedulerService.resolveJobTimeframe
  // är den enda definitionen. Saknas den blir specen v1, och det är rätt: en
  // påhittad timeframe hade gett experimentet en identitet det inte har.
  const executedTimeframe = text(context.executedTimeframe);
  const declaredTimeframe = text(context.declaredTimeframe);

  return {
    ok: true,
    marketDnaHash,
    replayMode,
    executionModel,
    strategyVersion,
    executedTimeframe,
    // 'none' är ett svar: strategin deklarerar ingen timeframe. Det skiljs från
    // null, som betyder att ingen frågade.
    declaredTimeframe: executedTimeframe ? (declaredTimeframe || 'none') : declaredTimeframe,
    period: context.period || null,
    symbols: Array.isArray(context.symbols) ? [...context.symbols].sort() : [],
    requestedBy: text(context.requestedBy) || 'optimizer',
    regimeKeys: Array.isArray(context.regimeKeys) ? [...new Set(context.regimeKeys.map(text).filter(Boolean))].sort() : [],
    marketClassification: text(context.marketClassification),
  };
}

// Timeframe följer med NÄR anroparen har den. Utan den blir specen en
// v1-identitet, precis som förut — men då kan den heller inte träffa ett
// v2-experiment, och den som vill ha dubblettskydd över timeframe måste lämna
// uppgiften. Se aiMemoryService: versionen härleds ur specen.
function experimentSpecFor(dna, context) {
  return {
    strategyDnaHash: dna.dnaHash,
    parameterHash: dna.parameterHash,
    marketDnaHash: context.marketDnaHash,
    replayMode: context.replayMode,
    executionModel: context.executionModel,
    ...(context.executedTimeframe ? {
      declaredTimeframe: context.declaredTimeframe || 'none',
      executedTimeframe: context.executedTimeframe,
    } : {}),
    strategyVersion: dna.strategyVersion || context.strategyVersion,
    period: context.period,
    symbols: context.symbols,
    requestedBy: context.requestedBy,
    regimeKeys: context.regimeKeys,
    marketClassification: context.marketClassification,
  };
}

function valuePair(path_, value) {
  const rule = PARAMETER_RULES[path_];
  if (!rule || !Number.isFinite(Number(value))) return [];
  const numeric = Number(value);
  const step = Math.max(Math.abs(numeric) * rule.stepPct, rule.min);
  const down = round(Math.max(rule.min, numeric - step));
  const up = round(numeric + step);
  return [
    { path: path_, value: down, mutationType: rule.down, direction: 'down' },
    { path: path_, value: up, mutationType: rule.up, direction: 'up' },
  ].filter((row) => row.value !== numeric);
}

// ── Vilken parameter är värd att pröva? ──────────────────────────────────────
//
// Ordningen var bokstavsordning, och `.slice(0, maxCandidates)` skar sedan
// listan. Med maxCandidates 1 — vilket är fabrikens standard — betydde det att
// varje mutation i systemets historia rörde samma parameter i samma riktning:
// `exit.takeProfitR` nedåt, eftersom "exit" sorteras före "risk". Resten av
// parameterrymden hade aldrig prövats av någon.
//
// Nu sorteras planerna efter hur lite som redan är känt om parametern. Antalet
// gånger en väg redan muterats i släktträdet skickas in av Evolution Engine,
// som äger trädet — optimeraren får ett faktum, inte en ny beroendekedja.
// Bokstavsordningen finns kvar som sista nyckel så att resultatet förblir
// deterministiskt.
function buildChangePlans(parentDna, { maxCandidates = DEFAULT_MAX_CANDIDATES, exploredPaths = {} } = {}) {
  const parameters = strategyDna.parametersOf(parentDna.genome);
  const plans = [];
  for (const path_ of Object.keys(parameters).sort()) {
    if (path_ === 'risk.tickSize') continue;
    for (const row of valuePair(path_, parameters[path_])) {
      plans.push({
        changes: { [row.path]: row.value },
        mutationType: row.mutationType,
        direction: row.direction,
        path: row.path,
        from: parameters[path_],
        to: row.value,
        // Hur många gånger den här parametern redan muterats i den här grenen.
        explored: Math.max(0, Number(exploredPaths[row.path]) || 0),
      });
    }
  }
  plans.sort((a, b) => a.explored - b.explored
    || String(a.path).localeCompare(String(b.path))
    || String(a.direction).localeCompare(String(b.direction)));
  return plans.slice(0, Math.max(0, Number(maxCandidates) || DEFAULT_MAX_CANDIDATES));
}

function candidateRationale(plan, { target, evidence }) {
  const score = evidence.available ? evidence[target] : null;
  return [
    `Muterar ${plan.path} ${plan.direction === 'up' ? 'upp' : 'ned'} från ${plan.from} till ${plan.to}.`,
    `Målet är ${target}; senaste värde i Strategy Library är ${score ?? 'okänt'}.`,
    'Kandidaten är ett DNA-förslag. Replay Scheduler avgör om experimentet ska köras.',
  ].join(' ');
}

function createAiOptimizer(options = {}) {
  const memory = options.memory || aiMemoryModule.defaultAiMemory;
  const dnaService = options.dnaService || strategyDna;

  function propose({
    parentDna,
    context = {},
    target = 'strategyScore',
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    libraryRecord = null,
    // Hur många gånger varje parameterväg redan muterats. Skickas in av
    // Evolution Engine, som äger släktträdet; optimeraren slår aldrig upp det
    // själv och behåller därmed sin okunskap om lineage.
    exploredPaths = {},
  } = {}) {
    if (!parentDna?.dnaHash || !parentDna?.genome) {
      return { ok: false, reason: 'parent_dna_required', ...SAFETY };
    }

    const memoryCheck = requireMemory(memory);
    if (!memoryCheck.ok) return { ok: false, reason: memoryCheck.reason, ...SAFETY };

    const targetCheck = optimizerInterface.validateTarget(target);
    if (!targetCheck.ok) {
      return { ok: false, reason: targetCheck.errors[0], errors: targetCheck.errors, ...SAFETY };
    }

    const normalizedContext = normalizeContext({
      ...context,
      strategyVersion: context.strategyVersion || parentDna.strategyVersion,
    });
    if (!normalizedContext.ok) return { ok: false, reason: normalizedContext.reason, ...SAFETY };

    // Minnet frågas innan något kandidat-DNA byggs. Den här läsningen väljer
    // ingenting; den gör det bara omöjligt att optimera utan minneskontakt.
    const parentMemory = memory.experimentsForDna(parentDna.dnaHash);
    const evidence = evidenceFromLibrary(libraryRecord);
    const plans = buildChangePlans(parentDna, { maxCandidates, exploredPaths });
    const proposals = [];
    const seenExperimentKeys = new Set();

    for (const plan of plans) {
      const mutation = dnaService.mutateStrategyDna(parentDna, plan.changes, {
        mutationType: plan.mutationType,
        branch: 'optimizer',
      });
      if (!mutation.ok) {
        proposals.push({
          status: 'rejected',
          parentDnaHash: parentDna.dnaHash,
          changes: plan.changes,
          mutationType: plan.mutationType,
          reason: mutation.reason,
          rejected: mutation.rejected || [],
          expectedTarget: target,
          ...SAFETY,
        });
        continue;
      }

      const spec = experimentSpecFor(mutation.dna, normalizedContext);
      const gate = optimizerInterface.gateThroughMemory(memory, spec);
      if (seenExperimentKeys.has(gate.experimentKey)) continue;
      seenExperimentKeys.add(gate.experimentKey);

      const proposal = {
        parentDnaHash: parentDna.dnaHash,
        changes: mutation.applied,
        mutationType: plan.mutationType,
        rationale: candidateRationale(plan, { target, evidence }),
        expectedTarget: target,
      };
      const validation = optimizerInterface.validateProposal(proposal);
      if (!validation.ok) {
        proposals.push({
          status: 'rejected',
          parentDnaHash: parentDna.dnaHash,
          changes: mutation.applied,
          mutationType: plan.mutationType,
          reason: 'invalid_optimizer_proposal',
          errors: validation.errors,
          expectedTarget: target,
          ...SAFETY,
        });
        continue;
      }

      if (gate.run === false) {
        const existingExperiment = typeof memory.findExperiment === 'function'
          ? memory.findExperiment(spec)
          : null;
        proposals.push({
          status: 'existing_experiment',
          cached: true,
          createsNewDna: false,
          parentDnaHash: parentDna.dnaHash,
          candidateDnaHash: mutation.dna.dnaHash,
          parameterHash: mutation.dna.parameterHash,
          changes: mutation.applied,
          mutationType: plan.mutationType,
          rationale: proposal.rationale,
          expectedTarget: target,
          libraryEvidence: evidence,
          experimentKey: gate.experimentKey,
          existingExperiment: existingExperiment || {
            experimentKey: gate.experimentKey,
            libraryRef: gate.libraryRef,
            lineage: gate.lineage,
            seenIn: gate.seenIn,
          },
          memoryGate: { run: false, reason: gate.reason },
          ...SAFETY,
        });
        continue;
      }

      proposals.push({
        status: 'new_dna_proposal',
        cached: false,
        createsNewDna: false,
        parentDnaHash: parentDna.dnaHash,
        dnaProposal: clone(mutation.dna),
        candidateDnaHash: mutation.dna.dnaHash,
        parameterHash: mutation.dna.parameterHash,
        changes: mutation.applied,
        rejected: mutation.rejected || [],
        mutationType: plan.mutationType,
        rationale: proposal.rationale,
        expectedTarget: target,
        libraryEvidence: evidence,
        experimentSpec: spec,
        memoryGate: { run: true, reason: gate.reason },
        ...SAFETY,
      });
    }

    return {
      ok: true,
      optimizerVersion: OPTIMIZER_VERSION,
      parentDnaHash: parentDna.dnaHash,
      target,
      candidates: proposals.length,
      proposals,
      parentMemoryExperiments: parentMemory.length,
      memoryAskedBeforeDna: true,
      schedulerSelectsExperiments: true,
      queueExecutesJobs: true,
      replayEngineKnown: false,
      winner: null,
      capabilities: {
        createsDnaProposals: true,
        asksMemoryBeforeDna: true,
        returnsExistingExperiment: true,
        createsMultipleCandidates: true,
        selectsWinner: false,
        runsReplay: false,
        enqueuesReplay: false,
        mutatesLineage: false,
        readsStrategyLibraryResultInput: true,
      },
      ...SAFETY,
    };
  }

  function describe() {
    return {
      ok: true,
      optimizerVersion: OPTIMIZER_VERSION,
      interface: {
        ...optimizerInterface.describeInterface(),
        implemented: true,
        implementation: OPTIMIZER_VERSION,
      },
      capabilities: {
        createsDnaProposals: true,
        asksMemoryBeforeDna: true,
        returnsExistingExperiment: true,
        createsMultipleCandidates: true,
        selectsWinner: false,
        runsReplay: false,
        enqueuesReplay: false,
        knowsReplayEngine: false,
        mutatesLineage: false,
      },
      memory: typeof memory.getStatus === 'function' ? memory.getStatus() : null,
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    OPTIMIZER_VERSION,
    propose,
    describe,
    buildExperimentSpec: experimentSpecFor,
    _internal: { buildChangePlans, normalizeContext, evidenceFromLibrary },
  };
}

module.exports = {
  SAFETY,
  OPTIMIZER_VERSION,
  DEFAULT_MAX_CANDIDATES,
  PARAMETER_RULES,
  createAiOptimizer,
  defaultAiOptimizerService: createAiOptimizer(),
};
