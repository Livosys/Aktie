'use strict';

const crypto = require('crypto');
const path = require('path');

const { createEventLog } = require('../../data/eventLog');
const backfillModule = require('../backfill/ibHistoricalBackfillService');
const historicalPriceFeedModule = require('../historicalPriceFeedService');
const replayEngineModule = require('../../scanner/replayEngine');
const fillEngineModule = require('../execution/simulatedFillEngine');
const strategyLibraryModule = require('../library/strategyLibraryService');
const aiMemoryModule = require('../memory/aiMemoryService');
const learningModule = require('../learning/learningEngineService');
const strategyBrainModule = require('../brain/strategyBrainService');
const factoryDirectorModule = require('../factory/factoryDirectorService');
const replayQueueModule = require('../replayQueueService');
const replaySchedulerModule = require('../replaySchedulerService');
const optimizerModule = require('../optimizer/aiOptimizerService');
const evolutionModule = require('../evolution/evolutionEngineService');
const strategyRuntimeModule = require('../strategyRuntimeService');
const familyTreeModule = require('../evolution/strategyFamilyTreeService');

const INTEGRATION_VERSION = 'factory-integration-v1';
const DEFAULT_EVENTS_FILE = path.resolve(__dirname, '../../../data/factory-integration/events.jsonl');

const EVENT_TYPES = Object.freeze({
  RUN_STARTED: 'INTEGRATION_RUN_STARTED',
  STEP_RECORDED: 'INTEGRATION_STEP_RECORDED',
  REFERENCES_VERIFIED: 'INTEGRATION_REFERENCES_VERIFIED',
  RUN_COMPLETED: 'INTEGRATION_RUN_COMPLETED',
  RUN_FAILED: 'INTEGRATION_RUN_FAILED',
});

const STEP_STATUS = Object.freeze({
  PASS: 'PASS',
  WARNING: 'WARNING',
  FAILED: 'FAILED',
});

const RUN_STATUS = Object.freeze({
  PASS: 'PASS',
  WARNING: 'WARNING',
  FAILED: 'FAILED',
});

const SAFETY = Object.freeze({
  source: 'factory_integration',
  mode: 'paper_only',
  paper_only: true,
  integrationOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const STEPS = Object.freeze([
  { name: 'IB Historical Data', key: 'ibHistoricalData', dataSource: 'interactive_brokers_historical_data' },
  { name: 'Historical PriceFeed', key: 'historicalPriceFeed', dataSource: 'historical_price_feed' },
  { name: 'Replay Engine', key: 'replayEngine', dataSource: 'native_replay_engine' },
  { name: 'Fill Engine', key: 'fillEngine', dataSource: 'fill_engine' },
  { name: 'Strategy Library', key: 'strategyLibrary', dataSource: 'strategy_library' },
  { name: 'AI Memory', key: 'aiMemory', dataSource: 'ai_memory' },
  { name: 'Learning Engine', key: 'learningEngine', dataSource: 'learning_engine' },
  { name: 'Strategy Brain', key: 'strategyBrain', dataSource: 'strategy_brain' },
  { name: 'Factory Director', key: 'factoryDirector', dataSource: 'factory_director' },
  { name: 'Replay Queue', key: 'replayQueue', dataSource: 'replay_queue' },
  { name: 'Replay Scheduler', key: 'replayScheduler', dataSource: 'replay_scheduler' },
  { name: 'AI Optimizer', key: 'aiOptimizer', dataSource: 'ai_optimizer' },
  { name: 'Evolution Engine', key: 'evolutionEngine', dataSource: 'evolution_engine' },
  { name: 'Strategy Runtime', key: 'strategyRuntime', dataSource: 'strategy_runtime' },
  { name: 'Replay Again', key: 'replayAgain', dataSource: 'native_replay_engine' },
]);

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

function lower(value) {
  return text(value, '').toLowerCase();
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
    if (['startTime', 'endTime', 'durationMs', 'duration', 'timestamp', 'createdAt', 'generatedAt', 'recordedAt', 'at'].includes(key)) return acc;
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

function unique(values = []) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))].sort();
}

function integrationRunIdFor(input = {}) {
  return text(input.integrationRunId || input.runId)
    || `factory_integration_${stableHash({
      version: INTEGRATION_VERSION,
      input,
    }).slice(0, 24)}`;
}

