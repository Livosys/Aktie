'use strict';

// ── AI Factory Loop Status ───────────────────────────────────────────────────
//
// Ett läsbart svar på två frågor: vad gör AI:n just nu, och vad lärde den sig
// senast.
//
// Modulen RÄKNAR ingenting eget. Den läser orchestratorns revisionsspår,
// Direktörens beslut, AI Memory, Strategy Library, replay-kön och
// evidenspolicyn — och sätter ihop dem. Varje siffra har en ägare någon
// annanstans, och det är avsiktligt: ett statuslager som räknar om saker blir
// förr eller senare oense med det det beskriver, och då vet ingen vilken siffra
// som gäller.
//
// Frontend får därför aldrig räkna om policy, härleda loopstatus eller
// duplicera hjärnans logik. Den ritar det här svaret.
//
// Ren läsning: inga skrivningar, inga sidoeffekter, ingen orderväg.

const orchestratorModule = require('./aiFactoryOrchestratorService');
const memoryModule = require('../memory/aiMemoryService');
const libraryModule = require('../library/strategyLibraryService');
const policyModule = require('../research/researchEvidencePolicyService');
const queueModule = require('../replayQueueService');
const calendarModule = require('../../data/tradingDayCalendar');
const hypothesisModule = require('../research/researchHypothesisService');
const ledgerModule = require('../research/researchEvidenceLedgerService');
const improvementModule = require('./aiImprovementDecisionService');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'ai_factory_loop_status',
});

const STATUS_VERSION = 'ai-factory-loop-status-v1';

// ── De sju stegen ────────────────────────────────────────────────────────────
//
// Orchestratorn kör sex steg. De tre sista i den här listan — evidens,
// klassificering och nästa beslut — sker INUTI EXECUTE_QUEUE respektive hos
// Direktören, och de förtjänar egna rader eftersom de är vad cykeln finns för.
// Listan är en VY över befintliga steg, inte en andra körordning.
const LOOP_STEPS = Object.freeze([
  { id: 'KNOWLEDGE_GAP', label: 'Kunskapslucka', from: 'SELECT_KNOWLEDGE_GAP' },
  { id: 'DNA_GENERATION', label: 'DNA-generation', from: 'CREATE_DNA_GENERATION' },
  { id: 'REPLAY_SCHEDULED', label: 'Replay schemalagd', from: 'SCHEDULE_REPLAY' },
  { id: 'HISTORICAL_REPLAY', label: 'Historisk replay', from: 'EXECUTE_QUEUE' },
  { id: 'EVIDENCE_RECORDED', label: 'Evidens bokförd', from: 'EXECUTE_QUEUE' },
  { id: 'POLICY_CLASSIFICATION', label: 'Policyklassificering', from: 'EXECUTE_QUEUE' },
  { id: 'NEXT_DECISION', label: 'Nästa beslut', from: 'RUN_OUTCOME' },
]);

const STEP_STATUS = Object.freeze({
  DONE: 'done',
  SKIPPED: 'skipped',
  RUNNING: 'running',
  PENDING: 'pending',
  FAILED: 'failed',
});

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

/** Generationen cykeln arbetade i, om steget bär den. */
function generationOf(result) {
  const rows = Array.isArray(result?.created) ? result.created : [];
  for (const row of rows) {
    const value = Number(row?.node?.generation ?? row?.generation);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Genomen cykeln skapade — barnen.
 *
 * Bara de FAKTISKT nya. Ett genom som redan låg i trädet är inget barn den här
 * cykeln fick, och att visa det som ett hade gjort en cykel utan framsteg till
 * en cykel som såg produktiv ut.
 */
function childGenomesOf(result) {
  const rows = Array.isArray(result?.created) ? result.created : [];
  return rows
    .map((row) => ({
      dnaHash: text(row?.dna?.dnaHash || row?.proposal?.candidateDnaHash),
      generation: Number.isFinite(Number(row?.node?.generation)) ? Number(row.node.generation) : null,
      changes: row?.applied && typeof row.applied === 'object' ? row.applied : null,
    }))
    .filter((row) => row.dnaHash);
}

function safeCall(fn, fallback = null) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (_) {
    // Ett trasigt delsystem får aldrig ta ner hela statusvyn. Fältet blir null
    // och UI:t visar det som okänt — vilket är sant — i stället för att sidan
    // blir tom.
    return fallback;
  }
}

/** Senaste körningen ur orchestratorns revisionsspår. */
function latestRun(trail = []) {
  const byRun = new Map();
  for (const event of trail) {
    const runId = text(event.runId);
    if (!runId) continue;
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId).push(event);
  }
  if (!byRun.size) return null;
  const runs = [...byRun.entries()].sort((a, b) => {
    const aLast = a[1][a[1].length - 1]?.recordedAt || '';
    const bLast = b[1][b[1].length - 1]?.recordedAt || '';
    return String(bLast).localeCompare(String(aLast));
  });
  const [runId, events] = runs[0];
  const previous = runs[1] ? { runId: runs[1][0], events: runs[1][1] } : null;
  return { runId, events, previous };
}

