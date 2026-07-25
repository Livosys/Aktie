import { hasValue } from '../utils/tradingFormatters.js';
import { normalizeStrategyId } from '../models/strategyViewModel.js';
import {
  TRADING_EVENT_TYPES,
  firstEventValue,
  normalizeTradingEvent,
  normalizeTradingEventType,
  tradingEventKey,
} from '../models/tradingEventModel.js';

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function payloadOf(entry) {
  if (!entry) return null;
  if (entry.ok === true && isPlainObject(entry.data)) return entry.data;
  if (isPlainObject(entry.data) && !Object.prototype.hasOwnProperty.call(entry, 'ok')) return entry.data;
  return entry;
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function isEventLikeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [
    value.eventId,
    value.event_id,
    value.id,
    value.type,
    value.eventType,
    value.event_type,
    value.event,
    value.timestamp,
    value.createdAt,
    value.updatedAt,
    value.startedAt,
    value.completedAt,
    value.candidateId,
    value.candidate_id,
    value.orderId,
    value.ibOrderId,
    value.orderRef,
    value.execId,
    value.executionId,
    value.positionId,
    value.tradeId,
    value.strategyId,
    value.strategy_id,
    value.status,
    value.state,
  ].some(hasValue);
}

function sourceArray(...values) {
  return values.flatMap((value) => {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (isEventLikeObject(value)) return [value];
    return [];
  });
}

function eventTimeMs(event = {}) {
  const ms = Date.parse(event.timestamp || '');
  return Number.isFinite(ms) ? ms : null;
}

function textKey(value) {
  return hasValue(value) ? String(value) : null;
}

function statusToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function explicitStrategyId(row = {}) {
  return normalizeStrategyId(
    row.strategyId,
    row.strategy_id,
    row.canonicalStrategyId,
    row.canonical_strategy_id,
    row.resolvedStrategyId,
    row.resolved_strategy_id,
    row.sourceStrategyId,
    row.source_strategy_id,
    row.strategy?.strategyId,
    row.strategy?.strategy_id,
    row.strategyViewModel?.strategyId,
  );
}

function resolvedStrategyId(row = {}, strategyStore = null) {
  const explicit = explicitStrategyId(row);
  if (explicit) return String(explicit);
  if (!strategyStore || typeof strategyStore.resolveStrategy !== 'function') return null;
  const strategy = strategyStore.resolveStrategy(row);
  return strategy?.strategyId ? String(strategy.strategyId) : null;
}

function orderLifecycleFromStatus(row = {}) {
  const raw = statusToken(firstEventValue(row.status, row.state, row.ibStatus, row.lifecycleStatus));
  if (!raw) return null;
  if (['intent_created', 'guard_passed', 'shadow_logged', 'pending', 'api_pending', 'presubmitted', 'pre_submitted'].includes(raw)) return 'pending';
  if (['submit_started', 'submitted'].includes(raw)) return 'submitted';
  if (['acknowledged', 'accepted', 'api_accepted'].includes(raw)) return 'accepted';
  if (['working', 'open', 'active'].includes(raw)) return 'working';
  if (['partiallyfilled', 'partially_filled', 'partial'].includes(raw)) return 'partially_filled';
  if (['filled', 'complete', 'completed'].includes(raw)) return 'filled';
  if (['cancelled', 'canceled', 'inactive', 'expired'].includes(raw)) return 'cancelled';
  if (['rejected', 'error', 'failed'].includes(raw)) return 'rejected';
  return null;
}

function orderEventType(row = {}) {
  const lifecycle = orderLifecycleFromStatus(row);
  const byLifecycle = {
    pending: TRADING_EVENT_TYPES.ORDER_PENDING,
    submitted: TRADING_EVENT_TYPES.ORDER_SUBMITTED,
    accepted: TRADING_EVENT_TYPES.ORDER_ACCEPTED,
    working: TRADING_EVENT_TYPES.ORDER_WORKING,
    partially_filled: TRADING_EVENT_TYPES.ORDER_PARTIALLY_FILLED,
    filled: TRADING_EVENT_TYPES.ORDER_FILLED,
    cancelled: TRADING_EVENT_TYPES.ORDER_CANCELLED,
    rejected: TRADING_EVENT_TYPES.ORDER_REJECTED,
  };
  return byLifecycle[lifecycle] || TRADING_EVENT_TYPES.ORDER;
}

