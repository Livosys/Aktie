'use strict';

const crypto = require('crypto');
const path = require('path');

const { createEventLog } = require('../../data/eventLog');
const strategyLibraryModule = require('../library/strategyLibraryService');
const strategyBrainModule = require('../brain/strategyBrainService');
const aiMemoryModule = require('../memory/aiMemoryService');
const evolutionModule = require('../evolution/evolutionEngineService');
// Optimeraren äger begreppet "hur många kandidater" och därmed standardvärdet.
const optimizerModule = require('../optimizer/aiOptimizerService');
const replaySchedulerModule = require('../replaySchedulerService');
const replayQueueRunnerModule = require('../replayQueueRunnerService');
const strategyDna = require('../dna/strategyDnaService');
const nativeStrategyRegistry = require('../nativeFuturesStrategyRegistryService');
const lifecyclePromotionModule = require('../library/strategyLifecyclePromotionService');
const promotionEngineModule = require('../library/promotionEngineService');

const ORCHESTRATOR_VERSION = 'ai-factory-orchestrator-v1';
// Env-överstyrbar enligt samma mönster som STRATEGY_LIBRARY_EVENTS_FILE,
// AI_MEMORY_EVENTS_FILE, STRATEGY_FAMILY_TREE_FILE, REPLAY_QUEUE_EVENTS_FILE
// och LEARNING_CONNECTOR_DIR. En sandlådekörning av fabriken ska inte lämna
// spår i driftens revisionsspår.
const DEFAULT_EVENTS_FILE = path.resolve(
  process.env.AI_FACTORY_ORCHESTRATOR_EVENTS_FILE
    || path.resolve(__dirname, '../../../data/ai-factory/orchestrator-events.jsonl'),
);

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'ai_factory_orchestrator',
});

const EVENT_TYPES = Object.freeze({
  STEP_STARTED: 'STEP_STARTED',
  STEP_COMPLETED: 'STEP_COMPLETED',
  STEP_FAILED: 'STEP_FAILED',
});

const STEPS = Object.freeze([
  {
    id: 'PLAN',
    component: 'AI Factory Orchestrator',
    responsibility: 'Build deterministic orchestration plan',
  },
  {
    id: 'SELECT_KNOWLEDGE_GAP',
    component: 'Strategy Brain',
    responsibility: 'Select next information-gain gap',
  },
  {
    id: 'CREATE_DNA_GENERATION',
    component: 'Evolution Engine',
    responsibility: 'Use AI Optimizer and create DNA lineage',
  },
  {
    id: 'SCHEDULE_REPLAY',
    component: 'Replay Scheduler',
    responsibility: 'Create append-only replay jobs',
  },
  {
    id: 'EXECUTE_QUEUE',
    component: 'Replay Queue',
    responsibility: 'Execute queued replay jobs through the existing runner',
  },
  {
    id: 'COMPLETE',
    component: 'AI Factory Orchestrator',
    responsibility: 'Close the trace for this cycle',
  },
]);

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).trim().toLowerCase() === 'true';
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'function') return '[Function]';
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.keys(value).sort().reduce((acc, key) => {
    if (key === 'runId' || key === 'correlationId') return acc;
    acc[key] = canonical(value[key]);
    return acc;
  }, {});
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(canonical(value))).digest('hex');
}

function planInput(input = {}) {
  return canonical(input);
}

function runIdFor(input = {}) {
  return text(input.runId) || `factory_run_${stableHash(planInput(input)).slice(0, 20)}`;
}

function correlationIdFor(input = {}, runId) {
  return text(input.correlationId) || runId;
}

function hasOperationalInput(input = {}) {
  return Object.keys(input || {}).some((key) => !['runId', 'correlationId', 'maxTicks'].includes(key));
}

function buildPlan(input = {}) {
  const normalizedInput = planInput(input);
  return {
    ok: true,
    orchestratorVersion: ORCHESTRATOR_VERSION,
    deterministic: true,
    inputHash: stableHash(normalizedInput),
    input: normalizedInput,
    steps: STEPS.map((step, index) => ({
      index,
      id: step.id,
      component: step.component,
      responsibility: step.responsibility,
    })),
    contracts: {
      orchestratorContainsStrategyLogic: false,
      orchestratorContainsReplayLogic: false,
      strategyBrainSelectsKnowledgeGap: true,
      aiMemoryBeforeOptimization: true,
      aiOptimizerCreatesOnlyDnaCandidates: true,
      evolutionOwnsLineage: true,
      replaySchedulerCreatesJobs: true,
      replayQueueExecutesJobs: true,
      strategyLibraryIsResultTruth: true,
    },
    capabilities: {
      tick: true,
      cycle: true,
      resumeFromLastSuccessfulStep: true,
      appendOnlyTrace: true,
    },
    ...SAFETY,
  };
}

