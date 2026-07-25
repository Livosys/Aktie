import {
  EMPTY_VALUE,
  fmtTime,
  hasValue,
  textOrEmpty,
} from '../utils/tradingFormatters.js';
import {
  alternativeActions,
  decisionConfidenceLabel,
  decisionDescription,
  decisionLabel,
  decisionPriority,
  decisionSeverity,
  decisionStatus,
  decisionSummary,
  decisionTimeline,
  recommendedAction,
} from './DecisionDomain.js';

function evidenceRows(value) {
  if (!hasValue(value)) return [];
  if (Array.isArray(value)) {
    return value.filter(hasValue).map((item, index) => ({
      label: item?.label || item?.key || `Evidence ${index + 1}`,
      value: typeof item === 'object' ? textOrEmpty(item.value || item.message || item.reason || item.summary || item.id) : textOrEmpty(item),
      rawValue: item,
    }));
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, item]) => hasValue(item))
      .map(([key, item]) => ({
        label: key,
        value: typeof item === 'object' ? textOrEmpty(item.value || item.message || item.reason || item.summary || item.id) : textOrEmpty(item),
        rawValue: item,
      }));
  }
  return [{ label: 'Evidence', value: textOrEmpty(value), rawValue: value }];
}

export function DecisionExplanation(decision = {}) {
  return {
    ...decisionSummary(decision),
    description: decisionDescription(decision),
    timestamp: decision.timestamp || null,
    formattedTimestamp: fmtTime(decision.timestamp),
  };
}

export function DecisionEvidence(decision = {}) {
  return evidenceRows(decision.evidence);
}

export function DecisionReason(decision = {}) {
  return {
    label: 'Reason',
    value: decision.reason || decisionDescription(decision) || null,
    displayValue: textOrEmpty(decision.reason || decisionDescription(decision)),
  };
}

export function DecisionConfidence(decision = {}) {
  return {
    value: decision.confidence ?? null,
    displayValue: decisionConfidenceLabel(decision),
  };
}

export function DecisionPriority(decision = {}) {
  return {
    value: decisionPriority(decision),
    displayValue: textOrEmpty(decisionPriority(decision)),
  };
}

export function DecisionSeverity(decision = {}) {
  return {
    value: decisionSeverity(decision),
    displayValue: textOrEmpty(decisionSeverity(decision)),
  };
}

export function DecisionRecommendation(decision = {}) {
  return {
    value: recommendedAction(decision),
    displayValue: textOrEmpty(recommendedAction(decision)),
  };
}

export function DecisionAlternatives(decision = {}) {
  return alternativeActions(decision).map((action, index) => ({
    label: action?.label || action?.title || `Alternative ${index + 1}`,
    value: typeof action === 'object' ? textOrEmpty(action.value || action.message || action.reason || action.summary || action.id) : textOrEmpty(action),
    rawValue: action,
  }));
}

export function DecisionHistory(decisions = []) {
  return decisionTimeline(decisions).map((decision) => ({
    decision,
    decisionId: decision.decisionId || null,
    label: decisionLabel(decision),
    status: decisionStatus(decision),
    timestamp: decision.timestamp || null,
    formattedTimestamp: fmtTime(decision.timestamp),
    reason: decision.reason || EMPTY_VALUE,
  }));
}