function candidateEventType(row = {}) {
  const status = statusToken(firstEventValue(row.status, row.state, row.riskStatus, row.approvalStatus));
  if (row.blocked === true || status.includes('blocked')) return TRADING_EVENT_TYPES.CANDIDATE_BLOCKED;
  if (firstEventValue(row.createdAt, row.signalTimestamp, row.timestamp)) return TRADING_EVENT_TYPES.CANDIDATE_CREATED;
  return TRADING_EVENT_TYPES.CANDIDATE;
}

function riskEventType(row = {}) {
  const status = statusToken(firstEventValue(row.status, row.state, row.code, row.reason, row.blockedReason));
  return status.includes('block') ? TRADING_EVENT_TYPES.RISK_BLOCKED : TRADING_EVENT_TYPES.RISK_STATE;
}

function addEvent(events, row, {
  eventType = null,
  source = null,
  status = null,
  metadata = {},
  strategyStore = null,
} = {}) {
  if (!row || typeof row !== 'object') return;
  const strategyId = resolvedStrategyId(row, strategyStore);
  const event = normalizeTradingEvent(
    strategyId ? { ...row, strategyId } : row,
    {
      eventType,
      source,
      status,
      metadata,
    },
  );
  if (!event.eventId && !event.timestamp && !event.source) return;
  events.push(event);
}

function addRows(events, rows, options = {}) {
  rows.forEach((row, index) => addEvent(events, row, {
    ...options,
    metadata: {
      ...(options.metadata || {}),
      index,
    },
  }));
}

function dedupeAndSort(events = []) {
  const keyed = new Map();
  events.forEach((event, index) => {
    const key = tradingEventKey(event, index);
    if (!key || keyed.has(key)) return;
    keyed.set(key, {
      ...event,
      metadata: {
        ...(event.metadata || {}),
        storeIndex: index,
      },
    });
  });
  return Array.from(keyed.values()).sort((a, b) => {
    const aTime = eventTimeMs(a);
    const bTime = eventTimeMs(b);
    if (aTime != null && bTime != null && aTime !== bTime) return bTime - aTime;
    if (aTime != null && bTime == null) return -1;
    if (aTime == null && bTime != null) return 1;
    return (a.metadata?.storeIndex ?? 0) - (b.metadata?.storeIndex ?? 0);
  });
}