// ── Vilken kunskapslucka går att stänga? ─────────────────────────────────────
//
// Hjärnan rangordnar efter informationsvinst, och den högsta vinsten har per
// definition den strategi som är minst känd. Efter att Strategy Registry synkas
// in i biblioteket är de minst kända strategierna katalogposter UTAN evaluator
// — parameteruppsättningar som ingen kod kan köra.
//
// Utan det här urvalet uppstår en livelock, och den är mätt: cykel 2 valde
// crypto_fast_momentum, scanner-replayen körde på QQQ/SPY, ingen
// biblioteksrad skrevs, kunskapsluckan var lika stor efteråt — och nästa cykel
// hade valt samma strategi igen, i all evighet.
//
// Ingen ny rangordning införs. Hjärnans egen `priority`-lista läses i hjärnans
// egen ordning; det som tillkommer är kravet att luckan går att stänga. Finns
// ingen sådan lucka används hjärnans nextReplay precis som förut.
function firstActionableGap(analysis = {}, isExecutable) {
  const priority = Array.isArray(analysis.priority) ? analysis.priority : [];
  if (typeof isExecutable !== 'function') return analysis.nextReplay || null;
  for (const row of priority) {
    if (row?.strategyId && isExecutable(row.strategyId)) return row;
  }
  return analysis.nextReplay || null;
}

function summarizeBrain(analysis = {}, { isExecutable = null } = {}) {
  const nextReplay = firstActionableGap(analysis, isExecutable);
  const selected = nextReplay
    ? (analysis.strategies || []).find((row) => row.strategyId === nextReplay.strategyId) || null
    : null;
  return {
    ok: analysis.ok !== false,
    brainVersion: analysis.brainVersion || null,
    nextReplay,
    selectedStrategy: selected ? {
      strategyId: selected.strategyId,
      dnaHash: selected.dnaHash || null,
      knowledgeScore: selected.knowledgeScore ?? null,
      recommendation: selected.recommendation || null,
      blindSpots: selected.blindSpots || [],
      gaps: selected.gaps || [],
    } : null,
    recommendations: analysis.recommendations || {},
    // Hjärnans rangordning, bara id:n och bara ordningen. Behövs för att
    // evolutionen ska ha någon förälder att arbeta på när den strategi som har
    // störst kunskapslucka saknar market DNA — se parentCandidateIds.
    //
    // Listan är runtime-data, inte en strategilista i koden: hjärnan förblir
    // generisk och nämner fortfarande inget strateginamn.
    rankedStrategyIds: (analysis.strategies || [])
      .map((row) => text(row.strategyId))
      .filter(Boolean),
    market: analysis.market || null,
  };
}

function resultOf(state, stepId) {
  return state.completed[stepId]?.result || null;
}

// ── Vem är förälder till nästa generation? ───────────────────────────────────
//
// Ursprungligen: den strategi hjärnan valt för nästa replay. Det gav en
// strukturell återvändsgränd, för de två stegen svarar på motsatta frågor.
//
// Hjärnans nextReplay pekar per definition på den MINST kända strategin —
// högst informationsvinst betyder störst kunskapslucka. Optimeraren kräver
// tvärtom att föräldern ÄR känd: utan `marketDnaHash` kan AI Memory inte avgöra
// om experimentet redan är gjort, och steget avbryts med `market_dna_required`.
// Kombinationen betydde att steget aldrig kunde lyckas.
//
// Hjärnan räknar redan fram svaret: `recommendations.optimize` är listan över
// strategier den bedömt har tillräckligt underlag för att förbättras. Den
// listan beräknades och kastades. Nu läses den — i den här ordningen:
//
//   1. uttrycklig förälder från anroparen (oförändrat)
//   2. hjärnans optimize-rekommendation, om den har market DNA
//   3. den valda kunskapsluckan (oförändrat fallback)
//
// Ingen ny heuristik. Ingen ny mutationstyp. Ett värde som redan fanns.
function parentCandidateIds({ input, brainResult, library }) {
  const ids = [];
  const explicit = text(input.parentStrategyId);
  if (explicit) ids.push(explicit);

  for (const id of arrOf(brainResult?.recommendations?.optimize)) {
    const candidate = text(id);
    if (!candidate || ids.includes(candidate)) continue;
    // Utan market DNA faller steget på market_dna_required längre ned. Att
    // sålla här i stället gör skillnaden synlig som ett VAL och inte som ett
    // fel senare i kedjan.
    const record = typeof library?.getStrategy === 'function' ? library.getStrategy(candidate) : null;
    if (record?.currentMarketDnaHash) ids.push(candidate);
  }

  // ── Evolutionen får aldrig stå still för att målet är okänt ───────────────
  //
  // Hjärnan pekar per definition ut den MINST kända strategin, och den saknar
  // ofta market DNA — den har ju inte körts. Optimeraren kräver market DNA för
  // att kunna bilda en experimentidentitet, så steget föll på
  // market_dna_required varje cykel och evolutionen skapade aldrig ett enda
  // nytt genom. Replayen kördes, men parameterrymden utforskades inte.
  //
  // Reservvägen är hjärnans egen rangordning: högst rankade strategi som
  // FAKTISKT har market DNA. Deterministiskt, och det är fortfarande hjärnan
  // som prioriterar — orchestratorn väljer bara den bäst rankade av dem som går
  // att arbeta på.
  if (!ids.length || !ids.some((id) => library?.getStrategy?.(id)?.currentMarketDnaHash)) {
    for (const id of arrOf(brainResult?.rankedStrategyIds)) {
      const candidate = text(id);
      if (!candidate || ids.includes(candidate)) continue;
      if (!library?.getStrategy?.(candidate)?.currentMarketDnaHash) continue;
      ids.push(candidate);
      break;
    }
  }

  const fallback = text(brainResult?.nextReplay?.strategyId || brainResult?.selectedStrategy?.strategyId);
  if (fallback && !ids.includes(fallback)) ids.push(fallback);
  return ids;
}

