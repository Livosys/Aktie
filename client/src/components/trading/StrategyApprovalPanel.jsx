import React from 'react';
import { hasValue, textOrEmpty } from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import { statusTone } from './StatusBadge.jsx';

export const StrategyApprovalPanel = React.memo(function StrategyApprovalPanel({ strategy }) {
  const items = [
    { label: 'Approval State', value: textOrEmpty(strategy.approvalState), tone: statusTone(strategy.approvalState) },
  ].filter((item) => hasValue(item.value) && item.value !== '—');

  if (!items.length) return null;

  return (
    <OverviewPanel eyebrow="Approval" title="Approval State">
      <FieldGrid items={items} />
    </OverviewPanel>
  );
});
