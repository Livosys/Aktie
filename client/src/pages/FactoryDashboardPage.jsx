import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DashboardShell } from '../components/dashboard/DashboardKit.jsx';
import ContextNavigation, { contextAction, contextHref } from '../components/ContextNavigation.jsx';
import {
  AIStatusPanel,
  ActionCenter,
  FactoryBrainCards,
  FactoryStateGrid,
} from '../components/factory/FactoryWorkflowPanels.jsx';
import FactoryLiveActivityFeed from '../components/factory/FactoryLiveActivityFeed.jsx';
import FactoryTimeline from '../components/factory/FactoryTimeline.jsx';
import FactoryWorkPipeline from '../components/factory/FactoryWorkPipeline.jsx';
import QuickHelpModal from '../components/tradingos/QuickHelpModal.jsx';
import {
  aiStoryEventText,
  aiStoryFactory,
  aiStoryFactoryActivity,
} from '../services/aiStoryService.js';
import {
  FACTORY_STATUS_KEYS,
  FACTORY_TERM_KEYS,
  uiFactoryDashboard,
  uiFactoryDecision,
  uiFactoryGap,
  uiFactoryReason,
  uiFactorySafeText,
  uiName,
  uiStatus,
  uiStrategyName,
} from '../services/uiTerminologyService.js';

// ── AI Fabriken · startsidan ─────────────────────────────────────────────────
//
// Sidan svarar på fyra frågor i fast ordning, och ordningen är designen:
//
//   1. Vad händer?          → hero-meningen
//   2. Varför händer det?   → hero-brödtexten
//   3. Behöver jag göra något? → zonen "Behöver dig", EN sak
//   4. Vad blir nästa steg? → sista raden i hero, och stegen under fliken Arbetet
//
// Läsvy. Sidan hämtar bara med GET och skriver ingenting. Knapparna i
// "Behöver dig" är länkar till de vyer där handlingen redan går att utföra.
//
// Fliken Arbetet ligger på samma route med ?tab=arbetet, enligt beslut K11.

// Fabriksbeslutet räknas fram ur hela biblioteket och hela marknadskatalogen.
// Bakänden cachar numera på exakta filavtryck, men den FÖRSTA frågan efter en
// omstart bygger om katalogen och tar sekunder. En sex sekunders timeout gjorde
// att sidan alltid avbröt just den frågan och visade tomma paneler i stället —
// den såg ut som "inga resultat" fast svaret var på väg.
const FETCH_TIMEOUT_MS = 30000;
// Läsvy. Fabriken fattar ett beslut per replay-cykel, inte fyra gånger i
// minuten, och varje uppdatering kostar riktig CPU i bakänden.
const AUTO_REFRESH_MS = 60000;

const TAB_TODAY = 'idag';
const TAB_WORK = 'arbetet';

// /factory/director, /factory/decision, /factory/next och /factory/status är
// fyra vyer av samma beräkning i bakänden, och director bär redan alla tre
// andra: beslutet ligger i .decision och tjänsternas tillstånd i .systemStatus.
// Sidan hämtade tidigare alla fyra, vilket lät bakänden räkna om hela
// fabriksbeslutet fyra gånger per laddning. Fallbacken i currentDecision() och
// serviceData() står kvar — den kostar ingenting och gör sidan robust om någon
// senare vill lägga tillbaka en källa.
const ENDPOINTS = Object.freeze({
  director: '/api/factory/director',
  brain: '/api/strategy-brain',
  queue: '/api/replay/queue',
  batchStatus: '/api/status/batches',
  library: '/api/strategy-library',
  market: '/api/market-intelligence',
  marketCatalog: '/api/market-intelligence/catalog',
  memoryStatus: '/api/ai-memory/status',
  memoryExperiments: '/api/ai-memory/experiments?limit=25',
  lineage: '/api/strategy-family-tree',
  learningSummary: '/api/learning/latest-summary',
  approvalStrategies: '/api/futures-paper/strategies',
});

function emptyResource() {
  return { loading: true, ok: false, data: null, status: null, failure: null, error: null };
}

function initialSources() {
  return Object.fromEntries(Object.keys(ENDPOINTS).map((key) => [key, emptyResource()]));
}

// Varför ett anrop misslyckades avgör vad användaren ska göra åt det, och de
// tre svaren är helt olika saker:
//
//   auth     du är utloggad — logga in igen
//   timeout  bakänden svarade inte i tid — den räknar, försök igen
//   error    bakänden eller nätet gav ett fel — något är trasigt
//
// Tidigare kollapsade alla tre till `error: 'HTTP 401'` och sidan visade
// tomma paneler. Ett 401 får ALDRIG se ut som "inga resultat".
const FAILURE = Object.freeze({ AUTH: 'auth', TIMEOUT: 'timeout', ERROR: 'error' });

async function fetchResource(url, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, FETCH_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const response = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      return {
        loading: false, ok: false, data: null, status: response.status,
        failure: FAILURE.AUTH, error: `HTTP ${response.status}`,
      };
    }
    if (!response.ok) {
      return {
        loading: false, ok: false, data: null, status: response.status,
        failure: FAILURE.ERROR, error: `HTTP ${response.status}`,
      };
    }
    return { loading: false, ok: true, data: await response.json(), status: 200, failure: null, error: null };
  } catch (err) {
    return {
      loading: false, ok: false, data: null, status: null,
      failure: timedOut ? FAILURE.TIMEOUT : FAILURE.ERROR,
      error: timedOut ? `timeout efter ${Math.round(FETCH_TIMEOUT_MS / 1000)}s` : (err?.message || String(err)),
    };
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Sidans samlade hämtningsläge. Auth väger tyngst: är man utloggad är allt
 * annat en följd av det och inte värt att rapportera separat.
 */
function connectionState(sources) {
  const rows = Object.values(sources || {});
  if (rows.some((row) => row.loading)) return null;
  const failed = rows.filter((row) => !row.ok);
  if (!failed.length) return null;
  if (failed.some((row) => row.failure === FAILURE.AUTH)) {
    return {
      kind: FAILURE.AUTH,
      title: 'Du är utloggad',
      detail: 'Sessionen har gått ut. Logga in igen för att se fabrikens data.',
      actionHref: '/login',
      actionLabel: 'Till inloggningen',
    };
  }
  if (failed.length === rows.length && failed.every((row) => row.failure === FAILURE.TIMEOUT)) {
    return {
      kind: FAILURE.TIMEOUT,
      title: 'Bakänden svarade inte i tid',
      detail: 'Fabriken räknar fortfarande. Panelerna nedan är tomma därför att svaret uteblev — inte därför att det saknas data.',
    };
  }
  return {
    kind: FAILURE.ERROR,
    title: failed.length === rows.length ? 'Ingen kontakt med bakänden' : 'Delar av sidan kunde inte hämtas',
    detail: `${failed.length} av ${rows.length} källor svarade inte: ${[...new Set(failed.map((row) => row.error))].slice(0, 3).join(', ')}.`,
  };
}

function useFactoryDashboardData() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [state, setState] = useState(() => ({
    loading: true,
    refreshing: false,
    lastRefreshAt: null,
    sources: initialSources(),
  }));

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({
      loading: Object.values(current.sources).every((source) => source.loading),
      refreshing: true,
      lastRefreshAt: current.lastRefreshAt,
      sources: current.sources,
    }));

    Promise.all(
      Object.entries(ENDPOINTS).map(([key, url]) => (
        fetchResource(url, controller.signal).then((resource) => [key, resource])
      )),
    ).then((entries) => {
      if (controller.signal.aborted) return;
      setState({
        loading: false,
        refreshing: false,
        lastRefreshAt: new Date().toISOString(),
        sources: Object.fromEntries(entries),
      });
    });

    return () => controller.abort();
  }, [refreshKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRefreshKey((current) => current + 1);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);
  return { ...state, refresh };
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
    || resourceData(sources, 'next')?.decision
    || resourceData(sources, 'status')?.currentDecision
    || null;
}

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function countValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value.length;
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