function correlationIdFor(input = {}, integrationRunId) {
  return text(input.correlationId) || integrationRunId;
}

function statusFromOutput(output) {
  if (!output || output.ok === false || lower(output.status) === 'failed') return STEP_STATUS.FAILED;
  if (output.warning || output.warn || arr(output.warnings).length || lower(output.status) === 'warning') {
    return STEP_STATUS.WARNING;
  }
  return STEP_STATUS.PASS;
}

function objectCount(value) {
  if (value == null) return 0;
  if (Number.isFinite(Number(value.objectCount))) return Number(value.objectCount);
  if (Array.isArray(value)) return value.length;
  if (typeof value !== 'object') return 1;
  let total = 0;
  for (const [key, row] of Object.entries(value)) {
    if (['warnings', 'errors', 'capabilities', 'safety'].includes(key)) continue;
    if (Array.isArray(row)) total += row.length;
  }
  if (total > 0) return total;
  if (Number.isFinite(Number(value.count))) return Number(value.count);
  if (Number.isFinite(Number(value.total))) return Number(value.total);
  return Object.keys(value).length ? 1 : 0;
}

function inputSummaryFor(step, context) {
  return {
    integrationRunId: context.integrationRunId,
    correlationId: context.correlationId,
    stepName: step.name,
    previousStep: context.steps[context.steps.length - 1]?.stepName || null,
    requestedBy: text(context.input.requestedBy || context.input.requested_by) || 'Factory Integration',
  };
}

async function callIntegrationCheck(service, step, context) {
  if (service && typeof service.integrationCheck === 'function') {
    return service.integrationCheck({
      stepName: step.name,
      stepKey: step.key,
      input: inputSummaryFor(step, context),
      context,
    });
  }
  return null;
}

function methodResult(service, method, args = []) {
  if (!service || typeof service[method] !== 'function') return null;
  return service[method](...args);
}

async function runIbHistoricalData(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  const status = methodResult(service, 'getStatus')
    || (service?.progress && typeof service.progress.stats === 'function'
      ? { ok: true, status: 'available', progress: service.progress.stats(), ...service.SAFETY }
      : null);
  if (status) return status;
  if (typeof service?.buildPlan === 'function') {
    return { ok: true, plan: service.buildPlan(context.input.backfill || context.input.ibHistoricalData || {}) };
  }
  return { ok: false, reason: 'ib_historical_data_service_unavailable' };
}

async function runHistoricalPriceFeed(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  const symbol = text(context.input.symbol || arr(context.input.symbols)[0]) || 'MNQ';
  const now = context.input.now || context.startTime;
  const output = methodResult(service, 'getCandles', [symbol, {
    now,
    timeframe: context.input.timeframe || '2m',
    limit: num(context.input.limit, 50),
  }]);
  return output || { ok: false, reason: 'historical_price_feed_unavailable' };
}

async function runReplay(service, step, context, replayInputKey = 'replay') {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  const replayInput = context.input[replayInputKey] || context.input.replay || {};
  if (context.input.executeReplay === true && typeof service?.runReplay === 'function') {
    return service.runReplay({
      symbols: replayInput.symbols || context.input.symbols || [context.input.symbol || 'MNQ'],
      start: replayInput.start || context.input.start,
      end: replayInput.end || context.input.end,
      mode: replayInput.mode || context.input.mode || 'scan_only',
      strategyRuntime: context.services.strategyRuntime,
      runtimeContext: replayInput.runtimeContext || context.input.runtimeContext || null,
    });
  }
  if (typeof service?.listRuns === 'function') {
    return { ok: true, dryRun: true, runs: service.listRuns(), source: 'replay_engine_runs' };
  }
  return { ok: false, reason: 'replay_engine_unavailable' };
}

async function runFillEngine(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  if (context.input.executeFill === true && typeof service?.fill === 'function') {
    return service.fill(context.input.order || {}, { bars: context.input.fillBars || [] });
  }
  const description = methodResult(service, 'describe');
  return description ? { ok: true, description } : { ok: false, reason: 'fill_engine_unavailable' };
}

