import { hasValue } from '../utils/tradingFormatters.js';
import {
  UNAVAILABLE,
  collectMatchingFields,
  field,
  firstPathValue,
  sourcePayload,
  unwrapSources,
} from './DomainUtils.js';
import { statusTone } from './StrategyDomain.js';

export const AI_DECISION_CATEGORIES = [
  { label: 'Trend', matchers: [/trend/i, /marketRegime/i, /market_regime/i, /\bregime\b/i] },
  { label: 'Momentum', matchers: [/momentum/i] },
  { label: 'EMA', matchers: [/\bema\b/i, /emaFast/i, /emaSlow/i, /ema_fast/i, /ema_slow/i] },
  { label: 'VWAP', matchers: [/\bvwap\b/i] },
  { label: 'ATR', matchers: [/\batr\b/i] },
  { label: 'ORB', matchers: [/\borb\b/i, /openingRange/i, /opening_range/i] },
  { label: 'Session', matchers: [/session/i, /marketOpen/i, /market_open/i] },
  { label: 'Risk', matchers: [/risk/i, /guard/i, /block/i] },
  { label: 'Supervisor', matchers: [/supervisor/i, /nextRecommendedActions/i, /actionPlan/i] },
  { label: 'Approval', matchers: [/approval/i, /approved/i, /allowlist/i, /eligible/i] },
  { label: 'Execution', matchers: [/execution/i, /order/i, /fill/i, /broker/i] },
];

export function namedSources(sources = {}) {
  const unwrapped = unwrapSources(sources);
  return Object.entries(unwrapped)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([name, value]) => ({ name, value }));
}

export function categoryRows(sources = {}, category) {
  return namedSources(sources).flatMap(({ name, value }) => (
    collectMatchingFields(value, category.matchers, { prefix: name, maxRows: 2 })
  )).slice(0, 4);
}

export function getRecommendations(sources = {}) {
  const unwrapped = unwrapSources(sources);
  return [
    unwrapped.narrowPerformance?.recommendedNextTest,
    unwrapped.narrowAutopilot?.autopilot?.recommendedNextTest,
    unwrapped.learningSummary?.recommendedNextTest,
    ...(Array.isArray(unwrapped.supervisor?.nextRecommendedActions) ? unwrapped.supervisor.nextRecommendedActions : []),
    ...(Array.isArray(unwrapped.supervisor?.actionPlan) ? unwrapped.supervisor.actionPlan : []),
  ].filter(Boolean);
}

export function getFirstDecisionCandidate(sources = {}) {
  const unwrapped = unwrapSources(sources);
  const candidates = [
    { source: 'narrowPerformance.recommendedNextTest', row: unwrapped.narrowPerformance?.recommendedNextTest },
    { source: 'narrowAutopilot.autopilot.recommendedNextTest', row: unwrapped.narrowAutopilot?.autopilot?.recommendedNextTest },
    { source: 'learningSummary.recommendedNextTest', row: unwrapped.learningSummary?.recommendedNextTest },
    { source: 'supervisor.nextRecommendedActions.0', row: Array.isArray(unwrapped.supervisor?.nextRecommendedActions) ? unwrapped.supervisor.nextRecommendedActions[0] : null },
    { source: 'supervisor.actionPlan.0', row: Array.isArray(unwrapped.supervisor?.actionPlan) ? unwrapped.supervisor.actionPlan[0] : null },
  ].find((item) => item.row && typeof item.row === 'object');
  return candidates || null;
}

export function getAIStatus(sources = {}) {
  return Object.entries(sources || {}).map(([key, entry]) => {
    const payload = sourcePayload(entry);
    const status = firstPathValue(payload || {}, ['status', 'readiness', 'summary.status', 'autopilot.status', 'scheduler.status']).value;
    return {
      key,
      status: status || (entry?.ok === true ? 'ok' : null),
      error: entry?.ok === false ? entry.error : null,
      tone: statusTone(status || (entry?.ok === true ? 'ok' : null)),
    };
  });
}

export function getAIStatusRows(sources = {}, renderStatus = null) {
  return getAIStatus(sources).map((row) => field(row.key, row.status, {
    fallback: UNAVAILABLE,
    tone: row.tone,
    hint: row.error,
    format: renderStatus || ((value) => hasValue(value) ? String(value) : UNAVAILABLE),
  }));
}

export function getAISummary(sources = {}) {
  const decision = getFirstDecisionCandidate(sources);
  return {
    decision,
    recommendations: getRecommendations(sources),
    status: getAIStatus(sources),
    categories: AI_DECISION_CATEGORIES.map((category) => ({
      ...category,
      rows: categoryRows(sources, category),
    })),
  };
}

export function getLearningStatus(sources = {}) {
  const unwrapped = unwrapSources(sources);
  return {
    narrowPerformance: unwrapped.narrowPerformance?.summary?.status || null,
    dataConfidence: unwrapped.narrowPerformance?.summary?.dataConfidence || null,
    sourceCounts: unwrapped.narrowPerformance?.summary?.sourceCounts || null,
    autopilot: unwrapped.narrowAutopilot?.scheduler?.status || unwrapped.narrowAutopilot?.autopilot?.status || null,
  };
}