function displayNumber(value, fallback) {
  const number = numberOrNull(value);
  return number === null ? fallback : new Intl.NumberFormat('sv-SE').format(number);
}

function displayPercent(done, total, fallback) {
  const doneNumber = numberOrNull(done);
  const totalNumber = numberOrNull(total);
  if (doneNumber === null || totalNumber === null || totalNumber <= 0) return fallback;
  return `${Math.round((doneNumber / totalNumber) * 100)}%`;
}

function displayProgress(value, fallback) {
  const number = numberOrNull(value);
  if (number === null) return fallback;
  const percent = number <= 1 ? number * 100 : number;
  return `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
}

function parseTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function firstTime(row, fields) {
  for (const field of fields) {
    const time = parseTime(row?.[field]);
    if (time !== null) return { time, value: row[field] };
  }
  return null;
}

function latestByTime(rows, fields) {
  return asArray(rows)
    .map((row) => ({ row, stamp: firstTime(row, fields) }))
    .filter((entry) => entry.stamp)
    .sort((a, b) => b.stamp.time - a.stamp.time)[0] || null;
}

function formatDateTime(value, fallback) {
  const time = parseTime(value);
  if (time === null) return fallback;
  return new Date(time).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
}

// Klockslag räcker på en sida som visar dygnet. Datum stör läsningen när
// allting ändå hände idag.
function formatClock(value, fallback) {
  const time = parseTime(value);
  if (time === null) return fallback;
  return new Date(time).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

function formatToday(now = new Date()) {
  const text = now.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function safeValue(value, fallback) {
  if (value != null && typeof value === 'object') return fallback;
  const text = uiFactorySafeText(value);
  return text || fallback;
}

function statusTone(statusKey) {
  if (statusKey === FACTORY_STATUS_KEYS.COMPLETED || statusKey === FACTORY_STATUS_KEYS.IDLE) return 'success';
  if (statusKey === FACTORY_STATUS_KEYS.FAILED) return 'danger';
  if (statusKey === FACTORY_STATUS_KEYS.PAUSED) return 'warning';
  if (statusKey === FACTORY_STATUS_KEYS.RUNNING) return 'info';
  return 'neutral';
}

function normalizeStatusKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['completed', 'complete', 'done', 'ok', 'qualified', 'success'].includes(normalized) || normalized.includes('completed')) {
    return FACTORY_STATUS_KEYS.COMPLETED;
  }
  if (['running', 'active', 'started'].includes(normalized) || normalized.includes('started')) {
    return FACTORY_STATUS_KEYS.RUNNING;
  }
  if (['failed', 'error', 'stopped'].includes(normalized) || normalized.includes('failed')) {
    return FACTORY_STATUS_KEYS.FAILED;
  }
  if (['paused', 'blocked'].includes(normalized)) return FACTORY_STATUS_KEYS.PAUSED;
  if (['idle', 'ready'].includes(normalized)) return FACTORY_STATUS_KEYS.IDLE;
  return FACTORY_STATUS_KEYS.WAITING;
}

function statusFromDecision(decision, loading) {
  if (loading) return FACTORY_STATUS_KEYS.WAITING;
  if (!decision) return FACTORY_STATUS_KEYS.WAITING;
  if (decision.action === 'SAFETY_HOLD') return FACTORY_STATUS_KEYS.PAUSED;
  if (decision.action === 'IDLE') return FACTORY_STATUS_KEYS.IDLE;
  return FACTORY_STATUS_KEYS.RUNNING;
}

function queueSummary(queue = {}) {
  const summary = queue.summary || {};
  const pending = countValue(queue.pending_jobs, summary.pending, queue.pending);
  const running = countValue(queue.running_jobs, summary.running, queue.running);
  const completed = countValue(queue.completed_jobs, summary.completed, queue.completed);
  const failed = countValue(queue.failed_jobs, summary.failed, queue.failed);
  const jobs = asArray(queue.jobs);
  const visible = countValue(summary.visible_jobs, jobs);
  const total = visible ?? [pending, running, completed, failed]
    .map((value) => value ?? 0)
    .reduce((sum, value) => sum + value, 0);
  return { pending: pending ?? 0, running: running ?? 0, completed: completed ?? 0, failed: failed ?? 0, total, jobs };
}

function normalizeLifecycle(stage) {
  const normalized = String(stage || '').trim().toLowerCase();
  if (['draft', 'new'].includes(normalized)) return 'draft';
  if (normalized === 'learning') return 'learning';
  if (normalized === 'testing') return 'testing';
  if (['candidate', 'ready_for_paper'].includes(normalized)) return 'candidate';
  if (['paper', 'monitoring', 'approved'].includes(normalized)) return 'paper';
  if (normalized === 'live') return 'live';
  if (normalized === 'retired') return 'retired';
  return 'draft';
}

function lifecycleCounts(library = {}) {
  const rows = asArray(library.strategies || library.records);
  const counts = { draft: 0, learning: 0, testing: 0, candidate: 0, paper: 0, live: 0, retired: 0 };
  for (const row of rows) counts[normalizeLifecycle(row.lifecycle || row.status)] += 1;
  return { rows, counts };
}

function splitRegime(regimeKey) {
  const [trend, volatility, session] = String(regimeKey || '').split('/');
  return { trend, volatility, session };
}

function marketLabel(copy, kind, value) {
  const labels = copy.marketLabels?.[kind] || {};
  const key = String(value || '').trim().toLowerCase();
  return labels[key] || copy.states.unknown;
}

function formatRegimeLabel(regimeKey, copy, fallback = copy.states.noMarket) {
  const { trend, volatility } = splitRegime(regimeKey);
  const trendLabel = marketLabel(copy, 'trend', trend);
  const volatilityLabel = marketLabel(copy, 'volatility', volatility);
  if (trendLabel === copy.states.unknown && volatilityLabel === copy.states.unknown) return fallback;
  return `${trendLabel} / ${volatilityLabel}`;
}

function topRegime(market = {}) {
  const counts = market.market?.regimeCounts || market.regimeCounts || {};
  return Object.entries(counts)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || String(a[0]).localeCompare(String(b[0])))
    .map(([key]) => key)[0] || null;
}

function latestReplayFromLibrary(strategies) {
  const replayRuns = asArray(strategies).flatMap((strategy) => (
    asArray(strategy.replayHistory).map((run) => ({ ...run, strategyId: strategy.strategyId }))
  ));
  return latestByTime(replayRuns, ['at', 'completedAt', 'completed_at', 'recordedAt']);
}

function latestImprovementActivity(nodes) {
  return latestByTime(nodes, ['createdAt', 'at', 'recordedAt']);
}

function latestMarketPeriod(catalog = {}) {
  return latestByTime(catalog.periods, ['to', 'from']);
}

// Ett internt strategi-id får aldrig nå skärmen. Allt som namnger en strategi
// för användaren går genom den här funktionen.
function strategyLabelFrom(row, copy) {
  const raw = row?.strategyName
    || row?.strategy_name
    || row?.rootStrategyId
    || row?.strategyId
    || row?.strategy_id
    || row?.strategy;
  return uiStrategyName(raw, copy.states.noStrategy);
}

function summarizeReplay(runEntry, copy) {
  if (!runEntry?.row) return copy.states.noReplayYet;
  const strategy = strategyLabelFrom(runEntry.row, copy);
  const time = formatDateTime(runEntry.stamp.value, copy.emptyValue);
  return `${strategy} · ${time}`;
}

function mutationLabel(copy, value) {
  const key = String(value || '').trim().toLowerCase();
  return copy.mutationLabels[key] || (key ? safeValue(key, copy.mutationLabels.unknown) : copy.mutationLabels.unknown);
}

function summarizeMutation(node, copy) {
  const mutation = node?.mutation || {};
  const changeKeys = Object.keys(mutation.changes || mutation.diff || {}).filter(Boolean);
  if (changeKeys.length) return changeKeys.map((key) => mutationLabel(copy, key)).join(', ');
  if (node?.mutationType) return mutationLabel(copy, node.mutationType);
  return copy.states.noChanges;
}

function summarizeImprovement(nodeEntry, copy) {
  if (!nodeEntry?.row) return copy.states.noImprovementYet;
  const node = nodeEntry.row;
  const strategy = strategyLabelFrom(node, copy);
  const generation = displayNumber(node.generation, copy.emptyValue);
  return `${strategy} · ${copy.labels.generation} ${generation}`;
}

function summarizeMarketPeriod(periodEntry, copy) {
  if (!periodEntry?.row) return copy.states.noMarketSelected;
  const row = periodEntry.row;
  const symbol = safeValue(row.symbol, copy.states.noMarketSelected);
  const when = row.from && row.to && row.from !== row.to
    ? `${row.from}–${row.to}`
    : safeValue(row.to || row.from, copy.emptyValue);
  return `${symbol} · ${when}`;
}

function brainReason(nextReplay, gaps, copy) {
  if (!nextReplay) return copy.states.noNextActivity;
  if (gaps.length) return `${copy.labels.biggestGap}: ${gaps[0]}`;
  const gain = numberOrNull(nextReplay.informationGain);
  if (gain !== null && gain > 0) return `${copy.labels.informationValue}: ${displayNumber(gain, copy.emptyValue)}`;
  return copy.states.noNextActivity;
}

function learningFromSources(sources) {
  const directorLearning = resourceData(sources, 'director')?.systemStatus?.services?.learning;
  const statusLearning = resourceData(sources, 'status')?.services?.learning;
  const legacy = resourceData(sources, 'learningSummary');
  return directorLearning || statusLearning || legacy?.summary || legacy || {};
}

function learningRecordsFrom(learning = {}) {
  return [
    ...asArray(learning.recordsList || learning.learningRecords),
    ...asArray(learning.latestRecord ? [learning.latestRecord] : []),
    ...asArray(learning.recommendations).map((row) => ({ ...row, recommendationOnly: true })),
  ];
}

function latestLearningActivity(learning = {}) {
  return latestByTime(learningRecordsFrom(learning), ['createdAt', 'recordedAt', 'at', 'updatedAt']);
}

function jobProgress(job) {
  const direct = numberOrNull(job?.progressPct ?? job?.progressPercent ?? job?.progress?.percent);
  if (direct !== null) return direct;
  const done = numberOrNull(job?.progress?.processedCandles ?? job?.processedCandles ?? job?.completed_candles);
  const total = numberOrNull(job?.progress?.totalCandles ?? job?.totalCandles ?? job?.total_candles);
  if (done !== null && total !== null && total > 0) return done / total;
  return null;
}

function aggregateJobProgress(jobs, fallback) {
  const values = asArray(jobs).map(jobProgress).filter((value) => value !== null);
  if (!values.length) return fallback;
  return displayProgress(values.reduce((sum, value) => sum + value, 0) / values.length, fallback);
}

function lifecycleStageEntry(strategies, stage) {
  return latestByTime(
    asArray(strategies).filter((strategy) => normalizeLifecycle(strategy.lifecycle || strategy.status) === stage),
    ['lastUpdated', 'created', 'at', 'recordedAt'],
  );
}

function digestLearningRows(learning, copy) {
  return learningRecordsFrom(learning)
    .map((record) => ({
      id: record.learningRecordId || record.replayRunId || record.createdAt || record.recordedAt,
      title: strategyLabelFrom(record, copy),
      detail: safeValue(
        record.why?.summary || record.why?.code || record.reason || record.recommendedNextAction || record.action,
        copy.states.noLearnings,
      ),
      time: record.createdAt || record.recordedAt || record.at || record.updatedAt,
      tone: record.succeeded === false ? 'warning' : 'success',
    }))
    .sort((a, b) => (parseTime(b.time) || 0) - (parseTime(a.time) || 0))
    .slice(0, 4);
}

// Misslyckanden namnges efter STRATEGIN, aldrig efter jobb-id eller
// körningsnummer. Den som läser vill veta vad som gick fel, inte vilken rad i
// kön det var.
function digestFailureRows(queueCounts, batchStatus, copy) {
  const queueFailures = queueCounts.jobs
    .filter((job) => normalizeStatusKey(job.status) === FACTORY_STATUS_KEYS.FAILED)
    .map((job) => ({
      id: `queue|${job.id || job.run_id || job.runId || job.failed_at}`,
      title: strategyLabelFrom(job, copy),
      detail: safeValue(job.reason || job.error || job.failed_reason, copy.states.noFailures),
      time: job.failed_at || job.updated_at || job.created_at,
      tone: 'danger',
    }));
  const batchFailures = [
    batchStatus.activeBatch,
    batchStatus.latestBatch,
    batchStatus.latestFailedBatch,
    ...asArray(batchStatus.recentBatchEvents),
  ]
    .filter((row) => normalizeStatusKey(row?.status || row?.type || row?.eventType) === FACTORY_STATUS_KEYS.FAILED)
    .map((row) => ({
      id: `batch|${row.timestamp || row.at || row.updatedAt}`,
      title: copy.pipeline.attention.batchLabel,
      detail: safeValue(row.reason || row.error || row.message, copy.states.noFailures),
      time: row.failedAt || row.updatedAt || row.completedAt || row.timestamp || row.at,
      tone: 'danger',
    }));
  return [...queueFailures, ...batchFailures]
    .sort((a, b) => (parseTime(b.time) || 0) - (parseTime(a.time) || 0))
    .slice(0, 4);
}

function priorityTone(priority) {
  if (priority === 'high') return 'warning';
  if (priority === 'medium') return 'info';
  return 'neutral';
}

function workflowAction(copy, key, overrides = {}) {
  const action = copy.workflow.actions[key];
  return {
    id: key,
    title: action.title,
    explanation: overrides.explanation || action.explanation,
    why: overrides.why || action.why,
    priority: action.priority,
    priorityLabel: copy.workflow.priorityLabels[action.priority] || action.priority,
    tone: priorityTone(action.priority),
    button: action.button,
    href: action.href,
  };
}

function buildDashboardContextActions({
  decision,
  nextReplay,
  latestRunningJob,
  latestWaitingJob,
  latestReplay,
  candidateEntry,
  paperEntry,
  marketPeriod,
}) {
  const evidence = decision?.evidence || decision?.assignment?.payload || {};
  const activeJob = latestRunningJob || latestWaitingJob || {};
  const latestRun = latestReplay?.row || {};
  const context = {
    decisionId: decision?.decisionId,
    strategyId: firstValue(
      evidence.strategyId,
      asArray(evidence.strategyIds)[0],
      evidence.nextReplay?.strategyId,
      nextReplay?.strategyId,
      activeJob.strategy?.id,
      activeJob.strategyId,
      latestRun.strategyId,
      candidateEntry?.row?.strategyId,
      paperEntry?.row?.strategyId,
    ),
    testId: firstValue(
      evidence.replayRunId,
      evidence.runId,
      evidence.nextReplay?.runId,
      activeJob.run_id,
      activeJob.runId,
      latestRun.runId,
      latestRun.replayRunId,
      latestRun.libraryRunId,
    ),
    replayRunId: firstValue(
      evidence.replayRunId,
      evidence.runId,
      activeJob.run_id,
      activeJob.runId,
      latestRun.runId,
      latestRun.replayRunId,
      latestRun.libraryRunId,
    ),
    marketId: firstValue(
      evidence.marketDnaHash,
      evidence.marketDna,
      evidence.nextReplay?.marketDnaHash,
      evidence.nextReplay?.targetRegime,
      nextReplay?.marketDnaHash,
      nextReplay?.targetRegime,
      activeJob.market_dna,
      activeJob.marketDna,
      latestRun.marketDnaHash,
      marketPeriod?.row?.regimeKey,
      marketPeriod?.row?.marketDnaHash,
      marketPeriod?.row?.symbol,
    ),
    marketDnaHash: firstValue(
      evidence.marketDnaHash,
      evidence.nextReplay?.marketDnaHash,
      nextReplay?.marketDnaHash,
      latestRun.marketDnaHash,
      marketPeriod?.row?.marketDnaHash,
    ),
  };
  const action = String(decision?.action || '').toUpperCase();

  if (action === 'REQUEST_APPROVAL_SERVICE' || candidateEntry?.row) {
    return [
      contextAction('approval', context, { primary: true }),
      contextAction('strategy', context),
      contextAction('decision', context),
      contextAction('factoryWork', context),
    ];
  }
  if (action === 'REQUEST_BACKFILL_SERVICE') {
    return [
      contextAction('factoryWork', context, { primary: true }),
      contextAction('market', context),
      contextAction('decision', context),
      contextAction('test', context),
    ];
  }
  if (
    action === 'REQUEST_REPLAY_SCHEDULER'
    || action === 'REQUEST_REPLAY_QUEUE'
    || latestRunningJob
    || latestWaitingJob
  ) {
    return [
      contextAction('test', context, { primary: true }),
      contextAction('strategy', context),
      contextAction('decision', context),
      contextAction('factoryWork', context),
    ];
  }
  if (action === 'REQUEST_AI_OPTIMIZER' || action === 'REQUEST_EVOLUTION_ENGINE') {
    return [
      contextAction('strategy', context, { primary: true }),
      contextAction('test', context),
      contextAction('decision', context),
      contextAction('factoryWork', context),
    ];
  }
  if (paperEntry?.row) {
    return [
      contextAction('paper', context, { primary: true }),
      contextAction('strategy', context),
      contextAction('decision', context),
      contextAction('factoryWork', context),
    ];
  }
  return [
    contextAction('decision', context, { primary: true }),
    contextAction('test', context),
    contextAction('strategy', context),
    contextAction('paper', context),
  ];
}

// Ordningen här ÄR prioriteringen. Zonen "Behöver dig" visar första posten och
// bara den — en lista av krav lämnar över prioriteringen till läsaren, vilket
// är precis det arbete produkten ska ta bort.
function buildActionCenter({ copy, decision, factoryStatus, queueCounts, stages, pendingApprovalCount }) {
  const actions = [];
  const decisionAction = decision?.action;
  const add = (key, overrides) => {
    if (!actions.some((action) => action.id === key)) actions.push(workflowAction(copy, key, overrides));
  };

  if ([FACTORY_STATUS_KEYS.FAILED, FACTORY_STATUS_KEYS.PAUSED].includes(factoryStatus)) add('checkSystem');
  if (decisionAction === 'REQUEST_BACKFILL_SERVICE') add('importHistory');
  // Use pending approval count instead of lifecycle candidate count
  if (decisionAction === 'REQUEST_APPROVAL_SERVICE' || pendingApprovalCount > 0) {
    add('approveStrategy', {
      explanation: pendingApprovalCount > 0 ? `${pendingApprovalCount} ${pendingApprovalCount === 1 ? 'strategi' : 'strategier'} väntar på godkännande.` : undefined,
    });
  }
  if (
    queueCounts.running > 0
    || queueCounts.pending > 0
    || decisionAction === 'REQUEST_REPLAY_SCHEDULER'
    || decisionAction === 'REQUEST_REPLAY_QUEUE'
  ) {
    add('waitTests', {
      explanation: `${copy.workflow.actions.waitTests.explanation} ${copy.labels.pendingTests}: ${displayNumber(queueCounts.pending, copy.emptyValue)}. ${copy.labels.runningTests}: ${displayNumber(queueCounts.running, copy.emptyValue)}.`,
    });
  }
  if (stages.paper > 0) add('reviewPaper');

  return actions.length ? actions : [workflowAction(copy, 'noAction')];
}

function activityItem(kind, title, detail, time, href, tone = 'neutral') {
  return { id: `${kind}|${time || title}`, kind, title, detail, time, href, tone, sortTime: parseTime(time) || 0 };
}

function buildImportantActivityFeed({
  copy, latestRunningJob, latestReplay, latestLearning, latestImprovement,
  candidateEntry, paperEntry, marketPeriod, lastRefreshAt,
}) {
  const items = aiStoryFactoryActivity({
    latestRunningJob,
    latestReplay,
    latestLearning,
    latestImprovement,
    candidateEntry,
    paperEntry,
    marketPeriod,
    lastRefreshAt,
  });
  if (latestRunningJob) {
    items[0] = {
      ...items[0],
      title: aiStoryEventText('testStarted', { strategyId: latestRunningJob.strategyId || latestRunningJob.strategy?.id, reason: latestRunningJob.reason }),
      detail: aiStoryEventText('testStarted', { strategyId: latestRunningJob.strategyId || latestRunningJob.strategy?.id, reason: latestRunningJob.reason }),
    };
  }
  if (latestReplay?.row) {
    const index = items.findIndex((item) => item.id === 'replay');
    if (index >= 0) {
      items[index] = {
        ...items[index],
        title: aiStoryEventText('testCompleted', {
          strategyId: latestReplay.row.strategyId,
          result: summarizeReplay(latestReplay, copy),
        }),
        detail: aiStoryEventText('testCompleted', {
          strategyId: latestReplay.row.strategyId,
          result: summarizeReplay(latestReplay, copy),
        }),
      };
    }
  }
  if (candidateEntry?.row) {
    const index = items.findIndex((item) => item.id === 'candidate');
    if (index >= 0) {
      items[index] = {
        ...items[index],
        title: aiStoryEventText('promoted', { strategyId: candidateEntry.row.strategyId }),
        detail: aiStoryEventText('promoted', { strategyId: candidateEntry.row.strategyId }),
      };
    }
  }
  if (paperEntry?.row) {
    const index = items.findIndex((item) => item.id === 'paper');
    if (index >= 0) {
      items[index] = {
        ...items[index],
        title: aiStoryEventText('paperStarted', { strategyId: paperEntry.row.strategyId }),
        detail: aiStoryEventText('paperStarted', { strategyId: paperEntry.row.strategyId }),
      };
    }
  }
  if (marketPeriod?.row) {
    const index = items.findIndex((item) => item.id === 'market');
    if (index >= 0) {
      items[index] = {
        ...items[index],
        title: aiStoryEventText('historyImported', { market: marketPeriod.row }),
        detail: aiStoryEventText('historyImported', { market: marketPeriod.row }),
      };
    }
  }
  if (latestLearning?.row) {
    const index = items.findIndex((item) => item.id === 'learning');
    if (index >= 0) {
      const story = aiStoryEventText('learned', {
        learning: latestLearning.row.reason || latestLearning.row.recommendedNextAction || latestLearning.row.action,
      });
      items[index] = {
        ...items[index],
        title: story,
        detail: story,
      };
    }
  }
  if (latestImprovement?.row) {
    const index = items.findIndex((item) => item.id === 'improvement');
    if (index >= 0) {
      const story = aiStoryEventText('improved', {
        reason: latestImprovement.row.reason || latestImprovement.row.mutationType,
        strategyId: latestImprovement.row.strategyId,
      });
      items[index] = {
        ...items[index],
        title: story,
        detail: story,
      };
    }
  }

  const badges = copy.today.recent.badges;
  return items
    .filter((item) => item.time)
    .sort((a, b) => b.sortTime - a.sortTime || String(a.kind || '').localeCompare(String(b.kind || '')))
    .slice(0, 5)
    .map((item) => ({
      ...item,
      timestamp: item.time,
      timeLabel: formatClock(item.time, copy.emptyValue),
      badge: badges[item.tone] || badges.neutral,
    }));
}

function timelineEvent(copy, kind, time, statusKey, description, href, tone) {
  const event = copy.workflow.timeline.events[kind];
  return {
    id: `${kind}|${time || event.title}`,
    kind,
    icon: event.icon,
    title: event.title,
    description: safeValue(description || event.description, event.description),
    time,
    status: uiStatus(statusKey),
    href: href || event.href,
    tone: tone || statusTone(statusKey),
    sortTime: parseTime(time) || 0,
  };
}

function timelineEmptyItems(copy) {
  const missing = copy.workflow.timeline.missing;
  return [
    { id: 'missing-history', kind: 'missing-history', icon: '○', title: missing.history, description: 'När historisk data finns kan AI börja skapa bättre tester.', time: copy.emptyValue, status: uiStatus(FACTORY_STATUS_KEYS.WAITING), href: '/system?tab=providers', tone: 'neutral' },
    { id: 'missing-tests', kind: 'missing-tests', icon: '○', title: missing.tests, description: 'Tester visas här när de har startat eller blivit klara.', time: copy.emptyValue, status: uiStatus(FACTORY_STATUS_KEYS.WAITING), href: '/factory/replay', tone: 'neutral' },
    { id: 'missing-improvements', kind: 'missing-improvements', icon: '○', title: missing.improvements, description: 'Förbättringar visas när AI har fått resultat att lära från.', time: copy.emptyValue, status: uiStatus(FACTORY_STATUS_KEYS.WAITING), href: '/factory/library', tone: 'neutral' },
  ];
}

function buildFactoryTimeline({
  copy, decision, nextReplay, replayGaps, latestWaitingJob, latestRunningJob,
  latestReplay, latestLearning, latestImprovement, candidateEntry, paperEntry,
  marketPeriod, brain, lastRefreshAt,
}) {
  const items = [];
  const evidence = decision?.evidence || decision?.assignment?.payload || {};
  const activeJob = latestRunningJob || latestWaitingJob;
  const baseContext = {
    decisionId: decision?.decisionId,
    strategyId: firstValue(
      evidence.strategyId,
      asArray(evidence.strategyIds)[0],
      evidence.nextReplay?.strategyId,
      nextReplay?.strategyId,
      activeJob?.strategy?.id,
      activeJob?.strategyId,
      latestReplay?.row?.strategyId,
      latestImprovement?.row?.strategyId,
      candidateEntry?.row?.strategyId,
      paperEntry?.row?.strategyId,
    ),
    testId: firstValue(
      evidence.replayRunId,
      evidence.runId,
      evidence.nextReplay?.runId,
      activeJob?.run_id,
      activeJob?.runId,
      latestReplay?.row?.runId,
      latestReplay?.row?.replayRunId,
      latestReplay?.row?.libraryRunId,
    ),
    replayRunId: firstValue(
      evidence.replayRunId,
      evidence.runId,
      activeJob?.run_id,
      activeJob?.runId,
      latestReplay?.row?.runId,
      latestReplay?.row?.replayRunId,
      latestReplay?.row?.libraryRunId,
    ),
    marketId: firstValue(
      marketPeriod?.row?.regimeKey,
      marketPeriod?.row?.marketDnaHash,
      marketPeriod?.row?.symbol,
      nextReplay?.targetRegime,
      nextReplay?.marketDnaHash,
      latestReplay?.row?.marketDnaHash,
    ),
    marketDnaHash: firstValue(
      marketPeriod?.row?.marketDnaHash,
      nextReplay?.marketDnaHash,
      latestReplay?.row?.marketDnaHash,
    ),
  };
  if (marketPeriod?.row) {
    items.push(timelineEvent(copy, 'historyImported', marketPeriod.stamp?.value, FACTORY_STATUS_KEYS.COMPLETED, aiStoryEventText('historyImported', { market: marketPeriod.row }), contextHref('market', baseContext)));
  }
  if (nextReplay || decision) {
    const strategy = strategyLabelFrom(nextReplay || decision, copy);
    const reason = nextReplay ? brainReason(nextReplay, replayGaps, copy) : uiFactoryReason(decision?.reason);
    items.push(timelineEvent(copy, 'opportunityFound', brain.generatedFor || brain.generatedAt || decision?.createdAt || lastRefreshAt, FACTORY_STATUS_KEYS.COMPLETED, aiStoryEventText('opportunityFound', { strategyId: strategy, reason }), contextHref('decision', baseContext)));
  }
  if (activeJob) {
    items.push(timelineEvent(copy, 'testStarted', activeJob.started_at || activeJob.created_at || activeJob.updated_at, latestRunningJob ? FACTORY_STATUS_KEYS.RUNNING : FACTORY_STATUS_KEYS.WAITING, aiStoryEventText('testStarted', { strategyId: activeJob.strategyId || activeJob.strategy?.id, reason: activeJob.reason }), contextHref('test', baseContext)));
  }
  if (latestReplay?.row) {
    items.push(timelineEvent(copy, 'testCompleted', latestReplay.stamp?.value, FACTORY_STATUS_KEYS.COMPLETED, aiStoryEventText('testCompleted', { result: summarizeReplay(latestReplay, copy) }), contextHref('result', baseContext)));
  }
  if (latestLearning?.row) {
    items.push(timelineEvent(copy, 'learned', latestLearning.stamp?.value, FACTORY_STATUS_KEYS.COMPLETED, aiStoryEventText('learned', { learning: latestLearning.row.why?.summary || latestLearning.row.reason || latestLearning.row.recommendedNextAction || latestLearning.row.action }), contextHref('decision', baseContext)));
  }
  if (latestImprovement?.row) {
    items.push(timelineEvent(copy, 'improved', latestImprovement.stamp?.value, FACTORY_STATUS_KEYS.COMPLETED, aiStoryEventText('improved', { reason: latestImprovement.row.reason || latestImprovement.row.mutationType, strategyId: latestImprovement.row.strategyId }), contextHref('strategy', baseContext)));
  }
  if (candidateEntry?.row) {
    items.push(timelineEvent(copy, 'promoted', candidateEntry.stamp?.value, FACTORY_STATUS_KEYS.COMPLETED, aiStoryEventText('promoted', { strategyId: candidateEntry.row.strategyId }), contextHref('approval', baseContext)));
  }
  if (paperEntry?.row) {
    const approvedAt = paperEntry.row.approvedAt || paperEntry.row.approved_at || paperEntry.stamp?.value;
    items.push(timelineEvent(copy, 'approved', approvedAt, FACTORY_STATUS_KEYS.COMPLETED, aiStoryEventText('approved', { strategyId: paperEntry.row.strategyId }), contextHref('paper', baseContext)));
    items.push(timelineEvent(copy, 'paperStarted', paperEntry.stamp?.value, FACTORY_STATUS_KEYS.RUNNING, aiStoryEventText('paperStarted', { strategyId: paperEntry.row.strategyId }), contextHref('paper', baseContext)));
  }

  const seen = new Set();
  const deduped = items
    .filter((item) => item.time)
    .sort((a, b) => a.sortTime - b.sortTime || String(a.kind || '').localeCompare(String(b.kind || '')))
    .filter((item) => {
      const key = `${item.kind || ''}|${item.time}|${item.description || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({ ...item, time: formatDateTime(item.time, copy.emptyValue) }));

  return { items: deduped, emptyItems: timelineEmptyItems(copy) };
}