async function runStrategyLibrary(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  const strategies = methodResult(service, 'listStrategies') || [];
  const events = methodResult(service, 'getAuditTrail', [{}]) || [];
  const status = methodResult(service, 'getStatus') || null;
  return { ok: true, strategies, events, status, source: 'strategy_library' };
}

async function runAiMemory(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  const experiments = methodResult(service, 'listExperiments') || [];
  const status = methodResult(service, 'getStatus') || null;
  return { ok: true, experiments, status, source: 'ai_memory' };
}

async function runLearningEngine(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  if (context.input.executeLearning === true && typeof service?.learnFromReplay === 'function') {
    const replayRunId = text(context.input.replayRunId || context.outputs['Replay Engine']?.runId);
    const strategyId = text(context.input.strategyId);
    if (!replayRunId) return { ok: false, reason: 'learning_requires_replay_run_id' };
    return service.learnFromReplay({ replayRunId, strategyId, requestedBy: 'Factory Integration' });
  }
  const summary = methodResult(service, 'getLearningSummary', [{ limit: 0 }]) || null;
  const learningRecords = methodResult(service, 'getLearningRecords') || [];
  const knowledge = methodResult(service, 'getStrategyKnowledge', [null]) || null;
  return {
    ok: true,
    summary,
    learningRecords,
    knowledge: arr(knowledge?.items),
    source: 'learning_engine',
  };
}

async function runStrategyBrain(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  const output = methodResult(service, 'analyze', [{
    library: context.services.strategyLibrary,
    catalog: context.input.catalog || null,
    now: new Date(context.input.now || context.startTime),
    replayMode: context.input.replayMode || 'strategy',
    executionModel: context.input.executionModel || 'simulated_fill',
  }]);
  return output || { ok: false, reason: 'strategy_brain_unavailable' };
}

async function runFactoryDirector(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  const output = methodResult(service, 'decide', [{
    runId: context.integrationRunId,
    requestedBy: 'Factory Integration',
    now: context.input.now || context.startTime,
    systemStatus: context.input.systemStatus || null,
  }]);
  return output || { ok: false, reason: 'factory_director_unavailable' };
}

async function runReplayQueue(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  const status = methodResult(service, 'getStatus');
  if (!status) return { ok: false, reason: 'replay_queue_unavailable' };
  const events = methodResult(service, 'readEvents') || [];
  return { ok: true, status, events, jobs: arr(status.jobs), source: 'replay_queue' };
}

async function runReplayScheduler(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  if (context.input.executeScheduler === true && typeof service?.runOnce === 'function') {
    return service.runOnce({
      enforceEnabled: false,
      requestedBy: 'Factory Integration',
      ...(context.input.scheduler || {}),
    });
  }
  const plan = methodResult(service, 'buildSchedule', [{
    requestedBy: 'Factory Integration',
    ...(context.input.scheduler || {}),
  }]);
  const status = methodResult(service, 'getStatus') || null;
  return plan ? { ok: true, plan, status } : { ok: false, reason: 'replay_scheduler_unavailable' };
}

async function runAiOptimizer(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  if (context.input.executeOptimizer === true && typeof service?.propose === 'function') {
    return service.propose(context.input.optimizer || {});
  }
  const description = methodResult(service, 'describe');
  return description || { ok: false, reason: 'ai_optimizer_unavailable' };
}

async function runEvolutionEngine(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  const status = methodResult(service, 'getStatus') || null;
  const tree = service?.familyTree || context.services.familyTree;
  const nodes = methodResult(tree, 'listNodes') || [];
  const branches = methodResult(tree, 'listBranches') || [];
  return status ? { ok: true, status, nodes, branches } : { ok: false, reason: 'evolution_engine_unavailable' };
}

async function runStrategyRuntime(service, step, context) {
  const checked = await callIntegrationCheck(service, step, context);
  if (checked) return checked;
  if (context.input.executeRuntime === true && typeof service?.execute === 'function') {
    return service.execute({
      symbol: context.input.symbol || 'MNQ',
      candles: context.input.runtimeCandles || context.outputs['Historical PriceFeed']?.candles || [],
      mode: context.input.runtimeMode || 'scan_only',
      runtimeContext: context.input.runtimeContext || null,
    });
  }
  const materialized = methodResult(service, 'materialize', [context.input.runtimeContext || {}])
    || methodResult(service, 'materializeRuntime', [context.input.runtimeContext || {}]);
  return materialized || { ok: false, reason: 'strategy_runtime_unavailable' };
}