function stepEventsOf(events = []) {
  const byStep = new Map();
  for (const event of events) {
    const step = text(event.step);
    if (!step) continue;
    if (!byStep.has(step)) byStep.set(step, []);
    byStep.get(step).push(event);
  }
  return byStep;
}

/** Kort, läsbar sammanfattning av vad steget faktiskt gjorde. */
function summarizeStep(id, result = {}) {
  if (!result || typeof result !== 'object') return null;
  if (result.skipped) return `hoppades över: ${text(result.reason) || 'okänt skäl'}`;
  switch (id) {
    case 'KNOWLEDGE_GAP': {
      const gap = result.nextReplay;
      if (!gap) return 'ingen kunskapslucka hittad';
      return `regim ${text(gap.targetRegime) || '-'}, informationsvinst ${num(gap.informationGain) ?? '-'}`;
    }
    case 'DNA_GENERATION': {
      const created = (result.created || []).length;
      const existing = (result.existingExperiments || []).length;
      // Genom som redan låg i släktträdet. Räknades tidigare som skapade, och
      // steget rapporterade då "1 nytt genom" för arvsmassa som inte var ny.
      const known = (result.alreadyInTree || []).length;
      if (!created && (existing || known)) {
        const parts = [];
        if (known) parts.push(`${known} genom fanns redan i släktträdet`);
        if (existing) parts.push(`${existing} redan känt experiment`);
        return `${parts.join(', ')} — inget nytt genom skapades`;
      }
      return `${created} nytt genom, ${known} fanns redan, ${existing} redan känt experiment`;
    }
    case 'REPLAY_SCHEDULED': {
      const appended = result.appended || {};
      if (num(appended.duplicates)) return 'jobbet fanns redan i kön';
      return `${num(appended.created) ?? 0} jobb köat`;
    }
    case 'HISTORICAL_REPLAY': {
      if (!result.executed) return 'ingen körning';
      const runId = text(result.replayRunId) || 'okänt id';
      const executed = Array.isArray(result.executedGenomes) ? result.executedGenomes : [];
      const requested = text(result.requestedGenome);
      // Bad jobbet om ett genom måste vyn säga om det FAKTISKT kördes. Ett
      // begärt genom som inte gick att ladda ger en körning om något annat.
      if (requested && !executed.some((id) => String(id).includes(requested))) {
        return `körd: ${runId} — men det begärda genomet ${requested} kördes INTE`;
      }
      if (executed.length) return `körd: ${runId} · genom ${executed.join(', ')}`;
      return `körd: ${runId}`;
    }
    case 'EVIDENCE_RECORDED':
      return result.memoryRecorded ? 'bokförd i Strategy Library och AI Memory' : 'ingen evidens bokförd';
    default:
      return null;
  }
}

