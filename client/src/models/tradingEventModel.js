import { hasValue } from '../utils/tradingFormatters.js';
import {
  firstValue,
  normalizeStrategyId,
} from './strategyViewModel.js';

export const TRADING_EVENT_TYPES = Object.freeze({
  MARKET: 'market',
  MARKET_QUOTE: 'market_quote',
  MARKET_SESSION: 'market_session',
  SCANNER: 'scanner',
  SCANNER_STARTED: 'scanner_started',
  SCANNER_COMPLETED: 'scanner_completed',
  CANDIDATE: 'candidate',
  CANDIDATE_CREATED: 'candidate_created',
  CANDIDATE_BLOCKED: 'candidate_blocked',
  STRATEGY: 'strategy',
  STRATEGY_RUNTIME: 'strategy_runtime',
  STRATEGY_SIGNAL: 'strategy_signal',
  SUPERVISOR: 'supervisor',
  SUPERVISOR_STATUS: 'supervisor_status',
  SUPERVISOR_RECOMMENDATION: 'supervisor_recommendation',
  RISK: 'risk',
  RISK_BLOCKED: 'risk_blocked',
  RISK_STATE: 'risk_state',
  APPROVAL: 'approval',
  APPROVAL_STATE: 'approval_state',
  ORDER: 'order',
  ORDER_PENDING: 'order_pending',
  ORDER_SUBMITTED: 'order_submitted',
  ORDER_ACCEPTED: 'order_accepted',
  ORDER_WORKING: 'order_working',
  ORDER_PARTIALLY_FILLED: 'order_partially_filled',
  ORDER_FILLED: 'order_filled',
  ORDER_CANCELLED: 'order_cancelled',
  ORDER_REJECTED: 'order_rejected',
  EXECUTION: 'execution',
  FILL: 'fill',
  POSITION: 'position',
  TRADE: 'trade',
  LEARNING: 'learning',
  ANALYTICS: 'analytics',
  REPLAY: 'replay',
  BATCH: 'batch',
  AI: 'ai',
  HISTORY: 'history',
  AUDIT: 'audit',
  UNKNOWN: 'unknown',
});

const CANONICAL_EVENT_TYPES = new Set(Object.values(TRADING_EVENT_TYPES));

const EVENT_TYPE_ALIASES = Object.freeze({
  scan: TRADING_EVENT_TYPES.SCANNER,
  scan_started: TRADING_EVENT_TYPES.SCANNER_STARTED,
  scan_completed: TRADING_EVENT_TYPES.SCANNER_COMPLETED,
  scanner_start: TRADING_EVENT_TYPES.SCANNER_STARTED,
  scanner_done: TRADING_EVENT_TYPES.SCANNER_COMPLETED,
  quote: TRADING_EVENT_TYPES.MARKET_QUOTE,
  market_data: TRADING_EVENT_TYPES.MARKET_QUOTE,
  session: TRADING_EVENT_TYPES.MARKET_SESSION,
  signal: TRADING_EVENT_TYPES.STRATEGY_SIGNAL,
  runtime: TRADING_EVENT_TYPES.STRATEGY_RUNTIME,
  strategy_status: TRADING_EVENT_TYPES.STRATEGY_RUNTIME,
  status_reason: TRADING_EVENT_TYPES.RISK_STATE,
  guard: TRADING_EVENT_TYPES.RISK,
  guard_blocked: TRADING_EVENT_TYPES.RISK_BLOCKED,
  risk_status: TRADING_EVENT_TYPES.RISK_STATE,
  approval_status: TRADING_EVENT_TYPES.APPROVAL_STATE,
  order_status: TRADING_EVENT_TYPES.ORDER,
  open_order: TRADING_EVENT_TYPES.ORDER,
  broker_order: TRADING_EVENT_TYPES.ORDER,
  broker_order_status: TRADING_EVENT_TYPES.ORDER,
  exec: TRADING_EVENT_TYPES.EXECUTION,
  execution_detail: TRADING_EVENT_TYPES.EXECUTION,
  broker_execution: TRADING_EVENT_TYPES.EXECUTION,
  broker_fill: TRADING_EVENT_TYPES.FILL,
  fill_report: TRADING_EVENT_TYPES.FILL,
  broker_position: TRADING_EVENT_TYPES.POSITION,
  paper_trade: TRADING_EVENT_TYPES.TRADE,
  batch_test: TRADING_EVENT_TYPES.BATCH,
  batch_run: TRADING_EVENT_TYPES.BATCH,
  recommendation: TRADING_EVENT_TYPES.AI,
  ai_recommendation: TRADING_EVENT_TYPES.AI,
  audit_log: TRADING_EVENT_TYPES.AUDIT,
});