const STEP_RUNNERS = Object.freeze({
  'IB Historical Data': runIbHistoricalData,
  'Historical PriceFeed': runHistoricalPriceFeed,
  'Replay Engine': (service, step, context) => runReplay(service, step, context, 'replay'),
  'Fill Engine': runFillEngine,
  'Strategy Library': runStrategyLibrary,
  'AI Memory': runAiMemory,
  'Learning Engine': runLearningEngine,
  'Strategy Brain': runStrategyBrain,
  'Factory Director': runFactoryDirector,
  'Replay Queue': runReplayQueue,
  'Replay Scheduler': runReplayScheduler,
  'AI Optimizer': runAiOptimizer,
  'Evolution Engine': runEvolutionEngine,
  'Strategy Runtime': runStrategyRuntime,
  'Replay Again': (service, step, context) => runReplay(service, step, context, 'replayAgain'),
});

function normalizeStepOutput(output) {
  if (output && typeof output.then === 'function') return output;
  if (output == null) return { ok: false, reason: 'empty_step_output' };
  if (typeof output !== 'object') return { ok: true, value: output };
  return output;
}

async function runStep(step, context) {
  const service = step.name === 'Replay Again' ? context.services.replayEngine : context.services[step.key];
  const startTime = context.now();
  const startTick = context.timer();
  let output;
  let error = null;
  try {
    output = normalizeStepOutput(await STEP_RUNNERS[step.name](service, step, context));
  } catch (err) {
    error = err;
    output = { ok: false, reason: err.message || String(err) };
  }
  const endTick = context.timer();
  const endTime = context.now();
  const status = statusFromOutput(output);
  const result = {
    stepName: step.name,
    status,
    input: inputSummaryFor(step, context),
    output: clone(output),
    durationMs: Math.max(0, num(endTick, 0) - num(startTick, 0)),
    objectCount: objectCount(output),
    dataSource: text(output?.dataSource || output?.source) || step.dataSource,
    startTime,
    endTime,
    reason: text(output?.reason || output?.error || error?.message) || (status === STEP_STATUS.PASS ? 'ok' : 'warning'),
  };
  context.steps.push(result);
  context.outputs[step.name] = result.output;
  return result;
}

function outputFor(steps, stepName) {
  return steps.find((step) => step.stepName === stepName)?.output || {};
}

function replayRunIdsFromReplayOutput(output = {}) {
  return [
    text(output.runId),
    ...arr(output.runs).map((row) => text(row.runId || row.run_id)),
    ...arr(output.results).map((row) => text(row.runId || row.run_id)),
  ].filter(Boolean);
}

function queueJobsFrom(output = {}) {
  const status = output.status || output;
  return [
    ...arr(output.jobs),
    ...arr(status.jobs),
    ...arr(status.pending_jobs),
    ...arr(status.running_jobs),
    ...arr(status.completed_jobs),
    ...arr(status.failed_jobs),
  ].filter((job, index, list) => {
    const id = text(job.id || job.job_id);
    if (!id) return true;
    return list.findIndex((row) => text(row.id || row.job_id) === id) === index;
  });
}

function collectReferenceSnapshot(steps = []) {
  const replay = outputFor(steps, 'Replay Engine');
  const replayAgain = outputFor(steps, 'Replay Again');
  const library = outputFor(steps, 'Strategy Library');
  const memory = outputFor(steps, 'AI Memory');
  const learning = outputFor(steps, 'Learning Engine');
  const queue = outputFor(steps, 'Replay Queue');
  const optimizer = outputFor(steps, 'AI Optimizer');
  const evolution = outputFor(steps, 'Evolution Engine');
  const runtime = outputFor(steps, 'Strategy Runtime');

  return {
    replayRuns: [
      ...replayRunIdsFromReplayOutput(replay),
      ...replayRunIdsFromReplayOutput(replayAgain),
    ],
    libraryEvents: arr(library.events || library.libraryEvents || library.auditTrail),
    strategies: arr(library.strategies),
    experiments: arr(memory.experiments),
    learningRecords: arr(learning.learningRecords || learning.records),
    knowledge: arr(learning.knowledge || learning.strategyKnowledge || learning.summary?.knowledge),
    queueJobs: queueJobsFrom(queue),
    queueEvents: arr(queue.events),
    optimizerProposals: arr(optimizer.proposals || optimizer.plan?.proposals),
    familyNodes: arr(evolution.nodes || evolution.familyNodes || evolution.status?.tree?.nodes),
    familyBranches: arr(evolution.branches || evolution.familyBranches),
    runtime,
  };
}

