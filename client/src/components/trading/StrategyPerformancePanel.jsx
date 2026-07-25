import React from 'react';
import {
  fmtNumber,
  fmtPercent,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { hasStrategyPerformance } from '../../models/strategyViewModel.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import { statusTone } from './StatusBadge.jsx';

export const StrategyPerformancePanel = React.memo(function StrategyPerformancePanel({ strategy }) {
  const performance = strategy.performance || {};
  if (!hasStrategyPerformance(performance)) return null;

  return (
    <OverviewPanel eyebrow="Performance" title="Strategy Performance">
      <FieldGrid
        items={[
          { label: 'Badge', value: textOrEmpty(performance.badge), tone: statusTone(performance.badge) },
          { label: 'Win Rate', value: hasValue(performance.winRate) ? fmtPercent(performance.winRate, 1) : '—' },
          { label: 'Profit Factor', value: hasValue(performance.profitFactor) ? fmtNumber(performance.profitFactor, 2) : '—' },
          { label: 'Trades', value: hasValue(performance.trades) ? fmtNumber(performance.trades) : '—' },
          { label: 'Trades Today', value: hasValue(performance.tradesToday) ? fmtNumber(performance.tradesToday) : '—' },
          { label: 'Trades Total', value: hasValue(performance.tradesTotal) ? fmtNumber(performance.tradesTotal) : '—' },
          { label: 'PnL Today', value: hasValue(performance.pnlToday) ? fmtNumber(performance.pnlToday, 2) : '—' },
          { label: 'PnL Week', value: hasValue(performance.pnlWeek) ? fmtNumber(performance.pnlWeek, 2) : '—' },
          { label: 'Avg PnL', value: hasValue(performance.avgPnl) ? fmtNumber(performance.avgPnl, 2) : '—' },
          { label: 'Expectancy', value: hasValue(performance.expectancy) ? fmtNumber(performance.expectancy, 2) : '—' },
          { label: 'Net PnL', value: hasValue(performance.netPnl) ? fmtNumber(performance.netPnl, 2) : '—' },
          { label: 'Gross PnL', value: hasValue(performance.grossPnl) ? fmtNumber(performance.grossPnl, 2) : '—' },
          { label: 'Commission', value: hasValue(performance.commission) ? fmtNumber(performance.commission, 2) : '—' },
          { label: 'Largest Win', value: hasValue(performance.largestWin) ? fmtNumber(performance.largestWin, 2) : '—' },
          { label: 'Largest Loss', value: hasValue(performance.largestLoss) ? fmtNumber(performance.largestLoss, 2) : '—' },
          { label: 'Average Win', value: hasValue(performance.averageWin) ? fmtNumber(performance.averageWin, 2) : '—' },
          { label: 'Average Loss', value: hasValue(performance.averageLoss) ? fmtNumber(performance.averageLoss, 2) : '—' },
          { label: 'Drawdown', value: hasValue(performance.drawdown) ? fmtNumber(performance.drawdown, 2) : '—' },
          { label: 'Score', value: hasValue(performance.score) ? fmtNumber(performance.score, 1) : '—' },
          { label: 'Consecutive Wins', value: hasValue(performance.consecutiveWins) ? fmtNumber(performance.consecutiveWins) : '—' },
          { label: 'Consecutive Losses', value: hasValue(performance.consecutiveLosses) ? fmtNumber(performance.consecutiveLosses) : '—' },
          { label: 'Best Market', value: textOrEmpty(performance.bestMarket) },
          { label: 'Best Symbol', value: textOrEmpty(performance.bestSymbol) },
        ].filter((item) => item.value !== '—')}
      />
    </OverviewPanel>
  );
});
