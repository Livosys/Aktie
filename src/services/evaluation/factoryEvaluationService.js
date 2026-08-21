'use strict';

const crypto = require('crypto');
const path = require('path');

const { createEventLog } = require('../../data/eventLog');
const strategyLibraryModule = require('../library/strategyLibraryService');
const aiMemoryModule = require('../memory/aiMemoryService');
const learningModule = require('../learning/learningEngineService');
const replayQueueModule = require('../replayQueueService');
const familyTreeModule = require('../evolution/strategyFamilyTreeService');

const FACTORY_EVALUATION_VERSION = 'factory-evaluation-v1';
const DEFAULT_EVENTS_FILE = path.resolve(__dirname, '../../../data/factory-evaluation/events.jsonl');

const EVENT_TYPES = Object.freeze({
  FACTORY_EVALUATION_RECORDED: 'FACTORY_EVALUATION_RECORDED',
});

const SAFETY = Object.freeze({
  source: 'factory_evaluation',
  mode: 'paper_only',
  paper_only: true,
  readOnlyExternalSources: true,
  writesOwnAppendOnlyLog: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const SCORE_WEIGHTS = Object.freeze({
  knowledgeGrowth: 0.20,
  memoryReuse: 0.15,
  experimentEfficiency: 0.15,
  replayEfficiency: 0.15,
  mutationSuccessRate: 0.15,
  promotionRate: 0.10,
  survivalRate: 0.10,
});

function text(value, fallback = null) {
  if (value == null) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

function arr(value) {
  return Array.isArray(value) ? value.filter((row) => row != null) : [];
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, num(value, min)));
}

function percent(numerator, denominator) {
  const d = num(denominator, 0);
  if (d <= 0) return 0;
  return round(clamp((num(numerator, 0) / d) * 100), 2);
}

function unique(values = []) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))].sort();
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'function') return '[Function]';
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.keys(value).sort().reduce((acc, key) => {
    if (['at', 'recordedAt', 'createdAt', 'generatedAt', 'timestamp', 'lastUpdated'].includes(key)) return acc;
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

function readCall(label, target, method, args = []) {
  if (!target || typeof target[method] !== 'function') return null;
  try {
    return target[method](...args);
  } catch (err) {
    return {
      ok: false,
      source: label,
      method,
      error: err.message || String(err),
    };
  }
}

function qualityScore(row = {}) {
  const values = [
    row.factoryQualityScore,
    row.qualityScore,
    row.strategyScore,
    row.executionScore,
    row.confidenceScore,
  ].map((value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }).filter((value) => value != null);
  if (!values.length) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 2);
}

function sourceSnapshot({ library, memory, learning, replayQueue, familyTree } = {}) {
  const libraryStatus = readCall('Strategy Library', library, 'getStatus') || {};
  const strategies = arr(readCall('Strategy Library', library, 'listStrategies'));
  const libraryEvents = arr(readCall('Strategy Library', library, 'getAuditTrail', [{}]));

  const memoryStatus = readCall('AI Memory', memory, 'getStatus') || {};
  const experiments = arr(readCall('AI Memory', memory, 'listExperiments'));

  const learningSummary = readCall('Learning Engine', learning, 'getLearningSummary', [{ limit: 0 }]) || {};
  const learningRecords = arr(readCall('Learning Engine', learning, 'getLearningRecords'));
  const knowledge = arr(readCall('Learning Engine', learning, 'getStrategyKnowledge', [null])?.items)
    .concat(arr(learningSummary.knowledge || learningSummary.knowledgeItemsList));

  const queueStatus = readCall('Replay Queue', replayQueue, 'getStatus') || {};
  const queueEvents = arr(readCall('Replay Queue', replayQueue, 'readEvents'));

  const familyNodes = arr(readCall('Strategy Family Tree', familyTree, 'listNodes'));
  const familyBranches = arr(readCall('Strategy Family Tree', familyTree, 'listBranches'));
  const familyEvents = arr(readCall('Strategy Family Tree', familyTree, 'getAuditTrail', [{}]));

  return {
    libraryStatus,
    strategies,
    libraryEvents,
    memoryStatus,
    experiments,
    learningSummary,
    learningRecords,
    knowledge,
    queueStatus,
    queueEvents,
    familyNodes,
    familyBranches,
    familyEvents,
  };
}

function replayMetrics(snapshot = {}) {
  const replayEvents = arr(snapshot.libraryEvents)
    .filter((event) => event.type === strategyLibraryModule.EVENT_TYPES.REPLAY_RECORDED);
  const libraryRunIds = unique(replayEvents.map((event, index) => text(event.runId) || `library_replay_${index}`));
  const completedQueueJobs = unique([
    ...arr(snapshot.queueStatus.completed_jobs).map((job) => job.id || job.job_id),
    ...arr(snapshot.queueEvents)
      .filter((event) => event.event_type === replayQueueModule.EVENT_TYPES.JOB_COMPLETED)
      .map((event) => event.job_id),
  ]);
  return {
    replaysRun: libraryRunIds.length || completedQueueJobs.length,
    replayResultEvents: replayEvents.length,
    completedReplayJobs: completedQueueJobs.length,
    replayRunIds: libraryRunIds,
  };
}

function experimentMetrics(snapshot = {}) {
  const experiments = arr(snapshot.experiments);
  const statusRepeats = Number(snapshot.memoryStatus.repeats);
  const reuseFromObservations = experiments.reduce((total, experiment) => {
    return total + Math.max(0, num(experiment.observations, 1) - 1);
  }, 0);
  return {
    experimentsCreated: num(snapshot.memoryStatus.experiments, experiments.length) || experiments.length,
    experimentsReusedFromMemory: Number.isFinite(statusRepeats) ? statusRepeats : reuseFromObservations,
    experimentKeys: unique(experiments.map((row) => row.experimentKey)),
  };
}

function lifecycleMetrics(snapshot = {}) {
  const events = arr(snapshot.libraryEvents);
  const strategies = arr(snapshot.strategies);
  const transitions = events.filter((event) => event.type === strategyLibraryModule.EVENT_TYPES.LIFECYCLE_TRANSITION);
  const promotedTo = (stage) => unique(transitions
    .filter((event) => text(event.to) === stage)
    .map((event) => event.strategyId));
  const paperFromTrades = unique(events
    .filter((event) => event.type === strategyLibraryModule.EVENT_TYPES.PAPER_RECORDED)
    .map((event) => event.strategyId));
  const liveFromTrades = unique(events
    .filter((event) => event.type === strategyLibraryModule.EVENT_TYPES.LIVE_RECORDED)
    .map((event) => event.strategyId));
  const retired = unique([
    ...events
      .filter((event) => event.type === strategyLibraryModule.EVENT_TYPES.RETIRED)
      .map((event) => event.strategyId),
    ...strategies
      .filter((row) => row.retired === true || text(row.lifecycle) === 'retired')
      .map((row) => row.strategyId),
  ]);
  const byStage = {};
  for (const row of strategies) {
    const stage = text(row.lifecycle, 'unknown');
    byStage[stage] = (byStage[stage] || 0) + 1;
  }
  const candidate = promotedTo('candidate');
  const paper = unique([...promotedTo('paper'), ...paperFromTrades]);
  const live = unique([...promotedTo('live'), ...liveFromTrades]);
  return {
    strategiesTotal: strategies.length,
    lifecycleByStage: byStage,
    advancedToCandidate: candidate.length,
    advancedToPaper: paper.length,
    advancedToLive: live.length,
    retiredStrategies: retired.length,
    promotedStrategyIds: unique([...candidate, ...paper, ...live]),
    retiredStrategyIds: retired,
  };
}

function learningMetrics(snapshot = {}) {
  const records = arr(snapshot.learningRecords);
  const knowledgeIds = unique([
    ...arr(snapshot.knowledge).map((row) => row.knowledgeId),
    ...records.map((row) => row.learningRecordId && `knowledge_for_${row.learningRecordId}`),
  ]);
  return {
    learningRecords: records.length || num(snapshot.learningSummary.records, 0),
    knowledgeItems: knowledgeIds.length || num(snapshot.learningSummary.knowledgeItems, 0),
    learningReplayRunIds: unique(records.map((row) => row.replayRunId)),
    learningExperimentKeys: unique(records.map((row) => row.experimentKey)),
  };
}

function latestScoreByDna(snapshot = {}) {
  const rows = new Map();
  for (const record of arr(snapshot.learningRecords)) {
    const dnaHash = text(record.dnaHash);
    const score = qualityScore(record);
    if (!dnaHash || score == null) continue;
    rows.set(dnaHash, {
      dnaHash,
      score,
      replayRunId: text(record.replayRunId),
      learningRecordId: text(record.learningRecordId),
    });
  }
  for (const strategy of arr(snapshot.strategies)) {
    const dnaHash = text(strategy.currentDnaHash || strategy.dnaHash);
    const score = qualityScore(strategy);
    if (!dnaHash || score == null || rows.has(dnaHash)) continue;
    rows.set(dnaHash, {
      dnaHash,
      score,
      strategyId: text(strategy.strategyId),
    });
  }
  return rows;
}

function extinctStrategyCount(nodes = []) {
  const byRoot = new Map();
  for (const node of arr(nodes)) {
    const root = text(node.rootStrategyId || node.strategyId || node.branch);
    if (!root) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(node);
  }
  return [...byRoot.values()]
    .filter((group) => group.length > 0)
    .filter((group) => group.some((node) => num(node.generation, 0) > 0))
    .filter((group) => group.every((node) => node.retired === true))
    .length;
}

function mutationMetrics(snapshot = {}) {
  const nodes = arr(snapshot.familyNodes);
  const scores = latestScoreByDna(snapshot);
  const mutations = nodes.filter((node) => text(node.parent));
  const comparisons = mutations.map((node) => {
    const childScore = scores.get(text(node.dnaHash))?.score ?? null;
    const parentScore = scores.get(text(node.parent))?.score ?? null;
    let outcome = 'unknown';
    if (childScore != null && parentScore != null && childScore > parentScore) outcome = 'improved';
    if (childScore != null && parentScore != null && childScore < parentScore) outcome = 'worsened';
    if (childScore != null && parentScore != null && childScore === parentScore) outcome = 'unchanged';
    return {
      dnaHash: text(node.dnaHash),
      parent: text(node.parent),
      generation: num(node.generation, 0),
      branch: text(node.branch),
      childScore,
      parentScore,
      outcome,
    };
  });

  const retiredEvents = arr(snapshot.familyEvents)
    .filter((event) => [
      familyTreeModule.EVENT_TYPES.NODE_RETIRED,
      familyTreeModule.EVENT_TYPES.BRANCH_RETIRED,
    ].includes(event.type));

  return {
    mutationsCreated: mutations.length,
    mutationsImproved: comparisons.filter((row) => row.outcome === 'improved').length,
    mutationsWorsened: comparisons.filter((row) => row.outcome === 'worsened').length,
    mutationsUnchanged: comparisons.filter((row) => row.outcome === 'unchanged').length,
    mutationsUnknown: comparisons.filter((row) => row.outcome === 'unknown').length,
    mutationComparisons: comparisons,
    retiredMutationNodes: unique(retiredEvents.map((event) => event.dnaHash)).length,
    extinctStrategies: extinctStrategyCount(nodes),
    fullyRetiredBranches: arr(snapshot.familyBranches).filter((branch) => branch.fullyRetired === true).length,
  };
}

function buildCounts(snapshot = {}) {
  return {
    ...replayMetrics(snapshot),
    ...experimentMetrics(snapshot),
    ...learningMetrics(snapshot),
    ...mutationMetrics(snapshot),
    ...lifecycleMetrics(snapshot),
  };
}

function buildKpis(counts = {}) {
  const promotionBase = num(counts.strategiesTotal, 0);
  const mutationKnown = num(counts.mutationsImproved, 0) + num(counts.mutationsWorsened, 0);
  const kpis = {
    knowledgeGrowth: percent(counts.knowledgeItems, counts.replaysRun),
    memoryReuse: percent(counts.experimentsReusedFromMemory, num(counts.experimentsCreated, 0) + num(counts.experimentsReusedFromMemory, 0)),
    experimentEfficiency: percent(counts.learningExperimentKeys?.length || 0, counts.experimentsCreated),
    replayEfficiency: percent(counts.learningReplayRunIds?.length || 0, counts.replaysRun),
    mutationSuccessRate: percent(counts.mutationsImproved, mutationKnown),
    promotionRate: percent(counts.promotedStrategyIds?.length || 0, promotionBase),
    retirementRate: percent(counts.retiredStrategies, promotionBase),
  };
  kpis.survivalRate = promotionBase > 0 ? round(100 - kpis.retirementRate, 2) : 0;
  return kpis;
}

function factoryScore(kpis = {}) {
  const score = Object.entries(SCORE_WEIGHTS).reduce((total, [key, weight]) => {
    return total + clamp(kpis[key], 0, 100) * weight;
  }, 0);
  return round(score, 2);
}

function buildEvaluation({ snapshot, input = {}, now }) {
  const counts = buildCounts(snapshot);
  const kpis = buildKpis(counts);
  const sourceHash = stableHash({
    version: FACTORY_EVALUATION_VERSION,
    counts,
    kpis,
  });
  const score = factoryScore(kpis);
  return {
    ok: true,
    evaluationId: `factory_evaluation_${sourceHash.slice(0, 24)}`,
    factoryEvaluationVersion: FACTORY_EVALUATION_VERSION,
    sourceHash,
    deterministic: true,
    generatedAt: text(input.now) || new Date(now()).toISOString(),
    requestedBy: text(input.requestedBy || input.requested_by) || 'Factory Evaluation',
    counts,
    kpis,
    factoryScore: score,
    scoreFormula: {
      maxScore: 100,
      weights: SCORE_WEIGHTS,
      usesStrategyScore: false,
      usesReplayScore: false,
      description: 'Weighted score for factory efficiency: learning, reuse, experiment yield, replay yield, mutation success, promotion and survival.',
    },
    capabilities: {
      measuresOnly: true,
      coordinatesWork: false,
      runsReplay: false,
      runsBatch: false,
      createsLearning: false,
      createsExperiments: false,
      createsDna: false,
      mutatesLineage: false,
      selectsNextFactoryAction: false,
      writesExternalServices: false,
      appendOnlyOwnLog: true,
    },
    ...SAFETY,
  };
}

function blankEvaluation(evaluationId) {
  return {
    evaluationId,
    evaluation: null,
    created: null,
    lastUpdated: null,
    eventCount: 0,
  };
}

function applyEvent(record, event) {
  const next = { ...record };
  next.eventCount += 1;
  next.lastUpdated = event.recordedAt || event.at;
  if (!next.created) next.created = event.at;
  if (event.type === EVENT_TYPES.FACTORY_EVALUATION_RECORDED) {
    next.evaluation = event.evaluation || next.evaluation;
  }
  return next;
}

function createFactoryEvaluationService(options = {}) {
  const log = createEventLog({
    file: options.eventsFile || DEFAULT_EVENTS_FILE,
    keyField: 'evaluationId',
    eventTypes: Object.values(EVENT_TYPES),
    now: options.now,
    label: 'factory_evaluation',
  });
  const library = options.strategyLibrary || options.library || strategyLibraryModule.defaultStrategyLibrary;
  const memory = options.aiMemory || options.memory || aiMemoryModule.defaultAiMemory;
  const learning = options.learningEngine || options.learning || learningModule.defaultLearningEngine;
  const replayQueue = options.replayQueue || replayQueueModule.defaultReplayQueueService;
  const familyTree = options.familyTree || familyTreeModule.defaultStrategyFamilyTree;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();

  function project() {
    return log.project(blankEvaluation, applyEvent);
  }

  function history() {
    return [...project().values()]
      .map((row) => row.evaluation)
      .filter(Boolean)
      .sort((a, b) => String(a.evaluationId).localeCompare(String(b.evaluationId)));
  }

  function getEvaluation(evaluationId) {
    const id = text(evaluationId);
    if (!id) return null;
    return project().get(id)?.evaluation || null;
  }

  function evaluate(input = {}) {
    const snapshot = sourceSnapshot({ library, memory, learning, replayQueue, familyTree });
    return buildEvaluation({ snapshot, input, now: clock });
  }

  function recordEvaluation(input = {}) {
    const evaluation = evaluate(input);
    const existing = getEvaluation(evaluation.evaluationId);
    if (existing) {
      return {
        ok: true,
        created: false,
        duplicate: true,
        evaluation: existing,
        ...SAFETY,
      };
    }
    const event = log.append(evaluation.evaluationId, EVENT_TYPES.FACTORY_EVALUATION_RECORDED, {
      evaluation,
      sourceHash: evaluation.sourceHash,
      factoryScore: evaluation.factoryScore,
      requestedBy: evaluation.requestedBy,
    });
    return {
      ok: true,
      created: true,
      duplicate: false,
      evaluation,
      event,
      ...SAFETY,
    };
  }

  function getStatus(input = {}) {
    const current = evaluate(input);
    const rows = history();
    return {
      ok: true,
      factoryEvaluationVersion: FACTORY_EVALUATION_VERSION,
      current,
      evaluations: rows.length,
      latestRecorded: rows[rows.length - 1] || null,
      appendOnly: true,
      log: log.stats(),
      ...SAFETY,
    };
  }

  return Object.freeze({
    SAFETY,
    EVENT_TYPES,
    FACTORY_EVALUATION_VERSION,
    SCORE_WEIGHTS,
    eventsFile: log.file,
    evaluate,
    recordEvaluation,
    getEvaluation,
    getHistory: history,
    getStatus,
    _internal: {
      stableHash,
      stableStringify,
      canonical,
      sourceSnapshot,
      buildCounts,
      buildKpis,
      factoryScore,
      buildEvaluation,
      replayMetrics,
      experimentMetrics,
      learningMetrics,
      mutationMetrics,
      lifecycleMetrics,
      log,
    },
  });
}

const defaultFactoryEvaluationService = createFactoryEvaluationService();

module.exports = {
  SAFETY,
  EVENT_TYPES,
  FACTORY_EVALUATION_VERSION,
  SCORE_WEIGHTS,
  DEFAULT_EVENTS_FILE,
  createFactoryEvaluationService,
  defaultFactoryEvaluationService,
  _internal: {
    stableHash,
    stableStringify,
    canonical,
    sourceSnapshot,
    buildCounts,
    buildKpis,
    factoryScore,
    buildEvaluation,
    replayMetrics,
    experimentMetrics,
    learningMetrics,
    mutationMetrics,
    lifecycleMetrics,
  },
};
