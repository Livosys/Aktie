import {
  hasValue,
  numberOrNull,
} from '../utils/tradingFormatters.js';
import { normalizeStrategyId } from './strategyViewModel.js';
import {
  TRADING_EVENT_TYPES,
  firstEventValue,
  normalizeTradingEventId,
} from './tradingEventModel.js';

export const DECISION_TYPES = Object.freeze({
  AI_RECOMMENDATION: 'AIRecommendation',
  SUPERVISOR_APPROVAL: 'SupervisorApproval',
  SUPERVISOR_REJECT: 'SupervisorReject',
  RISK_APPROVAL: 'RiskApproval',
  RISK_REJECT: 'RiskReject',
  RISK_PAUSE: 'RiskPause',
  RISK_RESUME: 'RiskResume',
  ENTRY_DECISION: 'EntryDecision',
  EXIT_DECISION: 'ExitDecision',
  POSITION_MANAGEMENT: 'PositionManagement',
  STOP_MOVE: 'StopMove',
  TARGET_MOVE: 'TargetMove',
  BREAK_EVEN_MOVE: 'BreakEvenMove',
  SCALE_OUT: 'ScaleOut',
  SCALE_IN: 'ScaleIn',
  CANCEL_ORDER: 'CancelOrder',
  ORDER_RETRY: 'OrderRetry',
  EXECUTION_DECISION: 'ExecutionDecision',
  LEARNING_RECOMMENDATION: 'LearningRecommendation',
  REPLAY_DECISION: 'ReplayDecision',
  ALERT_DECISION: 'AlertDecision',
  NOTIFICATION_DECISION: 'NotificationDecision',
  HEALTH_DECISION: 'HealthDecision',
});

const SUPPORTED_DECISION_TYPES = new Set(Object.values(DECISION_TYPES));

const DECISION_TYPE_ALIASES = Object.freeze({
  ai: DECISION_TYPES.AI_RECOMMENDATION,
  ai_recommendation: DECISION_TYPES.AI_RECOMMENDATION,
  recommendation: DECISION_TYPES.AI_RECOMMENDATION,
  supervisor_approval: DECISION_TYPES.SUPERVISOR_APPROVAL,
  approval: DECISION_TYPES.SUPERVISOR_APPROVAL,
  approved: DECISION_TYPES.SUPERVISOR_APPROVAL,
  supervisor_reject: DECISION_TYPES.SUPERVISOR_REJECT,
  supervisor_rejection: DECISION_TYPES.SUPERVISOR_REJECT,
  reject: DECISION_TYPES.SUPERVISOR_REJECT,
  rejected: DECISION_TYPES.SUPERVISOR_REJECT,
  risk_approval: DECISION_TYPES.RISK_APPROVAL,
  risk_approved: DECISION_TYPES.RISK_APPROVAL,
  risk_reject: DECISION_TYPES.RISK_REJECT,
  risk_rejection: DECISION_TYPES.RISK_REJECT,
  risk_blocked: DECISION_TYPES.RISK_REJECT,
  risk_pause: DECISION_TYPES.RISK_PAUSE,
  pause: DECISION_TYPES.RISK_PAUSE,
  paused: DECISION_TYPES.RISK_PAUSE,
  risk_resume: DECISION_TYPES.RISK_RESUME,
  resume: DECISION_TYPES.RISK_RESUME,
  resumed: DECISION_TYPES.RISK_RESUME,
  entry: DECISION_TYPES.ENTRY_DECISION,
  entry_decision: DECISION_TYPES.ENTRY_DECISION,
  enter: DECISION_TYPES.ENTRY_DECISION,
  exit: DECISION_TYPES.EXIT_DECISION,
  exit_decision: DECISION_TYPES.EXIT_DECISION,
  close: DECISION_TYPES.EXIT_DECISION,
  position: DECISION_TYPES.POSITION_MANAGEMENT,
  position_management: DECISION_TYPES.POSITION_MANAGEMENT,
  stop: DECISION_TYPES.STOP_MOVE,
  stop_move: DECISION_TYPES.STOP_MOVE,
  target: DECISION_TYPES.TARGET_MOVE,
  target_move: DECISION_TYPES.TARGET_MOVE,
  break_even: DECISION_TYPES.BREAK_EVEN_MOVE,
  breakeven: DECISION_TYPES.BREAK_EVEN_MOVE,
  break_even_move: DECISION_TYPES.BREAK_EVEN_MOVE,
  scale_out: DECISION_TYPES.SCALE_OUT,
  scale_in: DECISION_TYPES.SCALE_IN,
  cancel: DECISION_TYPES.CANCEL_ORDER,
  cancelled: DECISION_TYPES.CANCEL_ORDER,
  canceled: DECISION_TYPES.CANCEL_ORDER,
  cancel_order: DECISION_TYPES.CANCEL_ORDER,
  order_retry: DECISION_TYPES.ORDER_RETRY,
  retry: DECISION_TYPES.ORDER_RETRY,
  execution: DECISION_TYPES.EXECUTION_DECISION,
  execution_decision: DECISION_TYPES.EXECUTION_DECISION,
  fill: DECISION_TYPES.EXECUTION_DECISION,
  learning: DECISION_TYPES.LEARNING_RECOMMENDATION,
  learning_recommendation: DECISION_TYPES.LEARNING_RECOMMENDATION,
  replay: DECISION_TYPES.REPLAY_DECISION,
  replay_decision: DECISION_TYPES.REPLAY_DECISION,
  alert: DECISION_TYPES.ALERT_DECISION,
  alert_decision: DECISION_TYPES.ALERT_DECISION,
  notification: DECISION_TYPES.NOTIFICATION_DECISION,
  notification_decision: DECISION_TYPES.NOTIFICATION_DECISION,
  health: DECISION_TYPES.HEALTH_DECISION,
  health_decision: DECISION_TYPES.HEALTH_DECISION,
});

