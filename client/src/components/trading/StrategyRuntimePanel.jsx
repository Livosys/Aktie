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
import {
  FACTORY_TERM_KEYS,
  uiCopy,
  uiDescription,
  uiName,
  uiStatus,
} from '../../services/uiTerminologyService.js';

export const StrategyRuntimePanel = React.memo(function StrategyRuntimePanel({ strategy }) {
  const panel = uiCopy('strategyRuntimePanel');
  const items = [
    { label: panel.labels.runtimeState, value: textOrEmpty(uiStatus(strategy.runtimeState) || strategy.runtimeState), tone: statusTone(strategy.runtimeState) },
    { label: panel.labels.runtimeStatus, value: textOrEmpty(uiStatus(strategy.metadata?.status) || strategy.metadata?.status), tone: statusTone(strategy.metadata?.status) },
    { label: panel.labels.currentCandidate, value: boolText(strategy.currentCandidate), tone: strategy.currentCandidate === true ? 'success' : 'neutral' },
    { label: panel.labels.entryReady, value: boolText(strategy.entryReady), tone: strategy.entryReady === true ? 'success' : (strategy.entryReady === false ? 'warning' : 'neutral') },
    { label: panel.labels.canonicalVerdict, value: textOrEmpty(strategy.canonicalVerdict), tone: statusTone(strategy.canonicalVerdict) },
    { label: panel.labels.reasonCode, value: textOrEmpty(strategy.reasonCode), tone: strategy.reasonCode ? 'warning' : 'neutral' },
    { label: panel.labels.marketRegime, value: textOrEmpty(strategy.marketRegime) },
    { label: panel.labels.dataSource, value: textOrEmpty(strategy.metadata?.dataSource) },
    { label: panel.labels.updated, value: fmtTime(strategy.metadata?.updatedAt) },
  ].filter((item) => hasValue(item.value) && item.value !== '—');

  if (!items.length) return null;

  return (
    <OverviewPanel
      eyebrow={uiName(FACTORY_TERM_KEYS.STRATEGY_RUNTIME)}
      title={panel.title}
      summary={uiDescription(FACTORY_TERM_KEYS.STRATEGY_RUNTIME)}
    >
      <FieldGrid items={items} />
    </OverviewPanel>
  );
});
