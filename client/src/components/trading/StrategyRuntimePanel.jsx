import React from 'react';
import {
  boolText,
  fmtTime,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import { statusTone } from './StatusBadge.jsx';

export const StrategyRuntimePanel = React.memo(function StrategyRuntimePanel({ strategy }) {
  const items = [
    { label: 'Runtime State', value: textOrEmpty(strategy.runtimeState), tone: statusTone(strategy.runtimeState) },
    { label: 'Runtime Status', value: textOrEmpty(strategy.metadata?.status), tone: statusTone(strategy.metadata?.status) },
    { label: 'Current Candidate', value: boolText(strategy.currentCandidate), tone: strategy.currentCandidate === true ? 'success' : 'neutral' },
    { label: 'Entry Ready', value: boolText(strategy.entryReady), tone: strategy.entryReady === true ? 'success' : (strategy.entryReady === false ? 'warning' : 'neutral') },
    { label: 'Canonical Verdict', value: textOrEmpty(strategy.canonicalVerdict), tone: statusTone(strategy.canonicalVerdict) },
    { label: 'ReasonCode', value: textOrEmpty(strategy.reasonCode), tone: strategy.reasonCode ? 'warning' : 'neutral' },
    { label: 'Market Regime', value: textOrEmpty(strategy.marketRegime) },
    { label: 'Data Source', value: textOrEmpty(strategy.metadata?.dataSource) },
    { label: 'Updated', value: fmtTime(strategy.metadata?.updatedAt) },
  ].filter((item) => hasValue(item.value) && item.value !== '—');

  if (!items.length) return null;

  return (
    <OverviewPanel eyebrow="Runtime" title="Runtime State">
      <FieldGrid items={items} />
    </OverviewPanel>
  );
});