function arrOf(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Ett genoms uppmätta värde, läst ur Strategy Library.
 *
 * Ett muterat genom bokförs under sitt eget id (`rot@hash`), så biblioteket kan
 * svara på hur det gick. Saknas posten returneras null — och null betyder
 * "omätt", inte "dåligt". Skillnaden avgör om genomet får bli förälder på
 * meriter eller bara som outforskat.
 */
function genomeScorer(library) {
  if (typeof library?.getStrategy !== 'function') return null;
  return (node) => {
    const strategyId = `${text(node?.rootStrategyId) || ''}@${text(node?.dnaHash) || ''}`;
    const record = library.getStrategy(strategyId);
    if (!record) return null;
    // Strategy Score mäter replay, och det är replay evolutionen kör.
    const score = Number(record.strategyScore);
    return Number.isFinite(score) ? score : null;
  };
}

function selectedParentDna({ input, brainResult, dnaService, library, evolutionEngine = null }) {
  if (input.parentDna?.dnaHash) return input.parentDna;
  const population = typeof dnaService.listStrategyDna === 'function' ? dnaService.listStrategyDna() : [];
  const targetHash = text(input.parentDnaHash);
  if (targetHash) {
    return population.find((dna) => dna.dnaHash === targetHash) || null;
  }

  // ── Evolutionen måste kunna bygga vidare på sina egna resultat ─────────────
  //
  // Föräldern hämtades ur REGISTRET, alltså alltid generation 0. Varje strategi
  // har en handfull muterbara parametrar och två steg per parameter, så när de
  // åtta enstegsmutationerna fanns i trädet var familjen slut: varje cykel
  // föreslog samma åtta, fick tillbaka dem som redan existerande, och tillförde
  // ingenting. Generation 2 kunde aldrig uppstå.
  //
  // Motorn får därför peka ut föräldern inom familjen — roten så länge den har
  // outforskade steg kvar, annars dess minst utforskade barn. Misslyckas det
  // faller vi tillbaka på registret, precis som förut.
  //
  // Poängsättaren kommer HÄRIFRÅN, inte inifrån motorn. Evolution Engine skapar
  // DNA och bokför släktskap; att den också läste resultat hade blandat ihop
  // "vad är släkt med vad" med "vad var bra". Orchestratorn äger bägge frågorna
  // och får därför koppla ihop dem.
  const deepen = (rootDna) => {
    if (!rootDna || typeof evolutionEngine?.nextParentFor !== 'function') return rootDna;
    try {
      return evolutionEngine.nextParentFor(rootDna.dnaHash, { scoreOf: genomeScorer(library) }) || rootDna;
    } catch (_) {
      return rootDna;
    }
  };

  for (const strategyId of parentCandidateIds({ input, brainResult, library })) {
    const match = population.find((dna) => dna.strategyId === strategyId);
    if (match) return deepen(match);
  }
  // Sista utvägen: hjärnans hash, om strategin inte gick att slå upp på namn.
  const hash = text(brainResult?.nextReplay?.dnaHash || brainResult?.selectedStrategy?.dnaHash);
  return hash ? deepen(population.find((dna) => dna.dnaHash === hash) || null) : null;
}

// Biblioteksposten måste höra till den valda FÖRÄLDERN. Tidigare slogs den upp
// på hjärnans luckstrategi, vilket efter parentCandidateIds kan vara en annan
// strategi — och då hade market DNA hämtats från fel post.
function libraryRecordFor({ input, brainResult, library, parentDna }) {
  if (input.libraryRecord && typeof input.libraryRecord === 'object') return input.libraryRecord;
  const strategyId = text(parentDna?.strategyId
    || input.parentStrategyId
    || brainResult?.nextReplay?.strategyId
    || brainResult?.selectedStrategy?.strategyId);
  if (!strategyId || typeof library?.getStrategy !== 'function') return null;
  return library.getStrategy(strategyId);
}

/**
 * Vilken timeframe replay KOMMER att köra experimentet i.
 *
 * Hämtas ur den replay-konfiguration som samma cykel schemalägger — samma
 * funktion som schemaläggaren själv använder när den bygger jobbet. Två
 * uträkningar av samma sak hade kunnat glida isär, och då hade optimeraren
 * bokfört ett experiment i en annan timeframe än den som faktiskt kördes.
 *
 * Aldrig härledd ur strategins metadata på egen hand: `strategy.timeframe` når
 * hit bara därför att det är vad SCHEMALÄGGAREN läser när den sätter jobbets
 * timeframe, alltså via körkonfigurationen och inte som en gissning.
 *
 * Null när ingenting anger någon. Då blir experimentet en v1-identitet, vilket
 * är ärligare än att påstå en timeframe som ingen har beslutat.
 */
function plannedExecutedTimeframe({ input, brainResult }) {
  const optimization = input.optimization || {};
  const scheduler = input.scheduler || {};
  return replaySchedulerModule.resolveJobTimeframe({
    config: optimization.timeframe ? { timeframe: optimization.timeframe } : (scheduler.config || null),
    gap: brainResult?.nextReplay || null,
    strategy: brainResult?.selectedStrategy || null,
  });
}

/** Vad strategin SÄGER sig kräva. Metadata — och bara detta fält får vara det. */
function declaredTimeframeFor(strategyId) {
  try {
    const hypotheses = require('../research/researchHypothesisService');
    if (!hypotheses.isResearchStrategyId(strategyId)) return null;
    return hypotheses.getHypothesis(strategyId)?.semantics?.timeframe || null;
  } catch (_) {
    return null;
  }
}

function optimizerContext({ input, brainResult, libraryRecord }) {
  const optimization = input.optimization || {};
  const nextReplay = brainResult?.nextReplay || {};
  const marketDnaHash = text(
    optimization.marketDnaHash
    || input.marketDnaHash
    || libraryRecord?.currentMarketDnaHash,
  );
  if (!marketDnaHash) return { ok: false, reason: 'market_dna_required' };

  return {
    ok: true,
    context: {
      marketDnaHash,
      replayMode: text(optimization.replayMode || input.replayMode || nextReplay.replayMode) || 'optimizer',
      executionModel: text(optimization.executionModel || input.executionModel || nextReplay.executionModel) || 'simulated_fill',
      strategyVersion: text(optimization.strategyVersion || input.strategyVersion) || undefined,
      period: optimization.period || input.period || null,
      symbols: Array.isArray(optimization.symbols) ? optimization.symbols : (Array.isArray(input.symbols) ? input.symbols : []),
      requestedBy: 'AI Factory Orchestrator',
      regimeKeys: Array.isArray(optimization.regimeKeys)
        ? optimization.regimeKeys
        : [nextReplay.targetRegime].filter(Boolean),
      marketClassification: text(optimization.marketClassification || input.marketClassification),
      executedTimeframe: plannedExecutedTimeframe({ input, brainResult }),
      declaredTimeframe: declaredTimeframeFor(text(nextReplay.strategyId)),
    },
  };
}

/**
 * Genomet cykeln just skapade, i den form ett replay-jobb bär det.
 *
 * ── Varför loopen stod stilla ───────────────────────────────────────────────
 *
 * Köns dubblettskydd nycklade ett jobb på {strategi, market DNA, replay-läge,
 * period, exekveringsmodell}. Ingenting i den nyckeln sa vilket GENOM som
 * skulle prövas. Cykeln skapade därför ett nytt genom, byggde ett jobb som såg
 * exakt ut som det redan avslutade jobbet för samma kunskapslucka, fick
 * `duplicates: 1, created: 0` — och EXECUTE_QUEUE hoppade över med
 * `no_new_replay_job_created`. Varje cykel. Ingen evidens bokfördes någonsin.
 *
 * Genomet är nu ett fält på jobbet och ingår i köns avtryck. Ett nytt genom är
 * ett nytt jobb; en cykel UTAN nytt genom faller fortfarande på
 * `experiment_already_known_in_ai_memory` en rad tidigare, så dubblettskyddet
 * försvagas inte — det får bara veta vad som skiljer körningarna åt.
 *
 * ETT genom per jobb. Ett jobb är ett experiment, och två genom i samma jobb
 * hade gjort resultatet omöjligt att tillskriva någondera — men en cykel som
 * skapar flera genom ska ge flera JOBB, ett per genom.
 *
 * Bara genom som FAKTISKT går att köra tas med. Ett genom vars rot saknar kod,
 * eller vars mutation inte ändrade något strategin läser, kan inte prövas; ett
 * jobb för det hade blivit en körning om något annat än beställningen.
 */
function genomesForJobs(generation, { registry = nativeStrategyRegistry } = {}) {
  const created = Array.isArray(generation?.created) ? generation.created : [];
  const rows = [];
  for (const row of created) {
    const proposal = row?.proposal || {};
    const dnaHash = text(proposal.candidateDnaHash);
    if (!dnaHash) continue;
    const dna = proposal.dnaProposal || {};
    rows.push({
      dnaHash,
      strategyId: text(dna.strategyId),
      rootStrategyId: text(dna.originStrategyId || dna.strategyId),
      parentDnaHash: text(proposal.parentDnaHash || generation?.parentDnaHash),
      generation: Number.isFinite(Number(row?.node?.generation)) ? Number(row.node.generation) : null,
      options: dna.defaultOptions && typeof dna.defaultOptions === 'object' ? dna.defaultOptions : {},
    });
  }
  if (!rows.length || typeof registry?.describeRequestedGenomes !== 'function') return rows;

  let runnable;
  try {
    runnable = new Set(registry.describeRequestedGenomes(rows.map((row) => row.dnaHash))
      .filter((row) => row.loaded)
      .map((row) => row.dnaHash));
  } catch (_) {
    return rows;
  }
  return rows.filter((row) => runnable.has(row.dnaHash));
}

function schedulerInput({ input, brainResult, generation = null }) {
  const scheduler = input.scheduler || {};
  const nextReplay = brainResult?.nextReplay || null;
  const genomes = genomesForJobs(generation);
  // En kunskapslucka per genom. Utan det fick bara det första genomet en
  // replay, och resten av cykelns arbete prövades aldrig.
  const gaps = nextReplay
    ? (genomes.length ? genomes.map((genome) => ({ ...nextReplay, genome })) : [nextReplay])
    : [];
  const base = {
    now: input.now || scheduler.now || null,
    enforceEnabled: false,
    requestedBy: 'AI Factory Orchestrator',
    config: {
      // Ett jobb per genom. Kön betar av dem en i taget, så cykeln lägger på
      // arbete utan att någon enskild tick betalar hela replay-kostnaden.
      maxJobsPerRun: Math.max(1, gaps.length),
      ...(scheduler.config || {}),
    },
    strategies: [],
    scores: [],
    histories: {},
    knowledgeGaps: gaps,
  };
  return {
    ...base,
    ...(input.schedulerInput || {}),
    enforceEnabled: false,
  };
}

// ── Hur många genom en cykel får skapa ───────────────────────────────────────
//
// Talet stod hårdkodat som 1 här. Optimeraren kan föreslå flera kandidater och
// har 6 som sitt eget standardvärde, men fabriken bad alltid om ett — och med
// sex timmar mellan cyklerna blev det fyra genom per dygn i bästa fall. Var det
// enda förslaget dessutom redan känt tillförde cykeln ingenting alls.
//
// Källan är nu optimeraren själv, alltså den modul som äger begreppet. Talet
// går att styra med AI_FACTORY_MAX_CANDIDATES för den som vill köra långsammare
// eller snabbare, och en anropare kan fortfarande skicka in ett eget värde.
//
// Taket på 24 står kvar: varje genom kostar ~1,44 s replay per fyratimmars-
// fönster, och det är den kostnaden som gör brute force olämpligt.
const MAX_CANDIDATES_CEILING = 24;

function maxCandidatesPerCycle(requested) {
  if (requested != null) return clampInt(requested, optimizerDefaultCandidates(), 1, MAX_CANDIDATES_CEILING);
  const fromEnv = process.env.AI_FACTORY_MAX_CANDIDATES;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return clampInt(fromEnv, optimizerDefaultCandidates(), 1, MAX_CANDIDATES_CEILING);
  }
  return optimizerDefaultCandidates();
}