export const EMPTY_TRADING_EVENT = Object.freeze({
  eventId: null,
  eventType: TRADING_EVENT_TYPES.UNKNOWN,
  strategyId: null,
  candidateId: null,
  orderId: null,
  executionId: null,
  positionId: null,
  tradeId: null,
  timestamp: null,
  source: null,
  payload: null,
  status: null,
  metadata: Object.freeze({}),
});

export function firstEventValue(...values) {
  return values.find((value) => hasValue(value)) ?? null;
}

export function normalizeTradingEventId(...values) {
  const value = firstEventValue(...values);
  return hasValue(value) ? String(value) : null;
}

function normalizedToken(value) {
  if (!hasValue(value)) return null;
  return String(value)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function normalizeTradingEventType(value) {
  const key = normalizedToken(value);
  if (!key) return TRADING_EVENT_TYPES.UNKNOWN;
  if (CANONICAL_EVENT_TYPES.has(key)) return key;
  return EVENT_TYPE_ALIASES[key] || TRADING_EVENT_TYPES.UNKNOWN;
}

function timestampValue(source = {}, options = {}) {
  return firstEventValue(
    options.timestamp,
    source.timestamp,
    source.eventTimestamp,
    source.event_timestamp,
    source.brokerTimestamp,
    source.ibTimestamp,
    source.executionTime,
    source.reconciliationTimestamp,
    source.signalTimestamp,
    source.startedAt,
    source.completedAt,
    source.createdAt,
    source.updatedAt,
    source.receivedAt,
    source.generatedAt,
    source.time,
    source.date,
  );
}

function strategyIdValue(source = {}, options = {}) {
  return normalizeStrategyId(
    options.strategyId,
    source.strategyId,
    source.strategy_id,
    source.canonicalStrategyId,
    source.canonical_strategy_id,
    source.resolvedStrategyId,
    source.resolved_strategy_id,
    source.sourceStrategyId,
    source.source_strategy_id,
    source.strategy?.strategyId,
    source.strategy?.strategy_id,
    source.strategyViewModel?.strategyId,
  );
}

function candidateIdValue(source = {}, options = {}) {
  return normalizeTradingEventId(
    options.candidateId,
    source.candidateId,
    source.candidate_id,
    source.candidate?.candidateId,
    source.candidate?.candidate_id,
  );
}

function orderIdValue(source = {}, options = {}) {
  return normalizeTradingEventId(
    options.orderId,
    source.orderId,
    source.order_id,
    source.ibOrderId,
    source.ib_order_id,
    source.brokerOrderId,
    source.broker_order_id,
    source.orderRef,
    source.order_ref,
    source.order?.orderRef,
    source.permId,
    source.perm_id,
    source.order?.orderId,
    source.order?.permId,
  );
}

function executionIdValue(source = {}, options = {}) {
  return normalizeTradingEventId(
    options.executionId,
    source.executionId,
    source.execution_id,
    source.execId,
    source.exec_id,
    source.brokerExecutionId,
    source.broker_execution_id,
  );
}

function positionIdValue(source = {}, options = {}) {
  const explicit = normalizeTradingEventId(
    options.positionId,
    source.positionId,
    source.position_id,
  );
  if (explicit) return explicit;
  const parts = [
    source.accountMasked,
    source.account,
    source.conId,
    source.contract?.conId,
    source.localSymbol,
    source.root,
    source.symbol,
  ].filter(hasValue);
  return parts.length >= 2 ? `position:${parts.map(String).join(':')}` : null;
}

function tradeIdValue(source = {}, options = {}) {
  return normalizeTradingEventId(
    options.tradeId,
    source.tradeId,
    source.trade_id,
    source.paperTradeId,
    source.paper_trade_id,
  );
}

function sourceValue(source = {}, options = {}) {
  return firstEventValue(
    options.source,
    source.source,
    source.sourceKind,
    source.source_kind,
    source.executionSource,
    source.execution_source,
    source.dataSource,
    source.data_source,
  );
}

function statusValue(source = {}, options = {}) {
  return firstEventValue(
    options.status,
    source.status,
    source.state,
    source.lifecycleStatus,
    source.lifecycle_status,
    source.ibStatus,
    source.severity,
    source.result,
  );
}

function explicitEventIdValue(source = {}, options = {}) {
  return normalizeTradingEventId(
    options.eventId,
    source.eventId,
    source.event_id,
    source.auditId,
    source.audit_id,
    source.activityId,
    source.activity_id,
    source.id,
    source.uuid,
  );
}

function stableIdentity(parts = []) {
  const usable = parts.filter(hasValue).map((part) => String(part));
  if (!usable.length) return null;
  return usable.join(':');
}

function inferredEventType(source = {}, options = {}) {
  const explicitType = normalizeTradingEventType(firstEventValue(
    options.eventType,
    source.eventType,
    source.event_type,
    source.type,
    source.kind,
    source.event,
  ));
  if (explicitType !== TRADING_EVENT_TYPES.UNKNOWN) return explicitType;
  if (executionIdValue(source, options)) return TRADING_EVENT_TYPES.EXECUTION;
  if (firstEventValue(source.fillPrice, source.price, source.commission) && orderIdValue(source, options)) return TRADING_EVENT_TYPES.FILL;
  if (orderIdValue(source, options) || firstEventValue(source.orderRef, source.order_ref)) return TRADING_EVENT_TYPES.ORDER;
  if (candidateIdValue(source, options)) return TRADING_EVENT_TYPES.CANDIDATE;
  if (positionIdValue(source, options)) return TRADING_EVENT_TYPES.POSITION;
  if (tradeIdValue(source, options)) return TRADING_EVENT_TYPES.TRADE;
  if (firstEventValue(source.scanId, source.scan_id, source.scanStartedAt, source.lastScanAt)) return TRADING_EVENT_TYPES.SCANNER;
  if (firstEventValue(source.quoteId, source.last, source.price, source.marketPrice) && firstEventValue(source.root, source.symbol, source.localSymbol)) return TRADING_EVENT_TYPES.MARKET_QUOTE;
  return TRADING_EVENT_TYPES.UNKNOWN;
}

export function tradingEventKey(event = {}, index = null) {
  const key = normalizeTradingEventId(event.eventId);
  if (key) return key;
  return stableIdentity([
    event.eventType,
    event.source,
    event.strategyId,
    event.candidateId,
    event.orderId,
    event.executionId,
    event.positionId,
    event.tradeId,
    event.timestamp,
    event.status,
    index,
  ]);
}

export function isTradingEvent(value) {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'eventId') && Object.prototype.hasOwnProperty.call(value, 'eventType'));
}

