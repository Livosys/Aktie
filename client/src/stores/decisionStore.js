import { hasValue } from '../utils/tradingFormatters.js';
import {
  DECISION_TYPES,
  decisionModelKey,
  normalizeDecision,
} from '../models/decisionModel.js';
import {
  EMPTY_TRADING_EVENT_STORE,
  createTradingEventStore,
} from './tradingEventStore.js';

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

function sourceArray(...values) {
  return values.flatMap((value) => {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (value && typeof value === 'object') return [value];
    return [];
  });
}

function textKey(value) {
  return hasValue(value) ? String(value) : null;
}

function normalizedText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function timeMs(decision = {}) {
  const ms = Date.parse(decision.timestamp || '');
  return Number.isFinite(ms) ? ms : null;
}

function nonEmptyValue(value) {
  if (!hasValue(value)) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

export function mergeDecision(base = null, next = null) {
  if (!base) return next;
  if (!next) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (key === 'metadata') continue;
    if (nonEmptyValue(value)) merged[key] = value;
  }
  return {
    ...merged,
    metadata: {
      ...(base.metadata || {}),
      ...(next.metadata || {}),
    },
  };
}

function addDecision(decisions, row, options = {}) {
  const decision = normalizeDecision(row, options);
  if (!decision || !decision.decisionId) return;
  decisions.push(decision);
}

function addDecisionRows(decisions, rows, options = {}) {
  rows.forEach((row, index) => addDecision(decisions, row, {
    ...options,
    metadata: {
      ...(options.metadata || {}),
      index,
    },
  }));
}

function explicitDecisionRowsFromSnapshot(snapshot = {}) {
  const source = payloadOf(snapshot) || {};
  return sourceArray(
    source.decisions,
    source.decisionLog,
    source.decision_log,
    source.recommendations,
    source.nextRecommendedActions,
    source.actionPlan,
    source.approvals,
    source.rejections,
    source.blockedDecisions,
    source.riskDecisions,
    source.supervisorDecisions,
    source.executionDecisions,
    source.learningRecommendations,
    source.strategyResearch?.recommendations,
    source.autopilot?.recommendedNextTest,
    source.autopilot?.lastEvent,
    source.recommendedNextTest,
  );
}

function addExplicitDecisionRows(decisions, sources = {}) {
  addDecisionRows(decisions, sourceArray(sources.decisions), {
    metadata: { path: 'decisions' },
  });

  for (const [key, snapshot] of Object.entries({
    runtimeSnapshot: sources.runtimeSnapshot,
    executionSnapshot: sources.executionSnapshot,
    supervisorSnapshot: sources.supervisorSnapshot || sources.overview,
    analyticsSnapshot: sources.analyticsSnapshot || sources.analytics,
    replaySnapshot: sources.replaySnapshot || sources.replay,
    batchSnapshot: sources.batchSnapshot || sources.batches,
  })) {
    addDecisionRows(decisions, explicitDecisionRowsFromSnapshot(snapshot), {
      decisionSource: key,
      metadata: { path: key },
    });
  }

  for (const [key, entry] of Object.entries(sources.aiSources || {})) {
    addDecisionRows(decisions, explicitDecisionRowsFromSnapshot(entry), {
      decisionType: DECISION_TYPES.AI_RECOMMENDATION,
      decisionSource: `ai.${key}`,
      metadata: { path: `aiSources.${key}` },
    });
  }
}

function addEventDecisions(decisions, eventStore = EMPTY_TRADING_EVENT_STORE) {
  eventStore.getAllEvents().forEach((event, index) => {
    addDecision(decisions, event, {
      event,
      metadata: {
        path: 'TradingEventStore',
        eventStoreIndex: index,
      },
    });
  });
}