function addRuntimeEvents(events, {
  runtime = {},
  execution = {},
  candidateQueue = {},
  candidates = [],
  strategyOverview = [],
  strategyStatus = [],
  strategyPulse = [],
  reconciliation = {},
  strategyStore = null,
} = {}) {
  const runtimeCandidateQueue = runtime.candidateQueue || {};
  const resolvedReconciliation = isPlainObject(reconciliation) && Object.keys(reconciliation).length
    ? reconciliation
    : (runtime.brokerReconciliation || execution.reconciliation || {});

  addRows(events, sourceArray(strategyOverview, runtime.strategyOverview), {
    eventType: TRADING_EVENT_TYPES.STRATEGY,
    source: 'strategyOverview',
    strategyStore,
    metadata: { path: 'strategyOverview' },
  });
  addRows(events, sourceArray(strategyStatus, runtime.strategyStatus), {
    eventType: TRADING_EVENT_TYPES.STRATEGY_RUNTIME,
    source: 'strategyStatus',
    strategyStore,
    metadata: { path: 'strategyStatus' },
  });
  addRows(events, sourceArray(strategyPulse, runtime.strategyPulse), {
    eventType: TRADING_EVENT_TYPES.STRATEGY_SIGNAL,
    source: 'strategyPulse',
    strategyStore,
    metadata: { path: 'strategyPulse' },
  });
  sourceArray(candidates, candidateQueue.candidates, runtimeCandidateQueue.candidates).forEach((row, index) => addEvent(events, row, {
    eventType: candidateEventType(row),
    source: 'candidateQueue',
    strategyStore,
    metadata: { path: 'candidateQueue.candidates', index, canonicalizedBy: 'candidateEventType' },
  }));
  addRows(events, list(runtime.scanHistory), {
    eventType: TRADING_EVENT_TYPES.SCANNER_COMPLETED,
    source: 'scanHistory',
    strategyStore,
    metadata: { path: 'scanHistory' },
  });
  list(runtime.statusReasons).forEach((row, index) => addEvent(events, row, {
    eventType: riskEventType(row),
    source: 'statusReasons',
    strategyStore,
    metadata: { path: 'statusReasons', index, canonicalizedBy: 'riskEventType' },
  }));
  addRows(events, sourceArray(runtime.quotes, execution.quotes), {
    eventType: TRADING_EVENT_TYPES.MARKET_QUOTE,
    source: 'quotes',
    metadata: { path: 'quotes' },
  });
  sourceArray(runtime.brokerOrders, execution.brokerOrders, resolvedReconciliation.openOrders).forEach((row, index) => addEvent(events, row, {
    eventType: orderEventType(row),
    source: 'brokerOrders',
    strategyStore,
    metadata: { path: 'brokerOrders', index, canonicalizedBy: 'orderEventType' },
  }));
  sourceArray(runtime.brokerOrderStatuses, execution.brokerOrderStatuses, resolvedReconciliation.orderStatuses).forEach((row, index) => addEvent(events, row, {
    eventType: orderEventType(row),
    source: 'brokerOrderStatuses',
    strategyStore,
    metadata: { path: 'brokerOrderStatuses', index, canonicalizedBy: 'orderEventType' },
  }));
  addRows(events, sourceArray(runtime.brokerFills, runtime.brokerExecutions, execution.brokerFills, execution.brokerExecutions, resolvedReconciliation.executions, resolvedReconciliation.fills), {
    eventType: TRADING_EVENT_TYPES.FILL,
    source: 'brokerFills',
    strategyStore,
    metadata: { path: 'brokerFills' },
  });
  addRows(events, sourceArray(runtime.brokerPositions, execution.brokerPositions, resolvedReconciliation.positions), {
    eventType: TRADING_EVENT_TYPES.POSITION,
    source: 'brokerPositions',
    strategyStore,
    metadata: { path: 'brokerPositions' },
  });
  addRows(events, sourceArray(runtime.trades, runtime.paperTrades, runtime.closedTrades, runtime.recentTrades, execution.trades), {
    eventType: TRADING_EVENT_TYPES.TRADE,
    source: 'trades',
    strategyStore,
    metadata: { path: 'trades' },
  });
  addRows(events, list(resolvedReconciliation.intents), {
    eventType: TRADING_EVENT_TYPES.ORDER,
    source: 'brokerReconciliation.intents',
    strategyStore,
    metadata: { path: 'brokerReconciliation.intents' },
  });
  addRows(events, list(resolvedReconciliation.discrepancies), {
    eventType: TRADING_EVENT_TYPES.AUDIT,
    source: 'brokerReconciliation.discrepancies',
    strategyStore,
    metadata: { path: 'brokerReconciliation.discrepancies' },
  });
}