export function normalizeTradingEvent(source = {}, options = {}) {
  if (isTradingEvent(source) && !options.force) return source;
  const input = source && typeof source === 'object' ? source : { value: source };
  const eventType = inferredEventType(input, options);
  const strategyId = strategyIdValue(input, options);
  const candidateId = candidateIdValue(input, options);
  const orderId = orderIdValue(input, options);
  const executionId = executionIdValue(input, options);
  const positionId = positionIdValue(input, options);
  const tradeId = tradeIdValue(input, options);
  const timestamp = timestampValue(input, options);
  const eventSource = sourceValue(input, options);
  const status = statusValue(input, options);
  const explicitEventId = explicitEventIdValue(input, options);
  const payload = Object.prototype.hasOwnProperty.call(options, 'payload')
    ? options.payload
    : (Object.prototype.hasOwnProperty.call(input, 'payload') ? input.payload : input);
  const metadata = {
    ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {}),
  };
  const eventId = explicitEventId || stableIdentity([
    eventType,
    eventSource,
    strategyId,
    candidateId,
    orderId,
    executionId,
    positionId,
    tradeId,
    timestamp,
    status,
    metadata.path,
    metadata.index,
  ]);

  return {
    eventId,
    eventType,
    strategyId: strategyId ? String(strategyId) : null,
    candidateId,
    orderId,
    executionId,
    positionId,
    tradeId,
    timestamp: hasValue(timestamp) ? timestamp : null,
    source: hasValue(eventSource) ? String(eventSource) : null,
    payload: payload ?? null,
    status: hasValue(status) ? String(status) : null,
    metadata,
  };
}
