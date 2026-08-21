import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DashboardShell } from '../components/dashboard/DashboardKit.jsx';
import ContextNavigation, { contextAction, contextHref } from '../components/ContextNavigation.jsx';
import {
  aiStoryEventText,
  aiStoryJournalRow,
} from '../services/aiStoryService.js';
import {
  DecisionTimeline,
  FieldGrid,
  MetricCard,
  OverviewPanel,
  StatusBadge,
} from '../components/trading/index.js';
import {
  FACTORY_STATUS_KEYS,
  FACTORY_TERM_KEYS,
  uiDecisionJournal,
  uiFactoryDecision,
  uiFactoryGap,
  uiFactoryReason,
  uiFactorySafeText,
  uiName,
  uiStatus,
} from '../services/uiTerminologyService.js';

const FETCH_TIMEOUT_MS = 6000;

const ENDPOINTS = Object.freeze({
  director: '/api/factory/director',
  decision: '/api/factory/decision',
  next: '/api/factory/next',
  status: '/api/factory/status',
  brain: '/api/strategy-brain',
  queue: '/api/replay/queue',
  library: '/api/strategy-library',
  libraryAudit: '/api/strategy-library/audit?limit=5000',
  memoryStatus: '/api/ai-memory/status',
  memoryExperiments: '/api/ai-memory/experiments?limit=2000',
  lineage: '/api/strategy-family-tree',
  optimizerContract: '/api/ai-optimizer/contract',
  market: '/api/market-intelligence',
  marketCatalog: '/api/market-intelligence/catalog',
  learningSummary: '/api/learning/latest-summary',
  eventsRecent: '/api/events/recent?n=100',
  auditRecent: '/api/audit/recent?limit=500',
});

const TIMELINE_ORDER = Object.freeze([
  'replay',
  'learning',
  'memory',
  'brain',
  'director',
  'optimizer',
  'evolution',
  'library',
]);

function emptyResource() {
  return { loading: true, ok: false, data: null, error: null };
}

async function fetchResource(url, signal) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const response = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { loading: false, ok: true, data: await response.json(), error: null };
  } catch (err) {
    return { loading: false, ok: false, data: null, error: err?.message || String(err) };
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function useDecisionJournalData() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [state, setState] = useState(() => ({
    loading: true,
    sources: Object.fromEntries(Object.keys(ENDPOINTS).map((key) => [key, emptyResource()])),
  }));

  useEffect(() => {
    const controller = new AbortController();
    setState({
      loading: true,
      sources: Object.fromEntries(Object.keys(ENDPOINTS).map((key) => [key, emptyResource()])),
    });

    Promise.all(
      Object.entries(ENDPOINTS).map(([key, url]) => (
        fetchResource(url, controller.signal).then((resource) => [key, resource])
      )),
    ).then((entries) => {
      if (controller.signal.aborted) return;
      setState({ loading: false, sources: Object.fromEntries(entries) });
    });

    return () => controller.abort();
  }, [refreshKey]);

  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);
  return { ...state, refresh };
}

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function resourceData(sources, key) {
  const resource = sources[key];
  return resource?.ok ? resource.data : null;
}

function serviceData(sources, ...keys) {
  const director = resourceData(sources, 'director');
  const systemStatus = director?.systemStatus || null;
  for (const key of keys) {
    const direct = resourceData(sources, key);
    if (direct) return direct;
    const service = systemStatus?.services?.[key] || systemStatus?.[key];
    if (service) return service;
  }
  return null;
}

function currentDecision(sources) {
  return resourceData(sources, 'director')?.decision
    || resourceData(sources, 'decision')?.decision
    || resourceData(sources, 'decision')
    || resourceData(sources, 'next')?.decision
    || resourceData(sources, 'next')
    || resourceData(sources, 'status')?.currentDecision
    || null;
}

function parseTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function dateValue(row, fields = []) {
  for (const field of fields) {
    const value = row?.[field];
    if (parseTime(value) !== null) return value;
  }
  return null;
}

function formatDateTime(value, fallback) {
  const time = parseTime(value);
  if (time === null) return fallback;
  return new Date(time).toLocaleString('sv-SE', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function displayNumber(value, fallback, digits = 0) {
  const number = numberOrNull(value);
  if (number === null) return fallback;
  return new Intl.NumberFormat('sv-SE', {
    maximumFractionDigits: digits,
  }).format(number);
}

function shortId(value, fallback) {
  const text = safeValue(value, '');
  if (!text) return fallback;
  return text.length > 16 ? `${text.slice(0, 14)}...` : text;
}

function safeValue(value, fallback) {
  const text = uiFactorySafeText(value);
  return text || fallback;
}

function firstValue(...values) {
  for (const value of values) {
    if (value === 0) return value;
    if (Array.isArray(value) && value.length) return value;
    if (value && typeof value === 'object' && Object.keys(value).length) return value;
    if (value != null && value !== '') return value;
  }
  return null;
}

function normalizeStatus(value, copy) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['completed', 'complete', 'done', 'ok', 'qualified', 'success', 'allowed', 'observe_only', 'paper_opened', 'paper_closed'].includes(normalized)) return uiStatus(FACTORY_STATUS_KEYS.COMPLETED);
  if (['running', 'active', 'started'].includes(normalized)) return uiStatus(FACTORY_STATUS_KEYS.RUNNING);
  if (['failed', 'error', 'rejected', 'blocked'].includes(normalized)) return uiStatus(FACTORY_STATUS_KEYS.FAILED);
  if (['skipped', 'duplicate', 'already_known'].includes(normalized)) return copy.states.skipped;
  if (['created', 'queued', 'pending', 'waiting', 'recommended'].includes(normalized)) return uiStatus(FACTORY_STATUS_KEYS.WAITING);
  return value ? safeValue(value, uiStatus(FACTORY_STATUS_KEYS.WAITING)) : uiStatus(FACTORY_STATUS_KEYS.WAITING);
}

function statusTone(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['failed', 'error', 'rejected'].includes(normalized)) return 'danger';
  if (['pending', 'waiting', 'queued', 'recommended', 'skipped', 'duplicate', 'already_known'].includes(normalized)) return 'warning';
  if (['running', 'active', 'started'].includes(normalized)) return 'info';
  if (['completed', 'complete', 'done', 'ok', 'qualified', 'success'].includes(normalized)) return 'success';
  return 'neutral';
}

function normalizeAction(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['replay', 're_test', 'request_replay_scheduler', 'request_replay_queue'].includes(normalized)) return 'REQUEST_REPLAY_SCHEDULER';
  if (['optimize', 'request_ai_optimizer'].includes(normalized)) return 'REQUEST_AI_OPTIMIZER';
  if (['evolution', 'mutate', 'request_evolution_engine'].includes(normalized)) return 'REQUEST_EVOLUTION_ENGINE';
  if (['approval', 'paper', 'candidate', 'request_approval_service'].includes(normalized)) return 'REQUEST_APPROVAL_SERVICE';
  if (['backfill', 'request_backfill_service'].includes(normalized)) return 'REQUEST_BACKFILL_SERVICE';
  if (['safety', 'safety_hold'].includes(normalized)) return 'SAFETY_HOLD';
  if (['idle', 'wait'].includes(normalized)) return 'IDLE';
  return value;
}

function decisionTextFor(action, copy) {
  if (!action) return copy.states.noRecommendation;
  const text = uiFactoryDecision(normalizeAction(action));
  return text?.title || safeValue(action, copy.states.noRecommendation);
}