// ── Hero ─────────────────────────────────────────────────────────────────────
//
// Rad ett säger vad AI:n gör. Rad två säger om något krävs av dig — och bara
// den andra raden ändras när ett godkännande dyker upp, så förändringen syns
// utan att man behöver läsa om hela sidan.
function buildHero({ copy, factoryStatus, whyText, nextText, hasAction, refreshTime }) {
  const hero = copy.today.hero;
  const headline = factoryStatus === FACTORY_STATUS_KEYS.PAUSED ? hero.paused
    : factoryStatus === FACTORY_STATUS_KEYS.RUNNING ? hero.working
      : factoryStatus === FACTORY_STATUS_KEYS.IDLE || factoryStatus === FACTORY_STATUS_KEYS.COMPLETED ? hero.idle
        : hero.waiting;

  return {
    dateLine: `${formatToday()} · ${copy.today.since} ${formatClock(refreshTime, copy.emptyValue)}`,
    headline,
    subline: hasAction ? hero.oneThingForYou : hero.nothingForYou,
    why: whyText || copy.states.genericReason,
    next: nextText,
    state: uiStatus(factoryStatus),
    tone: statusTone(factoryStatus),
    updatedAt: `${copy.labels.lastUpdated}: ${formatDateTime(refreshTime, copy.emptyValue)}`,
  };
}