function addSupervisorEvents(events, {
  supervisorSnapshot = {},
  liveActivity = null,
  replaySnapshot = {},
  batchSnapshot = {},
  automationPlan = null,
  aiLatest = null,
  strategyStore = null,
} = {}) {
  const supervisor = payloadOf(supervisorSnapshot) || {};
  const activity = payloadOf(liveActivity) || supervisor.liveActivity || {};
  const replay = payloadOf(replaySnapshot) || {};
  const batches = payloadOf(batchSnapshot) || {};
  const plan = payloadOf(automationPlan) || {};
  const ai = payloadOf(aiLatest) || {};
  const liveRows = sourceArray(activity.latestEvents, activity.events, activity.recentEvents, supervisor.latestEvents, supervisor.events);
  addRows(events, liveRows, {
    eventType: null,
    source: 'supervisor.liveActivity',
    strategyStore,
    metadata: { path: 'supervisor.liveActivity' },
  });
  addRows(events, sourceArray(supervisor.nextRecommendedActions, supervisor.actionPlan, plan.nextRecommendedActions, plan.actionPlan), {
    eventType: TRADING_EVENT_TYPES.SUPERVISOR_RECOMMENDATION,
    source: 'supervisor.recommendations',
    strategyStore,
    metadata: { path: 'supervisor.recommendations' },
  });
  addRows(events, sourceArray(replay.recentReplays, replay.runs, replay.history, replay.latestReplay), {
    eventType: TRADING_EVENT_TYPES.REPLAY,
    source: 'replay',
    strategyStore,
    metadata: { path: 'replay' },
  });
  addRows(events, sourceArray(batches.recentBatches, batches.batches, batches.runs, batches.latestBatch), {
    eventType: TRADING_EVENT_TYPES.BATCH,
    source: 'batch',
    strategyStore,
    metadata: { path: 'batch' },
  });
  addRows(events, sourceArray(ai.events, ai.latestEvents, ai.recommendations, ai.nextRecommendedActions), {
    eventType: TRADING_EVENT_TYPES.AI,
    source: 'aiLatest',
    strategyStore,
    metadata: { path: 'aiLatest' },
  });
}

function addAiEvents(events, aiSources = {}, strategyStore = null) {
  for (const [key, entry] of Object.entries(aiSources || {})) {
    const payload = payloadOf(entry);
    if (!payload || typeof payload !== 'object') continue;
    addRows(events, sourceArray(
      payload.events,
      payload.latestEvents,
      payload.recommendations,
      payload.nextRecommendedActions,
      payload.actionPlan,
      payload.summary?.events,
      payload.summary?.recommendations,
    ), {
      eventType: normalizeTradingEventType(key) === TRADING_EVENT_TYPES.UNKNOWN ? TRADING_EVENT_TYPES.AI : null,
      source: `ai.${key}`,
      strategyStore,
      metadata: { path: `aiSources.${key}` },
    });
    addRows(events, sourceArray(
      payload.recommendedNextTest,
      payload.autopilot?.recommendedNextTest,
      payload.autopilot?.lastEvent,
      payload.latest,
    ), {
      eventType: TRADING_EVENT_TYPES.AI,
      source: `ai.${key}`,
      strategyStore,
      metadata: { path: `aiSources.${key}.latest` },
    });
  }
}

function addAnalyticsEvents(events, analyticsSnapshot = {}, strategyStore = null) {
  const analytics = payloadOf(analyticsSnapshot) || {};
  addRows(events, sourceArray(
    analytics.events,
    analytics.history,
    analytics.recentEvents,
    analytics.strategyEvents,
  ), {
    eventType: TRADING_EVENT_TYPES.ANALYTICS,
    source: 'analytics',
    strategyStore,
    metadata: { path: 'analytics' },
  });
}

function buildEvents(sources = {}) {
  const runtime = payloadOf(sources.runtimeSnapshot) || {};
  const execution = payloadOf(sources.executionSnapshot) || {};
  const events = [];
  addRuntimeEvents(events, {
    runtime,
    execution,
    candidateQueue: sources.candidateQueue || runtime.candidateQueue || {},
    candidates: sources.candidates || [],
    strategyOverview: sources.strategyOverview || [],
    strategyStatus: sources.strategyStatus || [],
    strategyPulse: sources.strategyPulse || [],
    reconciliation: sources.reconciliation || {},
    strategyStore: sources.strategyStore || null,
  });
  addSupervisorEvents(events, {
    supervisorSnapshot: sources.supervisorSnapshot || sources.overview || {},
    liveActivity: sources.liveActivity || null,
    replaySnapshot: sources.replaySnapshot || sources.replay || {},
    batchSnapshot: sources.batchSnapshot || sources.batches || {},
    automationPlan: sources.automationPlan || null,
    aiLatest: sources.aiLatest || null,
    strategyStore: sources.strategyStore || null,
  });
  addAiEvents(events, sources.aiSources || {}, sources.strategyStore || null);
  addAnalyticsEvents(events, sources.analyticsSnapshot || sources.analytics || {}, sources.strategyStore || null);
  addRows(events, list(sources.events), {
    eventType: null,
    source: 'events',
    strategyStore: sources.strategyStore || null,
    metadata: { path: 'events' },
  });
  return dedupeAndSort(events);
}

