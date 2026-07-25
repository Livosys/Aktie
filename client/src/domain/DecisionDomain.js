import {
  EMPTY_VALUE,
  fmtPercent,
  hasValue,
  numberOrNull,
  textOrEmpty,
} from '../utils/tradingFormatters.js';
import {
  DECISION_TYPES,
  normalizeDecision,
} from '../models/decisionModel.js';

const TYPE_LABELS = Object.freeze({
  [DECISION_TYPES.AI_RECOMMENDATION]: 'AI Recommendation',
  [DECISION_TYPES.SUPERVISOR_APPROVAL]: 'Supervisor Approval',
  [DECISION_TYPES.SUPERVISOR_REJECT]: 'Supervisor Reject',
  [DECISION_TYPES.RISK_APPROVAL]: 'Risk Approval',
  [DECISION_TYPES.RISK_REJECT]: 'Risk Reject',
  [DECISION_TYPES.RISK_PAUSE]: 'Risk Pause',
  [DECISION_TYPES.RISK_RESUME]: 'Risk Resume',
  [DECISION_TYPES.ENTRY_DECISION]: 'Entry Decision',
  [DECISION_TYPES.EXIT_DECISION]: 'Exit Decision',
  [DECISION_TYPES.POSITION_MANAGEMENT]: 'Position Management',
  [DECISION_TYPES.STOP_MOVE]: 'Stop Move',
  [DECISION_TYPES.TARGET_MOVE]: 'Target Move',
  [DECISION_TYPES.BREAK_EVEN_MOVE]: 'Break Even Move',
  [DECISION_TYPES.SCALE_OUT]: 'Scale Out',
  [DECISION_TYPES.SCALE_IN]: 'Scale In',
  [DECISION_TYPES.CANCEL_ORDER]: 'Cancel Order',
  [DECISION_TYPES.ORDER_RETRY]: 'Order Retry',
  [DECISION_TYPES.EXECUTION_DECISION]: 'Execution Decision',
  [DECISION_TYPES.LEARNING_RECOMMENDATION]: 'Learning Recommendation',
  [DECISION_TYPES.REPLAY_DECISION]: 'Replay Decision',
  [DECISION_TYPES.ALERT_DECISION]: 'Alert Decision',
  [DECISION_TYPES.NOTIFICATION_DECISION]: 'Notification Decision',
  [DECISION_TYPES.HEALTH_DECISION]: 'Health Decision',
});

const TYPE_CATEGORY = Object.freeze({
  [DECISION_TYPES.AI_RECOMMENDATION]: 'ai',
  [DECISION_TYPES.SUPERVISOR_APPROVAL]: 'supervisor',
  [DECISION_TYPES.SUPERVISOR_REJECT]: 'supervisor',
  [DECISION_TYPES.RISK_APPROVAL]: 'risk',
  [DECISION_TYPES.RISK_REJECT]: 'risk',
  [DECISION_TYPES.RISK_PAUSE]: 'risk',
  [DECISION_TYPES.RISK_RESUME]: 'risk',
  [DECISION_TYPES.ENTRY_DECISION]: 'strategy',
  [DECISION_TYPES.EXIT_DECISION]: 'strategy',
  [DECISION_TYPES.POSITION_MANAGEMENT]: 'position',
  [DECISION_TYPES.STOP_MOVE]: 'position',
  [DECISION_TYPES.TARGET_MOVE]: 'position',
  [DECISION_TYPES.BREAK_EVEN_MOVE]: 'position',
  [DECISION_TYPES.SCALE_OUT]: 'position',
  [DECISION_TYPES.SCALE_IN]: 'position',
  [DECISION_TYPES.CANCEL_ORDER]: 'order',
  [DECISION_TYPES.ORDER_RETRY]: 'order',
  [DECISION_TYPES.EXECUTION_DECISION]: 'execution',
  [DECISION_TYPES.LEARNING_RECOMMENDATION]: 'learning',
  [DECISION_TYPES.REPLAY_DECISION]: 'replay',
  [DECISION_TYPES.ALERT_DECISION]: 'notification',
  [DECISION_TYPES.NOTIFICATION_DECISION]: 'notification',
  [DECISION_TYPES.HEALTH_DECISION]: 'health',
});

const TYPE_ICON = Object.freeze({
  ai: 'brain',
  supervisor: 'shield',
  risk: 'shield-alert',
  strategy: 'route',
  position: 'line-chart',
  order: 'list-checks',
  execution: 'activity',
  learning: 'graduation-cap',
  replay: 'history',
  notification: 'bell',
  health: 'heart-pulse',
  unknown: 'circle-help',
});

function asDecision(decision = {}) {
  return normalizeDecision(decision) || decision || {};
}

function normalizedText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function timeMs(decision = {}) {
  const ms = Date.parse(decision.timestamp || '');
  return Number.isFinite(ms) ? ms : null;
}

function valueFromPayload(decision = {}, ...paths) {
  const payload = decision.metadata?.payload || decision.payload || null;
  if (!payload || typeof payload !== 'object') return null;
  for (const path of paths) {
    const value = String(path || '').split('.').reduce((current, part) => {
      if (current == null) return null;
      return current[part];
    }, payload);
    if (hasValue(value)) return value;
  }
  return null;
}

export function decisionLabel(decision = {}) {
  const row = asDecision(decision);
  return textOrEmpty(row.summary || TYPE_LABELS[row.decisionType] || row.decisionType);
}

export function decisionDescription(decision = {}) {
  const row = asDecision(decision);
  return row.description || row.reason || row.summary || null;
}

