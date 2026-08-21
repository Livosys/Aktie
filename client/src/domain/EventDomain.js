import { hasValue } from '../utils/tradingFormatters.js';
import {
  TRADING_EVENT_TYPES,
  normalizeTradingEvent,
  normalizeTradingEventType,
} from '../models/tradingEventModel.js';
import { normalizedText, statusTone } from './StrategyDomain.js';
import { FACTORY_TERM_KEYS, uiName } from '../services/uiTerminologyService.js';

export const EVENT_LIFECYCLE_GROUPS = Object.freeze({
  market: [
    TRADING_EVENT_TYPES.MARKET,
    TRADING_EVENT_TYPES.MARKET_QUOTE,
    TRADING_EVENT_TYPES.MARKET_SESSION,
  ],
  scanner: [
    TRADING_EVENT_TYPES.SCANNER,
    TRADING_EVENT_TYPES.SCANNER_STARTED,
    TRADING_EVENT_TYPES.SCANNER_COMPLETED,
  ],
  strategy: [
    TRADING_EVENT_TYPES.STRATEGY,
    TRADING_EVENT_TYPES.STRATEGY_RUNTIME,
    TRADING_EVENT_TYPES.STRATEGY_SIGNAL,
  ],
  candidate: [
    TRADING_EVENT_TYPES.CANDIDATE,
    TRADING_EVENT_TYPES.CANDIDATE_CREATED,
    TRADING_EVENT_TYPES.CANDIDATE_BLOCKED,
  ],
  supervisor: [
    TRADING_EVENT_TYPES.SUPERVISOR,
    TRADING_EVENT_TYPES.SUPERVISOR_STATUS,
    TRADING_EVENT_TYPES.SUPERVISOR_RECOMMENDATION,
  ],
  risk: [
    TRADING_EVENT_TYPES.RISK,
    TRADING_EVENT_TYPES.RISK_STATE,
    TRADING_EVENT_TYPES.RISK_BLOCKED,
  ],
  approval: [
    TRADING_EVENT_TYPES.APPROVAL,
    TRADING_EVENT_TYPES.APPROVAL_STATE,
  ],
  order: [
    TRADING_EVENT_TYPES.ORDER,
    TRADING_EVENT_TYPES.ORDER_PENDING,
    TRADING_EVENT_TYPES.ORDER_SUBMITTED,
    TRADING_EVENT_TYPES.ORDER_ACCEPTED,
    TRADING_EVENT_TYPES.ORDER_WORKING,
    TRADING_EVENT_TYPES.ORDER_PARTIALLY_FILLED,
    TRADING_EVENT_TYPES.ORDER_FILLED,
    TRADING_EVENT_TYPES.ORDER_CANCELLED,
    TRADING_EVENT_TYPES.ORDER_REJECTED,
  ],
  execution: [
    TRADING_EVENT_TYPES.EXECUTION,
    TRADING_EVENT_TYPES.FILL,
  ],
  position: [TRADING_EVENT_TYPES.POSITION],
  trade: [TRADING_EVENT_TYPES.TRADE],
  learning: [TRADING_EVENT_TYPES.LEARNING],
  analytics: [TRADING_EVENT_TYPES.ANALYTICS],
  replay: [TRADING_EVENT_TYPES.REPLAY],
  batch: [TRADING_EVENT_TYPES.BATCH],
  ai: [TRADING_EVENT_TYPES.AI],
  history: [TRADING_EVENT_TYPES.HISTORY],
  audit: [TRADING_EVENT_TYPES.AUDIT],
});

