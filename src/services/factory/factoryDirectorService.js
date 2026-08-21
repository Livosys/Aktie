'use strict';

const crypto = require('crypto');

const strategyBrainModule = require('../brain/strategyBrainService');
const strategyRuntimeModule = require('../strategyRuntimeService');
const replaySchedulerModule = require('../replaySchedulerService');
const replayQueueModule = require('../replayQueueService');
const backfillModule = require('../backfill/ibHistoricalBackfillService');
const optimizerModule = require('../optimizer/aiOptimizerService');
const evolutionModule = require('../evolution/evolutionEngineService');
const strategyLibraryModule = require('../library/strategyLibraryService');
const aiMemoryModule = require('../memory/aiMemoryService');
const learningModule = require('../learning/learningEngineService');
const approvalModule = require('../automationApprovalService');
const marketIntelligenceModule = require('../market/marketIntelligenceService');

const DIRECTOR_VERSION = 'factory-director-v1';

const SAFETY = Object.freeze({
  source: 'factory_director',
  mode: 'paper_only',
  paper_only: true,
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const ALLOWED_SERVICES = Object.freeze([
  'Strategy Brain',
  'Strategy Runtime',
  'Replay Scheduler',
  'Replay Queue',
  'Backfill Service',
  'AI Optimizer',
  'Evolution Engine',
  'Strategy Library',
  'AI Memory',
  'Learning Engine',
  'Approval Service',
  'Market Intelligence',
]);

const ACTIONS = Object.freeze({
  SAFETY: 'SAFETY_HOLD',
  BACKFILL: 'REQUEST_BACKFILL_SERVICE',
  KNOWLEDGE_GAP: 'REQUEST_REPLAY_SCHEDULER',
  REPLAY: 'REQUEST_REPLAY_QUEUE',
  OPTIMIZER: 'REQUEST_AI_OPTIMIZER',
  EVOLUTION: 'REQUEST_EVOLUTION_ENGINE',
  APPROVAL: 'REQUEST_APPROVAL_SERVICE',
  IDLE: 'IDLE',
});

const PRIORITIES = Object.freeze({
  [ACTIONS.SAFETY]: 1,
  [ACTIONS.BACKFILL]: 2,
  [ACTIONS.KNOWLEDGE_GAP]: 3,
  [ACTIONS.REPLAY]: 4,
  [ACTIONS.OPTIMIZER]: 5,
  [ACTIONS.EVOLUTION]: 6,
  [ACTIONS.APPROVAL]: 7,
  [ACTIONS.IDLE]: 8,
});

function text(value, fallback = null) {
  if (value == null) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function lower(value) {
  return text(value, '').toLowerCase();
}

function bool(value) {
  return value === true || lower(value) === 'true';
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function arr(value) {
  return Array.isArray(value) ? value.filter((row) => row != null) : [];
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'function') return '[Function]';
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.keys(value).sort().reduce((acc, key) => {
    if (['createdAt', 'generatedAt', 'timestamp', 'now'].includes(key)) return acc;
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

function iso(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function service(snapshot, ...names) {
  for (const name of names) {
    if (snapshot && snapshot[name]) return snapshot[name];
    if (snapshot && snapshot.services && snapshot.services[name]) return snapshot.services[name];
  }
  return null;
}

function readCall(label, target, method, args = []) {
  if (!target || typeof target[method] !== 'function') return null;
  try {
    return target[method](...args);
  } catch (err) {
    return {
      ok: false,
      service: label,
      method,
      error: err.message || String(err),
    };
  }
}

function readFirst(label, target, methods = [], args = []) {
  for (const method of methods) {
    const result = readCall(label, target, method, args);
    if (result) return result;
  }
  return null;
}

function runIdFor(input = {}, snapshot = {}) {
  return text(input.runId)
    || text(snapshot.runId)
    || `factory_director_run_${stableHash(snapshot).slice(0, 20)}`;
}

function createdAtFor(input = {}, snapshot = {}) {
  if (input.now) return iso(input.now);
  if (snapshot.generatedAt) return iso(snapshot.generatedAt);
  return iso(snapshot.createdAt || null);
}

function statusCount(status = {}, ...keys) {
  for (const key of keys) {
    if (status[key] !== undefined && status[key] !== null) return number(status[key], 0);
    if (status.summary && status.summary[key] !== undefined && status.summary[key] !== null) {
      return number(status.summary[key], 0);
    }
  }
  return 0;
}

function replayWork(status = {}) {
  const queue = service(status, 'replayQueue', 'queue') || {};
  return {
    pending: statusCount(queue, 'pending') + arr(queue.pending_jobs).length,
    active: statusCount(queue, 'running', 'active') + arr(queue.running_jobs).length,
    paused: bool(queue.paused) || bool(queue.summary && queue.summary.paused),
  };
}

function hasReplayWork(status = {}) {
  const work = replayWork(status);
  return work.pending > 0 || work.active > 0;
}

function backfillNeed(status = {}) {
  const backfill = service(status, 'backfill', 'backfillService') || {};
  const rawStatus = lower(backfill.status || backfill.state || (backfill.progress && backfill.progress.status));
  const pending = statusCount(backfill, 'pending', 'pendingSegments', 'pending_segments')
    + arr(backfill.pendingSegments).length
    + arr(backfill.missingRanges).length
    + arr(backfill.gaps).length;
  const needed = bool(backfill.needsBackfill)
    || bool(backfill.needs_backfill)
    || ['planned', 'pending', 'running', 'paused', 'needed', 'needs_backfill', 'segment_completed'].includes(rawStatus)
    || pending > 0;
  if (!needed) return null;
  return {
    status: rawStatus || 'needed',
    pending,
    reason: text(backfill.reason || backfill.blockedReason) || 'historical_backfill_required',
  };
}

function nextKnowledgeGap(status = {}) {
  const brain = service(status, 'brain', 'strategyBrain') || {};
  if (brain.nextReplay) return brain.nextReplay;
  if (brain.knowledgeGap) return brain.knowledgeGap;
  const priority = arr(brain.priority);
  const selected = priority.find((row) => number(row.informationGain, 0) > 0);
  if (selected) return selected;
  const systemic = brain.systemic || {};
  const untested = arr(systemic.regimesNoStrategyHasSeen || systemic.untestedByAnyone);
  if (untested.length) return { type: 'systemic_market_gap', regimes: untested };
  const learning = service(status, 'learning', 'learningEngine') || {};
  const replayRecommendation = arr(learning.recommendations)
    .find((row) => ['replay', 're_test', 'request_replay_scheduler'].includes(lower(row.action || row.recommendedNextAction)));
  if (replayRecommendation) {
    return {
      type: 'learning_replay_recommendation',
      strategyId: text(replayRecommendation.strategyId),
      reason: text(replayRecommendation.reason) || 'learning_summary_requested_replay',
      learningRecordId: text(replayRecommendation.learningRecordId),
    };
  }
  return null;
}

function optimizerNeed(status = {}) {
  const brain = service(status, 'brain', 'strategyBrain') || {};
  const optimizer = service(status, 'aiOptimizer', 'optimizer') || {};
  const library = service(status, 'strategyLibrary', 'library') || {};
  const learning = service(status, 'learning', 'learningEngine') || {};
  const learningOptimize = arr(learning.recommendations)
    .filter((row) => ['optimize', 'request_ai_optimizer'].includes(lower(row.action || row.recommendedNextAction)));
  const optimizeIds = arr(brain.recommendations && brain.recommendations.optimize);
  if (learningOptimize.length) {
    return {
      strategyIds: learningOptimize.map((row) => row.strategyId).filter(Boolean),
      reason: 'learning_summary_requested_optimization',
    };
  }
  if (optimizeIds.length) return { strategyIds: optimizeIds, reason: 'strategy_brain_requested_optimization' };
  if (bool(optimizer.pending) || bool(optimizer.needsOptimization) || bool(optimizer.needs_optimization)) {
    return { strategyIds: arr(optimizer.strategyIds), reason: text(optimizer.reason) || 'optimizer_pending' };
  }
  const rows = arr(library.strategies || library.records);
  const flagged = rows.filter((row) => bool(row.belowQuality)
    || bool(row.below_quality)
    || ['below_threshold', 'needs_optimization', 'weak_quality'].includes(lower(row.qualityStatus || row.status)));
  if (flagged.length) {
    return { strategyIds: flagged.map((row) => row.strategyId || row.id).filter(Boolean), reason: 'library_quality_flag' };
  }
  return null;
}

function evolutionNeed(status = {}) {
  const evolution = service(status, 'evolution', 'evolutionEngine') || {};
  const optimizer = service(status, 'aiOptimizer', 'optimizer') || {};
  const pending = statusCount(evolution, 'pending', 'pendingMutations', 'pending_mutations')
    + statusCount(optimizer, 'candidates', 'pendingCandidates', 'pending_candidates');
  if (pending <= 0 && !bool(evolution.pending) && !bool(evolution.needsLineage)) return null;
  return {
    pending,
    reason: text(evolution.reason || optimizer.reason) || 'optimizer_candidates_require_lineage',
  };
}

function approvalNeed(status = {}) {
  const approval = service(status, 'approval', 'approvalService') || {};
  const brain = service(status, 'brain', 'strategyBrain') || {};
  const learning = service(status, 'learning', 'learningEngine') || {};
  const waiting = arr(approval.waitingForApproval);
  const paper = arr(brain.recommendations && brain.recommendations.paper);
  const learningApproval = arr(learning.recommendations)
    .filter((row) => ['approval', 'paper', 'request_approval_service'].includes(lower(row.action || row.recommendedNextAction)));
  const candidates = arr(approval.candidates || approval.pendingCandidates || approval.pending_candidates);
  if (!waiting.length && !paper.length && !learningApproval.length && !candidates.length && !bool(approval.pending)) return null;
  return {
    count: waiting.length + paper.length + learningApproval.length + candidates.length + (bool(approval.pending) ? 1 : 0),
    reason: text(approval.reason) || (learningApproval.length ? 'learning_summary_requested_approval' : 'candidate_requires_manual_approval'),
  };
}

function safetyBlockers(status = {}) {
  const blockers = [];
  const safety = status.safety || {};
  if (safety.ok === false || bool(safety.blocked) || bool(safety.halted)) {
    blockers.push(text(safety.reason || safety.error) || 'factory_safety_blocked');
  }
  for (const key of [
    'brain',
    'strategyRuntime',
    'replayScheduler',
    'replayQueue',
    'backfill',
    'aiOptimizer',
    'evolution',
    'strategyLibrary',
    'aiMemory',
    'learning',
    'approval',
    'marketIntelligence',
  ]) {
    const row = service(status, key) || {};
    if (row.ok === false) blockers.push(`${key}:${text(row.error || row.reason) || 'service_not_ok'}`);
    if (lower(row.status) === 'blocked') blockers.push(`${key}:blocked`);
  }
  return [...new Set(blockers)].sort();
}

function assignmentFor(action, evidence = {}) {
  if (action === ACTIONS.SAFETY) return { service: 'Factory Director', instruction: 'hold', payload: evidence };
  if (action === ACTIONS.BACKFILL) return { service: 'Backfill Service', instruction: 'prepare_backfill', payload: evidence };
  if (action === ACTIONS.KNOWLEDGE_GAP) return { service: 'Replay Scheduler', instruction: 'schedule_from_brain_gap', payload: evidence };
  if (action === ACTIONS.REPLAY) return { service: 'Replay Queue', instruction: 'process_existing_replay_work', payload: evidence };
  if (action === ACTIONS.OPTIMIZER) return { service: 'AI Optimizer', instruction: 'prepare_dna_candidates', payload: evidence };
  if (action === ACTIONS.EVOLUTION) return { service: 'Evolution Engine', instruction: 'create_generation_lineage', payload: evidence };
  if (action === ACTIONS.APPROVAL) return { service: 'Approval Service', instruction: 'request_manual_decision', payload: evidence };
  return { service: 'Factory Director', instruction: 'idle', payload: evidence };
}

function selectAction(status = {}) {
  const blockers = safetyBlockers(status);
  if (blockers.length) {
    return {
      action: ACTIONS.SAFETY,
      reason: blockers[0],
      evidence: { blockers },
    };
  }

  const backfill = backfillNeed(status);
  if (backfill) {
    return {
      action: ACTIONS.BACKFILL,
      reason: backfill.reason,
      evidence: backfill,
    };
  }

  const gap = nextKnowledgeGap(status);
  if (gap && !hasReplayWork(status)) {
    return {
      action: ACTIONS.KNOWLEDGE_GAP,
      reason: text(gap.reason) || text(gap.type) || 'strategy_brain_found_knowledge_gap',
      evidence: { gap },
    };
  }

  const work = replayWork(status);
  if (work.active > 0 || work.pending > 0) {
    return {
      action: ACTIONS.REPLAY,
      reason: work.active > 0 ? 'replay_job_already_active' : 'replay_job_pending',
      evidence: work,
    };
  }

  const optimization = optimizerNeed(status);
  if (optimization) {
    return {
      action: ACTIONS.OPTIMIZER,
      reason: optimization.reason,
      evidence: optimization,
    };
  }

  const evolution = evolutionNeed(status);
  if (evolution) {
    return {
      action: ACTIONS.EVOLUTION,
      reason: evolution.reason,
      evidence: evolution,
    };
  }

  const approval = approvalNeed(status);
  if (approval) {
    return {
      action: ACTIONS.APPROVAL,
      reason: approval.reason,
      evidence: approval,
    };
  }

  return {
    action: ACTIONS.IDLE,
    reason: 'no_factory_action_required',
    evidence: {},
  };
}

function buildDecision(status = {}, input = {}) {
  const selected = selectAction(status);
  const runId = runIdFor(input, status);
  const requestedBy = text(input.requestedBy || input.requested_by) || 'Factory Director';
  const createdAt = createdAtFor(input, status);
  const priority = PRIORITIES[selected.action];
  const assignment = assignmentFor(selected.action, selected.evidence);
  const decisionCore = {
    directorVersion: DIRECTOR_VERSION,
    runId,
    reason: selected.reason,
    action: selected.action,
    priority,
    requestedBy,
    statusHash: stableHash(status),
    assignment,
  };
  return {
    decisionId: `factory_decision_${stableHash(decisionCore).slice(0, 24)}`,
    runId,
    reason: selected.reason,
    action: selected.action,
    priority,
    requestedBy,
    createdAt,
    status: 'recommended',
    assignment,
    evidence: selected.evidence,
    directorVersion: DIRECTOR_VERSION,
    ...SAFETY,
  };
}

function createDefaultBackfillService() {
  try {
    return backfillModule.createIbHistoricalBackfillService();
  } catch (_) {
    return null;
  }
}

function createFactoryDirector(options = {}) {
  const memory = options.aiMemory || options.memory || aiMemoryModule.defaultAiMemory;
  const library = options.strategyLibrary || options.library || strategyLibraryModule.defaultStrategyLibrary;
  const brain = options.strategyBrain || strategyBrainModule.createStrategyBrain({ memory, intelligence: marketIntelligenceModule });
  const runtime = options.strategyRuntime || strategyRuntimeModule.defaultStrategyRuntime || strategyRuntimeModule;
  const scheduler = options.replayScheduler || replaySchedulerModule.defaultReplaySchedulerService;
  const queue = options.replayQueue || replayQueueModule.defaultReplayQueueService;
  const backfill = options.backfillService === undefined ? createDefaultBackfillService() : options.backfillService;
  const optimizer = options.aiOptimizer || options.optimizer || optimizerModule.defaultAiOptimizerService;
  const evolution = options.evolutionEngine || evolutionModule.createEvolutionEngine();
  const learning = options.learningEngine || options.learning || learningModule.defaultLearningEngine;
  const approval = options.approvalService || approvalModule;
  const marketIntelligence = options.marketIntelligence || marketIntelligenceModule;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();

  function nowIso() {
    return iso(clock());
  }

  function collectSystemStatus(input = {}) {
    if (input.systemStatus && typeof input.systemStatus === 'object') {
      return {
        ...clone(input.systemStatus),
        generatedAt: text(input.systemStatus.generatedAt) || text(input.now) || '1970-01-01T00:00:00.000Z',
      };
    }

    const generatedAt = text(input.now) || nowIso();
    const snapshot = {
      ok: true,
      generatedAt,
      services: {},
      ...SAFETY,
    };

    snapshot.services.strategyLibrary = input.strategyLibraryStatus
      || readFirst('Strategy Library', library, ['getStatus']);
    snapshot.services.aiMemory = input.aiMemoryStatus
      || readFirst('AI Memory', memory, ['getStatus']);
    snapshot.services.strategyRuntime = input.strategyRuntimeStatus
      || readFirst('Strategy Runtime', runtime, ['materialize'], [input.runtimeContext || {}]);
    snapshot.services.replayScheduler = input.replaySchedulerStatus
      || readFirst('Replay Scheduler', scheduler, ['getStatus']);
    snapshot.services.replayQueue = input.replayQueueStatus
      || readFirst('Replay Queue', queue, ['getStatus']);
    snapshot.services.aiOptimizer = input.aiOptimizerStatus
      || readFirst('AI Optimizer', optimizer, ['describe']);
    snapshot.services.evolution = input.evolutionStatus
      || readFirst('Evolution Engine', evolution, ['getStatus']);
    snapshot.services.learning = input.learningSummary
      || input.learningStatus
      || readFirst('Learning Engine', learning, ['getLearningSummary', 'getStatus']);
    snapshot.services.approval = input.approvalStatus
      || readFirst('Approval Service', approval, ['getAutomationApprovals', 'getAllowlistStatus']);

    if (input.backfillStatus) {
      snapshot.services.backfill = input.backfillStatus;
    } else if (backfill) {
      snapshot.services.backfill = readFirst('Backfill Service', backfill, ['getStatus'])
        || (input.backfillRunId ? readFirst('Backfill Service', backfill, ['getProgress'], [input.backfillRunId]) : null)
        || (backfill.progress && typeof backfill.progress.stats === 'function'
          ? { ok: true, status: 'available', progress: backfill.progress.stats(), ...backfill.SAFETY }
          : null);
    } else {
      snapshot.services.backfill = null;
    }

    if (input.brainStatus) {
      snapshot.services.brain = input.brainStatus;
    } else if (brain && typeof brain.analyze === 'function' && library) {
      snapshot.services.brain = readCall('Strategy Brain', brain, 'analyze', [{
        library,
        catalog: input.catalog || null,
        now: new Date(generatedAt),
        replayMode: input.replayMode || 'strategy',
        executionModel: input.executionModel || 'simulated_fill',
      }]);
    } else {
      snapshot.services.brain = null;
    }

    if (input.marketIntelligenceStatus) {
      snapshot.services.marketIntelligence = input.marketIntelligenceStatus;
    } else if (input.includeMarketIntelligence === true && marketIntelligence && typeof marketIntelligence.buildMarketIntelligence === 'function') {
      snapshot.services.marketIntelligence = readCall('Market Intelligence', marketIntelligence, 'buildMarketIntelligence', [{
        library,
        catalog: input.catalog || null,
      }]);
    } else {
      snapshot.services.marketIntelligence = null;
    }

    snapshot.safety = {
      ok: true,
      blockers: safetyBlockers(snapshot),
      ...SAFETY,
    };
    snapshot.safety.ok = snapshot.safety.blockers.length === 0;
    return snapshot;
  }

  // ── Ett beslut per sidladdning, inte fyra ─────────────────────────────────
  //
  // /factory/director, /factory/decision, /factory/next och /factory/status är
  // fyra vyer av EXAKT samma beräkning, och fabrikssidan hämtar alla fyra.
  // Utan den här memon räknades hela fabriksbeslutet fram fyra gånger per
  // sidladdning, var femtonde sekund, per öppen flik.
  //
  // Fönstret är kort med flit. Beslutet är read-only rådgivning, och de tunga
  // delarna under har numera egna exakta avtryckscacher — memon finns bara för
  // att kollapsa de fyra samtidiga anropen, inte för att hålla ett svar vid liv.
  const DECISION_MEMO_MS = 5000;
  let memo = null;

  function decide(input = {}) {
    // En anropare som skickar in eget systemStatus äger svaret själv.
    if (input && input.systemStatus) return computeDecision(input);
    const key = stableHash(canonical(input || {}));
    const nowMs = Date.now();
    if (memo && memo.key === key && nowMs - memo.at < DECISION_MEMO_MS) return memo.value;
    const value = computeDecision(input);
    memo = { key, at: nowMs, value };
    return value;
  }

  /** Töm memon. För tester och för den som just ändrat fabrikens tillstånd. */
  function invalidateDecision() {
    memo = null;
  }

  function computeDecision(input = {}) {
    const systemStatus = collectSystemStatus(input);
    const decision = buildDecision(systemStatus, input);
    return {
      ok: true,
      directorVersion: DIRECTOR_VERSION,
      deterministic: true,
      oneDecision: true,
      decision,
      systemStatus,
      capabilities: {
        decidesNextAction: true,
        coordinatesOnly: true,
        executesWork: false,
        createsDna: false,
        optimizes: false,
        mutatesLineage: false,
        schedulesReplay: false,
        enqueuesReplay: false,
        touchesPaperRuntime: false,
        readsLearningSummary: true,
      },
      allowedServices: ALLOWED_SERVICES,
      ...SAFETY,
    };
  }

  function getDirectorState(input = {}) {
    return decide(input);
  }

  function getDecision(input = {}) {
    return decide(input).decision;
  }

  function getNext(input = {}) {
    return decide(input);
  }

  function getStatus(input = {}) {
    const current = decide(input);
    return {
      ok: true,
      directorVersion: DIRECTOR_VERSION,
      currentDecision: current.decision,
      allowedServices: ALLOWED_SERVICES,
      priorityOrder: [
        ACTIONS.SAFETY,
        ACTIONS.BACKFILL,
        ACTIONS.KNOWLEDGE_GAP,
        ACTIONS.REPLAY,
        ACTIONS.OPTIMIZER,
        ACTIONS.EVOLUTION,
        ACTIONS.APPROVAL,
        ACTIONS.IDLE,
      ],
      capabilities: current.capabilities,
      ...SAFETY,
    };
  }

  return Object.freeze({
    SAFETY,
    DIRECTOR_VERSION,
    ACTIONS,
    PRIORITIES,
    ALLOWED_SERVICES,
    collectSystemStatus,
    decide,
    getDirectorState,
    getDecision,
    getNext,
    getStatus,
    invalidateDecision,
    _internal: {
      stableHash,
      stableStringify,
      canonical,
      selectAction,
      safetyBlockers,
      backfillNeed,
      nextKnowledgeGap,
      replayWork,
      optimizerNeed,
      evolutionNeed,
      approvalNeed,
    },
  });
}

const defaultFactoryDirector = createFactoryDirector();

module.exports = {
  SAFETY,
  DIRECTOR_VERSION,
  ACTIONS,
  PRIORITIES,
  ALLOWED_SERVICES,
  createFactoryDirector,
  defaultFactoryDirector,
  _internal: {
    stableHash,
    stableStringify,
    canonical,
    selectAction,
    safetyBlockers,
    backfillNeed,
    nextKnowledgeGap,
    replayWork,
    optimizerNeed,
    evolutionNeed,
    approvalNeed,
  },
};