export function decisionSummary(decision = {}) {
  const row = asDecision(decision);
  return {
    decisionId: row.decisionId || null,
    label: decisionLabel(row),
    description: decisionDescription(row),
    reason: row.reason || null,
    category: decisionCategory(row),
    status: decisionStatus(row),
    severity: decisionSeverity(row),
    priority: decisionPriority(row),
    confidence: decisionConfidence(row),
    color: decisionColor(row),
    icon: decisionIcon(row),
    recommendedAction: recommendedAction(row),
    alternativeActions: alternativeActions(row),
  };
}

export function decisionSeverity(decision = {}) {
  const row = asDecision(decision);
  return row.severity || null;
}

export function decisionConfidence(decision = {}) {
  const row = asDecision(decision);
  const n = numberOrNull(row.confidence);
  return n == null ? null : n;
}

export function decisionConfidenceLabel(decision = {}) {
  const value = decisionConfidence(decision);
  if (value == null) return EMPTY_VALUE;
  return fmtPercent(value, 1);
}

export function decisionPriority(decision = {}) {
  const row = asDecision(decision);
  return row.priority || null;
}

export function decisionCategory(decision = {}) {
  const row = asDecision(decision);
  return TYPE_CATEGORY[row.decisionType] || 'unknown';
}

export function decisionStatus(decision = {}) {
  const row = asDecision(decision);
  return row.decisionState || row.status || null;
}

export function isBlocked(decision = {}) {
  const row = asDecision(decision);
  const text = normalizedText(decisionStatus(row) || row.reason || row.blockedBy);
  return Boolean(row.blockedBy) || text.includes('blocked') || text.includes('block') || row.decisionType === DECISION_TYPES.RISK_PAUSE;
}

export function isApproved(decision = {}) {
  const row = asDecision(decision);
  const text = normalizedText(decisionStatus(row));
  return text.includes('approved')
    || text.includes('accepted')
    || text.includes('passed')
    || text === 'ok'
    || [DECISION_TYPES.SUPERVISOR_APPROVAL, DECISION_TYPES.RISK_APPROVAL, DECISION_TYPES.RISK_RESUME].includes(row.decisionType);
}

export function isRejected(decision = {}) {
  const row = asDecision(decision);
  const text = normalizedText(decisionStatus(row) || row.reason);
  return text.includes('rejected')
    || text.includes('reject')
    || text.includes('denied')
    || text.includes('not_approved')
    || [DECISION_TYPES.SUPERVISOR_REJECT, DECISION_TYPES.RISK_REJECT].includes(row.decisionType);
}

export function isPending(decision = {}) {
  const text = normalizedText(decisionStatus(decision));
  return text.includes('pending') || text.includes('waiting') || text.includes('queued');
}

export function isCritical(decision = {}) {
  const row = asDecision(decision);
  const severity = normalizedText(row.severity);
  const priority = normalizedText(row.priority);
  return severity.includes('critical') || severity.includes('danger') || priority.includes('critical') || priority.includes('high');
}

export function decisionColor(decision = {}) {
  if (isRejected(decision) || isCritical(decision)) return 'danger';
  if (isBlocked(decision) || isPending(decision)) return 'warning';
  if (isApproved(decision)) return 'success';
  const category = decisionCategory(decision);
  if (category === 'ai' || category === 'execution' || category === 'replay') return 'info';
  return 'neutral';
}

export function decisionIcon(decision = {}) {
  return TYPE_ICON[decisionCategory(decision)] || TYPE_ICON.unknown;
}

export function recommendedAction(decision = {}) {
  const row = asDecision(decision);
  return row.recommendedAction || null;
}

export function alternativeActions(decision = {}) {
  const row = asDecision(decision);
  if (!hasValue(row.alternativeActions)) return [];
  return Array.isArray(row.alternativeActions) ? row.alternativeActions.filter(hasValue) : [row.alternativeActions];
}

export function decisionTimeline(decisions = [], filters = {}) {
  const rows = Array.isArray(decisions) ? decisions.filter(Boolean).map(asDecision) : [];
  return rows
    .filter((decision) => !hasValue(filters.strategyId) || String(decision.strategyId) === String(filters.strategyId))
    .filter((decision) => !hasValue(filters.tradeId) || String(decision.tradeId) === String(filters.tradeId))
    .filter((decision) => !hasValue(filters.positionId) || String(decision.positionId) === String(filters.positionId))
    .filter((decision) => !hasValue(filters.orderId) || String(decision.orderId) === String(filters.orderId))
    .filter((decision) => !hasValue(filters.candidateId) || String(decision.candidateId) === String(filters.candidateId))
    .sort((a, b) => {
      const aTime = timeMs(a);
      const bTime = timeMs(b);
      if (aTime != null && bTime != null && aTime !== bTime) return bTime - aTime;
      if (aTime != null && bTime == null) return -1;
      if (aTime == null && bTime != null) return 1;
      return 0;
    });
}

function groupBy(decisions = [], getKey) {
  const groups = new Map();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const key = getKey(decision);
    if (!hasValue(key)) continue;
    const text = String(key);
    const rows = groups.get(text) || [];
    rows.push(decision);
    groups.set(text, rows);
  }
  return groups;
}

export function groupByTrade(decisions = []) {
  return groupBy(decisions, (decision) => decision.tradeId);
}

export function groupByStrategy(decisions = []) {
  return groupBy(decisions, (decision) => decision.strategyId);
}

export function groupBySession(decisions = []) {
  return groupBy(decisions, (decision) => (
    decision.metadata?.session
    || decision.metadata?.marketSession
    || valueFromPayload(decision, 'session', 'marketSession', 'market_session')
  ));
}

export function groupByMarket(decisions = []) {
  return groupBy(decisions, (decision) => (
    decision.metadata?.market
    || decision.metadata?.symbol
    || valueFromPayload(decision, 'market', 'symbol', 'root', 'localSymbol')
  ));
}