function duplicateValues(values = []) {
  const counts = new Map();
  for (const value of values.map((row) => text(row)).filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value, count]) => ({ value, count }));
}

function libraryReplayEvents(snapshot = {}) {
  return arr(snapshot.libraryEvents).filter((event) => event.type === strategyLibraryModule.EVENT_TYPES.REPLAY_RECORDED);
}

function replayPair(event = {}) {
  const strategyId = text(event.strategyId);
  const runId = text(event.runId || event.replayRunId || event.run_id);
  return strategyId && runId ? `${strategyId}|${runId}` : null;
}

function checkReplayRunIds(snapshot = {}) {
  const queueCompletedRunIds = arr(snapshot.queueJobs)
    .filter((job) => lower(job.status) === 'completed')
    .map((job) => text(job.run_id || job.runId))
    .filter(Boolean);
  const libraryPairs = libraryReplayEvents(snapshot).map(replayPair).filter(Boolean);
  const issues = [
    ...duplicateValues(snapshot.replayRuns).map((row) => `duplicate_replay_engine_run_id:${row.value}`),
    ...duplicateValues(queueCompletedRunIds).map((row) => `duplicate_queue_replay_run_id:${row.value}`),
    ...duplicateValues(libraryPairs).map((row) => `duplicate_library_strategy_replay:${row.value}`),
  ];
  return {
    name: 'replayRunId',
    status: issues.length ? STEP_STATUS.FAILED : STEP_STATUS.PASS,
    objectCount: snapshot.replayRuns.length + queueCompletedRunIds.length + libraryPairs.length,
    issues,
  };
}

function checkLibraryRefs(snapshot = {}) {
  const events = libraryReplayEvents(snapshot);
  const byRun = new Set(events.map((event) => text(event.runId || event.replayRunId || event.run_id)).filter(Boolean));
  const byPair = new Set(events.map(replayPair).filter(Boolean));
  const issues = [];
  for (const experiment of arr(snapshot.experiments)) {
    const ref = experiment.libraryRef || {};
    const runId = text(ref.libraryRunId || ref.runId);
    if (!runId) continue;
    const strategyId = text(ref.strategyId || experiment.strategyId);
    const pair = strategyId ? `${strategyId}|${runId}` : null;
    if (!byRun.has(runId) && (!pair || !byPair.has(pair))) {
      issues.push(`broken_libraryRef:${experiment.experimentKey || 'unknown'}:${runId}`);
    }
  }
  return {
    name: 'libraryRef',
    status: issues.length ? STEP_STATUS.FAILED : STEP_STATUS.PASS,
    objectCount: arr(snapshot.experiments).length,
    issues,
  };
}

function checkExperimentKeys(snapshot = {}) {
  const keys = new Set(arr(snapshot.experiments).map((row) => text(row.experimentKey)).filter(Boolean));
  const issues = [];
  for (const record of arr(snapshot.learningRecords)) {
    const key = text(record.experimentKey);
    if (key && !keys.has(key)) issues.push(`broken_experimentKey:${record.learningRecordId || record.replayRunId}:${key}`);
  }
  return {
    name: 'experimentKey',
    status: issues.length ? STEP_STATUS.FAILED : STEP_STATUS.PASS,
    objectCount: arr(snapshot.learningRecords).length,
    issues,
  };
}

function checkLineage(snapshot = {}) {
  const nodes = arr(snapshot.familyNodes);
  const hashes = new Set(nodes.map((node) => text(node.dnaHash)).filter(Boolean));
  const issues = [];
  for (const node of nodes) {
    const parent = text(node.parent);
    if (parent && !hashes.has(parent)) issues.push(`broken_lineage:${node.dnaHash}->${parent}`);
  }
  return {
    name: 'lineage',
    status: issues.length ? STEP_STATUS.FAILED : STEP_STATUS.PASS,
    objectCount: nodes.length,
    issues,
  };
}