function nextTextFor(action, copy) {
  if (!action) return copy.states.noNext;
  const text = uiFactoryDecision(normalizeAction(action));
  return text?.next || copy.states.noNext;
}

function actionTone(action) {
  return uiFactoryDecision(normalizeAction(action))?.tone || 'neutral';
}

function displayReason(reason, copy) {
  if (!reason) return copy.states.noReason;
  return uiFactoryReason(reason) || safeValue(reason, copy.states.noReason);
}

function scoreSummary(row, copy) {
  const labels = copy.resultLabels;
  const parts = [];
  const trades = numberOrNull(firstValue(row.trades, row.replayTrades));
  const score = numberOrNull(firstValue(row.strategyScore, row.score));
  const winrate = numberOrNull(firstValue(row.winRate, row.winrate));
  const profitFactor = numberOrNull(row.profitFactor);
  const drawdown = numberOrNull(firstValue(row.maxDrawdownUsd, row.drawdown));
  if (trades !== null) parts.push(`${displayNumber(trades, copy.emptyValue)} ${labels.trades}`);
  if (score !== null) parts.push(`${labels.strategyScore} ${displayNumber(score, copy.emptyValue)}`);
  if (winrate !== null) parts.push(`${labels.winrate} ${displayNumber(winrate, copy.emptyValue, 1)}%`);
  if (profitFactor !== null) parts.push(`${labels.profitFactor} ${displayNumber(profitFactor, copy.emptyValue, 2)}`);
  if (drawdown !== null) parts.push(`${labels.drawdown} ${displayNumber(drawdown, copy.emptyValue, 0)}`);
  return parts.length ? parts.join(' · ') : copy.states.noResult;
}

function marketTextFrom(value, copy) {
  if (!value) return copy.states.noMarket;
  if (typeof value === 'string') return safeValue(value, copy.states.noMarket);
  const symbols = asArray(value.symbols || value.tickers).map((symbol) => safeValue(symbol, '')).filter(Boolean);
  const regime = safeValue(value.regimeKey || value.marketRegimeKey || value.marketDnaHash || value.classification || value.market_group, '');
  if (symbols.length && regime) return `${symbols.join(', ')} · ${regime}`;
  if (symbols.length) return symbols.join(', ');
  return regime || copy.states.noMarket;
}

function mutationTextFrom(node, copy) {
  if (!node) return copy.states.noMutation;
  const mutation = node.mutation || {};
  const changes = Object.keys(mutation.changes || mutation.diff || {}).filter(Boolean);
  if (changes.length) return changes.map((key) => safeValue(key, key)).join(', ');
  if (node.mutationType) return safeValue(node.mutationType, copy.states.noMutation);
  const generation = numberOrNull(node.generation ?? node.generationNumber);
  return generation === null ? copy.states.noMutation : `${copy.resultLabels.generation} ${displayNumber(generation, copy.emptyValue)}`;
}

function sourceSummary(sources) {
  const rows = Object.values(sources);
  const done = rows.filter((source) => !source.loading);
  return {
    available: done.filter((source) => source.ok).length,
    missing: done.filter((source) => !source.ok).length,
    total: rows.length,
  };
}

function latestByTime(rows, fields) {
  return asArray(rows)
    .map((row) => ({ row, timeValue: dateValue(row, fields) }))
    .filter((entry) => parseTime(entry.timeValue) !== null)
    .sort((a, b) => parseTime(b.timeValue) - parseTime(a.timeValue))[0] || null;
}

function libraryReplayRows(library = {}) {
  return asArray(library.strategies)
    .flatMap((strategy) => asArray(strategy.replayHistory).map((run) => ({
      ...run,
      strategyId: run.strategyId || strategy.strategyId,
      currentDnaHash: strategy.currentDnaHash,
      currentMarketDnaHash: strategy.currentMarketDnaHash,
      lifecycle: strategy.lifecycle,
    })));
}

function rowKey(row) {
  return [
    row.kind,
    row.replayRunId,
    row.learningRecordId,
    row.experimentKey,
    row.dnaHash,
    row.decisionId,
    row.queueJobId,
    row.libraryEventId,
    row.strategyId,
    row.time,
  ].map((value) => value || '').join('|');
}

function createJournalRow(input, copy) {
  const action = input.action || null;
  const reason = input.why || input.reason || null;
  const status = input.status || null;
  return {
    id: input.id || rowKey(input),
    decisionId: input.decisionId || null,
    kind: input.kind || 'decision',
    time: input.time || null,
    timeLabel: formatDateTime(input.time, copy.emptyValue),
    strategy: safeValue(input.strategyId || input.strategy || null, copy.states.noStrategy),
    market: input.market || copy.states.noMarket,
    replay: input.replay || copy.states.noReplay,
    learning: input.learning || copy.states.noLearning,
    memory: input.memory || copy.states.noMemory,
    recommendation: input.recommendation || decisionTextFor(action, copy),
    mutation: input.mutation || copy.states.noMutation,
    result: input.result || copy.states.noResult,
    why: displayReason(reason, copy),
    next: input.next || nextTextFor(action, copy),
    status: normalizeStatus(status || input.resultStatus || action, copy),
    tone: input.tone || statusTone(status || action),
    action,
    strategyId: input.strategyId || null,
    replayRunId: input.replayRunId || null,
    learningRecordId: input.learningRecordId || null,
    experimentKey: input.experimentKey || null,
    dnaHash: input.dnaHash || null,
    marketDnaHash: input.marketDnaHash || null,
    queueJobId: input.queueJobId || null,
    libraryEventId: input.libraryEventId || null,
    queryKeys: [
      input.id,
      input.decisionId,
      input.replayRunId,
      input.strategyId,
      input.learningRecordId,
      input.experimentKey,
    ].filter(Boolean).map(String),
    source: safeValue(input.source, copy.emptyValue),
    raw: input.raw || null,
    timelineContext: input.timelineContext || {},
    story: aiStoryJournalRow(input),
  };
}

function buildIndexes({ library, memoryExperiments, learning, lineage, brain, queue }) {
  const replays = libraryReplayRows(library);
  const replayByRunId = new Map(replays.map((row) => [String(row.runId || row.replayRunId || ''), row]).filter(([key]) => key));
  const memoryByRunId = new Map();
  const memoryByDnaHash = new Map();
  for (const experiment of memoryExperiments) {
    const libraryRunId = experiment.libraryRef?.libraryRunId || experiment.libraryRef?.runId || experiment.libraryRunId || experiment.runId;
    if (libraryRunId) memoryByRunId.set(String(libraryRunId), experiment);
    const dnaHash = experiment.identity?.strategyDnaHash || experiment.strategyDnaHash || experiment.dnaHash;
    if (dnaHash) memoryByDnaHash.set(String(dnaHash), experiment);
  }

  const learningRecords = [
    ...asArray(learning.recordsList || learning.learningRecords),
    ...asArray(learning.latestRecord ? [learning.latestRecord] : []),
  ];
  const learningByRunId = new Map();
  for (const record of learningRecords) {
    if (record?.replayRunId) learningByRunId.set(String(record.replayRunId), record);
  }

  const lineageByDnaHash = new Map();
  for (const node of asArray(lineage.nodes)) {
    if (node?.dnaHash) lineageByDnaHash.set(String(node.dnaHash), node);
  }

  const brainByStrategy = new Map();
  for (const row of asArray(brain.strategies)) {
    if (row?.strategyId) brainByStrategy.set(String(row.strategyId), row);
  }

  const queueByRunId = new Map();
  const queueByStrategy = new Map();
  for (const job of asArray(queue.jobs)) {
    if (job?.run_id) queueByRunId.set(String(job.run_id), job);
    const strategyId = job?.strategy?.id || job?.strategyId;
    if (strategyId) queueByStrategy.set(String(strategyId), job);
  }

  return {
    replayByRunId,
    memoryByRunId,
    memoryByDnaHash,
    learningByRunId,
    lineageByDnaHash,
    brainByStrategy,
    queueByRunId,
    queueByStrategy,
  };
}