// ── Läget ────────────────────────────────────────────────────────────────────
function buildState({ copy, factoryStatus, hasAction, queueCounts, stages, marketPeriod, regime, trend, volatility, marketType, pendingApprovalCount }) {
  const panel = copy.today.state;
  // Only show "needs decision" for actual user decisions (approval/review)
  // System actions (tests, checks) show as "working" or "waiting" instead
  const summary = hasAction
    ? { summaryLabel: panel.needsDecision, summaryTone: 'warning' }
    : factoryStatus === FACTORY_STATUS_KEYS.RUNNING
      ? { summaryLabel: panel.working, summaryTone: 'info' }
      : factoryStatus === FACTORY_STATUS_KEYS.IDLE || factoryStatus === FACTORY_STATUS_KEYS.COMPLETED
        ? { summaryLabel: panel.done, summaryTone: 'success' }
        : { summaryLabel: panel.waiting, summaryTone: 'neutral' };

  const work = panel.workCard;
  const strategy = panel.strategyCard;
  const marketCard = panel.marketCard;
  const proving = stages.draft + stages.learning + stages.testing;

  return {
    ...summary,
    cards: [
      {
        key: 'work',
        eyebrow: work.eyebrow,
        title: queueCounts.total ? `${displayNumber(queueCounts.total, copy.emptyValue)} ${copy.units.tests}` : work.nothing,
        summary: queueCounts.running ? work.running : work.queued,
        metricLabel: work.running,
        metricValue: displayNumber(queueCounts.running, copy.emptyValue),
        tone: queueCounts.running ? 'info' : 'neutral',
        items: [
          { label: work.queued, value: displayNumber(queueCounts.pending, copy.emptyValue) },
          { label: work.finished, value: displayNumber(queueCounts.completed, copy.emptyValue) },
          { label: work.failed, value: displayNumber(queueCounts.failed, copy.emptyValue), tone: queueCounts.failed ? 'danger' : undefined },
        ],
        href: `/factory?tab=${TAB_WORK}`,
        link: work.open,
      },
      {
        key: 'strategies',
        eyebrow: strategy.eyebrow,
        title: proving || pendingApprovalCount || stages.paper
          ? `${displayNumber(proving + pendingApprovalCount + stages.paper + stages.live, copy.emptyValue)} ${copy.units.strategies || ''}`.trim()
          : strategy.nothing,
        summary: pendingApprovalCount ? strategy.waitingForYou : strategy.proving,
        metricLabel: strategy.waitingForYou,
        metricValue: displayNumber(pendingApprovalCount, copy.emptyValue),
        tone: pendingApprovalCount ? 'warning' : 'neutral',
        items: [
          { label: strategy.proving, value: displayNumber(proving, copy.emptyValue) },
          { label: strategy.inPaper, value: displayNumber(stages.paper, copy.emptyValue) },
        ],
        href: '/factory/library',
        link: strategy.open,
      },
      {
        key: 'market',
        eyebrow: marketCard.eyebrow,
        title: regime ? marketType : marketCard.nothing,
        summary: summarizeMarketPeriod(marketPeriod, copy),
        metricLabel: copy.labels.trend,
        metricValue: regime ? trend : copy.states.noMarket,
        tone: 'neutral',
        items: [
          { label: copy.labels.volatility, value: regime ? volatility : copy.states.noMarket },
          { label: marketCard.latest, value: formatDateTime(marketPeriod?.stamp?.value, copy.states.noMarketSelected) },
        ],
        href: '/factory/market-dna',
        link: marketCard.open,
      },
    ],
  };
}