function groupBy(events = [], getKey) {
  const map = new Map();
  for (const event of events) {
    const key = textKey(getKey(event));
    if (!key) continue;
    const rows = map.get(key) || [];
    rows.push(event);
    map.set(key, rows);
  }
  return map;
}

function limitRows(rows = [], limit = null) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 0) return rows;
  return rows.slice(0, n);
}

export function createTradingEventStore(sources = {}) {
  const events = buildEvents(sources);
  const eventById = new Map();
  events.forEach((event, index) => {
    const key = tradingEventKey(event, index);
    if (key) eventById.set(String(key), event);
  });
  const byType = groupBy(events, (event) => event.eventType);
  const byStrategy = groupBy(events, (event) => event.strategyId);
  const byCandidate = groupBy(events, (event) => event.candidateId);
  const byOrder = groupBy(events, (event) => event.orderId);
  const byExecution = groupBy(events, (event) => event.executionId);
  const byPosition = groupBy(events, (event) => event.positionId);
  const byTrade = groupBy(events, (event) => event.tradeId);
  const bySource = groupBy(events, (event) => event.source);

  return {
    __tradingEventStore: true,
    getAllEvents() {
      return events;
    },
    getEvent(id) {
      const key = textKey(id);
      return key ? eventById.get(key) || null : null;
    },
    getEventsByType(type) {
      return byType.get(normalizeTradingEventType(type)) || [];
    },
    getEventsByStrategy(strategyId) {
      const key = textKey(strategyId);
      return key ? byStrategy.get(key) || [] : [];
    },
    getEventsByCandidate(candidateId) {
      const key = textKey(candidateId);
      return key ? byCandidate.get(key) || [] : [];
    },
    getEventsByOrder(orderId) {
      const key = textKey(orderId);
      return key ? byOrder.get(key) || [] : [];
    },
    getEventsByExecution(executionId) {
      const key = textKey(executionId);
      return key ? byExecution.get(key) || [] : [];
    },
    getEventsByPosition(positionId) {
      const key = textKey(positionId);
      return key ? byPosition.get(key) || [] : [];
    },
    getEventsByTrade(tradeId) {
      const key = textKey(tradeId);
      return key ? byTrade.get(key) || [] : [];
    },
    getEventsBySource(source) {
      const key = textKey(source);
      return key ? bySource.get(key) || [] : [];
    },
    getLatestEvents(limit = null) {
      return limitRows(events, limit);
    },
    getEventCountsByType() {
      return new Map(Array.from(byType.entries()).map(([type, rows]) => [type, rows.length]));
    },
    resolveEvent(source = {}, options = {}) {
      const strategyId = resolvedStrategyId(source, sources.strategyStore || null);
      return normalizeTradingEvent(strategyId ? { ...source, strategyId } : source, options);
    },
  };
}

export const EMPTY_TRADING_EVENT_STORE = Object.freeze({
  __tradingEventStore: true,
  getAllEvents: () => [],
  getEvent: () => null,
  getEventsByType: () => [],
  getEventsByStrategy: () => [],
  getEventsByCandidate: () => [],
  getEventsByOrder: () => [],
  getEventsByExecution: () => [],
  getEventsByPosition: () => [],
  getEventsByTrade: () => [],
  getEventsBySource: () => [],
  getLatestEvents: () => [],
  getEventCountsByType: () => new Map(),
  resolveEvent: (source = {}, options = {}) => normalizeTradingEvent(source, options),
});
