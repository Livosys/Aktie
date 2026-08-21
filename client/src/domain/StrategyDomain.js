import {
  EMPTY_VALUE,
  fmtNumber,
  hasValue,
  textOrEmpty,
} from '../utils/tradingFormatters.js';
import {
  hasStrategyPerformance,
  strategyDisplayName,
} from '../models/strategyViewModel.js';
import {
  FACTORY_STATUS_KEYS,
  FACTORY_TERM_KEYS,
  uiName,
  uiStatus,
} from '../services/uiTerminologyService.js';

export const ALL_FILTER = '__all__';

export const EMPTY_STRATEGY_FILTERS = Object.freeze({
  family: ALL_FILTER,
  runtimeState: ALL_FILTER,
  approvalState: ALL_FILTER,
  riskState: ALL_FILTER,
  signal: ALL_FILTER,
  marketRegime: ALL_FILTER,
  currentCandidate: ALL_FILTER,
  blocked: ALL_FILTER,
  query: '',
});

export function normalizedText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

export function stateText(strategy = {}) {
  return textOrEmpty(strategy.runtimeState || strategy.metadata?.status);
}

export function statusTone(value) {
  const text = normalizedText(value);
  if (!hasValue(value)) return 'neutral';
  if (['ok', 'shadow', 'shadow_ready', 'ready_waiting_for_signal', 'connected', 'working', 'accepted', 'acknowledged', 'filled', 'submitted', 'guard_passed', 'ibkr_paper_reserved_for_shadow', 'live'].includes(text)) return 'success';
  if (['degraded', 'degraded_feed', 'stale_quote', 'uncertain', 'blocked', 'paused', 'pending', 'presubmitted', 'pre_submitted', 'partiallyfilled', 'partially_filled', 'registry_gate_pending', 'reconciliation_required'].includes(text)) return 'warning';
  if (['cancelled', 'canceled', 'rejected', 'inactive', 'error', 'failed', 'guard_blocked', 'risk_blocked', 'not_approved'].includes(text)) return 'danger';
  if (['disabled', 'unknown'].includes(text)) return 'neutral';
  return 'info';
}

export function statusBadge(value, fallback = EMPTY_VALUE) {
  return {
    label: textOrEmpty(uiStatus(value) || value || fallback),
    tone: statusTone(value),
  };
}

export function booleanLabel(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return EMPTY_VALUE;
}

export function booleanTone(value) {
  if (value === true) return 'success';
  if (value === false) return 'neutral';
  return 'neutral';
}

export function blockedTone(strategy = {}) {
  if (strategy.blocked === true) return 'danger';
  if (strategy.blocked === false) return 'success';
  return statusTone(strategy.runtimeState);
}

export function stateMatches(strategy = {}, states = []) {
  const values = [
    strategy.runtimeState,
    strategy.metadata?.status,
    strategy.approvalState,
    strategy.riskState,
  ].map(normalizedText).filter(Boolean);
  return states.some((state) => values.includes(state) || values.some((value) => value.includes(state)));
}

export function hasAnyValue(strategies = [], getValue) {
  return strategies.some((strategy) => hasValue(getValue(strategy)));
}

export function hasAnyBoolean(strategies = [], getValue) {
  return strategies.some((strategy) => getValue(strategy) === true || getValue(strategy) === false);
}

export function hasAnyMetadata(strategy = {}) {
  return Object.values(strategy.metadata || {}).some((value) => hasValue(value));
}

export function optionRowsFromMap(map) {
  return Array.from(map.entries())
    .filter(([value]) => hasValue(value) && value !== EMPTY_VALUE)
    .map(([value, strategies]) => ({
      value,
      label: `${value} (${fmtNumber(strategies.length)})`,
    }))
    .sort((a, b) => String(a.value).localeCompare(String(b.value)));
}