/** Optimeraren äger begreppet och därmed standardvärdet. */
function optimizerDefaultCandidates() {
  const value = Number(optimizerModule.DEFAULT_MAX_CANDIDATES);
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_CANDIDATES_CEILING) : 6;
}

/**
 * Ska schemaläggningen hoppas över?
 *
 * Ja när cykeln inte tillförde någon ny arvsmassa. Två sätt att inte göra det,
 * och bägge måste räknas:
 *
 *   existingExperiments  minnet kände redan igen experimentet
 *   alreadyInTree        släktträdet hade redan genomet
 *
 * Den andra saknades. Evolution Engine kastade bort trädets `alreadyPresent`,
 * så ett genom som redan fanns räknades som `created` — och då var villkoret
 * `created === 0` aldrig sant. Fabriken schemalade en replay för samma genom
 * varje cykel och rapporterade "1 nytt genom" varje gång. Mätt: 24 "skapade"
 * genom gav 1 ny nod i trädet.
 */
function shouldSkipScheduling(evolutionResult) {
  if (!evolutionResult) return false;
  const created = Array.isArray(evolutionResult.created) ? evolutionResult.created.length : 0;
  if (created > 0) return false;
  const existing = Array.isArray(evolutionResult.existingExperiments) ? evolutionResult.existingExperiments.length : 0;
  const alreadyInTree = Array.isArray(evolutionResult.alreadyInTree) ? evolutionResult.alreadyInTree.length : 0;
  return existing > 0 || alreadyInTree > 0;
}

