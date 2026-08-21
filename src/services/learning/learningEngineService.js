'use strict';

const crypto = require('crypto');
const path = require('path');

const { createEventLog } = require('../../data/eventLog');
const strategyLibraryModule = require('../library/strategyLibraryService');
const aiMemoryModule = require('../memory/aiMemoryService');
const strategyBrainModule = require('../brain/strategyBrainService');
const marketDnaService = require('../market/marketDnaService');

const LEARNING_VERSION = 'learning-engine-v1';
const DEFAULT_EVENTS_FILE = path.resolve(__dirname, '../../../data/learning-engine/events.jsonl');

const EVENT_TYPES = Object.freeze({
  LEARNING_RECORDED: 'LEARNING_RECORDED',
  STRATEGY_KNOWLEDGE_RECORDED: 'STRATEGY_KNOWLEDGE_RECORDED',
});

const SAFETY = Object.freeze({
  source: 'learning_engine',
  mode: 'paper_only',
  paper_only: true,
  readOnlyExternalSources: true,
  writesOwnAppendOnlyLog: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const ACTIONS = Object.freeze({
  REPLAY: 'replay',
  OPTIMIZE: 'optimize',
  APPROVAL: 'approval',
  IDLE: 'idle',
});

function text(value, fallback = null) {
  if (value == null) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

function arr(value) {
  return Array.isArray(value) ? value.filter((row) => row != null) : [];
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 2) {
  const n = num(value);
  if (n == null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function lower(value) {
  return text(value, '').toLowerCase();
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.keys(value).sort().reduce((acc, key) => {
    if (['at', 'recordedAt', 'createdAt', 'timestamp', 'generatedAt'].includes(key)) return acc;
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

function learningRecordIdFor(input = {}) {
  return `learning_${stableHash({
    version: LEARNING_VERSION,
    replayRunId: input.replayRunId,
    strategyId: input.strategyId,
    experimentKey: input.experimentKey,
    dnaHash: input.dnaHash,
    marketDnaHash: input.marketDnaHash,
    replayMode: input.replayMode,
  }).slice(0, 24)}`;
}

function knowledgeIdFor(record = {}) {
  return `knowledge_${stableHash({
    version: LEARNING_VERSION,
    learningRecordId: record.learningRecordId,
    strategyId: record.strategyId,
    dnaHash: record.dnaHash,
    marketDnaHash: record.marketDna?.marketDnaHash,
    replayMode: record.replayMode,
    conclusion: record.why?.code,
  }).slice(0, 24)}`;
}

function replayFingerprint(row = {}) {
  return stableHash({
    strategyId: row.strategyId,
    runId: row.runId,
    mode: row.mode,
    from: row.from,
    to: row.to,
    trades: row.trades,
    winRate: row.winRate,
    strategyPnlUsd: row.strategyPnlUsd,
    profitFactor: row.profitFactor,
    maxDrawdownUsd: row.maxDrawdownUsd,
    strategyScore: row.strategyScore,
    executionScore: row.executionScore,
    marketDnaHash: row.marketDnaHash,
    marketRegimeKey: row.marketRegimeKey,
    marketRegimeKeys: row.marketRegimeKeys,
    qualified: row.qualified,
  });
}

function scoreAtReplay(library, replay = {}, scoreType) {
  if (!library || typeof library.getHistory !== 'function' || !scoreType) return null;
  const history = arr(library.getHistory(replay.strategyId, {
    types: [strategyLibraryModule.EVENT_TYPES.SCORE_UPDATED],
  }));
  const replayTime = replay.recordedAt || replay.at || null;
  const replayRecordedAt = replayTime ? Date.parse(replayTime) : null;
  const eligible = history
    .filter((event) => event.scoreType === scoreType)
    .filter((event) => {
      const t = Date.parse(event.recordedAt || event.at || 0);
      return !Number.isFinite(replayRecordedAt) || !Number.isFinite(t) || t >= replayRecordedAt;
    });
  return num(eligible[0]?.value);
}

function latestStrategyRecord(library, strategyId) {
  if (!library || typeof library.getStrategy !== 'function') return null;
  try {
    return library.getStrategy(strategyId);
  } catch (_) {
    return null;
  }
}

function findReplayResult(library, { replayRunId, strategyId } = {}) {
  if (!library || typeof library.getAuditTrail !== 'function') {
    return { ok: false, reason: 'learning_requires_strategy_library_audit_trail' };
  }
  const runId = text(replayRunId);
  const id = text(strategyId);
  if (!runId) return { ok: false, reason: 'learning_requires_replay_run_id' };

  const rows = arr(library.getAuditTrail({
    types: [strategyLibraryModule.EVENT_TYPES.REPLAY_RECORDED],
  })).filter((event) => text(event.runId) === runId)
    .filter((event) => !id || text(event.strategyId) === id);

  if (!rows.length) return { ok: false, reason: 'learning_replay_result_not_found', replayRunId: runId, strategyId: id };
  if (!id && new Set(rows.map((row) => text(row.strategyId))).size > 1) {
    return { ok: false, reason: 'learning_requires_strategy_id_for_multi_strategy_replay', replayRunId: runId };
  }

  const fingerprints = new Set(rows.map(replayFingerprint));
  if (fingerprints.size > 1) {
    return { ok: false, reason: 'learning_conflicting_replay_results', replayRunId: runId, strategyId: id };
  }

  return { ok: true, replay: rows[rows.length - 1], duplicateSourceEvents: rows.length - 1 };
}

function experimentMatchesReplay(experiment = {}, replay = {}) {
  const libraryRef = experiment.libraryRef || {};
  const refMatches = text(libraryRef.libraryRunId || libraryRef.runId) === text(replay.runId);
  const provenanceMatches = arr(experiment.provenance).some((row) => text(row.runId) === text(replay.runId));
  if (!refMatches && !provenanceMatches) return false;
  const refStrategyId = text(libraryRef.strategyId);
  if (refStrategyId && refStrategyId !== text(replay.strategyId)) return false;
  return true;
}

function findExperiment(memory, replay = {}) {
  if (!memory || typeof memory.listExperiments !== 'function') {
    return { ok: false, reason: 'learning_requires_ai_memory_experiment_index' };
  }
  const matches = arr(memory.listExperiments({ validForLearning: true }))
    .filter((experiment) => experimentMatchesReplay(experiment, replay));
  if (!matches.length) {
    return {
      ok: false,
      reason: 'learning_experiment_not_found_in_ai_memory',
      replayRunId: text(replay.runId),
      strategyId: text(replay.strategyId),
    };
  }
  const identities = new Set(matches.map((row) => stableHash(row.identity || {})));
  if (identities.size > 1) {
    return {
      ok: false,
      reason: 'learning_ambiguous_ai_memory_experiment',
      replayRunId: text(replay.runId),
      strategyId: text(replay.strategyId),
    };
  }
  return { ok: true, experiment: matches[0] };
}

function marketDnaFrom(replay = {}, experiment = {}) {
  const provenanceRegimes = arr(experiment.provenance).flatMap((row) => arr(row.regimeKeys));
  const regimeKeys = arr(replay.marketRegimeKeys).length
    ? arr(replay.marketRegimeKeys).map(text).filter(Boolean)
    : provenanceRegimes.map(text).filter(Boolean);
  const marketDnaHash = text(replay.marketDnaHash)
    || text(experiment.identity?.marketDnaHash)
    || marketDnaService.combineMarketDnaHashes(regimeKeys);
  return {
    marketDnaHash,
    regimeKey: text(replay.marketRegimeKey) || (regimeKeys.length === 1 ? regimeKeys[0] : null),
    regimeKeys: [...new Set(regimeKeys)].sort(),
    classification: text(replay.marketClassification),
    traits: null,
    version: marketDnaService.DNA_VERSION,
    source: text(replay.marketDnaHash) ? 'strategy_library' : 'ai_memory',
  };
}

function brainAnalysis(brain, library, replay = {}) {
  if (!brain || typeof brain.analyze !== 'function') {
    return { ok: false, reason: 'learning_requires_strategy_brain' };
  }
  try {
    return brain.analyze({
      library,
      replayMode: text(replay.mode) || 'strategy',
      executionModel: 'simulated_fill',
    });
  } catch (err) {
    return { ok: false, reason: 'strategy_brain_read_failed', error: err.message || String(err) };
  }
}

function brainRowFor(analysis = {}, strategyId) {
  return arr(analysis.strategies).find((row) => text(row.strategyId) === text(strategyId)) || null;
}

function classifyOutcome(metrics = {}) {
  if (num(metrics.trades, 0) <= 0) return { code: 'no_trades', succeeded: false };
  if (num(metrics.trades, 0) < 20) return { code: 'needs_more_samples', succeeded: false };
  if (metrics.qualified === true) return { code: 'qualified_replay', succeeded: true };
  if (num(metrics.strategyScore) != null && num(metrics.strategyScore) >= 60) {
    return { code: 'strategy_worked_in_market', succeeded: true };
  }
  if (num(metrics.profitFactor) != null && num(metrics.profitFactor) < 1) {
    return { code: 'loss_making_in_market', succeeded: false };
  }
  return { code: 'mixed_result', succeeded: false };
}

function improvementFrom(metrics = {}, outcome = {}) {
  const weak = [];
  if (num(metrics.trades, 0) < 20) weak.push('sample_size');
  if (num(metrics.strategyScore, 100) < 60) weak.push('strategy_score');
  if (num(metrics.executionScore, 100) < 55) weak.push('execution_score');
  if (num(metrics.confidenceScore, 100) < 55) weak.push('confidence_score');
  if (num(metrics.profitFactor, 2) < 1) weak.push('profit_factor');
  return {
    needed: outcome.succeeded !== true || weak.length > 0,
    focus: weak[0] || null,
    weakSignals: weak,
    reason: weak[0] || (outcome.succeeded ? 'quality_above_threshold' : 'mixed_result'),
  };
}

function actionFromBrain(brainRow = null) {
  const action = lower(brainRow?.recommendation?.action || brainRow?.action);
  if (['optimize', 'improve'].includes(action)) return ACTIONS.OPTIMIZE;
  if (['paper', 'candidate', 'approval', 'promote'].includes(action)) return ACTIONS.APPROVAL;
  if (['re_test', 'replay', 'test', 'knowledge_gap'].includes(action)) return ACTIONS.REPLAY;
  return null;
}

function recommendedAction(metrics = {}, outcome = {}, improvement = {}, brainRow = null) {
  const brainAction = actionFromBrain(brainRow);
  if (brainAction) return brainAction;
  if (num(metrics.trades, 0) < 20) return ACTIONS.REPLAY;
  if (improvement.needed) return ACTIONS.OPTIMIZE;
  if (outcome.succeeded) return ACTIONS.APPROVAL;
  return ACTIONS.IDLE;
}

function conclusionSummary(strategyId, marketDna, outcome) {
  const market = text(marketDna.classification)
    || text(marketDna.regimeKey)
    || 'unknown_market';
  if (outcome.code === 'qualified_replay' || outcome.code === 'strategy_worked_in_market') {
    return `${strategyId} worked in ${market}.`;
  }
  if (outcome.code === 'needs_more_samples') return `${strategyId} needs more samples in ${market}.`;
  if (outcome.code === 'loss_making_in_market') return `${strategyId} was weak in ${market}.`;
  if (outcome.code === 'no_trades') return `${strategyId} produced no trades in ${market}.`;
  return `${strategyId} gave a mixed result in ${market}.`;
}

function buildLearningRecord({ replay, experiment, strategyRecord, brain, library } = {}) {
  const strategyId = text(replay.strategyId);
  const marketDna = marketDnaFrom(replay, experiment);
  const dnaHash = text(experiment.identity?.strategyDnaHash) || text(strategyRecord?.currentDnaHash);
  const replayMode = text(experiment.identity?.replayMode) || text(replay.mode) || 'strategy';
  const confidenceScore = scoreAtReplay(library, replay, strategyLibraryModule.SCORE_TYPES.CONFIDENCE)
    ?? num(strategyRecord?.confidenceScore);
  const metrics = {
    trades: num(replay.trades, 0),
    winRate: round(replay.winRate),
    drawdown: round(replay.maxDrawdownUsd),
    profitFactor: replay.profitFactor == null ? null : round(replay.profitFactor, 3),
    strategyScore: num(replay.strategyScore) ?? num(strategyRecord?.strategyScore),
    executionScore: num(replay.executionScore) ?? num(strategyRecord?.executionScore),
    confidenceScore,
    qualified: replay.qualified === true,
  };
  const outcome = classifyOutcome(metrics);
  const improvement = improvementFrom(metrics, outcome);
  const brainRow = brainRowFor(brain, strategyId);
  const action = recommendedAction(metrics, outcome, improvement, brainRow);
  const learningRecordId = learningRecordIdFor({
    replayRunId: replay.runId,
    strategyId,
    experimentKey: experiment.experimentKey,
    dnaHash,
    marketDnaHash: marketDna.marketDnaHash,
    replayMode,
  });
  const why = {
    code: outcome.code,
    summary: conclusionSummary(strategyId, marketDna, outcome),
    evidence: {
      trades: metrics.trades,
      winRate: metrics.winRate,
      profitFactor: metrics.profitFactor,
      strategyScore: metrics.strategyScore,
      executionScore: metrics.executionScore,
      confidenceScore: metrics.confidenceScore,
    },
  };
  return {
    learningRecordId,
    learningVersion: LEARNING_VERSION,
    replayRunId: text(replay.runId),
    experimentKey: text(experiment.experimentKey),
    strategyId,
    dnaHash,
    marketDna,
    replayMode,
    executionModel: text(experiment.identity?.executionModel),
    trades: metrics.trades,
    winrate: metrics.winRate,
    winRate: metrics.winRate,
    drawdown: metrics.drawdown,
    profitFactor: metrics.profitFactor,
    strategyScore: metrics.strategyScore,
    executionScore: metrics.executionScore,
    confidenceScore: metrics.confidenceScore,
    succeeded: outcome.succeeded,
    why,
    improvement,
    recommendedNextAction: action,
    recommendation: {
      action,
      reason: why.code,
      strategyId,
      replayRunId: text(replay.runId),
      learningRecordId,
    },
    brain: {
      ok: brain?.ok === true,
      action: brainRow?.recommendation?.action || null,
      reason: brainRow?.recommendation?.reason || brainRow?.recommendation?.motivation || null,
      knowledgeScore: brainRow?.knowledgeScore ?? null,
      gaps: arr(brainRow?.gaps).map((gap) => ({
        type: text(gap.type),
        informationValue: num(gap.informationValue),
      })),
    },
    sourceRefs: {
      strategyLibrary: {
        strategyId,
        libraryRunId: text(replay.runId),
        eventType: strategyLibraryModule.EVENT_TYPES.REPLAY_RECORDED,
      },
      aiMemory: {
        experimentKey: text(experiment.experimentKey),
        libraryRunId: text(experiment.libraryRef?.libraryRunId),
      },
      marketDna: {
        version: marketDnaService.DNA_VERSION,
        marketDnaHash: marketDna.marketDnaHash,
      },
      strategyBrain: {
        version: brain?.brainVersion || null,
      },
    },
    ...SAFETY,
  };
}

function knowledgeFromRecord(record = {}) {
  const knowledgeId = knowledgeIdFor(record);
  return {
    knowledgeId,
    learningRecordId: record.learningRecordId,
    replayRunId: record.replayRunId,
    strategyId: record.strategyId,
    dnaHash: record.dnaHash,
    marketDnaHash: record.marketDna?.marketDnaHash || null,
    marketRegimeKey: record.marketDna?.regimeKey || null,
    marketRegimeKeys: arr(record.marketDna?.regimeKeys),
    replayMode: record.replayMode,
    conclusion: record.why?.summary || null,
    conclusionCode: record.why?.code || null,
    succeeded: record.succeeded === true,
    strength: round(((num(record.strategyScore, 0) + num(record.executionScore, 0) + num(record.confidenceScore, 0)) / 3), 2),
    evidence: {
      trades: record.trades,
      winrate: record.winrate,
      profitFactor: record.profitFactor,
      drawdown: record.drawdown,
      strategyScore: record.strategyScore,
      executionScore: record.executionScore,
      confidenceScore: record.confidenceScore,
    },
    recommendedNextAction: record.recommendedNextAction,
    improvement: record.improvement,
    ...SAFETY,
  };
}

function blankRecord(learningRecordId) {
  return {
    learningRecordId,
    learningRecord: null,
    knowledge: null,
    replayRunId: null,
    strategyId: null,
    eventCount: 0,
    created: null,
    lastUpdated: null,
  };
}

function applyEvent(record, event) {
  const next = { ...record };
  next.eventCount += 1;
  next.lastUpdated = event.recordedAt || event.at;
  if (!next.created) next.created = event.at;
  if (event.type === EVENT_TYPES.LEARNING_RECORDED) {
    next.learningRecord = event.learningRecord || next.learningRecord;
    next.replayRunId = text(event.replayRunId) || next.replayRunId;
    next.strategyId = text(event.strategyId) || next.strategyId;
  }
  if (event.type === EVENT_TYPES.STRATEGY_KNOWLEDGE_RECORDED) {
    next.knowledge = event.knowledge || next.knowledge;
  }
  return next;
}

function createLearningEngine(options = {}) {
  const log = createEventLog({
    file: options.eventsFile || DEFAULT_EVENTS_FILE,
    keyField: 'learningRecordId',
    eventTypes: Object.values(EVENT_TYPES),
    now: options.now,
    label: 'learning_engine',
  });
  const library = options.strategyLibrary || options.library || strategyLibraryModule.defaultStrategyLibrary;
  const memory = options.aiMemory || options.memory || aiMemoryModule.defaultAiMemory;
  const brain = options.strategyBrain || strategyBrainModule.createStrategyBrain({ memory });

  function project() {
    return log.project(blankRecord, applyEvent);
  }

  function getLearningRecords() {
    return [...project().values()]
      .map((row) => row.learningRecord)
      .filter(Boolean)
      .sort((a, b) => String(a.replayRunId).localeCompare(String(b.replayRunId))
        || String(a.strategyId).localeCompare(String(b.strategyId)));
  }

  function getKnowledgeRecords() {
    return [...project().values()]
      .map((row) => row.knowledge)
      .filter(Boolean)
      .sort((a, b) => String(a.replayRunId).localeCompare(String(b.replayRunId))
        || String(a.strategyId).localeCompare(String(b.strategyId)));
  }

  function findExistingLearningRecord({ replayRunId, strategyId } = {}) {
    const runId = text(replayRunId);
    const id = text(strategyId);
    return getLearningRecords().find((row) => row.replayRunId === runId && (!id || row.strategyId === id)) || null;
  }

  function learnFromReplay(input = {}) {
    const existing = findExistingLearningRecord(input);
    if (existing) {
      return {
        ok: true,
        created: false,
        duplicate: true,
        learningRecord: existing,
        knowledge: getKnowledgeRecords().find((row) => row.learningRecordId === existing.learningRecordId) || null,
        ...SAFETY,
      };
    }

    const replayResult = findReplayResult(library, input);
    if (!replayResult.ok) return { ...replayResult, ...SAFETY };

    const experimentResult = findExperiment(memory, replayResult.replay);
    if (!experimentResult.ok) return { ...experimentResult, ...SAFETY };

    const strategyRecord = latestStrategyRecord(library, replayResult.replay.strategyId) || {};
    const brainResult = brainAnalysis(brain, library, replayResult.replay);
    const learningRecord = buildLearningRecord({
      replay: replayResult.replay,
      experiment: experimentResult.experiment,
      strategyRecord,
      brain: brainResult,
      library,
    });
    const knowledge = knowledgeFromRecord(learningRecord);

    log.append(learningRecord.learningRecordId, EVENT_TYPES.LEARNING_RECORDED, {
      replayRunId: learningRecord.replayRunId,
      strategyId: learningRecord.strategyId,
      learningRecord,
      requestedBy: text(input.requestedBy) || 'learning_engine',
    });
    log.append(learningRecord.learningRecordId, EVENT_TYPES.STRATEGY_KNOWLEDGE_RECORDED, {
      replayRunId: learningRecord.replayRunId,
      strategyId: learningRecord.strategyId,
      knowledge,
      requestedBy: text(input.requestedBy) || 'learning_engine',
    });

    return {
      ok: true,
      created: true,
      duplicate: false,
      learningRecord,
      knowledge,
      duplicateSourceEvents: replayResult.duplicateSourceEvents,
      ...SAFETY,
    };
  }

  function getStrategyKnowledge(strategyId = null) {
    const id = text(strategyId);
    const items = getKnowledgeRecords().filter((row) => !id || row.strategyId === id);
    return {
      ok: true,
      strategyId: id,
      items,
      count: items.length,
      appendOnly: true,
      ...SAFETY,
    };
  }

  function getLearningSummary(query = {}) {
    const records = getLearningRecords();
    const knowledge = getKnowledgeRecords();
    const latest = records[records.length - 1] || null;
    const recommendations = records
      .filter((row) => row.recommendation)
      .map((row) => ({
        ...row.recommendation,
        marketDnaHash: row.marketDna?.marketDnaHash || null,
        reason: row.why?.code || row.recommendation.reason,
      }));
    const byStrategy = {};
    for (const record of records) {
      const bucket = byStrategy[record.strategyId] || { strategyId: record.strategyId, records: 0, succeeded: 0, failed: 0, lastReplayRunId: null };
      bucket.records += 1;
      bucket.succeeded += record.succeeded ? 1 : 0;
      bucket.failed += record.succeeded ? 0 : 1;
      bucket.lastReplayRunId = record.replayRunId;
      bucket.lastRecommendedNextAction = record.recommendedNextAction;
      byStrategy[record.strategyId] = bucket;
    }
    const limit = Math.abs(num(query.limit, 20));
    return {
      ok: true,
      learningVersion: LEARNING_VERSION,
      records: records.length,
      knowledgeItems: knowledge.length,
      latestRecord: latest,
      recommendations: limit ? recommendations.slice(-limit) : recommendations,
      byStrategy: Object.values(byStrategy).sort((a, b) => String(a.strategyId).localeCompare(String(b.strategyId))),
      appendOnly: true,
      log: log.stats(),
      ...SAFETY,
    };
  }

  function getStatus() {
    const summary = getLearningSummary({ limit: 10 });
    return {
      ok: true,
      learningVersion: LEARNING_VERSION,
      records: summary.records,
      knowledgeItems: summary.knowledgeItems,
      latestRecord: summary.latestRecord,
      recommendations: summary.recommendations,
      appendOnly: true,
      ...SAFETY,
    };
  }

  return Object.freeze({
    SAFETY,
    ACTIONS,
    EVENT_TYPES,
    LEARNING_VERSION,
    eventsFile: log.file,
    learnFromReplay,
    getLearningRecords,
    getStrategyKnowledge,
    getLearningSummary,
    getStatus,
    _internal: {
      stableHash,
      stableStringify,
      canonical,
      buildLearningRecord,
      knowledgeFromRecord,
      findReplayResult,
      findExperiment,
      marketDnaFrom,
      classifyOutcome,
      recommendedAction,
      log,
    },
  });
}

const defaultLearningEngine = createLearningEngine();

module.exports = {
  SAFETY,
  ACTIONS,
  EVENT_TYPES,
  LEARNING_VERSION,
  DEFAULT_EVENTS_FILE,
  createLearningEngine,
  defaultLearningEngine,
  _internal: {
    stableHash,
    stableStringify,
    canonical,
    buildLearningRecord,
    knowledgeFromRecord,
    findReplayResult,
    findExperiment,
    marketDnaFrom,
    classifyOutcome,
    recommendedAction,
  },
};