export function valueOptions(strategies = [], getValue) {
  const counts = new Map();
  for (const strategy of strategies) {
    const value = getValue(strategy);
    if (!hasValue(value)) continue;
    counts.set(String(value), (counts.get(String(value)) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, label: `${value} (${fmtNumber(count)})` }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

export function groupStrategies(strategies = [], getValue) {
  const grouped = new Map();
  for (const strategy of strategies) {
    const value = hasValue(getValue(strategy)) ? getValue(strategy) : EMPTY_VALUE;
    const rows = grouped.get(value) || [];
    rows.push(strategy);
    grouped.set(value, rows);
  }
  return grouped;
}

export function getStrategiesByFamily(strategies = []) {
  return groupStrategies(strategies, (strategy) => strategy.strategyFamily);
}

export function getStrategiesByRuntimeState(strategies = []) {
  return groupStrategies(strategies, (strategy) => strategy.runtimeState);
}

export function getStrategiesByApprovalState(strategies = []) {
  return groupStrategies(strategies, (strategy) => strategy.approvalState);
}

export function getStrategiesByRiskState(strategies = []) {
  return groupStrategies(strategies, (strategy) => strategy.riskState);
}

export function getStrategiesBySignal(strategies = []) {
  return groupStrategies(strategies, (strategy) => strategy.signal);
}

export function getStrategiesByMarketRegime(strategies = []) {
  return groupStrategies(strategies, (strategy) => strategy.marketRegime);
}

export function getRunningStrategies(strategies = []) {
  return strategies.filter((strategy) => stateMatches(strategy, ['running', 'active', 'ready', 'ready_waiting_for_signal', 'shadow', 'shadow_ready']));
}

export function getWaitingStrategies(strategies = []) {
  return strategies.filter((strategy) => stateMatches(strategy, ['waiting', 'waiting_for_signal', 'ready_waiting_for_signal', 'pending']));
}

export function getBlockedStrategies(strategies = []) {
  return strategies.filter((strategy) => strategy.blocked === true || stateMatches(strategy, ['blocked', 'risk_blocked', 'guard_blocked']));
}

export function getCandidateStrategies(strategies = []) {
  return strategies.filter((strategy) => hasValue(strategy.candidateId) || strategy.currentCandidate === true);
}

export function getReadyStrategies(strategies = []) {
  return strategies.filter((strategy) => stateMatches(strategy, ['entry_ready', 'ready', 'ready_waiting_for_signal', 'guard_passed']));
}

export function countIfAvailable(strategies = [], available, matcher) {
  if (!available) return EMPTY_VALUE;
  return fmtNumber(strategies.filter(matcher).length);
}

export function getStrategyStatistics(strategies = []) {
  const hasRuntimeState = hasAnyValue(strategies, (strategy) => strategy.runtimeState || strategy.metadata?.status);
  const hasCandidateState = hasAnyBoolean(strategies, (strategy) => strategy.currentCandidate)
    || strategies.some((strategy) => hasValue(strategy.candidateId));
  const hasBlockedState = hasAnyBoolean(strategies, (strategy) => strategy.blocked)
    || strategies.some((strategy) => stateMatches(strategy, ['blocked', 'risk_blocked', 'guard_blocked']));

  return {
    total: strategies.length,
    running: countIfAvailable(strategies, hasRuntimeState, (strategy) => stateMatches(strategy, ['running', 'active', 'shadow', 'shadow_ready'])),
    waiting: countIfAvailable(strategies, hasRuntimeState, (strategy) => stateMatches(strategy, ['waiting', 'waiting_for_signal', 'ready_waiting_for_signal', 'pending'])),
    blocked: countIfAvailable(strategies, hasBlockedState, (strategy) => strategy.blocked === true || stateMatches(strategy, ['blocked', 'risk_blocked', 'guard_blocked'])),
    paused: countIfAvailable(strategies, hasRuntimeState, (strategy) => stateMatches(strategy, ['paused'])),
    cooldown: countIfAvailable(strategies, hasRuntimeState, (strategy) => stateMatches(strategy, ['cooldown'])),
    candidates: countIfAvailable(strategies, hasCandidateState, (strategy) => strategy.currentCandidate === true || hasValue(strategy.candidateId)),
    entryReady: countIfAvailable(strategies, hasRuntimeState, (strategy) => stateMatches(strategy, ['entry_ready', 'ready', 'ready_waiting_for_signal', 'guard_passed'])),
    managingPosition: countIfAvailable(strategies, hasRuntimeState, (strategy) => stateMatches(strategy, ['managing_position', 'open_position', 'position_open', 'in_position'])),
    completed: countIfAvailable(strategies, hasRuntimeState, (strategy) => stateMatches(strategy, ['completed', 'complete', 'done', 'closed'])),
    disabled: countIfAvailable(strategies, hasRuntimeState, (strategy) => stateMatches(strategy, ['disabled', 'inactive', 'removed', 'deprecated'])),
  };
}

export function getStrategySummaryCards(strategies = []) {
  const stats = getStrategyStatistics(strategies);
  return [
    { label: uiStatus(FACTORY_STATUS_KEYS.RUNNING), value: stats.running, tone: 'success' },
    { label: uiStatus(FACTORY_STATUS_KEYS.WAITING), value: stats.waiting, tone: 'warning' },
    { label: 'Blocked', value: stats.blocked, tone: 'danger' },
    { label: uiStatus(FACTORY_STATUS_KEYS.PAUSED), value: stats.paused, tone: 'warning' },
    { label: 'Cooldown', value: stats.cooldown, tone: 'warning' },
    { label: uiName(FACTORY_TERM_KEYS.CANDIDATE), value: stats.candidates, tone: 'info' },
    { label: 'Entry Ready', value: stats.entryReady, tone: 'success' },
    { label: 'Managing Position', value: stats.managingPosition, tone: 'info' },
    { label: uiStatus(FACTORY_STATUS_KEYS.COMPLETED), value: stats.completed, tone: 'neutral' },
    { label: 'Disabled', value: stats.disabled, tone: 'neutral' },
  ];
}

export function getStrategyFilterOptions(strategyStore, strategies = []) {
  return {
    family: optionRowsFromMap(strategyStore.getStrategiesByFamily()),
    runtimeState: optionRowsFromMap(strategyStore.getStrategiesByRuntimeState()),
    approvalState: optionRowsFromMap(strategyStore.getStrategiesByApprovalState()),
    riskState: optionRowsFromMap(strategyStore.getStrategiesByRiskState()),
    signal: optionRowsFromMap(strategyStore.getStrategiesBySignal()),
    marketRegime: optionRowsFromMap(strategyStore.getStrategiesByMarketRegime()),
    hasCurrentCandidate: hasAnyBoolean(strategies, (strategy) => strategy.currentCandidate),
    hasBlocked: hasAnyBoolean(strategies, (strategy) => strategy.blocked),
  };
}

export function filterStrategies(strategies = [], filters = EMPTY_STRATEGY_FILTERS) {
  const query = String(filters.query || '').trim().toLowerCase();
  return strategies.filter((strategy) => {
    if (filters.family !== ALL_FILTER && strategy.strategyFamily !== filters.family) return false;
    if (filters.runtimeState !== ALL_FILTER && strategy.runtimeState !== filters.runtimeState) return false;
    if (filters.approvalState !== ALL_FILTER && strategy.approvalState !== filters.approvalState) return false;
    if (filters.riskState !== ALL_FILTER && strategy.riskState !== filters.riskState) return false;
    if (filters.signal !== ALL_FILTER && strategy.signal !== filters.signal) return false;
    if (filters.marketRegime !== ALL_FILTER && strategy.marketRegime !== filters.marketRegime) return false;
    if (filters.currentCandidate !== ALL_FILTER) {
      const target = filters.currentCandidate === 'true';
      if (strategy.currentCandidate !== target) return false;
    }
    if (filters.blocked !== ALL_FILTER) {
      const target = filters.blocked === 'true';
      if (strategy.blocked !== target) return false;
    }
    if (query) {
      const haystack = [
        strategy.strategyId,
        strategy.strategyName,
      ].map((value) => String(value || '').toLowerCase()).join(' ');
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export function getStrategyPerformance(strategy = {}) {
  return strategy.performance || {};
}

export function getStrategyHealth(strategy = {}) {
  return {
    strategyId: strategy.strategyId || null,
    label: strategyDisplayName(strategy, EMPTY_VALUE),
    runtime: statusBadge(strategy.runtimeState || strategy.metadata?.status),
    approval: statusBadge(strategy.approvalState),
    risk: statusBadge(strategy.riskState),
    blocked: strategy.blocked,
    blockedReason: strategy.blockedReason || null,
    hasPerformance: hasStrategyPerformance(strategy.performance),
  };
}

export function getStrategySummary(strategy = {}) {
  return {
    strategyId: strategy.strategyId || null,
    strategyName: strategy.strategyName || null,
    label: strategyDisplayName(strategy, EMPTY_VALUE),
    family: strategy.strategyFamily || null,
    runtimeState: strategy.runtimeState || null,
    approvalState: strategy.approvalState || null,
    riskState: strategy.riskState || null,
    signal: strategy.signal || null,
    marketRegime: strategy.marketRegime || null,
    currentCandidate: strategy.currentCandidate,
    blocked: strategy.blocked,
    candidateId: strategy.candidateId || null,
    orderRef: strategy.orderRef || null,
    performance: getStrategyPerformance(strategy),
    health: getStrategyHealth(strategy),
  };
}

export function resolveStrategy(source = {}, strategyStore = null, options = {}) {
  if (strategyStore && typeof strategyStore.resolveStrategy === 'function') {
    return strategyStore.resolveStrategy(source, options);
  }
  return source;
}