function learningFromSources(sources) {
  const directorLearning = resourceData(sources, 'director')?.systemStatus?.services?.learning;
  const statusLearning = resourceData(sources, 'status')?.services?.learning;
  const legacy = resourceData(sources, 'learningSummary');
  return directorLearning || statusLearning || legacy?.summary || legacy || {};
}

function rowsFromCurrentDecision(sources, indexes, copy) {
  const decision = currentDecision(sources);
  if (!decision) return [];
  const evidence = decision.evidence || decision.assignment?.payload || {};
  const strategyId = firstValue(evidence.strategyId, asArray(evidence.strategyIds)[0], evidence.nextReplay?.strategyId);
  const brainRow = indexes.brainByStrategy.get(String(strategyId || '')) || null;
  const runId = evidence.replayRunId || evidence.runId || evidence.nextReplay?.runId || null;
  const replay = runId ? indexes.replayByRunId.get(String(runId)) : null;
  const memory = runId ? indexes.memoryByRunId.get(String(runId)) : null;
  const learning = runId ? indexes.learningByRunId.get(String(runId)) : null;
  const dnaHash = firstValue(replay?.currentDnaHash, brainRow?.currentDnaHash, memory?.identity?.strategyDnaHash);
  const lineageNode = dnaHash ? indexes.lineageByDnaHash.get(String(dnaHash)) : null;
  return [createJournalRow({
    id: decision.decisionId,
    kind: 'director',
    time: decision.createdAt,
    strategyId,
    market: marketTextFrom(firstValue(evidence.marketDna, evidence.nextReplay?.marketDna, evidence.nextReplay?.targetRegime), copy),
    replay: runId ? shortId(runId, copy.states.noReplay) : copy.states.noReplay,
    learning: learning?.learningRecordId ? shortId(learning.learningRecordId, copy.states.noLearning) : copy.states.noLearning,
    memory: memory?.experimentKey ? copy.states.reused : copy.states.noMemory,
    recommendation: decisionTextFor(decision.action, copy),
    mutation: mutationTextFrom(lineageNode, copy),
    result: replay ? scoreSummary(replay, copy) : copy.states.noResult,
    why: decision.reason,
    next: uiFactoryDecision(decision.action)?.next || copy.states.noNext,
    status: decision.status,
    action: decision.action,
    decisionId: decision.decisionId,
    replayRunId: runId,
    learningRecordId: learning?.learningRecordId || null,
    experimentKey: memory?.experimentKey || null,
    dnaHash,
    marketDnaHash: firstValue(replay?.marketDnaHash, memory?.identity?.marketDnaHash),
    source: copy.states.recommendationFromDirector,
    raw: decision,
    timelineContext: { decision, replay, learning, memory, brain: brainRow, lineageNode },
  }, copy)];
}