export const EMPTY_DECISION = Object.freeze({
  decisionId: null,
  eventId: null,
  strategyId: null,
  candidateId: null,
  orderId: null,
  positionId: null,
  tradeId: null,
  timestamp: null,
  decisionType: null,
  decisionSource: null,
  decisionState: null,
  confidence: null,
  severity: null,
  priority: null,
  metadata: Object.freeze({}),
  summary: null,
  description: null,
  reason: null,
  evidence: null,
  recommendedAction: null,
  alternativeActions: null,
  blockedBy: null,
  approvedBy: null,
  createdBy: null,
  source: null,
  status: null,
});

function normalizedToken(value) {
  if (!hasValue(value)) return null;
  return String(value)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function normalizeDecisionId(...values) {
  const value = firstEventValue(...values);
  return hasValue(value) ? String(value) : null;
}

export function normalizeDecisionType(value) {
  if (!hasValue(value)) return null;
  if (SUPPORTED_DECISION_TYPES.has(String(value))) return String(value);
  return DECISION_TYPE_ALIASES[normalizedToken(value)] || null;
}

function textValue(...values) {
  const value = firstEventValue(...values);
  return hasValue(value) ? String(value) : null;
}

function numberValue(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n != null) return n;
  }
  return null;
}

function listValue(...values) {
  const value = firstEventValue(...values);
  if (!hasValue(value)) return null;
  return Array.isArray(value) ? value.filter(hasValue) : value;
}

function payload(source = {}) {
  return source?.payload && typeof source.payload === 'object' ? source.payload : source;
}

function timestampValue(source = {}, event = {}) {
  return firstEventValue(
    source.timestamp,
    source.decisionTimestamp,
    source.decision_timestamp,
    source.createdAt,
    source.updatedAt,
    source.completedAt,
    source.time,
    event.timestamp,
  );
}

function stateValue(source = {}, event = {}) {
  return textValue(
    source.decisionState,
    source.decision_state,
    source.approvalState,
    source.approval_state,
    source.riskState,
    source.risk_state,
    source.status,
    source.state,
    source.result,
    event.status,
  );
}