const EVENT_TYPE_LABELS = Object.freeze({
  [TRADING_EVENT_TYPES.MARKET]: 'Market',
  [TRADING_EVENT_TYPES.MARKET_QUOTE]: 'Market Quote',
  [TRADING_EVENT_TYPES.MARKET_SESSION]: 'Market Session',
  [TRADING_EVENT_TYPES.SCANNER]: 'Scanner',
  [TRADING_EVENT_TYPES.SCANNER_STARTED]: 'Scanner Started',
  [TRADING_EVENT_TYPES.SCANNER_COMPLETED]: 'Scanner Completed',
  [TRADING_EVENT_TYPES.CANDIDATE]: uiName(FACTORY_TERM_KEYS.CANDIDATE),
  [TRADING_EVENT_TYPES.CANDIDATE_CREATED]: uiName(FACTORY_TERM_KEYS.CANDIDATE),
  [TRADING_EVENT_TYPES.CANDIDATE_BLOCKED]: uiName(FACTORY_TERM_KEYS.CANDIDATE),
  [TRADING_EVENT_TYPES.STRATEGY]: 'Strategy',
  [TRADING_EVENT_TYPES.STRATEGY_RUNTIME]: uiName(FACTORY_TERM_KEYS.STRATEGY_RUNTIME),
  [TRADING_EVENT_TYPES.STRATEGY_SIGNAL]: 'Strategy Signal',
  [TRADING_EVENT_TYPES.SUPERVISOR]: 'Supervisor',
  [TRADING_EVENT_TYPES.SUPERVISOR_STATUS]: 'Supervisor Status',
  [TRADING_EVENT_TYPES.SUPERVISOR_RECOMMENDATION]: 'Supervisor Recommendation',
  [TRADING_EVENT_TYPES.RISK]: 'Risk',
  [TRADING_EVENT_TYPES.RISK_STATE]: 'Risk State',
  [TRADING_EVENT_TYPES.RISK_BLOCKED]: 'Risk Blocked',
  [TRADING_EVENT_TYPES.APPROVAL]: uiName(FACTORY_TERM_KEYS.APPROVAL),
  [TRADING_EVENT_TYPES.APPROVAL_STATE]: uiName(FACTORY_TERM_KEYS.APPROVAL),
  [TRADING_EVENT_TYPES.ORDER]: 'Order',
  [TRADING_EVENT_TYPES.ORDER_PENDING]: 'Order Pending',
  [TRADING_EVENT_TYPES.ORDER_SUBMITTED]: 'Order Submitted',
  [TRADING_EVENT_TYPES.ORDER_ACCEPTED]: 'Order Accepted',
  [TRADING_EVENT_TYPES.ORDER_WORKING]: 'Order Working',
  [TRADING_EVENT_TYPES.ORDER_PARTIALLY_FILLED]: 'Order Partially Filled',
  [TRADING_EVENT_TYPES.ORDER_FILLED]: 'Order Filled',
  [TRADING_EVENT_TYPES.ORDER_CANCELLED]: 'Order Cancelled',
  [TRADING_EVENT_TYPES.ORDER_REJECTED]: 'Order Rejected',
  [TRADING_EVENT_TYPES.EXECUTION]: 'Execution',
  [TRADING_EVENT_TYPES.FILL]: 'Fill',
  [TRADING_EVENT_TYPES.POSITION]: 'Position',
  [TRADING_EVENT_TYPES.TRADE]: 'Trade',
  [TRADING_EVENT_TYPES.LEARNING]: 'Learning',
  [TRADING_EVENT_TYPES.ANALYTICS]: 'Analytics',
  [TRADING_EVENT_TYPES.REPLAY]: uiName(FACTORY_TERM_KEYS.REPLAY_ENGINE),
  [TRADING_EVENT_TYPES.BATCH]: 'Batch',
  [TRADING_EVENT_TYPES.AI]: 'AI',
  [TRADING_EVENT_TYPES.HISTORY]: 'History',
  [TRADING_EVENT_TYPES.AUDIT]: 'Audit',
  [TRADING_EVENT_TYPES.UNKNOWN]: 'Unknown',
});

function timeMs(event = {}) {
  const ms = Date.parse(event.timestamp || '');
  return Number.isFinite(ms) ? ms : null;
}

function asEvents(events = []) {
  return Array.isArray(events) ? events.filter(Boolean).map((event) => normalizeTradingEvent(event)) : [];
}

function eventMatchesValue(value, target) {
  if (!hasValue(target)) return true;
  return hasValue(value) && String(value) === String(target);
}

function eventMatchesType(event = {}, type) {
  if (!hasValue(type)) return true;
  return event.eventType === normalizeTradingEventType(type);
}

function eventMatchesStatus(event = {}, status) {
  if (!hasValue(status)) return true;
  return normalizedText(event.status) === normalizedText(status);
}

function eventMatchesSearch(event = {}, query = '') {
  const text = String(query || '').trim().toLowerCase();
  if (!text) return true;
  return [
    event.eventId,
    event.eventType,
    event.strategyId,
    event.candidateId,
    event.orderId,
    event.executionId,
    event.positionId,
    event.tradeId,
    event.source,
    event.status,
  ].filter(hasValue).map((value) => String(value).toLowerCase()).join(' ').includes(text);
}

function eventTypeGroup(eventType) {
  const type = normalizeTradingEventType(eventType);
  for (const [group, types] of Object.entries(EVENT_LIFECYCLE_GROUPS)) {
    if (types.includes(type)) return group;
  }
  return TRADING_EVENT_TYPES.UNKNOWN;
}