function rowsFromBrain(sources, indexes, copy) {
  const brain = serviceData(sources, 'brain', 'strategyBrain') || {};
  const rows = [
    brain.nextReplay,
    ...asArray(brain.priority),
  ].filter(Boolean);
  const seen = new Set();
  return rows
    .filter((row) => {
      const key = `${row.strategyId || ''}|${row.targetRegime || row.marketDnaHash || ''}|${row.informationGain || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row, index) => {
      const replayRunId = row.runId || row.replayRunId || null;
      const replay = replayRunId ? indexes.replayByRunId.get(String(replayRunId)) : null;
      const memory = replayRunId ? indexes.memoryByRunId.get(String(replayRunId)) : null;
      const learning = replayRunId ? indexes.learningByRunId.get(String(replayRunId)) : null;
      const brainRow = indexes.brainByStrategy.get(String(row.strategyId || '')) || row;
      return createJournalRow({
        id: `brain|${row.strategyId || index}|${row.targetRegime || row.marketDnaHash || index}`,
        kind: 'brain',
        time: brain.generatedFor || row.createdAt || row.at,
        strategyId: row.strategyId,
        market: marketTextFrom(row.targetRegime || row.marketDna || row.marketDnaHash, copy),
        replay: replayRunId ? shortId(replayRunId, copy.states.noReplay) : copy.states.noReplay,
        learning: learning?.learningRecordId ? shortId(learning.learningRecordId, copy.states.noLearning) : copy.states.noLearning,
        memory: memory?.experimentKey ? copy.states.reused : copy.states.noMemory,
        recommendation: copy.states.recommendationFromBrain,
        mutation: copy.states.noMutation,
        result: replay ? scoreSummary(replay, copy) : copy.states.noResult,
        why: asArray(row.gapsAddressed).map((gap) => uiFactoryGap(gap)).filter(Boolean)[0]
          || row.reason
          || row.recommendation?.reason
          || copy.states.noReason,
        next: uiFactoryDecision('REQUEST_REPLAY_SCHEDULER').next,
        status: 'recommended',
        action: 'REQUEST_REPLAY_SCHEDULER',
        replayRunId,
        learningRecordId: learning?.learningRecordId || null,
        experimentKey: memory?.experimentKey || null,
        dnaHash: firstValue(replay?.currentDnaHash, memory?.identity?.strategyDnaHash, brainRow.currentDnaHash),
        marketDnaHash: firstValue(row.marketDnaHash, row.targetRegime, replay?.marketDnaHash, memory?.identity?.marketDnaHash),
        source: uiName(FACTORY_TERM_KEYS.STRATEGY_BRAIN),
        raw: row,
        timelineContext: { replay, learning, memory, brain: brainRow },
      }, copy);
    });
}

function rowsFromQueue(sources, indexes, copy) {
  const queue = serviceData(sources, 'queue', 'replayQueue') || {};
  return asArray(queue.jobs).map((job) => {
    const replayRunId = job.run_id || job.runId || null;
    const replay = replayRunId ? indexes.replayByRunId.get(String(replayRunId)) : null;
    const memory = replayRunId ? indexes.memoryByRunId.get(String(replayRunId)) : null;
    const learning = replayRunId ? indexes.learningByRunId.get(String(replayRunId)) : null;
    const strategyId = job.strategy?.id || job.strategyId || replay?.strategyId;
    const dnaHash = firstValue(replay?.currentDnaHash, memory?.identity?.strategyDnaHash);
    return createJournalRow({
      id: `queue|${job.id}`,
      kind: 'queue',
      time: dateValue(job, ['updated_at', 'completed_at', 'failed_at', 'started_at', 'created_at']),
      strategyId,
      market: marketTextFrom(job.market_dna || job.marketDna || replay?.marketDnaHash, copy),
      replay: replayRunId ? shortId(replayRunId, copy.states.noReplay) : shortId(job.id, copy.states.noReplay),
      learning: learning?.learningRecordId ? shortId(learning.learningRecordId, copy.states.noLearning) : copy.states.noLearning,
      memory: job.memory_recorded || memory?.experimentKey ? copy.states.registered : copy.states.noMemory,
      recommendation: decisionTextFor('REQUEST_REPLAY_QUEUE', copy),
      mutation: mutationTextFrom(dnaHash ? indexes.lineageByDnaHash.get(String(dnaHash)) : null, copy),
      result: replay ? scoreSummary(replay, copy) : normalizeStatus(job.status, copy),
      why: job.reason,
      next: job.status === 'completed'
        ? uiName(FACTORY_TERM_KEYS.STRATEGY_LIBRARY)
        : uiFactoryDecision('REQUEST_REPLAY_QUEUE').next,
      status: job.status,
      action: 'REQUEST_REPLAY_QUEUE',
      replayRunId,
      learningRecordId: learning?.learningRecordId || null,
      experimentKey: memory?.experimentKey || null,
      dnaHash,
      marketDnaHash: firstValue(replay?.marketDnaHash, memory?.identity?.marketDnaHash),
      queueJobId: job.id,
      source: uiName(FACTORY_TERM_KEYS.REPLAY_QUEUE),
      raw: job,
      timelineContext: { replay, learning, memory, queueJob: job, lineageNode: dnaHash ? indexes.lineageByDnaHash.get(String(dnaHash)) : null },
    }, copy);
  });
}

function rowsFromLibrary(sources, indexes, copy) {
  const audit = resourceData(sources, 'libraryAudit') || {};
  const events = asArray(audit.events);
  const library = serviceData(sources, 'library', 'strategyLibrary') || {};
  const replayRows = libraryReplayRows(library).map((run) => ({
    type: 'REPLAY_RECORDED',
    strategyId: run.strategyId,
    runId: run.runId || run.replayRunId,
    at: run.at || run.completedAt,
    recordedAt: run.recordedAt || run.at,
    ...run,
  }));
  const rows = events.length ? events : replayRows;
  return rows.map((event, index) => {
    const replayRunId = event.runId || event.replayRunId || event.libraryRunId || null;
    const replay = replayRunId ? indexes.replayByRunId.get(String(replayRunId)) || event : event;
    const memory = replayRunId ? indexes.memoryByRunId.get(String(replayRunId)) : null;
    const learning = replayRunId ? indexes.learningByRunId.get(String(replayRunId)) : null;
    const dnaHash = firstValue(event.dnaHash, replay.currentDnaHash, memory?.identity?.strategyDnaHash);
    const lineageNode = dnaHash ? indexes.lineageByDnaHash.get(String(dnaHash)) : null;
    const status = event.qualified === true ? 'qualified' : 'completed';
    return createJournalRow({
      id: `library|${event.eventId || event.event_id || event.type || index}|${replayRunId || index}`,
      kind: 'library',
      time: dateValue(event, ['recordedAt', 'at', 'completedAt']),
      strategyId: event.strategyId || replay.strategyId,
      market: marketTextFrom(firstValue(event.marketRegimeKey, event.marketDnaHash, event.marketClassification, replay.marketDnaHash), copy),
      replay: replayRunId ? shortId(replayRunId, copy.states.noReplay) : copy.states.noReplay,
      learning: learning?.learningRecordId ? shortId(learning.learningRecordId, copy.states.noLearning) : copy.states.noLearning,
      memory: memory?.experimentKey ? copy.states.registered : copy.states.noMemory,
      recommendation: learning?.recommendedNextAction
        ? decisionTextFor(learning.recommendedNextAction, copy)
        : decisionTextFor('IDLE', copy),
      mutation: mutationTextFrom(lineageNode, copy),
      result: scoreSummary(replay, copy),
      why: learning?.why?.code || event.reason || status,
      next: learning?.recommendedNextAction
        ? nextTextFor(learning.recommendedNextAction, copy)
        : uiFactoryDecision('IDLE').next,
      status,
      action: learning?.recommendedNextAction || 'IDLE',
      replayRunId,
      learningRecordId: learning?.learningRecordId || null,
      experimentKey: memory?.experimentKey || null,
      dnaHash,
      marketDnaHash: firstValue(event.marketDnaHash, replay.marketDnaHash, memory?.identity?.marketDnaHash),
      libraryEventId: event.eventId || event.event_id || null,
      source: copy.states.libraryUpdated,
      raw: event,
      timelineContext: { replay, learning, memory, lineageNode },
    }, copy);
  });
}

function rowsFromMemory(sources, indexes, copy) {
  const experiments = asArray(resourceData(sources, 'memoryExperiments')?.experiments);
  return experiments.map((experiment, index) => {
    const libraryRef = experiment.libraryRef || {};
    const replayRunId = libraryRef.libraryRunId || libraryRef.runId || experiment.libraryRunId || experiment.runId || null;
    const replay = replayRunId ? indexes.replayByRunId.get(String(replayRunId)) : null;
    const learning = replayRunId ? indexes.learningByRunId.get(String(replayRunId)) : null;
    const dnaHash = experiment.identity?.strategyDnaHash || experiment.dnaHash || replay?.currentDnaHash;
    const lineageNode = dnaHash ? indexes.lineageByDnaHash.get(String(dnaHash)) : null;
    const observations = numberOrNull(experiment.observations || experiment.eventCount);
    return createJournalRow({
      id: `memory|${experiment.experimentKey || index}`,
      kind: 'memory',
      time: dateValue(experiment, ['lastUpdated', 'recordedAt', 'firstSeenAt', 'createdAt']),
      strategyId: libraryRef.strategyId || replay?.strategyId,
      market: marketTextFrom(experiment.identity?.marketDnaHash || replay?.marketDnaHash, copy),
      replay: replayRunId ? shortId(replayRunId, copy.states.noReplay) : copy.states.noReplay,
      learning: learning?.learningRecordId ? shortId(learning.learningRecordId, copy.states.noLearning) : copy.states.noLearning,
      memory: observations && observations > 1 ? copy.states.reused : copy.states.registered,
      recommendation: learning?.recommendedNextAction ? decisionTextFor(learning.recommendedNextAction, copy) : copy.states.noRecommendation,
      mutation: mutationTextFrom(lineageNode, copy),
      result: replay ? scoreSummary(replay, copy) : copy.states.noResult,
      why: observations && observations > 1 ? copy.states.reused : copy.states.registered,
      next: learning?.recommendedNextAction ? nextTextFor(learning.recommendedNextAction, copy) : copy.states.noNext,
      status: observations && observations > 1 ? 'duplicate' : 'completed',
      action: learning?.recommendedNextAction || null,
      replayRunId,
      learningRecordId: learning?.learningRecordId || null,
      experimentKey: experiment.experimentKey || null,
      dnaHash,
      marketDnaHash: experiment.identity?.marketDnaHash || replay?.marketDnaHash || null,
      source: uiName(FACTORY_TERM_KEYS.AI_MEMORY),
      raw: experiment,
      timelineContext: { replay, learning, memory: experiment, lineageNode },
    }, copy);
  });
}

function rowsFromLearning(sources, indexes, copy) {
  const learning = learningFromSources(sources);
  const records = [
    ...asArray(learning.recordsList || learning.learningRecords),
    ...asArray(learning.latestRecord ? [learning.latestRecord] : []),
    ...asArray(learning.recommendations).map((row) => ({ ...row, recommendationOnly: true })),
  ];
  const seen = new Set();
  return records
    .filter((record) => {
      const key = `${record.learningRecordId || ''}|${record.replayRunId || ''}|${record.strategyId || ''}|${record.action || record.recommendedNextAction || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((record, index) => {
      const replay = record.replayRunId ? indexes.replayByRunId.get(String(record.replayRunId)) : null;
      const memory = record.experimentKey
        ? asArray(resourceData(sources, 'memoryExperiments')?.experiments).find((row) => row.experimentKey === record.experimentKey)
        : (record.replayRunId ? indexes.memoryByRunId.get(String(record.replayRunId)) : null);
      const dnaHash = firstValue(record.dnaHash, memory?.identity?.strategyDnaHash, replay?.currentDnaHash);
      const lineageNode = dnaHash ? indexes.lineageByDnaHash.get(String(dnaHash)) : null;
      const action = record.recommendedNextAction || record.action || record.recommendation?.action;
      return createJournalRow({
        id: `learning|${record.learningRecordId || record.replayRunId || index}|${action || index}`,
        kind: 'learning',
        time: dateValue(record, ['createdAt', 'recordedAt', 'at'])
          || replay?.at
          || memory?.libraryRef?.recordedAt,
        strategyId: record.strategyId || replay?.strategyId || memory?.libraryRef?.strategyId,
        market: marketTextFrom(record.marketDna || record.marketDnaHash || replay?.marketDnaHash, copy),
        replay: record.replayRunId ? shortId(record.replayRunId, copy.states.noReplay) : copy.states.noReplay,
        learning: record.learningRecordId ? shortId(record.learningRecordId, copy.states.noLearning) : copy.states.learningRecorded,
        memory: memory?.experimentKey ? copy.states.registered : copy.states.noMemory,
        recommendation: action ? decisionTextFor(action, copy) : copy.states.noRecommendation,
        mutation: mutationTextFrom(lineageNode, copy),
        result: scoreSummary(record, copy),
        why: record.why?.code || record.reason || record.recommendation?.reason,
        next: action ? nextTextFor(action, copy) : copy.states.noNext,
        status: record.succeeded === true ? 'success' : record.recommendationOnly ? 'recommended' : 'completed',
        action,
        replayRunId: record.replayRunId || null,
        learningRecordId: record.learningRecordId || null,
        experimentKey: record.experimentKey || memory?.experimentKey || null,
        dnaHash,
        marketDnaHash: record.marketDna?.marketDnaHash || record.marketDnaHash || replay?.marketDnaHash || null,
        source: copy.states.learningRecorded,
        raw: record,
        timelineContext: { replay, learning: record, memory, lineageNode },
      }, copy);
    });
}

function rowsFromLineage(sources, indexes, copy) {
  const lineage = serviceData(sources, 'lineage', 'evolution') || {};
  return asArray(lineage.nodes).map((node, index) => {
    const memory = indexes.memoryByDnaHash.get(String(node.dnaHash || '')) || null;
    const replayRunId = memory?.libraryRef?.libraryRunId || null;
    const replay = replayRunId ? indexes.replayByRunId.get(String(replayRunId)) : null;
    const learning = replayRunId ? indexes.learningByRunId.get(String(replayRunId)) : null;
    return createJournalRow({
      id: `lineage|${node.dnaHash || index}`,
      kind: 'lineage',
      time: node.createdAt || node.recordedAt || node.at,
      strategyId: node.strategyId || node.rootStrategyId || replay?.strategyId,
      market: marketTextFrom(memory?.identity?.marketDnaHash || replay?.marketDnaHash, copy),
      replay: replayRunId ? shortId(replayRunId, copy.states.noReplay) : copy.states.noReplay,
      learning: learning?.learningRecordId ? shortId(learning.learningRecordId, copy.states.noLearning) : copy.states.noLearning,
      memory: memory?.experimentKey ? copy.states.registered : copy.states.noMemory,
      recommendation: decisionTextFor('REQUEST_EVOLUTION_ENGINE', copy),
      mutation: mutationTextFrom(node, copy),
      result: replay ? scoreSummary(replay, copy) : copy.states.noResult,
      why: node.retiredReason || node.mutationType || copy.states.mutationCreated,
      next: uiFactoryDecision('REQUEST_REPLAY_SCHEDULER').next,
      status: node.retired ? 'completed' : 'created',
      action: 'REQUEST_EVOLUTION_ENGINE',
      replayRunId,
      learningRecordId: learning?.learningRecordId || null,
      experimentKey: memory?.experimentKey || null,
      dnaHash: node.dnaHash || null,
      marketDnaHash: memory?.identity?.marketDnaHash || replay?.marketDnaHash || null,
      source: copy.states.mutationCreated,
      raw: node,
      timelineContext: { replay, learning, memory, lineageNode: node },
    }, copy);
  });
}

function actionFromEventType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  if (normalized.includes('safety') || normalized.includes('risk') || normalized.includes('blocked')) return 'SAFETY_HOLD';
  if (normalized.includes('data_backfill')) return 'REQUEST_BACKFILL_SERVICE';
  if (normalized.includes('optimization')) return 'REQUEST_AI_OPTIMIZER';
  if (normalized.includes('candidate')) return 'REQUEST_APPROVAL_SERVICE';
  if (normalized.includes('batch') || normalized.includes('strategy_test') || normalized.includes('replay')) return 'REQUEST_REPLAY_QUEUE';
  if (normalized.includes('learning')) return 'REQUEST_REPLAY_SCHEDULER';
  if (normalized.includes('priority')) return 'REQUEST_REPLAY_SCHEDULER';
  return 'IDLE';
}

function resultFromEvent(event, copy) {
  const score = numberOrNull(event.score ?? event.details?.score ?? event.details?.strategyScore);
  const status = firstValue(event.decision, event.details?.status, event.type, event.event_type);
  if (score !== null) return `${copy.resultLabels.strategyScore} ${displayNumber(score, copy.emptyValue, 1)}`;
  return status ? normalizeStatus(status, copy) : copy.states.noResult;
}

function rowsFromEvents(sources, indexes, copy) {
  const events = [
    ...asArray(resourceData(sources, 'eventsRecent')?.events).map((event) => ({ ...event, sourceKind: 'event' })),
    ...asArray(resourceData(sources, 'auditRecent')?.events).map((event) => ({ ...event, sourceKind: 'audit' })),
  ];
  return events.map((event, index) => {
    const details = event.details || event.metadata || {};
    const replayRunId = details.replayRunId || details.replay_run_id || details.runId || details.run_id || event.replayRunId || event.runId || null;
    const replay = replayRunId ? indexes.replayByRunId.get(String(replayRunId)) : null;
    const memory = replayRunId ? indexes.memoryByRunId.get(String(replayRunId)) : null;
    const learning = replayRunId ? indexes.learningByRunId.get(String(replayRunId)) : null;
    const dnaHash = firstValue(details.dnaHash, details.strategyDnaHash, memory?.identity?.strategyDnaHash, replay?.currentDnaHash);
    const lineageNode = dnaHash ? indexes.lineageByDnaHash.get(String(dnaHash)) : null;
    const action = actionFromEventType(event.type || event.event_type);
    return createJournalRow({
      id: `event|${event.sourceKind}|${event.event_id || event.eventId || index}`,
      kind: event.sourceKind,
      time: event.timestamp || event.recordedAt || event.at,
      strategyId: event.strategy_id || event.strategyId || event.strategy || details.strategyId || details.strategy_id || replay?.strategyId,
      market: marketTextFrom(firstValue(event.market, event.symbol, details.market, details.marketDnaHash, replay?.marketDnaHash), copy),
      replay: replayRunId ? shortId(replayRunId, copy.states.noReplay) : copy.states.noReplay,
      learning: learning?.learningRecordId
        ? shortId(learning.learningRecordId, copy.states.noLearning)
        : String(event.source || '').toLowerCase() === 'learning' || String(event.event_type || event.type || '').toLowerCase().includes('learning')
          ? copy.states.learningRecorded
          : copy.states.noLearning,
      memory: memory?.experimentKey ? copy.states.registered : copy.states.noMemory,
      recommendation: decisionTextFor(action, copy),
      mutation: mutationTextFrom(lineageNode, copy),
      result: replay ? scoreSummary(replay, copy) : resultFromEvent(event, copy),
      why: event.reason || event.message || details.reason,
      next: nextTextFor(action, copy),
      status: event.decision || details.status || event.type || event.event_type,
      action,
      replayRunId,
      learningRecordId: learning?.learningRecordId || null,
      experimentKey: memory?.experimentKey || null,
      dnaHash,
      marketDnaHash: firstValue(details.marketDnaHash, memory?.identity?.marketDnaHash, replay?.marketDnaHash),
      source: event.sourceKind === 'audit' ? copy.states.auditRecorded : copy.states.eventRecorded,
      raw: event,
      timelineContext: { replay, learning, memory, lineageNode },
    }, copy);
  });
}

function dedupeRows(rows) {
  const byId = new Map();
  for (const row of rows) {
    const key = row.id || rowKey(row);
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, row);
      continue;
    }
    byId.set(key, {
      ...existing,
      ...Object.fromEntries(Object.entries(row).filter(([, value]) => value != null && value !== '')),
      timelineContext: {
        ...(existing.timelineContext || {}),
        ...(row.timelineContext || {}),
      },
    });
  }
  return [...byId.values()].sort((a, b) => {
    const timeDiff = (parseTime(b.time) || 0) - (parseTime(a.time) || 0);
    if (timeDiff) return timeDiff;
    return String(a.id).localeCompare(String(b.id));
  });
}