function dedupeAndSort(decisions = []) {
  const byId = new Map();
  decisions.forEach((decision, index) => {
    const key = decisionModelKey(decision, `decision_${index}`);
    const stored = byId.get(key);
    byId.set(key, mergeDecision(stored, {
      ...decision,
      metadata: {
        ...(decision.metadata || {}),
        storeIndex: index,
      },
    }));
  });
  return Array.from(byId.values()).sort((a, b) => {
    const aTime = timeMs(a);
    const bTime = timeMs(b);
    if (aTime != null && bTime != null && aTime !== bTime) return bTime - aTime;
    if (aTime != null && bTime == null) return -1;
    if (aTime == null && bTime != null) return 1;
    return (a.metadata?.storeIndex ?? 0) - (b.metadata?.storeIndex ?? 0);
  });
}

function buildDecisionRows(sources = {}) {
  const eventStore = sources.eventStore || createTradingEventStore(sources);
  const decisions = [];
  addExplicitDecisionRows(decisions, sources);
  addEventDecisions(decisions, eventStore);
  return dedupeAndSort(decisions);
}

function groupBy(decisions = [], getKey) {
  const map = new Map();
  for (const decision of decisions) {
    const key = textKey(getKey(decision));
    if (!key) continue;
    const rows = map.get(key) || [];
    rows.push(decision);
    map.set(key, rows);
  }
  return map;
}

function latest(rows = []) {
  return rows[0] || null;
}

function stateMatches(decision = {}, values = []) {
  const text = normalizedText(decision.decisionState || decision.status || decision.reason || decision.decisionType);
  return values.some((value) => text === value || text.includes(value));
}

function isApprovedDecision(decision = {}) {
  return stateMatches(decision, ['approved', 'accepted', 'allow', 'passed', 'ok', 'ready'])
    || [DECISION_TYPES.SUPERVISOR_APPROVAL, DECISION_TYPES.RISK_APPROVAL, DECISION_TYPES.RISK_RESUME].includes(decision.decisionType);
}

function isRejectedDecision(decision = {}) {
  return stateMatches(decision, ['rejected', 'reject', 'denied', 'failed', 'not_approved'])
    || [DECISION_TYPES.SUPERVISOR_REJECT, DECISION_TYPES.RISK_REJECT].includes(decision.decisionType);
}

function isBlockedDecision(decision = {}) {
  return stateMatches(decision, ['blocked', 'block', 'paused', 'pause'])
    || Boolean(decision.blockedBy)
    || [DECISION_TYPES.RISK_PAUSE, DECISION_TYPES.RISK_REJECT].includes(decision.decisionType);
}

function filterByType(decisions = [], types = []) {
  const allowed = new Set(types);
  return decisions.filter((decision) => allowed.has(decision.decisionType));
}

function filterTimeline(decisions = [], filters = {}) {
  return decisions.filter((decision) => {
    if (hasValue(filters.decisionType) && decision.decisionType !== filters.decisionType) return false;
    if (hasValue(filters.strategyId) && String(decision.strategyId) !== String(filters.strategyId)) return false;
    if (hasValue(filters.candidateId) && String(decision.candidateId) !== String(filters.candidateId)) return false;
    if (hasValue(filters.orderId) && String(decision.orderId) !== String(filters.orderId)) return false;
    if (hasValue(filters.positionId) && String(decision.positionId) !== String(filters.positionId)) return false;
    if (hasValue(filters.tradeId) && String(decision.tradeId) !== String(filters.tradeId)) return false;
    if (hasValue(filters.source) && String(decision.source || decision.decisionSource) !== String(filters.source)) return false;
    return true;
  });
}

