import {
  EMPTY_VALUE,
  fmtNumber,
  fmtTime,
  hasValue,
} from '../utils/tradingFormatters.js';
import {
  UNAVAILABLE,
  compactJsonValue,
  exposedFieldRows,
  field,
  firstPathValue,
  valueText,
} from './DomainUtils.js';
import { statusTone } from './StrategyDomain.js';

export const SUPERVISOR_HEALTH_SECTIONS = [
  {
    key: 'runtime',
    label: 'Runtime Health',
    paths: ['overview.status', 'overview.blocks.system_health.status', 'liveActivity.status'],
    fields: [
      { label: 'Supervisor status', paths: ['overview.status'] },
      { label: 'System health', paths: ['overview.blocks.system_health.status', 'overview.blocks.system_health.summary.overallStatus'] },
      { label: 'Replay autopilot', paths: ['overview.replayAutopilotSummary.status'] },
      { label: 'Batch autopilot', paths: ['overview.batchAutopilotSummary.status'] },
      { label: 'Last update', paths: ['updatedAt', 'overview.updatedAt'], format: fmtTime },
    ],
  },
  {
    key: 'market',
    label: 'Market Health',
    paths: ['overview.marketRegime.status', 'overview.marketRegime.regime', 'overview.dataStatus.status'],
    fields: [
      { label: 'Market regime', paths: ['overview.marketRegime.regime', 'overview.marketRegime.label', 'overview.marketRegime.status'] },
      { label: 'Data status', paths: ['overview.dataStatus.status'] },
      { label: 'Ready for replay', paths: ['overview.dataStatus.readyForReplay'], format: (value) => hasValue(value) ? fmtNumber(value) : EMPTY_VALUE },
      { label: 'Missing data', paths: ['overview.dataStatus.missingData'], format: (value) => hasValue(value) ? fmtNumber(value) : EMPTY_VALUE },
    ],
  },
  {
    key: 'strategy',
    label: 'Strategy Health',
    paths: ['overview.strategyResearch.status', 'overview.strategyRanking.status', 'overview.strategyRanking.bestJustNow'],
    fields: [
      { label: 'Research status', paths: ['overview.strategyResearch.status'] },
      { label: 'Ranking status', paths: ['overview.strategyRanking.status'] },
      { label: 'Best now', paths: ['overview.strategyRanking.bestJustNow.name', 'overview.strategyRanking.bestJustNow.strategyName', 'overview.strategyRanking.bestJustNow.strategyId'] },
      { label: 'Weakest now', paths: ['overview.strategyRanking.weakestJustNow.name', 'overview.strategyRanking.weakestJustNow.strategyName', 'overview.strategyRanking.weakestJustNow.strategyId'] },
      { label: 'Approved count', paths: ['overview.paperStatus.allowlist.approved', 'allowlist.summary.approved'] },
    ],
  },
  {
    key: 'broker',
    label: 'Broker Health',
    paths: ['overview.safety.broker_enabled', 'overview.paperStatus.status', 'overview.brokerStatus.status'],
    fields: [
      { label: 'Broker enabled', paths: ['overview.safety.broker_enabled', 'overview.broker_enabled'] },
      { label: 'Paper status', paths: ['overview.paperStatus.status'] },
      { label: 'Paper mode', paths: ['overview.safety.mode', 'overview.mode'] },
      { label: 'Can place orders', paths: ['overview.safety.can_place_orders', 'overview.can_place_orders'] },
    ],
  },
  {
    key: 'risk',
    label: 'Risk Health',
    paths: ['overview.riskStatus.status', 'overview.blocks.risk.status', 'overview.safety.actions_allowed'],
    fields: [
      { label: 'Risk status', paths: ['overview.riskStatus.status', 'overview.blocks.risk.status'] },
      { label: 'Actions allowed', paths: ['overview.safety.actions_allowed', 'overview.actions_allowed'] },
      { label: 'Live trading', paths: ['overview.safety.live_trading_enabled', 'overview.live_trading_enabled'] },
      { label: 'System blocker', paths: ['overview.blocks.system_health.summary.blockedReason', 'overview.blocks.autopilot.summary.blockedReason'] },
    ],
  },
  {
    key: 'execution',
    label: 'Execution Health',
    paths: ['overview.paperStatus.status', 'automationPlan.status', 'overview.executionStatus.status'],
    fields: [
      { label: 'Paper trading', paths: ['overview.paperStatus.status'] },
      { label: 'Paper trades', paths: ['overview.paperStatus.count'], format: (value) => hasValue(value) ? fmtNumber(value) : EMPTY_VALUE },
      { label: 'Automation plan', paths: ['automationPlan.status', 'automationPlan.mode'] },
      { label: 'Next safe step', paths: ['automationPlan.nextSafeStep', 'overview.nextRecommendedActions.0.reason'] },
    ],
  },
  {
    key: 'connection',
    label: 'Connection Health',
    paths: ['liveActivity.status', 'overview.liveActivitySummary.status', 'aiLatest.status'],
    fields: [
      { label: 'Live activity', paths: ['liveActivity.status', 'overview.liveActivitySummary.status'] },
      { label: 'Latest source', paths: ['overview.liveActivitySummary.latestSource', 'liveActivity.latestSource'] },
      { label: 'Latest event', paths: ['overview.liveActivitySummary.latestAt', 'liveActivity.latestAt'], format: fmtTime },
      { label: 'AI analyst', paths: ['overview.aiAnalystStatus.status', 'overview.aiAnalystStatus.readiness', 'aiLatest.status'] },
    ],
  },
];