// ── AI tänker ────────────────────────────────────────────────────────────────
//
// Högst tre kort, och bara de som faktiskt har något att säga. Ett kunskapshål
// formuleras som "det saknas data", aldrig som "strategin är dålig".
function buildBrainCards({ copy, decision, decisionCopy, nextReplay, replayGaps, whyText }) {
  const panel = copy.today.brain;
  const cards = [];

  if (decision) {
    cards.push({
      key: 'recommendation',
      rail: 'teal',
      eyebrow: panel.recommendationTitle,
      title: decisionCopy.title,
      body: whyText || decisionCopy.description,
    });
  }
  if (replayGaps.length) {
    cards.push({
      key: 'gap',
      rail: 'violet',
      eyebrow: panel.gapTitle,
      title: replayGaps[0],
      body: panel.gapExplanation,
    });
  }
  if (nextReplay) {
    cards.push({
      key: 'next-test',
      rail: 'teal',
      eyebrow: panel.nextTestTitle,
      title: uiStrategyName(nextReplay.strategyId, copy.states.noStrategy),
      body: nextReplay.targetRegime
        ? `${formatRegimeLabel(nextReplay.targetRegime, copy, copy.states.noMarketSelected)}. ${brainReason(nextReplay, replayGaps, copy)}`
        : brainReason(nextReplay, replayGaps, copy),
    });
  }

  return cards.slice(0, 3);
}