// ── Varför Factory Director INTE anropas här ─────────────────────────────────
//
// Direktören persisterar inget beslut; getStatus, getDecision och
// getDirectorState räknar alla om hela fabriksbeslutet — mätt 13–15 sekunder,
// eftersom de kör hjärnan över hela biblioteket. En statusvy som kostar det
// blir inte en statusvy, den blir en till körning.
//
// Nästa åtgärd härleds i stället ur orchestratorns egna spår: vad den senaste
// cykeln valde och hur långt den kom. Det är samma fråga besvarad ur det som
// FAKTISKT hänt i stället för ur en ny beräkning — och det kostar två
// millisekunder.
function nextDecisionFrom({ run, steps }) {
  if (!run) return { summary: 'ingen körning bokförd ännu', strategyId: null, at: null, status: STEP_STATUS.PENDING };
  const gap = steps.find((row) => row.id === 'KNOWLEDGE_GAP');
  const replay = steps.find((row) => row.id === 'HISTORICAL_REPLAY');
  const last = run.events[run.events.length - 1];

  if (replay?.status === STEP_STATUS.DONE) {
    return {
      status: STEP_STATUS.DONE,
      strategyId: gap?.strategyId || null,
      at: text(last?.recordedAt),
      summary: 'cykeln stängde sin kunskapslucka — nästa cykel väljer ny',
    };
  }
  if (replay?.status === STEP_STATUS.SKIPPED) {
    return {
      status: STEP_STATUS.DONE,
      strategyId: gap?.strategyId || null,
      at: text(last?.recordedAt),
      summary: 'ingen ny körning behövdes — kön hade redan jobbet',
    };
  }
  return {
    status: STEP_STATUS.PENDING,
    strategyId: gap?.strategyId || null,
    at: text(last?.recordedAt),
    summary: 'cykeln är inte klar',
  };
}

function buildSteps({ run }) {
  const byStep = run ? stepEventsOf(run.events) : new Map();
  // Två pass: NEXT_DECISION härleds ur de andra stegens utfall och kan därför
  // inte byggas i samma svep.
  const tracked = LOOP_STEPS.filter((step) => step.from !== 'RUN_OUTCOME');
  const decisionStep = LOOP_STEPS.find((step) => step.from === 'RUN_OUTCOME');
  const completedStep = (name) => {
    const events = byStep.get(name) || [];
    const done = events.find((row) => row.type === 'STEP_COMPLETED');
    const started = events.find((row) => row.type === 'STEP_STARTED');
    const failed = events.find((row) => row.type === 'STEP_FAILED');
    return { done, started, failed };
  };

  const rows = tracked.map((step) => {
    const { done, started, failed } = completedStep(step.from);
    const result = done?.result || {};
    let status = STEP_STATUS.PENDING;
    if (failed) status = STEP_STATUS.FAILED;
    else if (done) status = result.skipped ? STEP_STATUS.SKIPPED : STEP_STATUS.DONE;
    else if (started) status = STEP_STATUS.RUNNING;

    // De tre stegen som delar EXECUTE_QUEUE särskiljs på vad resultatet bär.
    if (step.id === 'EVIDENCE_RECORDED' && done && !result.memoryRecorded) status = STEP_STATUS.SKIPPED;
    if (step.id === 'POLICY_CLASSIFICATION') {
      const classified = result.payload?.research?.classified || [];
      return {
        id: step.id,
        label: step.label,
        status: classified.length ? STEP_STATUS.DONE : (done ? STEP_STATUS.SKIPPED : status),
        strategyId: text(classified[0]?.strategyId),
        at: text(done?.recordedAt),
        summary: classified.length
          ? classified.map((row) => `${row.strategyId}: ${row.outcome}`).join(', ')
          : 'ingen research-hypotes i körningen',
        outcomes: classified,
      };
    }

    return {
      id: step.id,
      label: step.label,
      status,
      strategyId: text(result.nextReplay?.strategyId
        || result.parentStrategyId
        || result.strategyId),
      dnaHash: text(result.nextReplay?.dnaHash || result.parentDnaHash),
      // Genomet steget gällde. Bara HISTORICAL_REPLAY kan svara på vad som
      // FAKTISKT kördes; de andra stegen lämnar fälten tomma.
      requestedGenome: text(result.requestedGenome),
      executedGenomes: Array.isArray(result.executedGenomes) ? result.executedGenomes : [],
      // Generationen fabriken arbetar i, och de genom cykeln faktiskt skapade.
      // Utan dem går det inte att se OM evolutionen kom framåt — bara att den
      // körde.
      generation: generationOf(result),
      children: childGenomesOf(result),
      at: text(done?.recordedAt || started?.recordedAt),
      summary: summarizeStep(step.id, result),
    };
  });

  return [...rows, { id: decisionStep.id, label: decisionStep.label, ...nextDecisionFrom({ run, steps: rows }) }];
}

