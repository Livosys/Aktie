import React from 'react';
import { textOrEmpty } from '../../utils/tradingFormatters.js';
import { strategyDisplayName } from '../../stores/strategyStore.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';

export const StrategyOverviewPanel = React.memo(function StrategyOverviewPanel({ strategy }) {
  return (
    <OverviewPanel eyebrow="Overview" title={strategyDisplayName(strategy)}>
      <FieldGrid
        items={[
          { label: 'Strategy ID', value: textOrEmpty(strategy.strategyId) },
          { label: 'Strategy Name', value: strategyDisplayName(strategy) },
          { label: 'Strategy Family', value: textOrEmpty(strategy.strategyFamily) },
          { label: 'Symbol', value: textOrEmpty(strategy.symbol) },
          { label: 'Direction', value: textOrEmpty(strategy.direction) },
        ]}
      />
    </OverviewPanel>
  );
});
