import React from 'react';
import { hasValue, textOrEmpty } from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import { statusTone } from './StatusBadge.jsx';

export const StrategySignalPanel = React.memo(function StrategySignalPanel({ strategy }) {
  const items = [
    { label: 'Signal', value: textOrEmpty(strategy.signal), tone: statusTone(strategy.signal) },
    { label: 'Signal Type', value: textOrEmpty(strategy.signalType) },
    { label: 'Signal Family', value: textOrEmpty(strategy.signalFamily) },
    { label: 'Entry Reason', value: textOrEmpty(strategy.entryReason) },
    { label: 'Exit Reason', value: textOrEmpty(strategy.exitReason) },
  ].filter((item) => hasValue(item.value) && item.value !== '—');

  if (!items.length) return null;

  return (
    <OverviewPanel eyebrow="Signals" title="Signal Context">
      <FieldGrid items={items} />
    </OverviewPanel>
  );
});