export function supervisorPanelRows(source, fields) {
  return exposedFieldRows(source, fields, UNAVAILABLE).map((row) => ({
    ...row,
    value: row.rawValue && typeof row.rawValue === 'object' ? compactJsonValue(row.rawValue) : row.value,
  }));
}

export function getSupervisorHealth({
  overview = {},
  liveActivity = null,
  replay = {},
  batches = {},
  allowlist = null,
  automationPlan = null,
  aiLatest = null,
  updatedAt = null,
} = {}) {
  const source = {
    overview,
    liveActivity,
    replay,
    batches,
    allowlist,
    automationPlan,
    aiLatest,
    updatedAt,
  };
  return SUPERVISOR_HEALTH_SECTIONS.map((section) => {
    const { value, path } = firstPathValue(source, section.paths);
    return {
      ...section,
      value,
      path,
      displayValue: hasValue(value) ? valueText(value) : UNAVAILABLE,
      tone: hasValue(value) ? statusTone(value) : 'neutral',
      rows: supervisorPanelRows(source, section.fields),
    };
  });
}

export function getRuntimeHealth(overview = {}) {
  const { value, path } = firstPathValue({ overview }, ['overview.status', 'overview.blocks.system_health.status']);
  return {
    value,
    path,
    tone: statusTone(value),
    label: hasValue(value) ? valueText(value) : UNAVAILABLE,
  };
}

export function getRuntimeSummary(overview = {}) {
  return {
    status: overview.status || null,
    updatedAt: overview.updatedAt || null,
    systemHealth: overview.blocks?.system_health?.status || null,
    replayAutopilot: overview.replayAutopilotSummary?.status || null,
    batchAutopilot: overview.batchAutopilotSummary?.status || null,
  };
}

export function getBlockedReasons(overview = {}) {
  return [
    overview.replayAutopilotSummary?.lastBlockedReason,
    overview.batchAutopilotSummary?.lastBlockedReason,
    overview.blocks?.autopilot?.summary?.blockedReason,
    overview.blocks?.system_health?.summary?.blockedReason,
  ].filter(hasValue);
}

export function getApprovalSummary(overview = {}, allowlist = null) {
  return {
    approved: overview.paperStatus?.allowlist?.approved ?? allowlist?.summary?.approved ?? null,
    status: overview.strategyResearch?.status || null,
    recommendations: Array.isArray(overview.strategyResearch?.recommendations)
      ? overview.strategyResearch.recommendations
      : [],
  };
}

export function supervisorUnavailableField(label) {
  return field(label, null, { fallback: UNAVAILABLE });
}
