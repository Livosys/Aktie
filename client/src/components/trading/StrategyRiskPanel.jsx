import React from 'react';
import {
  boolText,
  fmtNumber,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import { statusTone } from './StatusBadge.jsx';

export const StrategyRiskPanel = React.memo(function StrategyRiskPanel({ strategy }) {
  const items = [
    { label: 'Risk State', value: textOrEmpty(strategy.riskState), tone: statusTone(strategy.riskState) },
    { label: 'Risk Source', value: textOrEmpty(strategy.riskSource) },
    { label: 'Risk / Reward', value: fmtNumber(strategy.riskReward, 2) },
    { label: 'Blocked', value: boolText(strategy.blocked), tone: strategy.blocked === true ? 'danger' : (strategy.blocked === false ? 'success' : 'neutral') },
    { label: 'Blocked Reason', value: textOrEmpty(strategy.blockedReason), tone: strategy.blockedReason ? 'warning' : 'neutral' },
  ].filter((item) => hasValue(item.value) && item.value !== '—');

  if (!items.length) return null;

  return (
    <OverviewPanel eyebrow="Risk" title="Risk State">
      <FieldGrid items={items} />
    </OverviewPanel>
  );
});