function overallState({ run, steps }) {
  if (!run) return { state: 'idle', reason: 'ingen körning bokförd ännu' };
  if (steps.some((row) => row.status === STEP_STATUS.FAILED)) {
    return { state: 'blocked', reason: 'ett steg misslyckades' };
  }
  if (steps.some((row) => row.status === STEP_STATUS.RUNNING)) {
    return { state: 'running', reason: null };
  }
  const allSkipped = steps
    .filter((row) => row.id !== 'NEXT_DECISION')
    .every((row) => row.status === STEP_STATUS.SKIPPED);
  if (allSkipped) {
    return { state: 'blocked', reason: 'varje steg hoppades över — fabriken hittade inget arbete' };
  }
  const decision = steps.find((row) => row.id === 'NEXT_DECISION');
  return { state: 'idle', reason: text(decision?.summary) };
}

// ── Evidens för varje research-hypotes ───────────────────────────────────────
//
// Klassificeringen läser hela bibliotekets revisionsspår per hypotes. Mätt 303
// ms för 22 hypoteser — för dyrt att göra om vid varje sidladdning, och helt
// onödigt: svaret kan bara ändras när biblioteket fått en ny händelse.
//
// Nyckeln är därför bibliotekets egen händelseräknare. Den är monoton för en
// append-only logg, så ett cachat svar kan aldrig överleva den evidens det
// beskriver. Till skillnad från en TTL finns här inget fönster där siffran är
// fel.
let evidenceCache = null;

function classifiedHypotheses({ library, hypotheses = hypothesisModule, ledger = ledgerModule }) {
  const fingerprint = num(safeCall(() => library.getStatus()?.events, null));
  if (evidenceCache && fingerprint != null && evidenceCache.fingerprint === fingerprint) {
    return evidenceCache.rows;
  }
  const ids = (safeCall(() => hypotheses.listHypotheses(), []) || [])
    .map((row) => text(row.researchStrategyId))
    .filter(Boolean);
  const rows = safeCall(() => ledger.classifyRecordedRun(ids), []) || [];
  if (fingerprint != null) evidenceCache = { fingerprint, rows };
  return rows;
}

/** Ett klassificeringsutfall i den form UI:t ritar det. Inga omräknade tal. */
function researchResultRow(row, { hypothesis = null, record = null } = {}) {
  const m = row?.measured || {};
  return {
    strategyId: text(row?.strategyId),
    concept: text(hypothesis?.concept || hypothesis?.strategyId),
    hypothesisId: text(hypothesis?.hypothesisId),
    hypothesisVersion: text(hypothesis?.hypothesisVersion),
    hypothesisHash: text(hypothesis?.hypothesisHash),
    dnaHash: text(record?.currentDnaHash),
    cycle: hypothesis?.cycle ?? null,
    researchTrades: num(m.researchTrades),
    validationTrades: num(m.validationTrades),
    researchProfitFactor: num(m.researchProfitFactor),
    validationProfitFactor: num(m.validationProfitFactor),
    researchNetPnlUsd: num(m.researchNetPnlUsd),
    validationNetPnlUsd: num(m.validationNetPnlUsd),
    researchMaxDrawdownUsd: num(row?.aggregates?.research?.maxDrawdownUsd),
    validationMaxDrawdownUsd: num(row?.aggregates?.validation?.maxDrawdownUsd),
    edgeRetention: num(m.edgeRetention),
    outcome: text(row?.outcome),
    reason: text(row?.reason),
    failed: Array.isArray(row?.failed) ? row.failed : [],
    netEvidenceComplete: row?.netEvidenceComplete === true,
    at: text(record?.lastUpdated),
  };
}

/**
 * Hela loopens läge, komponerat ur befintliga tjänster.
 *
 * @param {object} [deps] injicerbara för test
 */