// ── Arbetet ──────────────────────────────────────────────────────────────────
//
// Sex steg som alltid ligger i samma ordning. Talen kommer från samma källor
// som resten av sidan — inget steg räknar om något själv.
function buildPipeline({
  copy, catalog, queueCounts, learning, nodes, optimizeIds, stages,
  marketPeriod, latestReplay, latestImprovement, reused, batchStatus, pendingApprovalCount,
}) {
  const text = copy.pipeline;
  const periods = asArray(catalog.periods);
  const learningRows = learningRecordsFrom(learning);

  const step = (key, count, state, tone, detail) => ({
    key,
    count: displayNumber(count, copy.emptyValue),
    unit: text.steps[key].unit,
    title: text.steps[key].title,
    body: text.steps[key].body,
    state,
    tone,
    status: uiStatus(
      state === 'running' ? FACTORY_STATUS_KEYS.RUNNING
        : state === 'done' ? FACTORY_STATUS_KEYS.COMPLETED
          : state === 'failed' ? FACTORY_STATUS_KEYS.FAILED
            : FACTORY_STATUS_KEYS.WAITING,
    ),
    detail,
  });

  const steps = [
    step('import', periods.length, periods.length ? 'done' : 'waiting', periods.length ? 'success' : 'neutral', summarizeMarketPeriod(marketPeriod, copy)),
    step(
      'tests',
      queueCounts.total,
      queueCounts.running ? 'running' : queueCounts.pending ? 'waiting' : queueCounts.completed ? 'done' : 'waiting',
      queueCounts.running ? 'info' : queueCounts.failed ? 'danger' : queueCounts.completed ? 'success' : 'neutral',
      summarizeReplay(latestReplay, copy),
    ),
    step('learnings', learningRows.length, learningRows.length ? 'done' : 'waiting', learningRows.length ? 'success' : 'neutral', null),
    step(
      'improvement',
      nodes.length,
      optimizeIds.length ? 'running' : nodes.length ? 'done' : 'waiting',
      optimizeIds.length ? 'info' : nodes.length ? 'success' : 'neutral',
      summarizeImprovement(latestImprovement, copy),
    ),
    // Use pending approval count instead of lifecycle candidate count
    step('approval', pendingApprovalCount, pendingApprovalCount ? 'needsYou' : 'waiting', pendingApprovalCount ? 'warning' : 'neutral', null),
    step('paper', stages.paper, stages.paper ? 'running' : 'waiting', stages.paper ? 'success' : 'neutral', null),
  ];

  const capacityFill = queueCounts.total
    ? displayPercent(queueCounts.completed, queueCounts.total, '0%')
    : '0%';

  return {
    headline: text.title,
    steps,
    learned: {
      title: copy.labels.latestLearnings,
      summary: text.steps.learnings.body,
      rows: digestLearningRows(learning, copy).map((row) => ({ ...row, badge: formatClock(row.time, copy.emptyValue) })),
    },
    attention: {
      title: copy.labels.latestFailures,
      summary: text.attention.empty,
      rows: digestFailureRows(queueCounts, batchStatus, copy).map((row) => ({ ...row, badge: formatClock(row.time, copy.emptyValue) })),
    },
    capacity: {
      eyebrow: copy.labels.progress,
      title: aggregateJobProgress(queueCounts.jobs, capacityFill),
      summary: text.subtitle,
      fill: capacityFill,
      items: [
        { label: copy.labels.runningTests, value: displayNumber(queueCounts.running, copy.emptyValue) },
        { label: copy.labels.pendingTests, value: displayNumber(queueCounts.pending, copy.emptyValue) },
        { label: copy.labels.completedTests, value: displayNumber(queueCounts.completed, copy.emptyValue) },
        { label: copy.labels.reusedResults, value: displayNumber(reused, copy.emptyValue), hint: copy.labels.previousExperiments },
      ],
    },
  };
}