function checkDnaReferences(snapshot = {}) {
  const definitions = new Set([
    ...arr(snapshot.strategies).map((row) => text(row.currentDnaHash || row.dnaHash)),
    ...arr(snapshot.familyNodes).map((row) => text(row.dnaHash)),
    ...arr(snapshot.optimizerProposals).map((row) => text(row.candidateDnaHash || row.dnaProposal?.dnaHash)),
  ].filter(Boolean));
  const refs = [
    ...arr(snapshot.experiments).map((row) => text(row.identity?.strategyDnaHash || row.dnaHash)),
    ...arr(snapshot.learningRecords).map((row) => text(row.dnaHash)),
  ].filter(Boolean);
  const issues = unique(refs).filter((hash) => !definitions.has(hash)).map((hash) => `broken_dna_reference:${hash}`);
  return {
    name: 'DNA',
    status: issues.length ? STEP_STATUS.FAILED : STEP_STATUS.PASS,
    objectCount: refs.length,
    issues,
  };
}

function checkMarketDnaReferences(snapshot = {}) {
  const definitions = new Set([
    ...libraryReplayEvents(snapshot).map((row) => text(row.marketDnaHash)),
    ...arr(snapshot.strategies).map((row) => text(row.currentMarketDnaHash)),
    ...arr(snapshot.learningRecords).map((row) => text(row.marketDna?.marketDnaHash || row.marketDnaHash)),
  ].filter(Boolean));
  const refs = [
    ...arr(snapshot.experiments).map((row) => text(row.identity?.marketDnaHash || row.marketDnaHash)),
    ...arr(snapshot.learningRecords).map((row) => text(row.marketDna?.marketDnaHash || row.marketDnaHash)),
  ].filter(Boolean);
  const issues = unique(refs).filter((hash) => !definitions.has(hash)).map((hash) => `broken_market_dna_reference:${hash}`);
  return {
    name: 'MarketDNA',
    status: issues.length ? STEP_STATUS.FAILED : STEP_STATUS.PASS,
    objectCount: refs.length,
    issues,
  };
}

function checkReplayQueueJobs(snapshot = {}) {
  const replayRunIds = new Set([
    ...arr(snapshot.replayRuns),
    ...libraryReplayEvents(snapshot).map((row) => text(row.runId || row.replayRunId || row.run_id)),
  ].filter(Boolean));
  const issues = [];
  for (const job of arr(snapshot.queueJobs)) {
    const jobId = text(job.id || job.job_id);
    if (!jobId) issues.push('broken_replay_queue_job:missing_job_id');
    const status = lower(job.status);
    const runId = text(job.run_id || job.runId);
    if (status === 'completed' && runId && !replayRunIds.has(runId)) {
      issues.push(`broken_replay_queue_job:${jobId}:unknown_run_id:${runId}`);
    }
  }
  return {
    name: 'replayQueueJob',
    status: issues.length ? STEP_STATUS.FAILED : STEP_STATUS.PASS,
    objectCount: arr(snapshot.queueJobs).length,
    issues,
  };
}

function verifyReferences(steps = []) {
  const snapshot = collectReferenceSnapshot(steps);
  const checks = [
    checkReplayRunIds(snapshot),
    checkLibraryRefs(snapshot),
    checkExperimentKeys(snapshot),
    checkLineage(snapshot),
    checkDnaReferences(snapshot),
    checkMarketDnaReferences(snapshot),
    checkReplayQueueJobs(snapshot),
  ];
  const failed = checks.filter((check) => check.status === STEP_STATUS.FAILED);
  const warnings = checks.filter((check) => check.status === STEP_STATUS.WARNING);
  return {
    status: failed.length ? STEP_STATUS.FAILED : (warnings.length ? STEP_STATUS.WARNING : STEP_STATUS.PASS),
    checks,
    issues: failed.flatMap((check) => check.issues),
    snapshot: {
      replayRuns: unique(snapshot.replayRuns),
      libraryReplayEvents: libraryReplayEvents(snapshot).length,
      experiments: snapshot.experiments.length,
      learningRecords: snapshot.learningRecords.length,
      queueJobs: snapshot.queueJobs.length,
      familyNodes: snapshot.familyNodes.length,
    },
  };
}

