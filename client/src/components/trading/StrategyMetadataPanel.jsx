import React from 'react';
import { fmtTime, hasValue, textOrEmpty } from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import { hasAnyMetadata } from './StrategyDashboardUtils.js';

export const StrategyMetadataPanel = React.memo(function StrategyMetadataPanel({ strategy }) {
  const metadata = strategy.metadata || {};
  if (!hasAnyMetadata(strategy)) return null;

  return (
    <OverviewPanel eyebrow="Metadata" title="Backend Metadata">
      <FieldGrid
        items={[
          { label: 'Source', value: textOrEmpty(metadata.source) },
          { label: 'Data Source', value: textOrEmpty(metadata.dataSource) },
          { label: 'Timeframe', value: textOrEmpty(metadata.timeframe) },
          { label: 'Market', value: textOrEmpty(metadata.market) },
          { label: 'Status', value: textOrEmpty(metadata.status) },
          { label: 'Created', value: fmtTime(metadata.createdAt) },
          { label: 'Updated', value: fmtTime(metadata.updatedAt) },
        ].filter((item) => hasValue(item.value) && item.value !== '—')}
      />
    </OverviewPanel>
  );
});