function buildDashboardModel({ loading, refreshing, lastRefreshAt, sources }) {
  const copy = uiFactoryDashboard();
  const connection = connectionState(sources);
  const decision = currentDecision(sources);
  const decisionCopy = uiFactoryDecision(decision?.action);
  const factoryStatus = statusFromDecision(decision, loading);

  const brain = serviceData(sources, 'brain', 'strategyBrain') || {};
  const nextReplay = brain.nextReplay || asArray(brain.priority).find((row) => Number(row.informationGain) > 0) || null;
  const replayGaps = asArray(nextReplay?.gapsAddressed).map((gap) => uiFactoryGap(gap)).filter(Boolean);

  const queue = serviceData(sources, 'queue', 'replayQueue') || {};
  const queueCounts = queueSummary(queue);

  const library = serviceData(sources, 'library', 'strategyLibrary') || {};
  const { rows: strategies, counts: stages } = lifecycleCounts(library);
  const latestReplay = latestReplayFromLibrary(strategies);

  const batchStatus = serviceData(sources, 'batchStatus') || {};

  const memory = serviceData(sources, 'memoryStatus', 'aiMemory') || brain.memory || {};
  const memoryExperiments = asArray(resourceData(sources, 'memoryExperiments')?.experiments);
  const reused = countValue(memory.repeats) ?? memoryExperiments.filter((row) => Number(row.observations || 0) > 1).length;

  const learning = learningFromSources(sources);
  const latestLearning = latestLearningActivity(learning);

  const lineage = serviceData(sources, 'lineage', 'evolution') || {};
  const nodes = asArray(lineage.nodes);
  const optimizeIds = asArray(brain.recommendations?.optimize);
  const latestImprovement = latestImprovementActivity(nodes);

  const market = serviceData(sources, 'market', 'marketIntelligence') || brain.market || {};
  const catalog = resourceData(sources, 'marketCatalog') || {};
  const marketPeriod = latestMarketPeriod(catalog);
  const regime = marketPeriod?.row?.regimeKey || topRegime(market);
  const regimeParts = splitRegime(regime);
  const traits = marketPeriod?.row?.traits || {};
  const trend = marketLabel(copy, 'trend', traits.direction || regimeParts.trend);
  const volatility = marketLabel(copy, 'volatility', traits.volatility || regimeParts.volatility);
  const marketType = formatRegimeLabel(regime, copy);
  const runningJobs = queueCounts.jobs.filter((job) => normalizeStatusKey(job.status) === FACTORY_STATUS_KEYS.RUNNING);
  const waitingJobs = queueCounts.jobs.filter((job) => normalizeStatusKey(job.status) === FACTORY_STATUS_KEYS.WAITING);
  const latestRunningJob = latestByTime(runningJobs, ['updated_at', 'started_at', 'created_at'])?.row || null;
  const latestWaitingJob = latestByTime(waitingJobs, ['updated_at', 'created_at'])?.row || null;
  const candidateEntry = lifecycleStageEntry(strategies, 'candidate');
  const paperEntry = lifecycleStageEntry(strategies, 'paper');

  // Calculate pending approval count from approval strategies data
  const approvalData = resourceData(sources, 'approvalStrategies') || {};
  const approvalStrategies = asArray(approvalData.strategies || []);
  // Pending approval: recommendedForReview=true AND status=null AND not duplicate
  const pendingApprovalCount = approvalStrategies.filter((s) => {
    const status = s.approvalState || s.status;
    const isDuplicate = Boolean(s.isDuplicate);
    // status should be null or falsy for pending (not approved/paused/removed)
    return s.recommendedForReview === true && !status && !isDuplicate;
  }).length;

  const story = aiStoryFactory({
    copy,
    factoryStatus,
    decision,
    nextReplay,
    latestWaitingJob,
    latestRunningJob,
    latestLearning,
    latestImprovement,
    candidateEntry,
    paperEntry,
    marketPeriod,
    brain,
    queueCounts,
    stages,
    refreshTime: lastRefreshAt || decision?.createdAt || brain.generatedFor || latestReplay?.stamp?.value,
  });

  const whyText = story.why || (decision?.reason
    ? uiFactoryReason(decision.reason)
    : runningJobs[0]?.reason
      ? uiFactoryReason(runningJobs[0].reason)
      : brainReason(nextReplay, replayGaps, copy));
  const nextText = story.next || (decision
    ? decisionCopy.next
    : waitingJobs.length
      ? uiFactoryDecision('REQUEST_REPLAY_QUEUE').next
      : copy.states.noNextActivity);

  const actions = buildActionCenter({ copy, decision, factoryStatus, queueCounts, stages, pendingApprovalCount });
  // Only count approval/review actions as "user action needed" — not system/test actions
  const hasUserAction = actions.some((action) => ['approveStrategy', 'reviewPaper'].includes(action.id));
  const refreshTime = lastRefreshAt || decision?.createdAt || brain.generatedFor || latestReplay?.stamp?.value;

  const heroState = buildHero({
    copy,
    factoryStatus,
    whyText: story.why || whyText,
    nextText: story.next || nextText,
    hasAction: hasUserAction,
    refreshTime: story.updatedAt || lastRefreshAt || decision?.createdAt || brain.generatedFor || latestReplay?.stamp?.value,
  });

  return {
    copy,
    connection,
    refreshing,
    factoryStatus,
    hero: {
      ...heroState,
      headline: story.headline || heroState.headline,
      subline: story.subline || heroState.subline,
      why: story.why || whyText,
      next: story.next || nextText,
      state: story.state || uiStatus(factoryStatus),
      tone: story.tone || statusTone(factoryStatus),
    },
    actions,
    state: buildState({ copy, factoryStatus, hasAction: hasUserAction, queueCounts, stages, marketPeriod, regime, trend, volatility, marketType, pendingApprovalCount }),
    brainCards: buildBrainCards({ copy, decision, decisionCopy, nextReplay, replayGaps, whyText }),
    contextActions: buildDashboardContextActions({
      decision,
      nextReplay,
      latestRunningJob,
      latestWaitingJob,
      latestReplay,
      candidateEntry,
      paperEntry,
      marketPeriod,
    }),
    activity: buildImportantActivityFeed({
      copy, latestRunningJob, latestReplay, latestLearning, latestImprovement,
      candidateEntry, paperEntry, marketPeriod, lastRefreshAt,
    }),
    timeline: buildFactoryTimeline({
      copy, decision, nextReplay, replayGaps, latestWaitingJob, latestRunningJob,
      latestReplay, latestLearning, latestImprovement, candidateEntry, paperEntry,
      marketPeriod, brain, lastRefreshAt,
    }),
    pipeline: buildPipeline({
      copy, catalog, queueCounts, learning, nodes, optimizeIds, stages,
      marketPeriod, latestReplay, latestImprovement, reused, batchStatus, pendingApprovalCount,
    }),
  };
}

