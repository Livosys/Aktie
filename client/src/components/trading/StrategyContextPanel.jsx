import React, { useMemo } from 'react';
import {
  EMPTY_VALUE,
  boolText,
  fmtNumber,
  fmtPercent,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import {
  hasStrategyPerformance,
} from '../../models/strategyViewModel.js';
import {
  resolveStrategy,
  strategyDisplayName,
} from '../../stores/strategyStore.js';
import { FieldGrid } from './FieldGrid.jsx';
import { StatusBadge, statusTone } from './StatusBadge.jsx';

function compactModelValue(value) {
  if (value === true || value === false) return boolText(value);
  if (!hasValue(value)) return EMPTY_VALUE;
  if (typeof value === 'object') {
    return textOrEmpty(value.candidateId || value.id || value.strategyId || value.strategy_id || value.label || value.name);
  }
  return textOrEmpty(value);
}

function performanceItems(performance = {}) {
  if (!hasStrategyPerformance(performance)) {
    return [
      { label: 'Performance', value: EMPTY_VALUE, hint: 'Unavailable' },
    ];
  }
  return [
    { label: 'Badge', value: textOrEmpty(performance.badge), tone: statusTone(performance.badge) },
    { label: 'Trades', value: hasValue(performance.trades) ? fmtNumber(performance.trades) : EMPTY_VALUE },
    { label: 'Trades today', value: hasValue(performance.tradesToday) ? fmtNumber(performance.tradesToday) : EMPTY_VALUE },
    { label: 'Trades total', value: hasValue(performance.tradesTotal) ? fmtNumber(performance.tradesTotal) : EMPTY_VALUE },
    { label: 'Win rate', value: hasValue(performance.winRate) ? fmtPercent(performance.winRate) : EMPTY_VALUE },
    { label: 'Profit factor', value: hasValue(performance.profitFactor) ? fmtNumber(performance.profitFactor, 2) : EMPTY_VALUE },
    { label: 'PnL today', value: hasValue(performance.pnlToday) ? fmtNumber(performance.pnlToday, 2) : EMPTY_VALUE },
    { label: 'PnL week', value: hasValue(performance.pnlWeek) ? fmtNumber(performance.pnlWeek, 2) : EMPTY_VALUE },
    { label: 'Avg PnL', value: hasValue(performance.avgPnl) ? fmtNumber(performance.avgPnl, 2) : EMPTY_VALUE },
    { label: 'Expectancy', value: hasValue(performance.expectancy) ? fmtNumber(performance.expectancy, 2) : EMPTY_VALUE },
    { label: 'Net PnL', value: hasValue(performance.netPnl) ? fmtNumber(performance.netPnl, 2) : EMPTY_VALUE },
    { label: 'Gross PnL', value: hasValue(performance.grossPnl) ? fmtNumber(performance.grossPnl, 2) : EMPTY_VALUE },
    { label: 'Commission', value: hasValue(performance.commission) ? fmtNumber(performance.commission, 2) : EMPTY_VALUE },
    { label: 'Largest win', value: hasValue(performance.largestWin) ? fmtNumber(performance.largestWin, 2) : EMPTY_VALUE },
    { label: 'Largest loss', value: hasValue(performance.largestLoss) ? fmtNumber(performance.largestLoss, 2) : EMPTY_VALUE },
    { label: 'Average win', value: hasValue(performance.averageWin) ? fmtNumber(performance.averageWin, 2) : EMPTY_VALUE },
    { label: 'Average loss', value: hasValue(performance.averageLoss) ? fmtNumber(performance.averageLoss, 2) : EMPTY_VALUE },
    { label: 'Drawdown', value: hasValue(performance.drawdown) ? fmtNumber(performance.drawdown, 2) : EMPTY_VALUE },
    { label: 'Score', value: hasValue(performance.score) ? fmtNumber(performance.score, 1) : EMPTY_VALUE },
    { label: 'Consecutive wins', value: hasValue(performance.consecutiveWins) ? fmtNumber(performance.consecutiveWins) : EMPTY_VALUE },
    { label: 'Consecutive losses', value: hasValue(performance.consecutiveLosses) ? fmtNumber(performance.consecutiveLosses) : EMPTY_VALUE },
    { label: 'Best market', value: textOrEmpty(performance.bestMarket || performance.bestSymbol), hint: performance.bestMarket && performance.bestSymbol ? performance.bestSymbol : null },
  ];
}

export const StrategyContextPanel = React.memo(function StrategyContextPanel({
  strategy: strategyModel = null,
  context = {},
}) {
  const strategy = useMemo(() => resolveStrategy(strategyModel || context), [context, strategyModel]);
  const strategyLabel = strategyDisplayName(strategy, EMPTY_VALUE);
  const runtimeState = textOrEmpty(strategy.runtimeState);
  const approvalState = textOrEmpty(strategy.approvalState);
  const items = useMemo(() => [
    { label: 'Strategy', value: strategyLabel, hint: hasValue(strategy.strategyId) ? String(strategy.strategyId) : null, tone: hasValue(strategy.strategyId) ? 'info' : 'neutral' },
    { label: 'Strategy family', value: textOrEmpty(strategy.strategyFamily) },
    { label: 'Signal', value: textOrEmpty(strategy.signal) },
    { label: 'Entry reason', value: textOrEmpty(strategy.entryReason) },
    { label: 'Exit reason', value: textOrEmpty(strategy.exitReason) },
    { label: 'Risk state', value: textOrEmpty(strategy.riskState), hint: strategy.riskSource ? `source ${strategy.riskSource}` : null, tone: statusTone(strategy.riskState) },
    { label: 'Risk / Reward', value: hasValue(strategy.riskReward) ? fmtNumber(strategy.riskReward, 2) : EMPTY_VALUE },
    { label: 'Approval state', value: approvalState, tone: statusTone(strategy.approvalState) },
    { label: 'Runtime state', value: runtimeState, tone: statusTone(strategy.runtimeState) },
    { label: 'Market regime', value: textOrEmpty(strategy.marketRegime) },
    { label: 'Current candidate', value: compactModelValue(strategy.currentCandidate) },
    { label: 'Blocked', value: compactModelValue(strategy.blocked), hint: strategy.blockedReason || null, tone: strategy.blocked === true ? 'danger' : (strategy.blocked === false ? 'success' : 'neutral') },
    { label: 'Candidate', value: textOrEmpty(strategy.candidateId) },
    { label: 'Order ref', value: textOrEmpty(strategy.orderRef) },
  ], [
    approvalState,
    runtimeState,
    strategy.approvalState,
    strategy.blocked,
    strategy.blockedReason,
    strategy.candidateId,
    strategy.currentCandidate,
    strategy.entryReason,
    strategy.exitReason,
    strategy.marketRegime,
    strategy.orderRef,
    strategy.riskReward,
    strategy.riskSource,
    strategy.riskState,
    strategy.runtimeState,
    strategy.signal,
    strategy.strategyFamily,
    strategy.strategyId,
    strategyLabel,
  ]);

  const perfItems = useMemo(() => performanceItems(strategy.performance), [strategy.performance]);

  return (
    <div style={{
      border: '1px solid var(--border)',
      background: 'var(--surface-2)',
      borderRadius: 8,
      padding: 12,
      display: 'grid',
      gap: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            color: 'var(--muted)',
            fontSize: 11,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 0,
          }}>
            Strategy link
          </div>
          <div style={{
            marginTop: 3,
            color: 'var(--text)',
            fontSize: 17,
            fontWeight: 900,
            lineHeight: 1.2,
            overflowWrap: 'anywhere',
          }}>
            {strategyLabel}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <StatusBadge tone={statusTone(strategy.approvalState)} compact>{approvalState}</StatusBadge>
          <StatusBadge tone={statusTone(strategy.runtimeState)} compact>{runtimeState}</StatusBadge>
        </div>
      </div>
      <FieldGrid items={items} />
      <div>
        <div style={{
          color: 'var(--muted)',
          fontSize: 11,
          fontWeight: 800,
          textTransform: 'uppercase',
          letterSpacing: 0,
          marginBottom: 8,
        }}>
          Strategy performance
        </div>
        <FieldGrid items={perfItems} />
      </div>
    </div>
  );
});
