import React from 'react';
import { hasValue, textOrEmpty } from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import { statusTone } from './StatusBadge.jsx';

export const StrategyOrdersPanel = React.memo(function StrategyOrdersPanel({ strategy }) {
  const items = [
    { label: 'Order Ref', value: textOrEmpty(strategy.orderRef) },
    { label: 'Candidate ID', value: textOrEmpty(strategy.candidateId) },
    { label: 'Intent Status', value: textOrEmpty(strategy.intentStatus), tone: statusTone(strategy.intentStatus) },
  ].filter((item) => hasValue(item.value) && item.value !== '—');

  if (!items.length) return null;

  return (
    <OverviewPanel eyebrow="Orders" title="Order Linkage">
      <FieldGrid items={items} />
    </OverviewPanel>
  );
});