function rowMatchesContext(row, value) {
  const needle = String(value || '').trim();
  if (!needle) return false;
  return [
    row.id,
    row.decisionId,
    row.replayRunId,
    row.strategyId,
    row.learningRecordId,
    row.experimentKey,
    ...(row.queryKeys || []),
  ].filter(Boolean).map(String).includes(needle);
}

function selectedIdFromSearch(rows, searchParams) {
  for (const key of ['decision', 'test', 'strategy', 'id']) {
    const value = searchParams.get(key);
    const match = rows.find((row) => rowMatchesContext(row, value));
    if (match) return match.id;
  }
  return null;
}

function contextFromJournalRow(row = {}) {
  return {
    decisionId: row.decisionId || row.id,
    strategyId: row.strategyId,
    testId: row.replayRunId,
    replayRunId: row.replayRunId,
    marketDnaHash: row.marketDnaHash,
  };
}

function journalContextActions(row) {
  const context = contextFromJournalRow(row || {});
  if (!row) {
    return [
      contextAction('factory', {}, { primary: true }),
      contextAction('test'),
      contextAction('strategy'),
    ];
  }
  return [
    contextAction(row.replayRunId ? 'test' : 'strategy', context, { primary: true }),
    ...(row.replayRunId ? [contextAction('strategy', context)] : [contextAction('test', context)]),
    contextAction('paper', context),
    contextAction('factory', context),
  ];
}