/**
 * After lifecycle promotions, check if any CANDIDATE strategies are now ready for PAPER review.
 * Records PAPER_REVIEW_RECOMMENDED event for canonical-approved strategies.
 */
function recordPaperReviewRecommendations(lib, promotedStrategies = []) {
  if (!lib || typeof lib.recordPaperReviewRecommendation !== 'function') return { recorded: 0 };
  if (!promotedStrategies || !Array.isArray(promotedStrategies)) return { recorded: 0 };

  const recorded = [];

  try {
    for (const promoted of promotedStrategies) {
      // Only check strategies that were promoted TO candidate
      if (promoted.to !== 'candidate') continue;

      const strategy = lib.getStrategy(promoted.strategyId);
      if (!strategy) continue;

      // Check if this newly promoted CANDIDATE can move to PAPER
      const evaluation = promotionEngineModule.evaluatePromotion(strategy);
      if (evaluation.from === 'candidate' && evaluation.to === 'paper' && evaluation.allowed) {
        lib.recordPaperReviewRecommendation({
          strategyId: promoted.strategyId,
          reason: 'canonical_promotion_ready_for_paper',
          evidence: `CANDIDATE→PAPER gates all passed. Checks: ${evaluation.checks.map(c => c.code).join(', ')}`,
        });
        recorded.push(promoted.strategyId);
      }
    }
  } catch (err) {
    // Silently skip; doesn't block orchestrator
  }

  return { recorded: recorded.length, strategyIds: recorded };
}