export default function FactoryDashboardPage() {
  const data = useFactoryDashboardData();
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const model = useMemo(() => buildDashboardModel(data), [data]);
  const copy = model.copy;

  const tab = searchParams.get('tab') === TAB_WORK ? TAB_WORK : TAB_TODAY;
  const selectTab = useCallback((next) => {
    const params = new URLSearchParams(searchParams);
    if (next === TAB_WORK) params.set('tab', TAB_WORK);
    else params.delete('tab');
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <DashboardShell>
      <div className="m-between" style={{ marginBottom: 'var(--s6)' }}>
        <div className="m-seg" role="tablist" aria-label={copy.title}>
          <button type="button" role="tab" aria-pressed={tab === TAB_TODAY} onClick={() => selectTab(TAB_TODAY)}>
            {copy.today.tabs.today}
          </button>
          <button type="button" role="tab" aria-pressed={tab === TAB_WORK} onClick={() => selectTab(TAB_WORK)}>
            {copy.today.tabs.work}
          </button>
        </div>
        {/* Loopen har ingen egen menypost — V1-menyn har en huvudväg per
            produktområde. Den som frågar "vad gör AI:n just nu?" är redan här,
            så vägen dit går härifrån. */}
        <div className="m-seg">
          <Link to="/factory/loop">AI-loopen</Link>
        </div>
        <div className="m-flex">
          <Link to="/decision-journal" className="m-btn m-btn-ghost m-btn-sm">
            {uiName(FACTORY_TERM_KEYS.AI_DECISION_JOURNAL)}
          </Link>
          <button type="button" className="m-btn m-btn-ghost m-btn-sm" onClick={data.refresh}>
            {copy.refreshButton}
          </button>
          <button type="button" className="m-btn m-btn-sm" onClick={() => setHelpOpen(true)}>
            {copy.helpButton}
          </button>
        </div>
      </div>

      {model.connection ? (
        <div
          data-factory-connection={model.connection.kind}
          role="alert"
          className="m-card"
          style={{
            marginBottom: 'var(--s5)',
            borderLeft: `3px solid ${model.connection.kind === 'auth' ? 'var(--c-warn, #d98324)' : 'var(--c-danger, #c0392b)'}`,
          }}
        >
          <strong>{model.connection.title}</strong>
          <div style={{ marginTop: 'var(--s2)' }}>{model.connection.detail}</div>
          {model.connection.actionHref ? (
            <div style={{ marginTop: 'var(--s3)' }}>
              <a className="m-btn m-btn-sm" href={model.connection.actionHref}>
                {model.connection.actionLabel}
              </a>
            </div>
          ) : (
            <div style={{ marginTop: 'var(--s3)' }}>
              <button type="button" className="m-btn m-btn-sm" onClick={data.refresh}>
                {copy.refreshButton}
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div style={{ marginBottom: 'var(--s5)' }}>
        <ContextNavigation actions={model.contextActions} />
      </div>

      {tab === TAB_TODAY ? (
        <div data-factory-today data-factory-workflow>
          <AIStatusPanel status={model.hero} copy={copy} />
          <ActionCenter actions={model.actions} copy={copy} />
          <FactoryStateGrid state={model.state} copy={copy} />
          <FactoryBrainCards cards={model.brainCards} copy={copy} />
          <FactoryLiveActivityFeed items={model.activity} copy={copy} />
        </div>
      ) : (
        <div data-factory-work>
          <FactoryWorkPipeline pipeline={model.pipeline} copy={copy} />
          <FactoryTimeline
            items={model.timeline.items}
            emptyItems={model.timeline.emptyItems}
            copy={copy}
          />
        </div>
      )}

      <QuickHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </DashboardShell>
  );
}