export function eventTypeLabel(eventType) {
  const type = normalizeTradingEventType(eventType);
  return EVENT_TYPE_LABELS[type] || EVENT_TYPE_LABELS[TRADING_EVENT_TYPES.UNKNOWN];
}

export function eventStatusTone(event = {}) {
  if (event.eventType === TRADING_EVENT_TYPES.ORDER_REJECTED || event.eventType === TRADING_EVENT_TYPES.RISK_BLOCKED || event.eventType === TRADING_EVENT_TYPES.CANDIDATE_BLOCKED) return 'danger';
  if (event.eventType === TRADING_EVENT_TYPES.ORDER_CANCELLED) return 'warning';
  if (event.eventType === TRADING_EVENT_TYPES.ORDER_FILLED || event.eventType === TRADING_EVENT_TYPES.FILL || event.eventType === TRADING_EVENT_TYPES.EXECUTION) return 'success';
  return statusTone(event.status || event.eventType);
}

export function getEventStatus(event = {}) {
  return {
    status: event.status || null,
    eventType: event.eventType || TRADING_EVENT_TYPES.UNKNOWN,
    label: event.status || eventTypeLabel(event.eventType),
    tone: eventStatusTone(event),
  };
}

export function getEventTimeline(events = [], filters = {}) {
  const rows = asEvents(events)
    .filter((event) => eventMatchesType(event, filters.eventType))
    .filter((event) => eventMatchesValue(event.strategyId, filters.strategyId))
    .filter((event) => eventMatchesValue(event.candidateId, filters.candidateId))
    .filter((event) => eventMatchesValue(event.orderId, filters.orderId))
    .filter((event) => eventMatchesValue(event.executionId, filters.executionId))
    .filter((event) => eventMatchesValue(event.positionId, filters.positionId))
    .filter((event) => eventMatchesValue(event.tradeId, filters.tradeId))
    .filter((event) => eventMatchesValue(event.source, filters.source))
    .filter((event) => eventMatchesStatus(event, filters.status))
    .filter((event) => eventMatchesSearch(event, filters.query));

  return rows.sort((a, b) => {
    const aTime = timeMs(a);
    const bTime = timeMs(b);
    if (aTime != null && bTime != null && aTime !== bTime) return bTime - aTime;
    if (aTime != null && bTime == null) return -1;
    if (aTime == null && bTime != null) return 1;
    return 0;
  });
}

export function groupEventsByType(events = []) {
  const groups = new Map();
  for (const event of asEvents(events)) {
    const key = event.eventType || TRADING_EVENT_TYPES.UNKNOWN;
    const rows = groups.get(key) || [];
    rows.push(event);
    groups.set(key, rows);
  }
  return groups;
}

export function groupEventsByStrategy(events = []) {
  const groups = new Map();
  for (const event of asEvents(events)) {
    if (!hasValue(event.strategyId)) continue;
    const key = String(event.strategyId);
    const rows = groups.get(key) || [];
    rows.push(event);
    groups.set(key, rows);
  }
  return groups;
}

export function getEventsByLifecycle(events = []) {
  const groups = new Map(Object.keys(EVENT_LIFECYCLE_GROUPS).map((key) => [key, []]));
  for (const event of asEvents(events)) {
    const group = eventTypeGroup(event.eventType);
    const rows = groups.get(group) || [];
    rows.push(event);
    groups.set(group, rows);
  }
  return groups;
}

export function getLatestEvent(events = []) {
  return getEventTimeline(events)[0] || null;
}

export function getEventSummary(events = []) {
  const rows = asEvents(events);
  const byType = groupEventsByType(rows);
  const byStrategy = groupEventsByStrategy(rows);
  const lifecycle = getEventsByLifecycle(rows);
  return {
    total: rows.length,
    latest: getLatestEvent(rows),
    byType,
    byStrategy,
    byLifecycle: lifecycle,
    strategyCount: byStrategy.size,
    typedCount: Array.from(byType.values()).reduce((sum, group) => sum + group.length, 0),
  };
}

export function eventMatchesStrategy(event = {}, strategyId = null) {
  return eventMatchesValue(event.strategyId, strategyId);
}

export function eventHasCanonicalIdentity(event = {}) {
  return [
    event.eventId,
    event.eventType,
    event.strategyId,
    event.candidateId,
    event.orderId,
    event.executionId,
    event.positionId,
    event.tradeId,
    event.timestamp,
    event.source,
  ].some(hasValue);
}
