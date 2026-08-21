import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DashboardShell } from '../components/dashboard/DashboardKit.jsx';
import ContextNavigation, { contextAction } from '../components/ContextNavigation.jsx';
import {
  FieldGrid,
  MetricCard,
  OverviewPanel,
  StatusBadge,
} from '../components/trading/index.js';
import {
  FACTORY_STATUS_KEYS,
  FACTORY_TERM_KEYS,
  uiFactoryDecision,
  uiFactoryExplorer,
  uiFactoryReason,
  uiFactorySafeText,
  uiLifecycleStage,
  uiName,
  uiStatus,
} from '../services/uiTerminologyService.js';
import {
  aiStoryStrategySummary,
  aiStoryTestSummary,
} from '../services/aiStoryService.js';

const FETCH_TIMEOUT_MS = 6000;

const ENDPOINTS = Object.freeze({
  library: '/api/strategy-library',
  libraryAudit: '/api/strategy-library/audit?limit=5000',
  lineage: '/api/strategy-family-tree',
  memoryExperiments: '/api/ai-memory/experiments?limit=2000',
  brain: '/api/strategy-brain',
  market: '/api/market-intelligence',
  marketCatalog: '/api/market-intelligence/catalog',
  queue: '/api/replay/queue',
  learningSummary: '/api/learning/latest-summary',
});

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