function durationLabel(start, end, copy) {
  const startMs = parseTime(start);
  const endMs = parseTime(end);
  if (startMs === null || endMs === null || endMs < startMs) return copy.states.noDuration;
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes} min ${remainingSeconds} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} h ${remainingMinutes} min` : `${hours} h`;
}

function timelineTimestamp(row, key, context) {
  if (key === 'replay') {
    return dateValue(context.queueJob, ['completed_at', 'failed_at', 'started_at', 'updated_at', 'created_at'])
      || dateValue(context.replay, ['completedAt', 'recordedAt', 'at', 'startedAt'])
      || row.time;
  }
  if (key === 'learning') return dateValue(context.learning, ['createdAt', 'recordedAt', 'at']) || row.time;
  if (key === 'memory') return dateValue(context.memory, ['lastUpdated', 'recordedAt', 'firstSeenAt', 'createdAt']) || row.time;
  if (key === 'brain') return dateValue(context.brain, ['generatedFor', 'generatedAt', 'createdAt', 'at']) || row.time;
  if (key === 'director') return dateValue(context.decision, ['createdAt', 'updatedAt', 'at']) || row.time;
  if (key === 'evolution') return dateValue(context.lineageNode, ['createdAt', 'recordedAt', 'at']) || row.time;
  if (key === 'library') {
    return dateValue(context.replay, ['recordedAt', 'completedAt', 'at'])
      || dateValue(row.raw, ['recordedAt', 'completedAt', 'at'])
      || row.time;
  }
  return row.time;
}

function timelineDuration(row, key, context, copy) {
  if (key === 'replay') {
    return durationLabel(
      dateValue(context.queueJob, ['started_at', 'created_at']) || dateValue(context.replay, ['startedAt', 'from']),
      dateValue(context.queueJob, ['completed_at', 'failed_at', 'updated_at']) || dateValue(context.replay, ['completedAt', 'recordedAt', 'at']),
      copy,
    );
  }
  if (key === 'director') {
    return durationLabel(
      dateValue(context.decision, ['createdAt']),
      dateValue(context.decision, ['completedAt', 'updatedAt', 'createdAt']),
      copy,
    );
  }
  if (key === 'learning') {
    return durationLabel(
      dateValue(context.learning, ['startedAt', 'createdAt', 'recordedAt']),
      dateValue(context.learning, ['completedAt', 'updatedAt', 'createdAt', 'recordedAt']),
      copy,
    );
  }
  return copy.states.noDuration;
}

function timelineHref(key, row) {
  const context = contextFromJournalRow(row || {});
  if (key === 'replay') return contextHref('test', context);
  if (key === 'learning' || key === 'memory' || key === 'brain' || key === 'director' || key === 'optimizer') {
    return contextHref('decision', context);
  }
  if (key === 'evolution') {
    return context.strategyId
      ? `/factory/family-tree?strategy=${encodeURIComponent(context.strategyId)}`
      : '/factory/family-tree';
  }
  if (key === 'library') return contextHref('strategy', context);
  return null;
}

function timelineResult(row, key, context, copy) {
  if (key === 'replay') return context.replay ? scoreSummary(context.replay, copy) : row.result;
  if (key === 'learning') return context.learning ? scoreSummary(context.learning, copy) : row.learning;
  if (key === 'memory') return context.memory ? row.memory : copy.states.noMemory;
  if (key === 'brain') return row.recommendation;
  if (key === 'director') return row.next;
  if (key === 'optimizer') return row.mutation === copy.states.noMutation ? copy.states.noParameterChanges : row.mutation;
  if (key === 'evolution') return row.mutation === copy.states.noMutation ? copy.states.noGenerationHistory : row.mutation;
  if (key === 'library') return row.result === copy.states.noResult ? copy.states.noStrategyLife : row.result;
  return copy.states.noStepData;
}

function timelineHappened(row, key, context, copy) {
  if (key === 'replay') return row.replay;
  if (key === 'learning') return row.learning;
  if (key === 'memory') return row.memory;
  if (key === 'brain') return context.brain || row.kind === 'brain' ? row.why : copy.states.noStepData;
  if (key === 'director') return row.recommendation;
  if (key === 'optimizer') return row.mutation === copy.states.noMutation ? copy.states.noParameterChanges : row.mutation;
  if (key === 'evolution') return context.lineageNode || row.kind === 'lineage' ? row.mutation : copy.states.noGenerationHistory;
  if (key === 'library') return row.result === copy.states.noResult ? copy.states.noStrategyLife : row.result;
  return copy.states.noStepData;
}

function buildTimeline(row, copy) {
  if (!row) return [];
  const context = row.timelineContext || {};
  const hasReplay = Boolean(row.replayRunId || context.replay || context.queueJob);
  const hasLearning = Boolean(row.learningRecordId || context.learning);
  const hasMemory = Boolean(row.experimentKey || context.memory);
  const hasBrain = Boolean(context.brain || row.kind === 'brain');
  const hasDirector = Boolean(context.decision || row.kind === 'director');
  const hasOptimizer = ['REQUEST_AI_OPTIMIZER', 'REQUEST_EVOLUTION_ENGINE'].includes(normalizeAction(row.action));
  const hasEvolution = Boolean(row.dnaHash || context.lineageNode || row.kind === 'lineage');
  const hasLibrary = Boolean(row.libraryEventId || context.replay || row.kind === 'library');
  const statusFor = {
    replay: hasReplay ? copy.states.found : copy.states.missing,
    learning: hasLearning ? copy.states.found : copy.states.missing,
    memory: hasMemory ? copy.states.found : copy.states.missing,
    brain: hasBrain ? copy.states.found : copy.states.missing,
    director: hasDirector ? copy.states.found : copy.states.missing,
    optimizer: hasOptimizer ? copy.states.found : copy.states.missing,
    evolution: hasEvolution ? copy.states.found : copy.states.missing,
    library: hasLibrary ? copy.states.found : copy.states.missing,
  };
  const colorFor = (key) => (statusFor[key] === copy.states.found ? 'success' : 'neutral');
  return TIMELINE_ORDER.map((key) => {
    const timestamp = timelineTimestamp(row, key, context);
    return {
      decisionId: `${row.id}|${key}`,
      stepKey: key,
      label: copy.timeline[key],
      timestamp,
      timeLabel: formatDateTime(timestamp, copy.emptyValue),
      duration: timelineDuration(row, key, context, copy),
      status: statusFor[key],
      color: colorFor(key),
      result: timelineResult(row, key, context, copy),
      happened: timelineHappened(row, key, context, copy),
      why: key === 'director'
        ? `${copy.timelineReasons[key]} ${row.recommendation}`
        : copy.timelineReasons[key],
      current: row.next,
      actionLabel: copy.timelineActions[key],
      href: timelineHref(key, row),
      reason: key === 'director'
        ? `${copy.timelineReasons[key]} ${row.recommendation}`
        : copy.timelineReasons[key],
    };
  });
}

function buildJournalModel({ loading, sources }) {
  const copy = uiDecisionJournal();
  const library = serviceData(sources, 'library', 'strategyLibrary') || {};
  const memoryExperiments = asArray(resourceData(sources, 'memoryExperiments')?.experiments);
  const learning = learningFromSources(sources);
  const lineage = serviceData(sources, 'lineage', 'evolution') || {};
  const brain = serviceData(sources, 'brain', 'strategyBrain') || {};
  const queue = serviceData(sources, 'queue', 'replayQueue') || {};
  const indexes = buildIndexes({ library, memoryExperiments, learning, lineage, brain, queue });
  const rows = dedupeRows([
    ...rowsFromCurrentDecision(sources, indexes, copy),
    ...rowsFromBrain(sources, indexes, copy),
    ...rowsFromQueue(sources, indexes, copy),
    ...rowsFromLibrary(sources, indexes, copy),
    ...rowsFromMemory(sources, indexes, copy),
    ...rowsFromLearning(sources, indexes, copy),
    ...rowsFromLineage(sources, indexes, copy),
    ...rowsFromEvents(sources, indexes, copy),
  ]);
  const latest = rows.find((row) => parseTime(row.time) !== null) || rows[0] || null;
  const sourceCounts = sourceSummary(sources);
  const withResults = rows.filter((row) => row.result && row.result !== copy.states.noResult).length;
  const reused = rows.filter((row) => row.memory === copy.states.reused).length;
  const nextSteps = new Set(rows.map((row) => row.next).filter((value) => value && value !== copy.states.noNext));

  return {
    copy,
    loading,
    rows,
    latest,
    sourceCounts,
    kpis: [
      {
        label: copy.labels.total,
        value: loading ? copy.loading : displayNumber(rows.length, copy.emptyValue),
        hint: latest ? latest.timeLabel : copy.states.noDecisions,
        tone: rows.length ? 'success' : 'neutral',
      },
      {
        label: copy.labels.withResults,
        value: displayNumber(withResults, copy.emptyValue),
        hint: uiName(FACTORY_TERM_KEYS.STRATEGY_LIBRARY),
        tone: withResults ? 'success' : 'neutral',
      },
      {
        label: copy.labels.reusedMemory,
        value: displayNumber(reused, copy.emptyValue),
        hint: uiName(FACTORY_TERM_KEYS.AI_MEMORY),
        tone: reused ? 'success' : 'neutral',
      },
      {
        label: copy.labels.sources,
        value: `${sourceCounts.available}/${sourceCounts.total}`,
        hint: `${copy.labels.missingSources}: ${displayNumber(sourceCounts.missing, copy.emptyValue)}`,
        tone: sourceCounts.missing ? 'warning' : 'success',
      },
    ],
    nextStepCount: nextSteps.size,
  };
}

function DecisionRow({ row, selected, onSelect, copy }) {
  const columns = copy.columns;
  return (
    <button
      type="button"
      onClick={() => onSelect(row.id)}
      aria-label={`${copy.openRow}: ${row.timeLabel}`}
      style={{
        width: '100%',
        border: selected ? '1px solid var(--blue-border)' : '1px solid var(--border)',
        background: selected ? 'var(--blue-dim)' : 'var(--surface)',
        color: 'var(--text)',
        borderRadius: 'var(--r)',
        padding: 'var(--s4)',
        textAlign: 'left',
        display: 'grid',
        gap: 'var(--s3)',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s3)', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{row.timeLabel}</strong>
          <span style={{ color: 'var(--muted)', fontSize: 12, overflowWrap: 'anywhere' }}>
            {row.strategy} · {row.market}
          </span>
        </div>
        <StatusBadge tone={row.tone}>{row.status}</StatusBadge>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 8,
        }}
      >
        {[
          [columns.replay, row.replay],
          [columns.learning, row.learning],
          [columns.memory, row.memory],
          [columns.recommendation, row.recommendation],
          [columns.mutation, row.mutation],
          [columns.result, row.result],
        ].map(([label, value]) => (
          <span key={label} style={{ minWidth: 0 }}>
            <span style={{ display: 'block', color: 'var(--muted)', fontFamily: 'var(--data)', fontSize: 9.5, fontWeight: 400, textTransform: 'uppercase', letterSpacing: '.09em' }}>
              {label}
            </span>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere', marginTop: 'var(--s1)' }}>
              {value}
            </span>
          </span>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
        <span>
          <span style={{ display: 'block', color: 'var(--muted)', fontFamily: 'var(--data)', fontSize: 9.5, fontWeight: 400, textTransform: 'uppercase', letterSpacing: '.09em' }}>
            {columns.why}
          </span>
          <span style={{ display: 'block', fontSize: 13, lineHeight: 1.35, overflowWrap: 'anywhere', marginTop: 'var(--s1)' }}>{row.why}</span>
        </span>
        <span>
          <span style={{ display: 'block', color: 'var(--muted)', fontFamily: 'var(--data)', fontSize: 9.5, fontWeight: 400, textTransform: 'uppercase', letterSpacing: '.09em' }}>
            {columns.next}
          </span>
          <span style={{ display: 'block', fontSize: 13, lineHeight: 1.35, overflowWrap: 'anywhere', marginTop: 'var(--s1)' }}>{row.next}</span>
        </span>
      </div>
    </button>
  );
}

function JournalList({ rows, selectedId, onSelect, copy }) {
  if (!rows.length) {
    return (
      <div className="m-empty">
        <div className="m-empty-title">{copy.states.noDecisions}</div>
        <div className="m-empty-body">{copy.states.noTimeline}</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--s3)' }}>
      {rows.map((row) => (
        <DecisionRow
          key={row.id}
          row={row}
          selected={row.id === selectedId}
          onSelect={onSelect}
          copy={copy}
        />
      ))}
    </div>
  );
}

function TimelineStepList({ timeline, selectedStepKey, onSelect, copy }) {
  if (!timeline.length) return null;
  const fields = copy.timelineFields;
  return (
    <div style={{ display: 'grid', gap: 'var(--s3)' }} data-decision-timeline-steps>
      {timeline.map((item) => {
        const selected = item.stepKey === selectedStepKey;
        return (
          <button
            key={item.decisionId}
            type="button"
            onClick={() => onSelect(item.stepKey)}
            aria-label={`${fields.open}: ${item.label}`}
            data-decision-timeline-step={item.stepKey}
            style={{
              border: selected ? '1px solid var(--blue-border)' : '1px solid var(--border)',
              background: selected ? 'var(--blue-dim)' : 'var(--surface)',
              color: 'var(--text)',
              borderRadius: 'var(--r)',
              cursor: 'pointer',
              padding: 'var(--s4)',
              textAlign: 'left',
              display: 'grid',
              gap: 'var(--s3)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ minWidth: 0 }}>
                <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{item.label}</strong>
                <span style={{ display: 'block', color: 'var(--muted)', fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>
                  {item.actionLabel}
                </span>
              </span>
              <StatusBadge tone={item.color}>{item.status}</StatusBadge>
            </div>
            <FieldGrid
              items={[
                { label: fields.time, value: item.timeLabel },
                { label: fields.duration, value: item.duration },
                { label: fields.status, value: item.status, tone: item.color },
                { label: fields.result, value: item.result },
              ]}
            />
          </button>
        );
      })}
    </div>
  );
}

function TimelineStepDetail({ step, copy }) {
  if (!step) return null;
  const fields = copy.timelineFields;
  return (
    <div
      data-decision-timeline-detail={step.stepKey}
      style={{
        padding: 12,
        border: '1px solid var(--border)',
        borderRadius: 'var(--r)',
        background: 'var(--surface-2)',
        display: 'grid',
        gap: 'var(--s3)',
      }}
    >
      <FieldGrid
        items={[
          { label: fields.happened, value: step.happened },
          { label: fields.why, value: step.why },
          { label: fields.outcome, value: step.result },
          { label: fields.current, value: step.current },
          { label: fields.open, value: step.actionLabel },
        ]}
      />
      {step.href ? (
        <Link to={step.href} className="btn ghost" style={{ justifySelf: 'start' }}>
          {step.actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

function TimelinePanel({ row, copy }) {
  const timeline = buildTimeline(row, copy);
  const [selectedStepKey, setSelectedStepKey] = useState(TIMELINE_ORDER[0]);
  useEffect(() => {
    setSelectedStepKey(TIMELINE_ORDER[0]);
  }, [row?.id]);
  const selectedStep = timeline.find((item) => item.stepKey === selectedStepKey) || timeline[0] || null;
  return (
    <OverviewPanel
      eyebrow={copy.readOnly}
      title={copy.labels.timeline}
      summary={row ? row.story?.story || aiStoryEventText('learned', { learning: row.why || row.result }) : copy.states.noTimeline}
      style={{ display: 'grid', gap: 'var(--s4)' }}
    >
      {row ? (
        <FieldGrid
          items={[
            { label: copy.columns.time, value: row.timeLabel },
            { label: copy.columns.strategy, value: row.strategy },
            { label: copy.columns.market, value: row.market },
            { label: copy.columns.result, value: row.result },
            { label: copy.labels.source, value: row.source },
            { label: copy.columns.next, value: row.next },
          ]}
        />
      ) : null}

      <ContextNavigation compact actions={journalContextActions(row)} />

      <DecisionTimeline items={timeline} emptyText={copy.states.noTimeline} />
      <TimelineStepList
        timeline={timeline}
        selectedStepKey={selectedStep?.stepKey || selectedStepKey}
        onSelect={setSelectedStepKey}
        copy={copy}
      />
      <TimelineStepDetail step={selectedStep} copy={copy} />

      <div
        style={{
          padding: 12,
          border: '1px solid var(--border)',
          borderRadius: 'var(--r)',
          background: 'var(--surface-2)',
        }}
      >
        <FieldGrid
          items={[
            { label: copy.labels.help, value: copy.help.what },
            { label: uiName(FACTORY_TERM_KEYS.FACTORY_STATUS), value: copy.help.why },
            { label: uiName(FACTORY_TERM_KEYS.FACTORY_DIRECTOR), value: copy.help.next },
          ]}
        />
      </div>
    </OverviewPanel>
  );
}

export default function AiDecisionJournalPage() {
  const data = useDecisionJournalData();
  const model = useMemo(() => buildJournalModel(data), [data]);
  const { copy } = model;
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState(null);
  const requestedSelectionId = useMemo(
    () => selectedIdFromSearch(model.rows, searchParams),
    [model.rows, searchParams],
  );

  useEffect(() => {
    if (!model.rows.length) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) => {
      if (requestedSelectionId) return requestedSelectionId;
      return model.rows.some((row) => row.id === current) ? current : model.rows[0].id;
    });
  }, [model.rows, requestedSelectionId]);

  const handleSelect = useCallback((id) => {
    setSelectedId(id);
    const row = model.rows.find((candidate) => candidate.id === id);
    if (!row) return;
    const params = new URLSearchParams(searchParams);
    params.set('decision', row.decisionId || row.id);
    if (row.replayRunId) params.set('test', row.replayRunId);
    if (row.strategyId) params.set('strategy', row.strategyId);
    setSearchParams(params, { replace: true });
  }, [model.rows, searchParams, setSearchParams]);

  const selectedRow = model.rows.find((row) => row.id === selectedId) || null;

  return (
    <DashboardShell title={copy.title} subtitle={copy.subtitle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s4)', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--s5)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--s3)', flex: '1 1 520px' }}>
          {model.kpis.map((metric) => (
            <MetricCard
              key={metric.label}
              label={metric.label}
              value={metric.value}
              hint={metric.hint}
              tone={metric.tone}
            />
          ))}
        </div>
        <button type="button" className="btn ghost" onClick={data.refresh}>
          {copy.refreshButton}
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
          gap: 'var(--s5)',
          alignItems: 'start',
        }}
      >
        <OverviewPanel
          eyebrow={copy.readOnly}
          title={copy.title}
          summary={copy.help.what}
          style={{ display: 'grid', gap: 'var(--s4)' }}
        >
          <FieldGrid
            items={[
              { label: copy.labels.total, value: displayNumber(model.rows.length, copy.emptyValue) },
              { label: copy.labels.activeNextSteps, value: displayNumber(model.nextStepCount, copy.emptyValue) },
              { label: copy.labels.availableSources, value: `${model.sourceCounts.available}/${model.sourceCounts.total}` },
              { label: copy.labels.missingSources, value: displayNumber(model.sourceCounts.missing, copy.emptyValue), tone: model.sourceCounts.missing ? 'warning' : undefined },
            ]}
          />
          <JournalList
            rows={model.rows}
            selectedId={selectedId}
            onSelect={handleSelect}
            copy={copy}
          />
        </OverviewPanel>

        <TimelinePanel row={selectedRow} copy={copy} />
      </div>
    </DashboardShell>
  );
}