export function createDecisionStore(sources = {}) {
  const eventStore = sources.eventStore || createTradingEventStore(sources);
  const decisions = buildDecisionRows({ ...sources, eventStore });
  const byId = new Map(decisions.map((decision, index) => [decisionModelKey(decision, `decision_${index}`), decision]));
  const byStrategy = groupBy(decisions, (decision) => decision.strategyId);
  const byTrade = groupBy(decisions, (decision) => decision.tradeId);
  const byPosition = groupBy(decisions, (decision) => decision.positionId);
  const byOrder = groupBy(decisions, (decision) => decision.orderId);
  const byCandidate = groupBy(decisions, (decision) => decision.candidateId);
  const byEvent = groupBy(decisions, (decision) => decision.eventId);

  return {
    __decisionStore: true,
    eventStore,
    normalizeDecision(source = {}, options = {}) {
      return normalizeDecision(source, options);
    },
    mergeDecision,
    resolveDecision(source = {}, options = {}) {
      return normalizeDecision(source, options);
    },
    getDecision(id) {
      const key = textKey(id);
      return key ? byId.get(key) || null : null;
    },
    getLatestDecision() {
      return latest(decisions);
    },
    getLatestDecisionByStrategy(strategyId) {
      const key = textKey(strategyId);
      return key ? latest(byStrategy.get(key) || []) : null;
    },
    getLatestDecisionByTrade(tradeId) {
      const key = textKey(tradeId);
      return key ? latest(byTrade.get(key) || []) : null;
    },
    getLatestDecisionByPosition(positionId) {
      const key = textKey(positionId);
      return key ? latest(byPosition.get(key) || []) : null;
    },
    getLatestDecisionByOrder(orderId) {
      const key = textKey(orderId);
      return key ? latest(byOrder.get(key) || []) : null;
    },
    getLatestDecisionByCandidate(candidateId) {
      const key = textKey(candidateId);
      return key ? latest(byCandidate.get(key) || []) : null;
    },
    getLatestDecisionByEvent(eventId) {
      const key = textKey(eventId);
      return key ? latest(byEvent.get(key) || []) : null;
    },
    getDecisions(filters = {}) {
      return filterTimeline(decisions, filters);
    },
    getDecisionTimeline(filters = {}) {
      return filterTimeline(decisions, filters);
    },
    getBlockedDecisions() {
      return decisions.filter(isBlockedDecision);
    },
    getApprovedDecisions() {
      return decisions.filter(isApprovedDecision);
    },
    getRejectedDecisions() {
      return decisions.filter(isRejectedDecision);
    },
    getLearningDecisions() {
      return filterByType(decisions, [DECISION_TYPES.LEARNING_RECOMMENDATION]);
    },
    getReplayDecisions() {
      return filterByType(decisions, [DECISION_TYPES.REPLAY_DECISION]);
    },
    getDecisionsByStrategy(strategyId) {
      const key = textKey(strategyId);
      return key ? byStrategy.get(key) || [] : [];
    },
    getDecisionsByTrade(tradeId) {
      const key = textKey(tradeId);
      return key ? byTrade.get(key) || [] : [];
    },
    getDecisionsByPosition(positionId) {
      const key = textKey(positionId);
      return key ? byPosition.get(key) || [] : [];
    },
    getDecisionsByOrder(orderId) {
      const key = textKey(orderId);
      return key ? byOrder.get(key) || [] : [];
    },
    getDecisionsByCandidate(candidateId) {
      const key = textKey(candidateId);
      return key ? byCandidate.get(key) || [] : [];
    },
  };
}

export const EMPTY_DECISION_STORE = Object.freeze({
  __decisionStore: true,
  eventStore: EMPTY_TRADING_EVENT_STORE,
  normalizeDecision: (source = {}, options = {}) => normalizeDecision(source, options),
  mergeDecision,
  resolveDecision: (source = {}, options = {}) => normalizeDecision(source, options),
  getDecision: () => null,
  getLatestDecision: () => null,
  getLatestDecisionByStrategy: () => null,
  getLatestDecisionByTrade: () => null,
  getLatestDecisionByPosition: () => null,
  getLatestDecisionByOrder: () => null,
  getLatestDecisionByCandidate: () => null,
  getLatestDecisionByEvent: () => null,
  getDecisions: () => [],
  getDecisionTimeline: () => [],
  getBlockedDecisions: () => [],
  getApprovedDecisions: () => [],
  getRejectedDecisions: () => [],
  getLearningDecisions: () => [],
  getReplayDecisions: () => [],
  getDecisionsByStrategy: () => [],
  getDecisionsByTrade: () => [],
  getDecisionsByPosition: () => [],
  getDecisionsByOrder: () => [],
  getDecisionsByCandidate: () => [],
});