function eventDecisionType(event = {}, source = {}) {
  const explicit = normalizeDecisionType(firstEventValue(
    source.decisionType,
    source.decision_type,
    source.decision,
    source.type,
    source.kind,
  ));
  if (explicit) return explicit;

  const state = normalizedToken(stateValue(source, event));
  const eventType = event.eventType;
  const eventSource = normalizedToken(firstEventValue(event.source, source.source, source.decisionSource));

  if (eventSource?.includes('alert')) return DECISION_TYPES.ALERT_DECISION;
  if (eventSource?.includes('notification')) return DECISION_TYPES.NOTIFICATION_DECISION;

  if (eventType === TRADING_EVENT_TYPES.AI || eventType === TRADING_EVENT_TYPES.SUPERVISOR_RECOMMENDATION) return DECISION_TYPES.AI_RECOMMENDATION;
  if (eventType === TRADING_EVENT_TYPES.SUPERVISOR || eventType === TRADING_EVENT_TYPES.SUPERVISOR_STATUS) {
    if (state?.includes('reject') || state?.includes('block')) return DECISION_TYPES.SUPERVISOR_REJECT;
    if (state?.includes('approv') || state?.includes('accept')) return DECISION_TYPES.SUPERVISOR_APPROVAL;
    return DECISION_TYPES.HEALTH_DECISION;
  }
  if (eventType === TRADING_EVENT_TYPES.APPROVAL || eventType === TRADING_EVENT_TYPES.APPROVAL_STATE) {
    if (state?.includes('reject') || state?.includes('block') || state?.includes('not_approved')) return DECISION_TYPES.SUPERVISOR_REJECT;
    if (state?.includes('approv') || state?.includes('accept')) return DECISION_TYPES.SUPERVISOR_APPROVAL;
    return DECISION_TYPES.SUPERVISOR_APPROVAL;
  }
  if (eventType === TRADING_EVENT_TYPES.RISK_BLOCKED) return DECISION_TYPES.RISK_REJECT;
  if (eventType === TRADING_EVENT_TYPES.RISK || eventType === TRADING_EVENT_TYPES.RISK_STATE) {
    if (state?.includes('pause')) return DECISION_TYPES.RISK_PAUSE;
    if (state?.includes('resume')) return DECISION_TYPES.RISK_RESUME;
    if (state?.includes('reject') || state?.includes('block') || state?.includes('fail')) return DECISION_TYPES.RISK_REJECT;
    if (state?.includes('approv') || state?.includes('pass') || state?.includes('ok')) return DECISION_TYPES.RISK_APPROVAL;
    return DECISION_TYPES.RISK_APPROVAL;
  }
  if (eventType === TRADING_EVENT_TYPES.CANDIDATE || eventType === TRADING_EVENT_TYPES.CANDIDATE_CREATED || eventType === TRADING_EVENT_TYPES.STRATEGY_SIGNAL) return DECISION_TYPES.ENTRY_DECISION;
  if (eventType === TRADING_EVENT_TYPES.CANDIDATE_BLOCKED) return DECISION_TYPES.RISK_REJECT;
  if (eventType === TRADING_EVENT_TYPES.ORDER_CANCELLED) return DECISION_TYPES.CANCEL_ORDER;
  if (eventType === TRADING_EVENT_TYPES.ORDER_REJECTED) return DECISION_TYPES.EXECUTION_DECISION;
  if ([
    TRADING_EVENT_TYPES.ORDER,
    TRADING_EVENT_TYPES.ORDER_PENDING,
    TRADING_EVENT_TYPES.ORDER_SUBMITTED,
    TRADING_EVENT_TYPES.ORDER_ACCEPTED,
    TRADING_EVENT_TYPES.ORDER_WORKING,
    TRADING_EVENT_TYPES.ORDER_PARTIALLY_FILLED,
    TRADING_EVENT_TYPES.ORDER_FILLED,
  ].includes(eventType)) return DECISION_TYPES.EXECUTION_DECISION;
  if (eventType === TRADING_EVENT_TYPES.EXECUTION || eventType === TRADING_EVENT_TYPES.FILL) return DECISION_TYPES.EXECUTION_DECISION;
  if (eventType === TRADING_EVENT_TYPES.POSITION) {
    const moveType = normalizeDecisionType(firstEventValue(source.moveType, source.managementType, source.action));
    return moveType || DECISION_TYPES.POSITION_MANAGEMENT;
  }
  if (eventType === TRADING_EVENT_TYPES.TRADE) {
    return firstEventValue(source.exitReason, source.exit_reason, source.closedAt, source.closed_at)
      ? DECISION_TYPES.EXIT_DECISION
      : DECISION_TYPES.ENTRY_DECISION;
  }
  if (eventType === TRADING_EVENT_TYPES.LEARNING || eventType === TRADING_EVENT_TYPES.ANALYTICS || eventType === TRADING_EVENT_TYPES.BATCH) return DECISION_TYPES.LEARNING_RECOMMENDATION;
  if (eventType === TRADING_EVENT_TYPES.REPLAY) return DECISION_TYPES.REPLAY_DECISION;
  if (eventType === TRADING_EVENT_TYPES.AUDIT || eventType === TRADING_EVENT_TYPES.HISTORY) return DECISION_TYPES.HEALTH_DECISION;
  return null;
}

function hasDecisionPayload(source = {}, event = {}) {
  return [
    source.decisionId,
    source.decision_id,
    source.decisionType,
    source.decision_type,
    source.decision,
    source.reason,
    source.reasonSv,
    source.entryReason,
    source.exitReason,
    source.evidence,
    source.recommendedAction,
    source.recommendation,
    source.blockedBy,
    source.approvedBy,
    event.eventType,
  ].some(hasValue);
}