function factoryHealth(steps = [], references = null) {
  const out = {};
  for (const step of steps) out[step.stepName] = step.status;
  if (references) out.References = references.status;
  return out;
}

function runStatusFrom(steps = [], references = null) {
  if (steps.some((step) => step.status === STEP_STATUS.FAILED) || references?.status === STEP_STATUS.FAILED) {
    return RUN_STATUS.FAILED;
  }
  if (steps.some((step) => step.status === STEP_STATUS.WARNING) || references?.status === STEP_STATUS.WARNING) {
    return RUN_STATUS.WARNING;
  }
  return RUN_STATUS.PASS;
}

function resultHashFor(result = {}) {
  return stableHash({
    integrationVersion: result.integrationVersion,
    status: result.status,
    steps: result.steps.map((step) => ({
      stepName: step.stepName,
      status: step.status,
      output: step.output,
      objectCount: step.objectCount,
      dataSource: step.dataSource,
      reason: step.reason,
    })),
    references: result.references,
  });
}

function defaultBackfillService() {
  try {
    return backfillModule.createIbHistoricalBackfillService();
  } catch (_) {
    return null;
  }
}

function createFactoryIntegrationService(options = {}) {
  const log = createEventLog({
    file: options.eventsFile || DEFAULT_EVENTS_FILE,
    keyField: 'integrationRunId',
    eventTypes: Object.values(EVENT_TYPES),
    now: options.now,
    label: 'factory_integration',
  });
  const services = {
    ibHistoricalData: options.ibHistoricalData || options.backfillService || defaultBackfillService(),
    historicalPriceFeed: options.historicalPriceFeed || historicalPriceFeedModule.defaultHistoricalPriceFeedService,
    replayEngine: options.replayEngine || replayEngineModule,
    fillEngine: options.fillEngine || fillEngineModule.defaultSimulatedFillEngine,
    strategyLibrary: options.strategyLibrary || strategyLibraryModule.defaultStrategyLibrary,
    aiMemory: options.aiMemory || aiMemoryModule.defaultAiMemory,
    learningEngine: options.learningEngine || learningModule.defaultLearningEngine,
    strategyBrain: options.strategyBrain || strategyBrainModule.createStrategyBrain({
      memory: options.aiMemory || aiMemoryModule.defaultAiMemory,
    }),
    factoryDirector: options.factoryDirector || factoryDirectorModule.defaultFactoryDirector,
    replayQueue: options.replayQueue || replayQueueModule.defaultReplayQueueService,
    replayScheduler: options.replayScheduler || replaySchedulerModule.defaultReplaySchedulerService,
    aiOptimizer: options.aiOptimizer || optimizerModule.defaultAiOptimizerService,
    evolutionEngine: options.evolutionEngine || evolutionModule.createEvolutionEngine(),
    strategyRuntime: options.strategyRuntime || strategyRuntimeModule.defaultStrategyRuntime || strategyRuntimeModule,
    familyTree: options.familyTree || familyTreeModule.defaultStrategyFamilyTree,
  };
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const timer = typeof options.timer === 'function' ? options.timer : () => Date.now();

  function nowIso() {
    return iso(clock());
  }

  function append(integrationRunId, type, payload) {
    return log.append(integrationRunId, type, payload);
  }

  async function runIntegration(input = {}) {
    const integrationRunId = integrationRunIdFor(input);
    const correlationId = correlationIdFor(input, integrationRunId);
    const startTime = text(input.now) || nowIso();
    const runStartTick = timer();
    const context = {
      input,
      services,
      steps: [],
      outputs: {},
      integrationRunId,
      correlationId,
      startTime,
      now: nowIso,
      timer,
    };

    append(integrationRunId, EVENT_TYPES.RUN_STARTED, {
      integrationRunId,
      correlationId,
      startTime,
      requestedBy: text(input.requestedBy || input.requested_by) || 'Factory Integration',
      integrationVersion: INTEGRATION_VERSION,
      status: 'RUNNING',
    });

    for (const step of STEPS) {
      const result = await runStep(step, context);
      append(integrationRunId, EVENT_TYPES.STEP_RECORDED, {
        integrationRunId,
        correlationId,
        step: result,
        stepName: result.stepName,
        status: result.status,
      });

      if (result.status === STEP_STATUS.FAILED) {
        const endTime = nowIso();
        const durationMs = Math.max(0, timer() - runStartTick);
        const failed = {
          ok: false,
          integrationVersion: INTEGRATION_VERSION,
          integrationRunId,
          correlationId,
          startTime,
          endTime,
          durationMs,
          duration: durationMs,
          status: RUN_STATUS.FAILED,
          failedStep: result.stepName,
          steps: context.steps,
          references: null,
          factoryHealth: factoryHealth(context.steps),
          deterministic: true,
          ...SAFETY,
        };
        failed.integrationResultHash = resultHashFor(failed);
        append(integrationRunId, EVENT_TYPES.RUN_FAILED, {
          integrationRunId,
          correlationId,
          startTime,
          endTime,
          duration: durationMs,
          status: RUN_STATUS.FAILED,
          failedStep: result.stepName,
          integrationResultHash: failed.integrationResultHash,
        });
        return failed;
      }
    }

    const references = verifyReferences(context.steps);
    append(integrationRunId, EVENT_TYPES.REFERENCES_VERIFIED, {
      integrationRunId,
      correlationId,
      status: references.status,
      references,
    });
    const endTime = nowIso();
    const durationMs = Math.max(0, timer() - runStartTick);
    const status = runStatusFrom(context.steps, references);
    const result = {
      ok: status !== RUN_STATUS.FAILED,
      integrationVersion: INTEGRATION_VERSION,
      integrationRunId,
      correlationId,
      startTime,
      endTime,
      durationMs,
      duration: durationMs,
      status,
      failedStep: status === RUN_STATUS.FAILED ? 'REFERENCE_INTEGRITY' : null,
      steps: context.steps,
      references,
      factoryHealth: factoryHealth(context.steps, references),
      deterministic: true,
      ...SAFETY,
    };
    result.integrationResultHash = resultHashFor(result);
    append(integrationRunId, status === RUN_STATUS.FAILED ? EVENT_TYPES.RUN_FAILED : EVENT_TYPES.RUN_COMPLETED, {
      integrationRunId,
      correlationId,
      startTime,
      endTime,
      duration: durationMs,
      status,
      failedStep: result.failedStep,
      integrationResultHash: result.integrationResultHash,
    });
    return result;
  }

  function getHistory(integrationRunId = null) {
    const query = {};
    const rows = text(integrationRunId) ? log.historyFor(integrationRunId, query) : log.auditTrail(query);
    return rows;
  }

  function getStatus() {
    const rows = log.auditTrail({});
    const runs = unique(rows.map((row) => row.integrationRunId));
    const last = rows[rows.length - 1] || null;
    return {
      ok: true,
      integrationVersion: INTEGRATION_VERSION,
      runs: runs.length,
      events: rows.length,
      lastEvent: last,
      appendOnly: true,
      steps: STEPS.map((step) => step.name),
      referencesChecked: [
        'replayRunId',
        'libraryRef',
        'experimentKey',
        'lineage',
        'DNA',
        'MarketDNA',
        'replayQueueJob',
      ],
      log: log.stats(),
      ...SAFETY,
    };
  }

  return Object.freeze({
    SAFETY,
    EVENT_TYPES,
    STEP_STATUS,
    RUN_STATUS,
    INTEGRATION_VERSION,
    STEPS,
    eventsFile: log.file,
    runIntegration,
    getHistory,
    getStatus,
    _internal: {
      stableHash,
      stableStringify,
      canonical,
      integrationRunIdFor,
      correlationIdFor,
      runStep,
      verifyReferences,
      collectReferenceSnapshot,
      factoryHealth,
      resultHashFor,
      objectCount,
      log,
    },
  });
}

const defaultFactoryIntegrationService = createFactoryIntegrationService();

module.exports = {
  SAFETY,
  EVENT_TYPES,
  STEP_STATUS,
  RUN_STATUS,
  INTEGRATION_VERSION,
  DEFAULT_EVENTS_FILE,
  STEPS,
  createFactoryIntegrationService,
  defaultFactoryIntegrationService,
  _internal: {
    stableHash,
    stableStringify,
    canonical,
    integrationRunIdFor,
    correlationIdFor,
    verifyReferences,
    collectReferenceSnapshot,
    factoryHealth,
    resultHashFor,
    objectCount,
  },
};