function useFactoryExplorerData() {
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

function safeValue(value, fallback) {
  const text = uiFactorySafeText(value);
  return text || fallback;
}

function shortId(value, fallback) {
  const text = safeValue(value, '');
  if (!text) return fallback;
  return text.length > 16 ? `${text.slice(0, 14)}...` : text;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function displayNumber(value, fallback, digits = 0) {
  const number = numberOrNull(value);
  if (number === null) return fallback;
  return new Intl.NumberFormat('sv-SE', { maximumFractionDigits: digits }).format(number);
}

function displayPercent(value, fallback) {
  const number = numberOrNull(value);
  if (number === null) return fallback;
  const normalized = Math.abs(number) <= 1 ? number * 100 : number;
  return `${displayNumber(normalized, fallback, 1)} %`;
}

function displaySignedMoney(value, fallback) {
  const number = numberOrNull(value);
  if (number === null) return fallback;
  const formatted = new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(number);
  return number > 0 ? `+${formatted}` : formatted;
}

function parseTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function formatDateTime(value, fallback) {
  const time = parseTime(value);
  if (time === null) return fallback;
  return new Date(time).toLocaleString('sv-SE', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
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

function statusText(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['completed', 'complete', 'done', 'ok', 'qualified', 'success'].includes(normalized)) return uiStatus(FACTORY_STATUS_KEYS.COMPLETED);
  if (['running', 'active', 'started'].includes(normalized)) return uiStatus(FACTORY_STATUS_KEYS.RUNNING);
  if (['failed', 'error', 'rejected', 'blocked'].includes(normalized)) return uiStatus(FACTORY_STATUS_KEYS.FAILED);
  if (['paused'].includes(normalized)) return uiStatus(FACTORY_STATUS_KEYS.PAUSED);
  return uiStatus(FACTORY_STATUS_KEYS.WAITING);
}

function statusTone(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['failed', 'error', 'rejected', 'blocked'].includes(normalized)) return 'danger';
  if (['running', 'active', 'started'].includes(normalized)) return 'info';
  if (['completed', 'complete', 'done', 'ok', 'qualified', 'success'].includes(normalized)) return 'success';
  return 'warning';
}

function latestRow(rows, fields) {
  return asArray(rows)
    .map((row) => ({
      row,
      time: fields.map((field) => row?.[field]).find((value) => parseTime(value) !== null),
    }))
    .filter((entry) => parseTime(entry.time) !== null)
    .sort((a, b) => parseTime(b.time) - parseTime(a.time))[0]?.row || null;
}

function latestTime(rows, fields) {
  return asArray(rows)
    .flatMap((row) => fields.map((field) => row?.[field]).filter((value) => parseTime(value) !== null))
    .sort((a, b) => parseTime(b) - parseTime(a))[0] || null;
}

function scoreText(row, copy) {
  const score = numberOrNull(row.strategyScore ?? row.score);
  const trades = numberOrNull(row.replayTrades ?? row.trades);
  const parts = [];
  if (score !== null) parts.push(`${uiName(FACTORY_TERM_KEYS.SCORE)} ${displayNumber(score, copy.emptyValue)}`);
  if (trades !== null) parts.push(`${displayNumber(trades, copy.emptyValue)} ${copy.labels.replay}`);
  return parts.length ? parts.join(' · ') : copy.states.noResult;
}

function mutationText(node, copy) {
  const mutation = node?.mutation || {};
  const changes = Object.keys(mutation.changes || mutation.diff || {}).filter(Boolean);
  if (changes.length) return changes.map((key) => safeValue(key, key)).join(', ');
  return safeValue(node?.mutationType, copy.states.noGeneration);
}

const STRATEGY_WORDS = Object.freeze({
  ai: 'AI',
  atr: 'ATR',
  ema: 'EMA',
  macd: 'MACD',
  mes: 'MES',
  mnq: 'MNQ',
  orb: 'ORB',
  rsi: 'RSI',
  vwap: 'VWAP',
});

const PRODUCT_STAGE_ORDER = Object.freeze(['idea', 'test', 'paper', 'live', 'retired']);

function titleWord(word) {
  const normalized = String(word || '').trim().toLowerCase();
  if (!normalized) return '';
  return STRATEGY_WORDS[normalized] || `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}

function strategyName(strategy, copy) {
  const explicit = safeValue(strategy.displayName || strategy.name || strategy.title || strategy.strategyName, '');
  if (explicit) return explicit;
  const raw = String(strategy.strategyId || strategy.id || '').trim();
  if (!raw) return copy.states.noSelection;
  const cleaned = raw
    .replace(/^native_futures_/, '')
    .replace(/^futures_/, '')
    .replace(/^strategy_/, '')
    .replace(/_v\d+$/i, '')
    .replace(/_(long|short)$/i, '');
  const words = cleaned.split(/[_\s-]+/).filter(Boolean).map(titleWord);
  return words.length ? words.join(' ') : copy.states.noSelection;
}

function strategyDescription(strategy, copy) {
  const explicit = safeValue(strategy.description || strategy.summary || strategy.intent, '');
  if (explicit) return explicit;
  const text = String(strategy.strategyId || strategy.id || '').toLowerCase();
  if (text.includes('vwap')) return copy.descriptions.vwap;
  if (text.includes('breakout') || text.includes('orb')) return copy.descriptions.breakout;
  if (text.includes('reversal') || text.includes('mean') || text.includes('range')) return copy.descriptions.reversal;
  if (text.includes('momentum') || text.includes('trend')) return copy.descriptions.momentum;
  return copy.descriptions.default;
}

function rawLifecycle(strategy, brainRow = {}) {
  return String(brainRow.lifecycle || strategy.lifecycle || strategy.status || 'draft').trim().toLowerCase();
}

function productStageKey(strategy, brainRow = {}) {
  const stage = rawLifecycle(strategy, brainRow);
  if (stage === 'retired' || strategy.retired === true) return 'retired';
  if (stage === 'live') return 'live';
  if (['paper', 'monitoring', 'approved'].includes(stage)) return 'paper';
  if (['testing', 'learning', 'candidate'].includes(stage)) return 'test';
  return 'idea';
}

function productLifecycleLabel(strategy, brainRow, copy) {
  const stage = rawLifecycle(strategy, brainRow);
  if (stage === 'candidate') return copy.labels.readyForPaper;
  return copy.lifecycle[productStageKey(strategy, brainRow)] || copy.lifecycle.idea;
}

function productLifecycleTone(strategy, brainRow = {}) {
  const stage = rawLifecycle(strategy, brainRow);
  if (stage === 'retired' || strategy.retired === true) return 'warning';
  if (stage === 'live') return 'success';
  if (['candidate', 'paper', 'monitoring', 'approved'].includes(stage)) return 'info';
  if (['testing', 'learning'].includes(stage)) return 'neutral';
  return 'warning';
}

function replayTradeCount(strategy) {
  return asArray(strategy.replayHistory).reduce((total, row) => total + (numberOrNull(row.trades) || 0), 0);
}

function latestResultText(strategy, brainRow, copy) {
  const latestLive = latestRow(strategy.liveHistory, ['closedAt', 'at']);
  const latestPaper = latestRow(strategy.paperHistory, ['closedAt', 'at']);
  const latestReplay = latestRow(strategy.replayHistory, ['recordedAt', 'completedAt', 'at']);
  const score = numberOrNull(strategy.strategyScore ?? brainRow.strategyScore ?? latestReplay?.strategyScore);
  if (latestLive) return `${displaySignedMoney(latestLive.realizedPnlUsd, copy.states.noResult)} i Live Trading`;
  if (latestPaper) return `${displaySignedMoney(latestPaper.realizedPnlUsd, copy.states.noResult)} i Paper Trading`;
  if (score !== null) return `Betyg ${displayNumber(score, copy.emptyValue)}`;
  if (latestReplay?.strategyPnlUsd != null) return `${displaySignedMoney(latestReplay.strategyPnlUsd, copy.states.noResult)} i historiskt test`;
  if (latestReplay?.winRate != null) return `Vinstgrad ${displayPercent(latestReplay.winRate, copy.emptyValue)}`;
  return copy.states.noResult;
}

function resultTone(strategy, brainRow = {}) {
  const score = numberOrNull(strategy.strategyScore ?? brainRow.strategyScore);
  if (score === null) return 'neutral';
  if (score >= 65) return 'success';
  if (score >= 45) return 'info';
  return 'warning';
}

function marketTypeLabel(value, copy) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return copy.states.noMarket;
  if (/^[a-f0-9]{12,}$/i.test(normalized) || normalized.includes('hash')) return copy.states.noMarket;
  const labels = {
    range: 'Sidledes marknad',
    sideways: 'Sidledes marknad',
    trend: 'Trend',
    trend_up: 'Stigande trend',
    uptrend: 'Stigande trend',
    trend_down: 'Fallande trend',
    downtrend: 'Fallande trend',
    high_volatility: 'Hög volatilitet',
    low_volatility: 'Låg volatilitet',
    volatile: 'Hög volatilitet',
    calm: 'Lugn marknad',
    regular: 'Vanlig session',
  };
  return labels[normalized] || normalized
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(titleWord)
    .join(' ');
}

function bestMarketTypes(strategy, copy) {
  const scores = new Map();
  for (const run of asArray(strategy.replayHistory)) {
    const names = [
      run.marketClassification,
      run.marketRegimeKey,
      ...(Array.isArray(run.marketRegimeKeys) ? run.marketRegimeKeys : []),
    ].map((value) => marketTypeLabel(value, copy)).filter((value) => value && value !== copy.states.noMarket);
    const uniqueNames = [...new Set(names)];
    const score = numberOrNull(run.strategyScore ?? run.strategyPnlUsd ?? run.winRate) ?? 0;
    for (const name of uniqueNames) {
      const current = scores.get(name) || { name, count: 0, total: 0 };
      current.count += 1;
      current.total += score;
      scores.set(name, current);
    }
  }
  return [...scores.values()]
    .sort((a, b) => (b.total / Math.max(1, b.count)) - (a.total / Math.max(1, a.count)) || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((row) => row.name);
}

function learningFromSources(sources) {
  const learning = resourceData(sources, 'learningSummary') || {};
  return learning.summary || learning;
}

function learningRecordsFrom(learning = {}) {
  const rows = [
    ...asArray(learning.recordsList || learning.learningRecords),
    ...asArray(learning.latestRecord ? [learning.latestRecord] : []),
    ...asArray(learning.recommendations).map((row) => ({ ...row, recommendationOnly: true })),
  ];
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.learningRecordId || ''}|${row.replayRunId || row.recommendation?.replayRunId || ''}|${row.strategyId || ''}|${row.recommendedNextAction || row.action || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function learningByTestId(learning = {}) {
  const byId = new Map();
  for (const record of learningRecordsFrom(learning)) {
    const runId = firstValue(record.replayRunId, record.recommendation?.replayRunId);
    if (runId) byId.set(String(runId), record);
  }
  return byId;
}

function testStatusKey(value, fallback = 'waiting') {
  const normalized = String(value || '').trim().toLowerCase();
  if (['running', 'active', 'started', 'processing', 'in_progress'].includes(normalized)) return 'running';
  if (['queued', 'pending', 'waiting', 'created', 'scheduled', 'recommended', 'skipped'].includes(normalized)) return 'waiting';
  if (['failed', 'error', 'rejected', 'blocked', 'aborted', 'cancelled'].includes(normalized)) return 'failed';
  if (['completed', 'complete', 'done', 'ok', 'qualified', 'success', 'passed'].includes(normalized)) return 'completed';
  return fallback;
}

function testStatusTone(statusKey) {
  if (statusKey === 'running') return 'info';
  if (statusKey === 'waiting') return 'warning';
  if (statusKey === 'failed') return 'danger';
  if (statusKey === 'completed') return 'success';
  return 'neutral';
}

function testStatusLabel(statusKey, copy) {
  return copy.states[statusKey] || copy.states.waiting;
}

function actionNextStep(action, copy) {
  const normalized = String(action || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('optimizer') || normalized.includes('evolution') || normalized.includes('optimize') || normalized.includes('improve')) {
    return copy.nextSteps.improve;
  }
  if (normalized.includes('approval') || normalized.includes('paper') || normalized.includes('candidate')) {
    return copy.nextSteps.reviewPaper;
  }
  if (normalized.includes('replay') || normalized.includes('test') || normalized.includes('queue') || normalized.includes('scheduler')) {
    return copy.nextSteps.runMore;
  }
  if (normalized.includes('idle') || normalized.includes('wait')) return copy.nextSteps.done;
  return uiFactoryDecision(action)?.next || null;
}

function reasonText(reason, copy) {
  const translated = uiFactoryReason(reason);
  if (translated && translated !== reason) return translated;
  return copy.states.noReason;
}

function historicalTestResultText(row, copy) {
  const trades = numberOrNull(firstValue(row.trades, row.tradeCount, row.sampleSize));
  const score = numberOrNull(firstValue(row.strategyScore, row.score));
  const pnl = numberOrNull(firstValue(row.strategyPnlUsd, row.pnlUsd, row.pnl));
  const winrate = numberOrNull(firstValue(row.winRate, row.winrate));
  const parts = [];
  if (pnl !== null) parts.push(displaySignedMoney(pnl, copy.states.noResult));
  if (score !== null) parts.push(`Betyg ${displayNumber(score, copy.emptyValue)}`);
  if (winrate !== null) parts.push(`Vinstgrad ${displayPercent(winrate, copy.emptyValue)}`);
  if (trades !== null) parts.push(`${displayNumber(trades, copy.emptyValue)} ${copy.labels.trades.toLowerCase()}`);
  return parts.length ? parts.slice(0, 3).join(' · ') : copy.states.noResult;
}

function historicalTestLearningText(run, learning, statusKey, copy) {
  if (statusKey === 'running' || statusKey === 'waiting') return copy.outcomes.waiting;
  const code = firstValue(learning?.why?.code, learning?.reason, learning?.recommendation?.reason);
  const translated = uiFactoryReason(code);
  if (translated && translated !== code) return translated;
  const trades = numberOrNull(firstValue(run.trades, learning?.trades));
  const score = numberOrNull(firstValue(run.strategyScore, learning?.strategyScore));
  if (trades === 0) return copy.outcomes.noTrades;
  if (score !== null && score >= 60) return copy.outcomes.strong;
  if (score !== null && score < 45) return copy.outcomes.weak;
  if (statusKey === 'failed') return copy.outcomes.mixed;
  return copy.outcomes.mixed;
}

function historicalTestNextStep(run, learning, statusKey, copy) {
  if (statusKey === 'running' || statusKey === 'waiting') return copy.nextSteps.wait;
  if (statusKey === 'failed') return copy.nextSteps.runMore;
  const action = firstValue(learning?.recommendedNextAction, learning?.action, learning?.recommendation?.action);
  return actionNextStep(action, copy) || (learning ? copy.nextSteps.readResult : copy.nextSteps.learn);
}

function historicalTestCounts(rows) {
  return rows.reduce((counts, row) => {
    counts[row.statusKey] = (counts[row.statusKey] || 0) + 1;
    return counts;
  }, { running: 0, waiting: 0, completed: 0, failed: 0 });
}

function strategyMatchesNode(strategy, node) {
  const ids = [
    strategy.strategyId,
    strategy.id,
    strategy.executionStrategyId,
    strategy.originStrategyId,
    strategy.nativeStrategyId,
  ].filter(Boolean).map(String);
  return [
    node.strategyId,
    node.rootStrategyId,
    node.originStrategyId,
    node.nativeStrategyId,
  ].filter(Boolean).some((id) => ids.includes(String(id)));
}

function developmentText(strategy, nodes, copy) {
  const versions = asArray(nodes).filter((node) => strategyMatchesNode(strategy, node)).length;
  const moves = asArray(strategy.promotionHistory).length;
  const retirements = asArray(strategy.retirementHistory).length;
  if (versions > 1) return `${displayNumber(versions, copy.emptyValue)} versioner har skapats.`;
  if (moves > 0) return `${displayNumber(moves, copy.emptyValue)} steg har sparats i biblioteket.`;
  if (retirements > 0) return 'Strategin har arkiverats med bevarad historik.';
  if (strategy.currentVersion) return `Version ${safeValue(strategy.currentVersion, copy.states.noVersion)}.`;
  return copy.states.noDevelopment;
}

function learningText(strategy, markets, copy) {
  const trades = replayTradeCount(strategy);
  const score = numberOrNull(strategy.strategyScore);
  if (!asArray(strategy.replayHistory).length) return 'AI väntar på första historiska testet.';
  if (markets.length) return `Fungerar bäst i ${markets.join(', ')}.`;
  if (score !== null && score < 45 && trades >= 20) return 'Resultatet är svagt och behöver förbättras eller arkiveras.';
  return copy.states.noLearning;
}

function strategyAttention(strategy, brainRow, copy) {
  const stage = rawLifecycle(strategy, brainRow);
  if (stage === 'retired' || strategy.retired === true) return null;
  const score = numberOrNull(strategy.strategyScore ?? brainRow.strategyScore);
  const confidence = numberOrNull(strategy.confidenceScore ?? brainRow.confidenceScore);
  const runs = asArray(strategy.replayHistory).length;
  const trades = replayTradeCount(strategy);
  const readyForPaper = stage === 'candidate' || brainRow.promotion?.allowed === true || brainRow.promotion?.to === 'paper';

  if (brainRow.retirementSuggested === true || (score !== null && score < 35 && trades >= 20)) {
    return {
      label: copy.attention.canRetire,
      why: 'Resultatet har varit svagt trots tillräckligt testunderlag.',
      priority: 1,
      tone: 'warning',
    };
  }
  if (readyForPaper) {
    return {
      label: copy.attention.readyForPaper,
      why: 'Testunderlaget räcker för manuell granskning.',
      priority: 2,
      tone: 'success',
    };
  }
  if (!runs || trades < 20 || (confidence !== null && confidence < 40) || numberOrNull(brainRow.gapCount) > 0) {
    return {
      label: copy.attention.needsTests,
      why: 'Biblioteket saknar tillräckligt testunderlag.',
      priority: 3,
      tone: 'info',
    };
  }
  if (score !== null && score < 55) {
    return {
      label: copy.attention.weakResults,
      why: 'Senaste betyget ligger under kvalitetsgränsen.',
      priority: 4,
      tone: 'warning',
    };
  }
  return null;
}

function nextStepText(strategy, brainRow, attention, copy) {
  const stage = rawLifecycle(strategy, brainRow);
  if (stage === 'retired' || strategy.retired === true) return copy.nextSteps.archive;
  if (attention?.label === copy.attention.canRetire) return copy.nextSteps.archive;
  if (attention?.label === copy.attention.readyForPaper || stage === 'candidate') return copy.nextSteps.reviewPaper;
  if (attention?.label === copy.attention.needsTests) return copy.nextSteps.runTests;
  if (attention?.label === copy.attention.weakResults) return copy.nextSteps.improve;
  if (['paper', 'monitoring', 'approved'].includes(stage)) return copy.nextSteps.watchPaper;
  if (stage === 'live') return copy.nextSteps.watchLive;
  return copy.nextSteps.wait;
}

function lifecycleCounts(strategies) {
  const counts = {};
  for (const strategy of strategies) {
    const stage = String(strategy.lifecycle || strategy.status || 'draft').toLowerCase();
    counts[stage] = (counts[stage] || 0) + 1;
  }
  return counts;
}

function buildLibraryRows(sources, copy) {
  const library = resourceData(sources, 'library') || {};
  const brain = resourceData(sources, 'brain') || {};
  const lineage = resourceData(sources, 'lineage') || {};
  const brainByStrategy = new Map(asArray(brain.strategies).map((row) => [String(row.strategyId), row]));
  const nodes = asArray(lineage.nodes);

  return asArray(library.strategies).map((strategy) => ({
    strategy,
    brainRow: brainByStrategy.get(String(strategy.strategyId || strategy.id)) || {},
  })).map(({ strategy, brainRow }) => {
    const productCopy = copy.libraryProduct || copy;
    const attention = strategyAttention(strategy, brainRow, productCopy);
    const markets = bestMarketTypes(strategy, productCopy);
    const latestResult = latestResultText(strategy, brainRow, productCopy);
    const status = productLifecycleLabel(strategy, brainRow, productCopy);
    const nextStep = nextStepText(strategy, brainRow, attention, productCopy);
    const time = latestTime([
      strategy,
      ...asArray(strategy.replayHistory),
      ...asArray(strategy.paperHistory),
      ...asArray(strategy.liveHistory),
      ...asArray(strategy.promotionHistory),
      ...asArray(strategy.retirementHistory),
    ], ['lastUpdated', 'created', 'at', 'recordedAt', 'closedAt']);
    const title = strategyName(strategy, productCopy);
    const tests = asArray(strategy.replayHistory).length;
    const replayTrades = replayTradeCount(strategy);
    const strategyId = strategy.strategyId || strategy.id || title;
    const latestReplay = latestRow(strategy.replayHistory, ['recordedAt', 'completedAt', 'at']);
    const latestTestRunId = firstValue(latestReplay?.runId, latestReplay?.replayRunId, latestReplay?.libraryRunId);
    const story = aiStoryStrategySummary({
      strategyId,
      status,
      latestResult,
      nextStep,
      learning: learningText(strategy, markets, productCopy),
      lifecycle: strategy.lifecycle || brainRow.lifecycle,
    });

    return {
      id: strategyId,
      strategyId,
      latestTestRunId,
      title,
      description: story.story,
      status,
      stageKey: productStageKey(strategy, brainRow),
      tone: productLifecycleTone(strategy, brainRow),
      summary: story.summary,
      latestResult,
      resultTone: resultTone(strategy, brainRow),
      nextStep: story.next,
      attention,
      priority: attention?.priority || 99,
      time,
      tests,
      replayTrades,
      paperTrades: asArray(strategy.paperHistory).length,
      liveTrades: asArray(strategy.liveHistory).length,
      markets,
      development: developmentText(strategy, nodes, productCopy),
      learning: story.detail || learningText(strategy, markets, productCopy),
      version: safeValue(strategy.currentVersion, productCopy.states.noVersion),
      rawStage: rawLifecycle(strategy, brainRow),
      score: numberOrNull(strategy.strategyScore ?? brainRow.strategyScore),
      story,
      queryKeys: [strategyId, title, latestTestRunId].filter(Boolean).map(String),
      fields: [
        { label: productCopy.labels.name, value: title },
        { label: productCopy.labels.status, value: status },
        { label: productCopy.labels.latestResult, value: story.summary },
        { label: productCopy.labels.nextStep, value: story.next },
      ],
    };
  }).sort((a, b) => a.priority - b.priority
    || (numberOrNull(b.score) ?? -1) - (numberOrNull(a.score) ?? -1)
    || (parseTime(b.time) || 0) - (parseTime(a.time) || 0)
    || a.title.localeCompare(b.title));
}

function buildFamilyRows(sources, copy) {
  const lineage = resourceData(sources, 'lineage') || {};
  return asArray(lineage.nodes).map((node) => {
    const strategyId = node.strategyId || node.rootStrategyId || node.originStrategyId || node.nativeStrategyId;
    const nodeId = node.dnaHash || strategyId;
    return {
      id: nodeId,
      strategyId,
      title: safeValue(strategyId || node.dnaHash, copy.states.noStrategy),
      status: node.retired ? uiLifecycleStage('retired') : uiStatus(FACTORY_STATUS_KEYS.COMPLETED),
      tone: node.retired ? 'warning' : 'success',
      summary: mutationText(node, copy),
      time: node.createdAt || node.recordedAt || node.at,
      queryKeys: [nodeId, strategyId, node.dnaHash].filter(Boolean).map(String),
      fields: [
        { label: uiName(FACTORY_TERM_KEYS.STRATEGY_DNA), value: safeValue(node.dnaHash, copy.emptyValue) },
        { label: copy.labels.generation, value: displayNumber(node.generation, copy.states.noGeneration) },
        { label: copy.labels.branch, value: safeValue(node.branch, copy.emptyValue) },
        { label: copy.labels.strategy, value: safeValue(node.strategyId || node.rootStrategyId, copy.states.noStrategy) },
        { label: copy.labels.result, value: mutationText(node, copy) },
      ],
    };
  }).sort((a, b) => (parseTime(b.time) || 0) - (parseTime(a.time) || 0) || a.title.localeCompare(b.title));
}

function buildMarketRows(sources, copy) {
  const catalog = resourceData(sources, 'marketCatalog') || {};
  const market = resourceData(sources, 'market') || {};
  const periodRows = asArray(catalog.periods).map((period, index) => ({
    id: `period|${period.symbol || index}|${period.from || ''}|${period.to || ''}`,
    marketId: period.regimeKey || period.marketDnaHash || period.symbol,
    title: safeValue(period.symbol, copy.states.noMarket),
    status: uiStatus(FACTORY_STATUS_KEYS.COMPLETED),
    tone: 'success',
    summary: safeValue(period.regimeKey || period.marketDnaHash, copy.states.noMarket),
    time: period.to || period.from,
    queryKeys: [period.symbol, period.regimeKey, period.marketDnaHash].filter(Boolean).map(String),
    fields: [
      { label: copy.labels.market, value: safeValue(period.symbol, copy.states.noMarket) },
      { label: uiName(FACTORY_TERM_KEYS.MARKET_DNA), value: safeValue(period.regimeKey || period.marketDnaHash, copy.states.noMarket) },
      { label: copy.labels.version, value: `${safeValue(period.from, copy.emptyValue)} - ${safeValue(period.to, copy.emptyValue)}` },
      { label: copy.labels.result, value: safeValue(period.traits?.direction || period.traits?.volatility || period.session, copy.states.noResult) },
    ],
  }));

  const regimeRows = Object.entries(market.market?.regimeCounts || market.regimeCounts || {}).map(([key, value]) => ({
    id: `regime|${key}`,
    marketId: key,
    title: safeValue(key, copy.states.noMarket),
    status: uiStatus(FACTORY_STATUS_KEYS.COMPLETED),
    tone: 'success',
    summary: `${displayNumber(value, copy.emptyValue)} ${copy.labels.periods}`,
    time: market.generatedAt || market.updatedAt || null,
    queryKeys: [key].filter(Boolean).map(String),
    fields: [
      { label: uiName(FACTORY_TERM_KEYS.MARKET_DNA), value: safeValue(key, copy.states.noMarket) },
      { label: copy.labels.periods, value: displayNumber(value, copy.emptyValue) },
      { label: copy.labels.result, value: safeValue(key, copy.states.noMarket) },
    ],
  }));

  return [...periodRows, ...regimeRows]
    .sort((a, b) => (parseTime(b.time) || 0) - (parseTime(a.time) || 0) || a.title.localeCompare(b.title));
}

function buildReplayRows(sources, copy) {
  const library = resourceData(sources, 'library') || {};
  const queue = resourceData(sources, 'queue') || {};
  const productCopy = copy.historicalTestsProduct || copy;
  const learning = learningFromSources(sources);
  const learningByRunId = learningByTestId(learning);
  const brain = resourceData(sources, 'brain') || {};
  const brainByStrategy = new Map(asArray(brain.strategies).map((row) => [String(row.strategyId), row]));
  const strategiesById = new Map(asArray(library.strategies).flatMap((strategy) => (
    [
      strategy.strategyId,
      strategy.id,
      strategy.executionStrategyId,
      strategy.originStrategyId,
      strategy.nativeStrategyId,
    ].filter(Boolean).map((id) => [String(id), strategy])
  )));

  const libraryRows = asArray(library.strategies).flatMap((strategy) => (
    asArray(strategy.replayHistory).map((run, index) => {
      const runId = firstValue(run.runId, run.replayRunId, run.libraryRunId, `${strategy.strategyId || index}`);
      const learningRecord = learningByRunId.get(String(runId)) || null;
      const strategyId = firstValue(run.strategyId, strategy.strategyId, strategy.id);
      const brainRow = brainByStrategy.get(String(strategyId || '')) || {};
      const statusKey = testStatusKey(run.status || (run.qualified === false ? 'completed' : 'completed'), 'completed');
      const market = marketTypeLabel(firstValue(run.marketRegimeKey, run.marketClassification, run.marketDnaHash, strategy.currentMarketDnaHash), productCopy);
      const strategyTitle = strategyName(strategy, copy.libraryProduct || productCopy);
      const result = historicalTestResultText(run, productCopy);
      const learningText = historicalTestLearningText(run, learningRecord, statusKey, productCopy);
      const nextStep = historicalTestNextStep(run, learningRecord, statusKey, productCopy);
      const story = aiStoryTestSummary({
        strategyId,
        status: statusKey,
        result,
        learning: learningText,
        nextStep,
      });
      const time = firstValue(run.recordedAt, run.completedAt, run.at, strategy.lastUpdated);
      return {
        id: `historical-test|${runId}|${strategyId || index}`,
        runId,
        strategyId,
        marketId: firstValue(run.marketRegimeKey, run.marketClassification, run.marketDnaHash, strategy.currentMarketDnaHash),
        title: strategyTitle,
        description: story.story,
        status: testStatusLabel(statusKey, productCopy),
        statusKey,
        tone: testStatusTone(statusKey),
        summary: story.summary,
        time,
        strategy: strategyTitle,
        market,
        result,
        learning: story.detail || learningText,
        nextStep: story.next || nextStep,
        tested: `${strategyTitle} i ${market}`,
        why: reasonText(firstValue(learningRecord?.why?.code, learningRecord?.reason, brainRow.recommendation?.reason), productCopy),
        trades: numberOrNull(firstValue(run.trades, learningRecord?.trades)),
        isActive: statusKey === 'running' || statusKey === 'waiting',
        queryKeys: [runId, strategyId, strategyTitle, firstValue(run.marketRegimeKey, run.marketClassification, run.marketDnaHash, strategy.currentMarketDnaHash)].filter(Boolean).map(String),
        story,
        fields: [
          { label: productCopy.labels.strategy, value: strategyTitle },
          { label: productCopy.labels.market, value: market },
          { label: productCopy.labels.ranAt, value: formatDateTime(time, productCopy.emptyValue) },
          { label: productCopy.labels.result, value: story.summary },
          { label: productCopy.labels.learning, value: story.detail || learningText },
          { label: productCopy.labels.nextStep, value: nextStep },
        ],
      };
    })
  ));

  const queueRows = asArray(queue.jobs).map((job, index) => {
    const runId = firstValue(job.run_id, job.runId, job.id, `${index}`);
    const strategyId = firstValue(job.strategy?.id, job.strategyId);
    const strategy = strategiesById.get(String(strategyId || '')) || { strategyId };
    const learningRecord = learningByRunId.get(String(runId)) || null;
    const statusKey = testStatusKey(job.status, 'waiting');
    const market = marketTypeLabel(firstValue(job.market_dna, job.marketDna, job.targetRegime), productCopy);
    const strategyTitle = strategyName(strategy, copy.libraryProduct || productCopy);
    const time = firstValue(job.completed_at, job.failed_at, job.started_at, job.updated_at, job.created_at);
    const status = testStatusLabel(statusKey, productCopy);
    const result = statusKey === 'completed' && learningRecord
      ? historicalTestResultText(learningRecord, productCopy)
      : status;
    const learningText = historicalTestLearningText(job, learningRecord, statusKey, productCopy);
    return {
      id: `historical-test-active|${job.id || runId}|${index}`,
      runId,
      strategyId,
      marketId: firstValue(job.market_dna, job.marketDna, job.targetRegime),
      title: strategyTitle,
      description: `${market} · ${formatDateTime(time, productCopy.emptyValue)}`,
      status,
      statusKey,
      tone: testStatusTone(statusKey),
      summary: result,
      time,
      strategy: strategyTitle,
      market,
      result,
      learning: learningText,
      nextStep: historicalTestNextStep(job, learningRecord, statusKey, productCopy),
      tested: `${strategyTitle} i ${market}`,
      why: reasonText(job.reason || job.error || job.failed_reason, productCopy),
      trades: numberOrNull(firstValue(job.trades, learningRecord?.trades)),
      isActive: statusKey === 'running' || statusKey === 'waiting',
      queryKeys: [job.id, runId, strategyId, strategyTitle, firstValue(job.market_dna, job.marketDna, job.targetRegime)].filter(Boolean).map(String),
      fields: [
        { label: productCopy.labels.strategy, value: strategyTitle },
        { label: productCopy.labels.market, value: market },
        { label: productCopy.labels.ranAt, value: formatDateTime(time, productCopy.emptyValue) },
        { label: productCopy.labels.result, value: result },
        { label: productCopy.labels.learning, value: learningText },
        { label: productCopy.labels.nextStep, value: historicalTestNextStep(job, learningRecord, statusKey, productCopy) },
      ],
    };
  });

  const seenCompleted = new Set(libraryRows.map((row) => row.id.split('|')[1]).filter(Boolean));
  return [
    ...libraryRows,
    ...queueRows.filter((row) => row.isActive || !seenCompleted.has(row.id.split('|')[1])),
  ].sort((a, b) => (parseTime(b.time) || 0) - (parseTime(a.time) || 0) || a.title.localeCompare(b.title));
}

function productLifecycleCounts(rows) {
  return rows.reduce((counts, row) => {
    counts.total += 1;
    if (row.rawStage === 'retired' || row.stageKey === 'retired') counts.retired += 1;
    else if (row.rawStage === 'live') counts.live += 1;
    else if (row.rawStage === 'candidate') counts.readyForPaper += 1;
    else if (['testing', 'learning'].includes(row.rawStage)) counts.testing += 1;
    else if (row.rawStage === 'draft' || row.stageKey === 'idea') counts.draft += 1;
    return counts;
  }, {
    total: 0,
    draft: 0,
    testing: 0,
    readyForPaper: 0,
    live: 0,
    retired: 0,
  });
}

function rowsForMode(mode, sources, copy) {
  if (mode === 'replay') return buildReplayRows(sources, copy);
  if (mode === 'family') return buildFamilyRows(sources, copy);
  if (mode === 'market') return buildMarketRows(sources, copy);
  return buildLibraryRows(sources, copy);
}

function buildModel(mode, data) {
  const copy = uiFactoryExplorer();
  const modeCopy = copy.modes[mode] || copy.modes.library;
  const rows = rowsForMode(mode, data.sources, copy);
  const sources = sourceSummary(data.sources);
  const latest = rows.find((row) => parseTime(row.time) !== null) || rows[0] || null;
  const counts = lifecycleCounts(asArray(resourceData(data.sources, 'library')?.strategies));
  const lineage = resourceData(data.sources, 'lineage') || {};
  const marketCatalog = resourceData(data.sources, 'marketCatalog') || {};
  const productCounts = mode === 'library' ? productLifecycleCounts(rows) : null;
  const testCounts = mode === 'replay' ? historicalTestCounts(rows) : null;

  return {
    copy,
    modeCopy,
    rows,
    latest,
    sources,
    productCounts,
    attentionRows: mode === 'library' ? rows.filter((row) => row.attention).slice(0, 3) : [],
    activeTestRows: mode === 'replay' ? rows.filter((row) => row.isActive).slice(0, 6) : [],
    latestTestRows: mode === 'replay' ? rows.filter((row) => !row.isActive).slice(0, 12) : [],
    kpis: mode === 'library' ? [
      { label: copy.libraryProduct.labels.total, value: data.loading ? copy.states.loading : displayNumber(productCounts.total, copy.emptyValue), tone: productCounts.total ? 'success' : 'neutral' },
      { label: copy.libraryProduct.labels.draft, value: displayNumber(productCounts.draft, copy.emptyValue), tone: productCounts.draft ? 'warning' : 'neutral' },
      { label: copy.libraryProduct.labels.testing, value: displayNumber(productCounts.testing, copy.emptyValue), tone: productCounts.testing ? 'info' : 'neutral' },
      { label: copy.libraryProduct.labels.readyForPaper, value: displayNumber(productCounts.readyForPaper, copy.emptyValue), tone: productCounts.readyForPaper ? 'success' : 'neutral' },
      { label: copy.libraryProduct.labels.live, value: displayNumber(productCounts.live, copy.emptyValue), tone: productCounts.live ? 'success' : 'neutral' },
      { label: copy.libraryProduct.labels.retired, value: displayNumber(productCounts.retired, copy.emptyValue), tone: productCounts.retired ? 'warning' : 'neutral' },
    ] : mode === 'replay' ? [
      { label: copy.historicalTestsProduct.labels.running, value: data.loading ? copy.states.loading : displayNumber(testCounts.running, copy.emptyValue), tone: testCounts.running ? 'info' : 'neutral' },
      { label: copy.historicalTestsProduct.labels.waiting, value: displayNumber(testCounts.waiting, copy.emptyValue), tone: testCounts.waiting ? 'warning' : 'neutral' },
      { label: copy.historicalTestsProduct.labels.completed, value: displayNumber(testCounts.completed, copy.emptyValue), tone: testCounts.completed ? 'success' : 'neutral' },
      { label: copy.historicalTestsProduct.labels.failed, value: displayNumber(testCounts.failed, copy.emptyValue), tone: testCounts.failed ? 'danger' : 'neutral' },
    ] : [
      { label: copy.labels.total, value: data.loading ? copy.states.loading : displayNumber(rows.length, copy.emptyValue), hint: modeCopy.title, tone: rows.length ? 'success' : 'neutral' },
      { label: copy.labels.strategies, value: displayNumber(Object.values(counts).reduce((sum, value) => sum + value, 0), copy.emptyValue), hint: uiName(FACTORY_TERM_KEYS.STRATEGY_LIBRARY), tone: 'neutral' },
      { label: copy.labels.nodes, value: displayNumber(asArray(lineage.nodes).length, copy.emptyValue), hint: uiName(FACTORY_TERM_KEYS.STRATEGY_FAMILY_TREE), tone: 'neutral' },
      { label: copy.labels.periods, value: displayNumber(asArray(marketCatalog.periods).length, copy.emptyValue), hint: uiName(FACTORY_TERM_KEYS.MARKET_DNA), tone: 'neutral' },
    ],
  };
}

function rowMatchesContext(row, value) {
  const target = String(value || '').trim();
  if (!target) return false;
  return [
    row.id,
    row.strategyId,
    row.runId,
    row.marketId,
    row.latestTestRunId,
    ...asArray(row.queryKeys),
  ].filter(Boolean).some((candidate) => String(candidate) === target);
}

function selectedIdFromSearch(rows, mode, searchParams) {
  const keys = mode === 'library'
    ? ['strategy', 'id']
    : mode === 'replay'
      ? ['test', 'strategy', 'id']
      : mode === 'market'
        ? ['market', 'id']
        : ['strategy', 'test', 'market', 'id'];
  for (const key of keys) {
    const value = searchParams.get(key);
    const row = rows.find((candidate) => rowMatchesContext(candidate, value));
    if (row) return row.id;
  }
  return null;
}

function selectionParamForMode(mode) {
  if (mode === 'library') return 'strategy';
  if (mode === 'replay') return 'test';
  if (mode === 'market') return 'market';
  return 'id';
}

function contextFromRow(row = {}) {
  return {
    strategyId: row.strategyId,
    testId: row.runId || row.latestTestRunId,
    replayRunId: row.runId || row.latestTestRunId,
    marketId: row.marketId,
    marketDnaHash: row.marketDnaHash || row.marketId,
  };
}

function genericContextActions(mode, row) {
  const context = contextFromRow(row || {});
  if (!row) {
    return [
      contextAction('factory', {}, { primary: true }),
      contextAction('test'),
      contextAction('strategy'),
    ];
  }
  if (mode === 'market') {
    return [
      contextAction('test', context, { primary: true }),
      contextAction('strategy', context),
      contextAction('factory', context),
    ];
  }
  return [
    contextAction('strategy', context, { primary: true }),
    contextAction('test', context),
    contextAction('paper', context),
    contextAction('factory', context),
  ];
}

function ExplorerRow({ row, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(row.id)}
      style={{
        width: '100%',
        border: selected ? '1px solid var(--blue-border)' : '1px solid var(--border)',
        background: selected ? 'var(--blue-dim)' : 'var(--surface)',
        borderRadius: 'var(--r)',
        color: 'var(--text)',
        cursor: 'pointer',
        padding: 'var(--s4)',
        textAlign: 'left',
        display: 'grid',
        gap: 'var(--s3)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ overflowWrap: 'anywhere' }}>{row.title}</strong>
        <StatusBadge tone={row.tone}>{row.status}</StatusBadge>
      </div>
      <span style={{ color: 'var(--muted)', fontSize: 12, overflowWrap: 'anywhere' }}>{row.summary}</span>
      <span style={{ color: 'var(--muted)', fontSize: 11 }}>{formatDateTime(row.time, '')}</span>
    </button>
  );
}

function ExplorerList({ rows, selectedId, onSelect, copy }) {
  if (!rows.length) {
    return (
      <div className="m-empty">
        <div className="m-empty-title">{copy.states.empty}</div>
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 'var(--s3)' }}>
      {rows.map((row) => (
        <ExplorerRow
          key={row.id}
          row={row}
          selected={row.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function HistoricalTestsOverview({ model }) {
  const copy = model.copy.historicalTestsProduct;
  return (
    <OverviewPanel
      data-historical-tests-overview
      eyebrow={copy.readOnly}
      title={copy.sections.overview.title}
      summary={copy.sections.overview.summary}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--s3)' }}>
        {model.kpis.map((metric) => (
          <MetricCard
            key={metric.label}
            label={metric.label}
            value={metric.value}
            tone={metric.tone}
          />
        ))}
      </div>
    </OverviewPanel>
  );
}

function HistoricalTestCard({ row, selected, onSelect, copy }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(row.id)}
      data-historical-test-card
      style={{
        width: '100%',
        border: selected ? '1px solid var(--blue-border)' : '1px solid var(--border)',
        background: selected ? 'var(--blue-dim)' : 'var(--surface)',
        borderRadius: 'var(--r)',
        color: 'var(--text)',
        cursor: 'pointer',
        padding: 'var(--s4)',
        textAlign: 'left',
        display: 'grid',
        gap: 'var(--s3)',
        minHeight: 210,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s3)', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: 'block', fontFamily: 'var(--display)', fontSize: 17, lineHeight: 1.2, overflowWrap: 'anywhere' }}>{row.strategy}</strong>
          <span style={{ display: 'block', color: 'var(--muted)', fontSize: 13, lineHeight: 1.45, marginTop: 6 }}>{row.market}</span>
        </div>
        <StatusBadge tone={row.tone} compact>{row.status}</StatusBadge>
      </div>
      <FieldGrid
        items={[
          { label: copy.labels.ranAt, value: formatDateTime(row.time, copy.emptyValue) },
          { label: copy.labels.result, value: row.result },
          { label: copy.labels.learning, value: row.learning },
          { label: copy.labels.nextStep, value: row.nextStep },
        ]}
      />
    </button>
  );
}

function HistoricalTestsLatest({ rows, selectedId, onSelect, copy }) {
  return (
    <OverviewPanel
      data-historical-tests-latest
      eyebrow={copy.readOnly}
      title={copy.sections.latest.title}
      summary={copy.sections.latest.summary}
    >
      {!rows.length ? (
        <div className="m-empty">
          <div className="m-empty-title">{copy.states.noTests}</div>
          <div className="m-empty-body">{copy.outcomes.waiting}</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 'var(--s4)' }}>
          {rows.map((row) => (
            <HistoricalTestCard
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              onSelect={onSelect}
              copy={copy}
            />
          ))}
        </div>
      )}
    </OverviewPanel>
  );
}

function HistoricalTestsActive({ rows, selectedId, onSelect, copy }) {
  return (
    <OverviewPanel
      data-historical-tests-active
      eyebrow={copy.readOnly}
      title={copy.sections.active.title}
      summary={copy.sections.active.summary}
    >
      {!rows.length ? (
        <div className="m-empty">
          <div className="m-empty-title">{copy.states.noActive}</div>
          <div className="m-empty-body">{copy.nextSteps.done}</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--s3)' }}>
          {rows.map((row) => (
            <HistoricalTestCard
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              onSelect={onSelect}
              copy={copy}
            />
          ))}
        </div>
      )}
    </OverviewPanel>
  );
}

function HistoricalTestDetails({ row, copy }) {
  if (!row) {
    return (
      <OverviewPanel
        data-historical-test-details
        eyebrow={copy.readOnly}
        title={copy.sections.detail.title}
        summary={copy.states.noSelection}
      >
        <ContextNavigation
          compact
          actions={[
            contextAction('factory', {}, { primary: true }),
            contextAction('strategy'),
            contextAction('decision'),
          ]}
        />
      </OverviewPanel>
    );
  }
  const context = contextFromRow(row);

  return (
    <OverviewPanel
      data-historical-test-details
      eyebrow={copy.readOnly}
      title={copy.sections.detail.title}
      summary={row.story?.story || row.description}
      style={{ position: 'sticky', top: 16 }}
    >
      <div style={{ display: 'grid', gap: 'var(--s4)' }}>
        <StatusBadge tone={row.tone}>{row.status}</StatusBadge>
        <FieldGrid
          items={[
            { label: copy.labels.tested, value: row.tested },
            { label: copy.labels.why, value: row.why },
            { label: copy.labels.result, value: row.story?.summary || row.result },
            { label: copy.labels.learning, value: row.story?.detail || row.learning },
            { label: copy.labels.nextStep, value: row.story?.next || row.nextStep },
            { label: copy.labels.status, value: row.status, tone: row.tone },
            { label: copy.labels.trades, value: row.trades == null ? copy.emptyValue : displayNumber(row.trades, copy.emptyValue) },
          ]}
        />
        <ContextNavigation
          compact
          actions={[
            contextAction('strategy', context, { primary: true }),
            contextAction('decision', context),
            contextAction('factory', context),
          ]}
        />
      </div>
    </OverviewPanel>
  );
}

function HistoricalTestsProductView({ model, selected, selectedId, onSelect }) {
  const copy = model.copy.historicalTestsProduct;
  return (
    <div data-historical-tests-product style={{ display: 'grid', gap: 'var(--s5)' }}>
      <HistoricalTestsOverview model={model} />
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
        gap: 'var(--s5)',
        alignItems: 'start',
      }}>
        <div style={{ display: 'grid', gap: 'var(--s5)' }}>
          <HistoricalTestsLatest rows={model.latestTestRows} selectedId={selectedId} onSelect={onSelect} copy={copy} />
          <HistoricalTestsActive rows={model.activeTestRows} selectedId={selectedId} onSelect={onSelect} copy={copy} />
        </div>
        <HistoricalTestDetails row={selected} copy={copy} />
      </div>
    </div>
  );
}

function StrategyLibraryOverview({ model }) {
  const copy = model.copy.libraryProduct;
  return (
    <OverviewPanel
      data-strategy-library-overview
      eyebrow={copy.readOnly}
      title={copy.sections.overview.title}
      summary={copy.sections.overview.summary}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--s3)' }}>
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
    </OverviewPanel>
  );
}

function AttentionCard({ row, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(row.id)}
      style={{
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        borderRadius: 'var(--r)',
        color: 'var(--text)',
        cursor: 'pointer',
        padding: 'var(--s4)',
        textAlign: 'left',
        display: 'grid',
        gap: 'var(--s2)',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s3)', alignItems: 'flex-start' }}>
        <strong style={{ fontFamily: 'var(--display)', fontSize: 16, overflowWrap: 'anywhere' }}>{row.title}</strong>
        <StatusBadge tone={row.attention.tone || row.tone} compact>{row.attention.label}</StatusBadge>
      </div>
      <span style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.45 }}>{row.attention.why}</span>
      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{row.nextStep}</span>
    </button>
  );
}

function StrategyAttentionList({ rows, copy, onSelect }) {
  return (
    <OverviewPanel
      data-strategy-library-attention
      eyebrow={copy.readOnly}
      title={copy.sections.attention.title}
      summary={copy.sections.attention.summary}
    >
      {!rows.length ? (
        <div className="m-empty">
          <div className="m-empty-title">{copy.states.noAttention}</div>
          <div className="m-empty-body">{copy.nextSteps.wait}</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 'var(--s3)' }}>
          {rows.map((row) => <AttentionCard key={row.id} row={row} onSelect={onSelect} />)}
        </div>
      )}
    </OverviewPanel>
  );
}

function StrategyLibraryCard({ row, selected, onSelect, copy }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(row.id)}
      data-strategy-library-card
      style={{
        width: '100%',
        border: selected ? '1px solid var(--blue-border)' : '1px solid var(--border)',
        background: selected ? 'var(--blue-dim)' : 'var(--surface)',
        borderRadius: 'var(--r)',
        color: 'var(--text)',
        cursor: 'pointer',
        padding: 'var(--s4)',
        textAlign: 'left',
        display: 'grid',
        gap: 'var(--s3)',
        minHeight: 190,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s3)', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: 'block', fontFamily: 'var(--display)', fontSize: 17, lineHeight: 1.2, overflowWrap: 'anywhere' }}>{row.title}</strong>
          <span style={{ display: 'block', color: 'var(--muted)', fontSize: 13, lineHeight: 1.45, marginTop: 6 }}>{row.description}</span>
        </div>
        <StatusBadge tone={row.tone} compact>{row.status}</StatusBadge>
      </div>
      <FieldGrid
        items={[
          { label: copy.labels.latestResult, value: row.latestResult, tone: row.resultTone },
          { label: copy.labels.nextStep, value: row.nextStep },
        ]}
      />
    </button>
  );
}

function StrategyLibraryCards({ rows, selectedId, onSelect, copy }) {
  return (
    <OverviewPanel
      data-strategy-library-cards
      eyebrow={copy.readOnly}
      title={copy.sections.all.title}
      summary={copy.sections.all.summary}
    >
      {!rows.length ? (
        <div className="m-empty">
          <div className="m-empty-title">{copy.states.noStrategies}</div>
          <div className="m-empty-body">{copy.nextSteps.wait}</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 270px), 1fr))', gap: 'var(--s4)' }}>
          {rows.map((row) => (
            <StrategyLibraryCard
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              onSelect={onSelect}
              copy={copy}
            />
          ))}
        </div>
      )}
    </OverviewPanel>
  );
}

function StrategyLifecycleTimeline({ row, copy }) {
  const activeIndex = PRODUCT_STAGE_ORDER.indexOf(row?.stageKey || 'idea');
  return (
    <div data-strategy-library-lifecycle style={{ display: 'grid', gap: 'var(--s3)' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
        gap: 'var(--s2)',
      }}>
        {PRODUCT_STAGE_ORDER.map((stage, index) => {
          const reached = activeIndex >= index;
          const current = activeIndex === index;
          return (
            <div
              key={stage}
              style={{
                border: `1px solid ${current ? 'var(--blue-border)' : 'var(--border)'}`,
                background: reached ? 'var(--surface-2)' : 'transparent',
                borderRadius: 'var(--r)',
                padding: '10px 8px',
                textAlign: 'center',
                minHeight: 54,
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <span style={{
                color: current ? 'var(--blue)' : (reached ? 'var(--text)' : 'var(--muted)'),
                fontSize: 12,
                fontWeight: current ? 700 : 500,
              }}>
                {copy.lifecycle[stage]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StrategyLibraryDetail({ row, copy }) {
  if (!row) {
    return (
      <OverviewPanel
        data-strategy-library-detail
        eyebrow={copy.readOnly}
        title={copy.sections.detail.title}
        summary={copy.states.noSelection}
      >
        <ContextNavigation
          compact
          actions={[
            contextAction('factory', {}, { primary: true }),
            contextAction('test'),
            contextAction('paper'),
          ]}
        />
      </OverviewPanel>
    );
  }

  const marketText = row.markets.length ? row.markets.join(', ') : copy.states.noMarket;
  const testText = `${displayNumber(row.tests, copy.emptyValue)} historiska tester · ${displayNumber(row.replayTrades, copy.emptyValue)} affärer`;
  const context = contextFromRow(row);

  return (
    <OverviewPanel
      data-strategy-library-detail
      eyebrow={copy.readOnly}
      title={row.title}
      summary={row.story?.story || copy.sections.detail.summary}
      style={{ position: 'sticky', top: 16 }}
    >
      <div style={{ display: 'grid', gap: 'var(--s4)' }}>
        <StatusBadge tone={row.tone}>{row.status}</StatusBadge>
        <FieldGrid
          items={[
            { label: copy.labels.what, value: row.description },
            { label: copy.labels.development, value: row.story?.detail || row.development },
            { label: copy.labels.tests, value: row.story?.summary || testText },
            { label: copy.labels.markets, value: marketText },
            { label: copy.labels.latestResult, value: row.latestResult, tone: row.resultTone },
            { label: copy.labels.nextStep, value: row.story?.next || row.nextStep },
            { label: copy.labels.learnings, value: row.story?.detail || row.learning },
            { label: copy.labels.version, value: row.version },
            { label: copy.labels.updated, value: formatDateTime(row.time, copy.emptyValue) },
          ]}
        />
        <div>
          <div style={{
            color: 'var(--muted)',
            fontFamily: 'var(--data)',
            fontSize: 9.5,
            letterSpacing: '.16em',
            textTransform: 'uppercase',
            marginBottom: 8,
          }}>
            {copy.sections.lifecycle.title}
          </div>
          <StrategyLifecycleTimeline row={row} copy={copy} />
        </div>
        <ContextNavigation
          compact
          actions={[
            contextAction('test', context, { primary: true }),
            contextAction('paper', context),
            contextAction('decision', context),
            contextAction('factory', context),
          ]}
        />
      </div>
    </OverviewPanel>
  );
}

function StrategyLibraryProductView({ model, selected, selectedId, onSelect }) {
  const copy = model.copy.libraryProduct;
  return (
    <div data-strategy-library-product style={{ display: 'grid', gap: 'var(--s5)' }}>
      <StrategyLibraryOverview model={model} />
      <StrategyAttentionList rows={model.attentionRows} copy={copy} onSelect={onSelect} />
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
        gap: 'var(--s5)',
        alignItems: 'start',
      }}>
        <StrategyLibraryCards rows={model.rows} selectedId={selectedId} onSelect={onSelect} copy={copy} />
        <StrategyLibraryDetail row={selected} copy={copy} />
      </div>
    </div>
  );
}

export default function FactoryExplorerPage({ mode = 'library' }) {
  const data = useFactoryExplorerData();
  const model = useMemo(() => buildModel(mode, data), [mode, data]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState(null);
  const requestedSelectionId = useMemo(
    () => selectedIdFromSearch(model.rows, mode, searchParams),
    [model.rows, mode, searchParams],
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
    params.set(selectionParamForMode(mode), mode === 'replay' ? (row.runId || row.id) : mode === 'market' ? (row.marketId || row.id) : (row.strategyId || row.id));
    setSearchParams(params, { replace: true });
  }, [mode, model.rows, searchParams, setSearchParams]);

  const selected = model.rows.find((row) => row.id === selectedId) || null;
  const copy = model.copy;

  if (mode === 'library') {
    return (
      <DashboardShell title={model.copy.libraryProduct.title} subtitle={model.copy.libraryProduct.subtitle}>
        <StrategyLibraryProductView
          model={model}
          selected={selected}
          selectedId={selectedId}
          onSelect={handleSelect}
        />
      </DashboardShell>
    );
  }

  if (mode === 'replay') {
    return (
      <DashboardShell title={model.copy.historicalTestsProduct.title} subtitle={model.copy.historicalTestsProduct.subtitle}>
        <HistoricalTestsProductView
          model={model}
          selected={selected}
          selectedId={selectedId}
          onSelect={handleSelect}
        />
      </DashboardShell>
    );
  }

  return (
    <DashboardShell title={model.modeCopy.title} subtitle={model.modeCopy.subtitle}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--s3)', marginBottom: 'var(--s5)' }}>
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 'var(--s5)', alignItems: 'start' }}>
        <OverviewPanel
          eyebrow={copy.readOnly}
          title={model.modeCopy.title}
          summary={model.modeCopy.summary}
          style={{ display: 'grid', gap: 'var(--s4)' }}
        >
          <FieldGrid
            items={[
              { label: copy.labels.status, value: model.rows.length ? uiStatus(FACTORY_STATUS_KEYS.COMPLETED) : uiStatus(FACTORY_STATUS_KEYS.WAITING), tone: model.rows.length ? 'success' : 'neutral' },
              { label: copy.labels.latest, value: model.latest ? formatDateTime(model.latest.time, copy.emptyValue) : copy.states.empty },
              { label: copy.labels.source, value: `${model.sources.available}/${model.sources.total}` },
              { label: copy.labels.details, value: model.sources.missing ? copy.states.missing : copy.states.complete, tone: model.sources.missing ? 'warning' : 'success' },
            ]}
          />
          <ExplorerList rows={model.rows} selectedId={selectedId} onSelect={handleSelect} copy={copy} />
        </OverviewPanel>

        <OverviewPanel
          eyebrow={copy.readOnly}
          title={copy.labels.selected}
          summary={selected ? selected.summary : copy.states.noSelection}
          style={{ display: 'grid', gap: 'var(--s4)' }}
        >
          <FieldGrid items={selected?.fields || [{ label: copy.labels.details, value: copy.states.noSelection }]} />
          <ContextNavigation compact actions={genericContextActions(mode, selected)} />
        </OverviewPanel>
      </div>
    </DashboardShell>
  );
}