function createAiFactoryOrchestrator(options = {}) {
  const memory = options.memory || aiMemoryModule.defaultAiMemory;
  const library = options.library || strategyLibraryModule.defaultStrategyLibrary;
  const brain = options.strategyBrain || strategyBrainModule.createStrategyBrain({ memory });
  const evolutionEngine = options.evolutionEngine || evolutionModule.createEvolutionEngine();
  const scheduler = options.replayScheduler || replaySchedulerModule.defaultReplaySchedulerService;
  const queueRunner = options.replayQueueRunner || replayQueueRunnerModule.defaultReplayQueueRunnerService;
  const dnaService = options.dnaService || strategyDna;
  // "Går att köra" betyder i det här systemet: det finns en evaluator. Den
  // frågan äger native-registret, och den injiceras hit i stället för att
  // hårdkodas, så att orchestratorn förblir prövbar utan registret.
  const isExecutableStrategy = typeof options.isExecutableStrategy === 'function'
    ? options.isExecutableStrategy
    : (strategyId) => nativeStrategyRegistry.isNativeStrategyId(strategyId);
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const log = createEventLog({
    file: options.eventsFile || DEFAULT_EVENTS_FILE,
    keyField: 'runId',
    eventTypes: Object.values(EVENT_TYPES),
    now: clock,
    label: 'ai_factory_orchestrator',
  });

  function nowIso() {
    return new Date(clock()).toISOString();
  }

  function append(runId, type, payload) {
    return log.append(runId, type, {
      orchestratorVersion: ORCHESTRATOR_VERSION,
      ...payload,
    });
  }

  function getRunState(runId) {
    const id = text(runId);
    const events = id ? log.historyFor(id) : [];
    const completed = {};
    const failedByStep = {};
    let correlationId = null;

    for (const event of events) {
      if (event.correlationId) correlationId = event.correlationId;
      if (event.type === EVENT_TYPES.STEP_COMPLETED && event.step) {
        completed[event.step] = event;
        delete failedByStep[event.step];
      }
      if (event.type === EVENT_TYPES.STEP_FAILED && event.step) {
        failedByStep[event.step] = event;
      }
    }

    const completedSteps = STEPS
      .map((step) => step.id)
      .filter((step) => completed[step]);
    const nextStep = STEPS.find((step) => !completed[step.id]) || null;
    const failed = Object.values(failedByStep).sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt))).at(-1) || null;

    return {
      ok: true,
      runId: id,
      correlationId,
      completed,
      completedSteps,
      failed,
      nextStep: nextStep ? nextStep.id : null,
      complete: !nextStep,
      events,
      eventCount: events.length,
      ...SAFETY,
    };
  }

  async function runStep(step, { input, runId, correlationId, state }) {
    if (step.id === 'PLAN') {
      return { ok: true, plan: buildPlan(input) };
    }

    if (step.id === 'SELECT_KNOWLEDGE_GAP') {
      if (!brain || typeof brain.analyze !== 'function') return { ok: false, reason: 'strategy_brain_unavailable' };
      const analysis = brain.analyze({
        library,
        catalog: input.catalog || null,
        now: input.now ? new Date(input.now) : new Date(nowIso()),
        replayMode: input.replayMode || 'strategy',
        executionModel: input.executionModel || 'simulated_fill',
      });
      return summarizeBrain(analysis, { isExecutable: isExecutableStrategy });
    }

    if (step.id === 'CREATE_DNA_GENERATION') {
      if (!evolutionEngine || typeof evolutionEngine.createOptimizedDnaCandidates !== 'function') {
        return { ok: false, reason: 'evolution_engine_optimizer_entrypoint_required' };
      }
      const brainResult = resultOf(state, 'SELECT_KNOWLEDGE_GAP');
      if (!brainResult?.nextReplay) {
        return { ok: true, skipped: true, reason: 'no_knowledge_gap_selected' };
      }
      const parentDna = selectedParentDna({ input, brainResult, dnaService, library, evolutionEngine });
      if (!parentDna?.dnaHash) return { ok: true, skipped: true, reason: 'parent_dna_not_found' };
      const libraryRecord = libraryRecordFor({ input, brainResult, library, parentDna });
      const context = optimizerContext({ input, brainResult, libraryRecord });
      if (!context.ok) return { ok: true, skipped: true, reason: context.reason, parentDnaHash: parentDna.dnaHash };

      const optimization = input.optimization || {};
      const result = evolutionEngine.createOptimizedDnaCandidates({
        parentDna,
        context: context.context,
        target: text(optimization.target || input.target) || 'strategyScore',
        maxCandidates: maxCandidatesPerCycle(optimization.maxCandidates ?? input.maxCandidates),
        branch: text(optimization.branch || input.branch) || 'factory',
        libraryRecord,
      });
      if (result.ok === false) return result;
      if (result.optimizerAskedMemoryBeforeDna !== true) {
        return { ok: false, reason: 'optimizer_memory_gate_missing', result };
      }
      return {
        ok: true,
        parentDnaHash: parentDna.dnaHash,
        created: result.created || [],
        // Genom som redan låg i trädet. Räknas separat — se shouldSkipScheduling.
        alreadyInTree: result.alreadyInTree || [],
        addedNewGenome: result.addedNewGenome === true,
        existingExperiments: result.existingExperiments || [],
        rejected: result.rejected || [],
        winner: result.winner ?? null,
        optimizerAskedMemoryBeforeDna: true,
        evolution: {
          engineVersion: result.engineVersion || null,
          optimizerVersion: result.optimizerVersion || null,
        },
      };
    }

    if (step.id === 'SCHEDULE_REPLAY') {
      if (!scheduler || typeof scheduler.runOnce !== 'function') return { ok: false, reason: 'replay_scheduler_unavailable' };
      const brainResult = resultOf(state, 'SELECT_KNOWLEDGE_GAP');
      const generation = resultOf(state, 'CREATE_DNA_GENERATION');
      if (!brainResult?.nextReplay) return { ok: true, skipped: true, reason: 'no_knowledge_gap_selected' };
      if (shouldSkipScheduling(generation)) {
        return { ok: true, skipped: true, reason: 'experiment_already_known_in_ai_memory' };
      }
      if (bool(input.scheduleReplay, true) === false) {
        return { ok: true, skipped: true, reason: 'schedule_replay_disabled_by_input' };
      }
      const scheduled = scheduler.runOnce(schedulerInput({ input, brainResult, generation }));
      if (scheduled.ok === false) return scheduled;
      return {
        ok: true,
        scheduled: scheduled.scheduled !== false,
        schedulerRunsReplay: scheduled.scheduler_runs_replay === true,
        appended: scheduled.appended ? {
          ok: scheduled.appended.ok,
          created: scheduled.appended.created || 0,
          duplicates: scheduled.appended.duplicates || 0,
          failed: scheduled.appended.failed || 0,
          jobs: (scheduled.appended.results || []).map((row) => ({
            created: row.created === true,
            duplicate: row.duplicate === true,
            jobId: row.job?.id || null,
          })),
        } : null,
        plan: scheduled.plan ? {
          totalJobs: scheduled.plan.summary?.total_jobs || 0,
          jobIds: (scheduled.plan.jobs || []).map((job) => job.id),
        } : null,
      };
    }

    if (step.id === 'EXECUTE_QUEUE') {
      const scheduled = resultOf(state, 'SCHEDULE_REPLAY');
      const created = scheduled?.appended?.created || 0;
      if (scheduled?.skipped) return { ok: true, skipped: true, reason: scheduled.reason };
      if (created <= 0) return { ok: true, skipped: true, reason: 'no_new_replay_job_created' };
      if (bool(input.executeQueue, true) === false) {
        return { ok: true, skipped: true, reason: 'execute_queue_disabled_by_input' };
      }
      if (!queueRunner || typeof queueRunner.runNextJob !== 'function') return { ok: false, reason: 'replay_queue_runner_unavailable' };
      const executed = await queueRunner.runNextJob();
      if (executed.ok === false) return executed;

      // ── Automatic Lifecycle Progression ──────────────────────────────────
      // After replay evidence is persisted, evaluate and apply pending promotions.
      // This makes lifecycle advancement event-driven rather than endpoint-driven.
      let promotionResult = null;
      let paperReviewResult = null;
      if (executed.executed === true) {
        try {
          promotionResult = lifecyclePromotionModule.promoteReadyStrategies(library);
          // For newly promoted CANDIDATE strategies, record PAPER_REVIEW_RECOMMENDED if eligible
          if (promotionResult?.promoted && Array.isArray(promotionResult.promoted)) {
            paperReviewResult = recordPaperReviewRecommendations(library, promotionResult.promoted);
          }
        } catch (err) {
          // Log but don't block orchestrator: replay evidence is already persisted
          promotionResult = {
            ok: false,
            reason: 'promotion_evaluation_failed',
            error: err?.message || String(err),
            evaluated: 0,
            promoted: [],
          };
        }
      }

      return {
        ok: true,
        executed: executed.executed === true,
        jobId: executed.job?.id || null,
        replayRunId: executed.replay?.runId || executed.job?.run_id || null,
        memoryRecorded: executed.memoryRecorded === true,
        // Genomet jobbet BAD om, och de som faktiskt kördes. De två kan skilja
        // sig — ett begärt genom vars rot saknar kod går inte att köra — och då
        // handlar körningen om något annat än beställningen.
        requestedGenome: text(executed.job?.genome?.dna_hash),
        executedGenomes: arrOf(executed.replay?.summary?.executedGenomes),
        requestedGenomes: arrOf(executed.replay?.summary?.requestedGenomes),
        // Lifecycle promotions triggered by replay evidence
        lifecyclePromotion: promotionResult ? {
          ok: promotionResult.ok !== false,
          evaluated: promotionResult.evaluated || 0,
          promoted: promotionResult.promoted || [],
          failures: promotionResult.failures || [],
        } : null,
        // PAPER review recommendations for newly promoted CANDIDATES
        paperReviewRecommendations: paperReviewResult ? {
          recorded: paperReviewResult.recorded,
          strategyIds: paperReviewResult.strategyIds || [],
        } : null,
      };
    }

    if (step.id === 'COMPLETE') {
      return {
        ok: true,
        completedAt: nowIso(),
        summary: {
          knowledgeGap: resultOf(state, 'SELECT_KNOWLEDGE_GAP')?.nextReplay || null,
          dnaCreated: (resultOf(state, 'CREATE_DNA_GENERATION')?.created || []).length,
          knownExperiments: (resultOf(state, 'CREATE_DNA_GENERATION')?.existingExperiments || []).length,
          replayJobsCreated: resultOf(state, 'SCHEDULE_REPLAY')?.appended?.created || 0,
          replayExecuted: resultOf(state, 'EXECUTE_QUEUE')?.executed === true,
        },
      };
    }

    return { ok: false, reason: `unknown_orchestrator_step:${step.id}` };
  }

  async function tick(input = {}) {
    const runId = runIdFor(input);
    let state = getRunState(runId);
    const correlationId = text(input.correlationId) || state.correlationId || correlationIdFor(input, runId);
    if (state.complete) {
      return { ok: true, runId, correlationId, complete: true, step: null, state, ...SAFETY };
    }

    const existingPlan = resultOf(state, 'PLAN')?.plan || null;
    const effectiveInput = existingPlan && !hasOperationalInput(input)
      ? { ...existingPlan.input, runId, correlationId }
      : input;
    const requestedPlan = buildPlan(effectiveInput);
    if (existingPlan && existingPlan.inputHash !== requestedPlan.inputHash) {
      const step = state.nextStep || 'UNKNOWN';
      append(runId, EVENT_TYPES.STEP_FAILED, {
        correlationId,
        step,
        error: 'input_changed_for_existing_run',
        expectedInputHash: existingPlan.inputHash,
        actualInputHash: requestedPlan.inputHash,
      });
      return {
        ok: false,
        runId,
        correlationId,
        step,
        error: 'input_changed_for_existing_run',
        expectedInputHash: existingPlan.inputHash,
        actualInputHash: requestedPlan.inputHash,
        state: getRunState(runId),
        ...SAFETY,
      };
    }

    const step = STEPS.find((row) => !state.completed[row.id]);
    append(runId, EVENT_TYPES.STEP_STARTED, {
      correlationId,
      step: step.id,
      stepIndex: STEPS.findIndex((row) => row.id === step.id),
    });

    try {
      const result = await runStep(step, { input: effectiveInput, runId, correlationId, state });
      if (result?.ok === false) {
        append(runId, EVENT_TYPES.STEP_FAILED, {
          correlationId,
          step: step.id,
          stepIndex: STEPS.findIndex((row) => row.id === step.id),
          error: result.reason || result.error || 'step_failed',
          result,
        });
        return {
          ok: false,
          runId,
          correlationId,
          step: step.id,
          error: result.reason || result.error || 'step_failed',
          result,
          state: getRunState(runId),
          ...SAFETY,
        };
      }
      append(runId, EVENT_TYPES.STEP_COMPLETED, {
        correlationId,
        step: step.id,
        stepIndex: STEPS.findIndex((row) => row.id === step.id),
        result,
      });
      state = getRunState(runId);
      return {
        ok: true,
        runId,
        correlationId,
        step: step.id,
        result,
        complete: state.complete,
        nextStep: state.nextStep,
        state,
        ...SAFETY,
      };
    } catch (err) {
      append(runId, EVENT_TYPES.STEP_FAILED, {
        correlationId,
        step: step.id,
        stepIndex: STEPS.findIndex((row) => row.id === step.id),
        error: err.message || String(err),
      });
      return {
        ok: false,
        runId,
        correlationId,
        step: step.id,
        error: err.message || String(err),
        state: getRunState(runId),
        ...SAFETY,
      };
    }
  }

  async function runCycle(input = {}) {
    const maxTicks = clampInt(input.maxTicks, STEPS.length + 2, 1, 100);
    const ticks = [];
    let last = null;
    const runId = runIdFor(input);
    for (let i = 0; i < maxTicks; i += 1) {
      last = await tick(input);
      ticks.push({
        ok: last.ok,
        step: last.step,
        complete: last.complete === true,
        error: last.error || null,
      });
      if (!last.ok || last.complete) break;
    }
    return {
      ok: last?.ok === true,
      runId,
      correlationId: text(input.correlationId) || getRunState(runId).correlationId || correlationIdFor(input, runId),
      complete: last?.complete === true,
      ticks,
      state: getRunState(runId),
      ...SAFETY,
    };
  }

  function getStatus() {
    return {
      ok: true,
      orchestratorVersion: ORCHESTRATOR_VERSION,
      steps: STEPS.map((step) => step.id),
      log: log.stats(),
      capabilities: buildPlan({}).capabilities,
      contracts: buildPlan({}).contracts,
      memory: typeof memory.getStatus === 'function' ? memory.getStatus() : null,
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    ORCHESTRATOR_VERSION,
    EVENT_TYPES,
    STEPS,
    eventsFile: log.file,
    buildPlan,
    tick,
    runCycle,
    getRunState,
    getAuditTrail: (query) => log.auditTrail(query),
    getStatus,
    _internal: {
      log,
      stableHash,
      stableStringify,
      canonical,
      runIdFor,
      correlationIdFor,
      schedulerInput,
      optimizerContext,
    },
  };
}

module.exports = {
  SAFETY,
  ORCHESTRATOR_VERSION,
  EVENT_TYPES,
  STEPS,
  DEFAULT_EVENTS_FILE,
  buildPlan,
  createAiFactoryOrchestrator,
  defaultAiFactoryOrchestrator: createAiFactoryOrchestrator(),
};