function stableIdentity(parts = []) {
  const usable = parts.filter(hasValue).map((part) => String(part));
  return usable.length ? usable.join(':') : null;
}

export function isDecision(value) {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'decisionId') && Object.prototype.hasOwnProperty.call(value, 'decisionType'));
}

export function normalizeDecision(source = {}, options = {}) {
  if (isDecision(source) && !options.force) return source;
  const event = options.event || (source && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, 'eventType') ? source : {});
  const input = payload(source && typeof source === 'object' ? source : {});
  if (!hasDecisionPayload(input, event) && !options.decisionType) return null;

  const eventId = normalizeTradingEventId(options.eventId, input.eventId, input.event_id, event.eventId);
  const strategyId = normalizeStrategyId(
    options.strategyId,
    input.strategyId,
    input.strategy_id,
    input.canonicalStrategyId,
    input.resolvedStrategyId,
    event.strategyId,
  );
  const candidateId = normalizeTradingEventId(options.candidateId, input.candidateId, input.candidate_id, event.candidateId);
  const orderId = normalizeTradingEventId(options.orderId, input.orderId, input.order_id, input.ibOrderId, input.orderRef, event.orderId);
  const positionId = normalizeTradingEventId(options.positionId, input.positionId, input.position_id, event.positionId);
  const tradeId = normalizeTradingEventId(options.tradeId, input.tradeId, input.trade_id, event.tradeId);
  const timestamp = timestampValue(input, event);
  const decisionType = normalizeDecisionType(options.decisionType) || eventDecisionType(event, input);
  if (!decisionType) return null;

  const decisionSource = textValue(
    options.decisionSource,
    input.decisionSource,
    input.decision_source,
    input.source,
    input.sourceKind,
    input.createdBy,
    event.source,
  );
  const decisionState = stateValue(input, event);
  const reason = textValue(
    input.reason,
    input.reasonSv,
    input.reason_sv,
    input.entryReason,
    input.entry_reason,
    input.exitReason,
    input.exit_reason,
    input.blockedReason,
    input.blocked_reason,
    input.message,
  );
  const explicitDecisionId = normalizeDecisionId(
    options.decisionId,
    input.decisionId,
    input.decision_id,
    input.decision?.decisionId,
    input.decision?.id,
  );
  const decisionId = explicitDecisionId || stableIdentity([
    eventId ? `event:${eventId}` : null,
    decisionType,
    decisionSource,
    strategyId,
    candidateId,
    orderId,
    positionId,
    tradeId,
    timestamp,
    decisionState,
    reason,
  ]);

  const metadata = {
    ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    ...(event.metadata && typeof event.metadata === 'object' ? event.metadata : {}),
    ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {}),
    eventType: event.eventType || input.eventType || null,
    identitySource: explicitDecisionId ? 'decisionId' : (eventId ? 'eventId' : 'backendFields'),
  };

  return {
    decisionId,
    eventId,
    strategyId: strategyId ? String(strategyId) : null,
    candidateId,
    orderId,
    positionId,
    tradeId,
    timestamp: hasValue(timestamp) ? timestamp : null,
    decisionType,
    decisionSource,
    decisionState,
    confidence: numberValue(input.confidence, input.confidenceScore, input.confidence_score, input.probability),
    severity: textValue(input.severity, input.level, input.riskSeverity, input.prioritySeverity),
    priority: textValue(input.priority, input.priorityLabel, input.urgency),
    metadata,
    summary: textValue(input.summary, input.title, input.label, input.name, input.decisionSummary),
    description: textValue(input.description, input.desc, input.message, input.details, input.note),
    reason,
    evidence: listValue(input.evidence, input.evidenceItems, input.reasoning, input.context, input.signals),
    recommendedAction: textValue(input.recommendedAction, input.recommended_action, input.recommendation, input.nextAction, input.next_action),
    alternativeActions: listValue(input.alternativeActions, input.alternative_actions, input.alternatives),
    blockedBy: textValue(input.blockedBy, input.blocked_by, input.blocker, input.blockedReason),
    approvedBy: textValue(input.approvedBy, input.approved_by, input.approver),
    createdBy: textValue(input.createdBy, input.created_by, input.author, input.owner),
    source: decisionSource,
    status: decisionState,
  };
}

export function decisionModelKey(decision = {}, fallback = 'decision') {
  return normalizeDecisionId(decision.decisionId, decision.eventId, decision.orderId, decision.tradeId, fallback);
}