function getLoopStatus(deps = {}) {
  const orchestrator = deps.orchestrator || orchestratorModule.createAiFactoryOrchestrator({});
  const memory = deps.memory || memoryModule.defaultAiMemory;
  const library = deps.library || libraryModule.defaultStrategyLibrary;
  // Kön exponerar getStatus på INSTANSEN, inte på modulen.
  const queue = deps.replayQueue || queueModule.defaultReplayQueueService;
  const policy = deps.policy || policyModule;
  const calendar = deps.calendar || calendarModule;

  const trail = safeCall(() => orchestrator.getAuditTrail({}), []) || [];
  const run = latestRun(trail);
  const steps = buildSteps({ run });
  const decisionStep = steps.find((row) => row.id === 'NEXT_DECISION');

  const memoryStatus = safeCall(() => memory.getStatus(), null);
  const libraryStatus = safeCall(() => library.getStatus(), null);
  const queueStatus = safeCall(() => queue.getStatus(), null);
  const policyDescription = safeCall(() => policy.describePolicy(), null);

  const replayStep = steps.find((row) => row.id === 'HISTORICAL_REPLAY');
  const gapStep = steps.find((row) => row.id === 'KNOWLEDGE_GAP');
  const classificationStep = steps.find((row) => row.id === 'POLICY_CLASSIFICATION');

  const outcomeCounts = { HISTORICALLY_VALIDATED_CANDIDATE: 0, INSUFFICIENT_EVIDENCE: 0, REJECTED_BY_HISTORICAL_EVIDENCE: 0 };
  for (const row of classificationStep?.outcomes || []) {
    if (row.outcome && outcomeCounts[row.outcome] != null) outcomeCounts[row.outcome] += 1;
  }

  // ── Evidens, resultat och beslut för hela hypotespopulationen ─────────────
  //
  // Klassificeringssteget ovan beskriver DEN SENASTE KÖRNINGEN och är tomt så
  // fort cykeln inte råkade röra en research-hypotes. Det säger ingenting om
  // vad fabriken sammanlagt vet, vilket är just vad sidan ska svara på.
  const classifications = classifiedHypotheses({ library });
  const hypothesisById = new Map((safeCall(() => hypothesisModule.listHypotheses(), []) || [])
    .map((row) => [text(row.researchStrategyId), row]));
  const recordById = new Map((safeCall(() => library.listStrategies(), []) || [])
    .map((row) => [text(row.strategyId), row]));

  const results = classifications
    .map((row) => researchResultRow(row, {
      hypothesis: hypothesisById.get(text(row.strategyId)) || null,
      record: recordById.get(text(row.strategyId)) || null,
    }))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

  const totalOutcomes = { HISTORICALLY_VALIDATED_CANDIDATE: 0, INSUFFICIENT_EVIDENCE: 0, REJECTED_BY_HISTORICAL_EVIDENCE: 0 };
  for (const row of results) {
    if (row.outcome && totalOutcomes[row.outcome] != null) totalOutcomes[row.outcome] += 1;
  }

  // Förbättringsbesluten. Klassificeringen är INDATA — den ändras aldrig här.
  const decisionRows = improvementModule.decideAll(
    classifications.map((row) => recordById.get(text(row.strategyId)) || {
      strategyId: text(row.strategyId), lifecycle: 'draft',
    }),
    new Map(classifications.map((row) => [text(row.strategyId), row])),
  );
  const decisionSummary = improvementModule.summarize(decisionRows);
  const currentDecision = decisionRows.find((row) => row.strategyId === (gapStep?.strategyId || null))
    || decisionRows.find((row) => row.decision === improvementModule.DECISIONS.IMPROVE)
    || decisionRows[0]
    || null;

  const memoryLog = memoryStatus?.log || null;

  return {
    ok: true,
    statusVersion: STATUS_VERSION,
    generatedAt: new Date().toISOString(),

    status: {
      ...overallState({ run, steps }),
      currentRunId: run?.runId || null,
      lastCompletedRunId: run?.previous?.runId || null,
      currentStrategy: gapStep?.strategyId || null,
      // Evolutionens läge: vilken generation cykeln arbetade i, vilket genom
      // den utgick från, och vilka barn den fick.
      generation: steps.find((row) => row.generation != null)?.generation ?? null,
      parentGenome: text(steps.find((row) => row.id === 'DNA_GENERATION')?.dnaHash),
      children: steps.find((row) => row.id === 'DNA_GENERATION')?.children || [],
      // Genomet jobbet gällde. Hela listan över vad körningen laddade ligger på
      // replay-steget — den blir lång, eftersom en körning utvärderar alla
      // släktträdets genom och inte bara det beställda.
      requestedGenome: text(steps.find((row) => row.id === 'HISTORICAL_REPLAY')?.requestedGenome),
      currentAction: text(steps.find((row) => row.status === STEP_STATUS.RUNNING)?.label),
      lastCompletedAction: text([...steps].reverse().find((row) => row.status === STEP_STATUS.DONE)?.label),
      nextAction: text(decisionStep?.summary),
      // Blockeraren, om det finns en. Ett misslyckat steg väger tyngst; annars
      // är det skälet till att cykeln inte kom vidare.
      lastError: text(steps.find((row) => row.status === STEP_STATUS.FAILED)?.summary),
      blockedReason: text(steps.filter((row) => row.status === STEP_STATUS.SKIPPED)
        .map((row) => row.summary)
        .find((row) => row && row.includes('hoppades över'))),
    },

    steps,

    research: {
      experimentsRun: num(memoryStatus?.experiments),
      replaysCompleted: Array.isArray(queueStatus?.completed_jobs)
        ? queueStatus.completed_jobs.length
        : num(queueStatus?.completed_jobs),
      replaysPending: Array.isArray(queueStatus?.pending_jobs)
        ? queueStatus.pending_jobs.length
        : num(queueStatus?.pending_jobs),
      queuePaused: queueStatus?.paused === true,
      historicalDaysAvailable: safeCall(() => calendar.sharedDays().length, null),
      dataAccessMode: calendar.DATA_ACCESS_MODES.EXACT_CONTRACT,
      currentStrategy: gapStep?.strategyId || null,
      nextStrategy: text(decisionStep?.strategyId),
      lastReplayRunId: replayStep?.status === STEP_STATUS.DONE ? text(replayStep.summary) : null,
    },

    evidence: {
      policyVersion: policyDescription?.policyVersion || null,
      policyStatus: policyDescription?.status || null,
      // Utfallen i DEN SENASTE KÖRNINGEN.
      outcomes: outcomeCounts,
      classified: classificationStep?.outcomes || [],
      // Utfallen för HELA hypotespopulationen, oavsett när de kördes.
      totalOutcomes,
      hypothesesClassified: results.length,
    },

    // ── Senaste research-resultat ────────────────────────────────────────────
    researchResults: {
      policyVersion: policyDescription?.policyVersion || null,
      total: results.length,
      counts: totalOutcomes,
      latest: results[0] || null,
      rows: results,
    },

    // ── AI:s beslut, som är något ANNAT än evidensklassificeringen ────────────
    decisions: {
      decisionVersion: improvementModule.DECISION_VERSION,
      improvementTriggerScore: improvementModule.IMPROVEMENT_TRIGGER_SCORE,
      separation: improvementModule.describe().separation,
      summary: decisionSummary,
      current: currentDecision,
      rows: decisionRows,
    },

    memory: {
      totalExperiments: num(memoryStatus?.experiments),
      validExperiments: num(memoryStatus?.validForLearning),
      excludedExperiments: num(memoryStatus?.excluded),
      // repeats = körningar som frågade minnet och fick svaret "redan känt".
      duplicateSkips: num(memoryStatus?.repeats),
      distinctMarkets: num(memoryStatus?.distinctMarkets),
      byIdentityVersion: memoryStatus?.byIdentityVersion || null,
      latestExperimentAt: text(memoryLog?.lastRecordedAt),
      firstExperimentAt: text(memoryLog?.firstRecordedAt),
      eventsByType: memoryLog?.byType || null,
    },

    library: {
      strategies: num(libraryStatus?.strategies),
      lifecycleStates: libraryStatus?.byStage || libraryStatus?.lifecycle || null,
      retired: num(libraryStatus?.retired),
      events: num(libraryStatus?.events),
      latestChangeAt: text([...(safeCall(() => library.listStrategies(), []) || [])]
        .map((row) => row.lastUpdated)
        .filter(Boolean)
        .sort()
        .pop()),
      latestEvidence: results[0]
        ? {
          strategyId: results[0].strategyId,
          outcome: results[0].outcome,
          reason: results[0].reason,
          at: results[0].at,
        }
        : null,
    },

    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  STATUS_VERSION,
  LOOP_STEPS,
  STEP_STATUS,
  getLoopStatus,
  _internal: { latestRun, buildSteps, overallState, summarizeStep },
};
