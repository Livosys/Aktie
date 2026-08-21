import React from 'react';
import { hasValue, textOrEmpty } from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import { statusTone } from './StatusBadge.jsx';
import { FACTORY_TERM_KEYS, uiDescription, uiName } from '../../services/uiTerminologyService.js';

export const StrategyApprovalPanel = React.memo(function StrategyApprovalPanel({ strategy }) {
  const title = uiName(FACTORY_TERM_KEYS.APPROVAL);
  const items = [
    { label: title, value: textOrEmpty(strategy.approvalState), tone: statusTone(strategy.approvalState) },
  ].filter((item) => hasValue(item.value) && item.value !== '—');

  if (!items.length) return null;

  return (
    <OverviewPanel eyebrow={title} title={title} summary={uiDescription(FACTORY_TERM_KEYS.APPROVAL)}>
      <FieldGrid items={items} />
    </OverviewPanel>
  );
});
