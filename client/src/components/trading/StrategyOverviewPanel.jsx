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
          // Migrerade strategier körs via sin native-implementation, och det är
          // det id:t som hamnar på broker-order, intents och trades. Utan det
          // här fältet går native-id:na på Ledger och Positioner inte att para
          // ihop med någon strategi.
          {
            label: 'Execution Engine',
            value: strategy.nativeMigrated ? 'Native Futures' : 'Legacy',
            hint: textOrEmpty(strategy.nativeStrategyVersion),
          },
          {
            label: 'Execution Strategy ID',
            value: textOrEmpty(strategy.executionStrategyId || strategy.strategyId),
          },
          {
            label: 'Native Signal',
            value: textOrEmpty(strategy.nativeTargetSignalSubtype || strategy.nativeTargetSignalFamily),
          },
          { label: 'Symbol', value: textOrEmpty(strategy.symbol) },
          { label: 'Direction', value: textOrEmpty(strategy.direction) },
        ]}
      />
    </OverviewPanel>
  );
});
