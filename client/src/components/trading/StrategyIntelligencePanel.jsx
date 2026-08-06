import React, { useMemo } from 'react';
import {
  EMPTY_VALUE,
  fmtNumber,
  fmtPercent,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { strategyDisplayName } from '../../stores/strategyStore.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import { StatusBadge, statusTone } from './StatusBadge.jsx';
import {
  UNAVAILABLE,
  field,
  numericTone,
} from './intelligenceUtils.js';
import { booleanLabel, booleanTone } from './StrategyDashboardUtils.js';

function formatPerformanceValue(key, value) {
  if (!hasValue(value)) return EMPTY_VALUE;
  if (['winRate'].includes(key)) return fmtPercent(value, 1);
  if (['profitFactor', 'avgPnl', 'score'].includes(key)) return fmtNumber(value, 2);
  if (['pnlToday', 'pnlWeek', 'expectancy', 'netPnl', 'grossPnl', 'commission', 'largestWin', 'largestLoss', 'averageWin', 'averageLoss', 'drawdown'].includes(key)) return fmtNumber(value, 2);
  return fmtNumber(value);
}

function performanceRows(performance = {}) {
  return [
    { label: 'Win rate', key: 'winRate' },
    { label: 'Profit factor', key: 'profitFactor' },
    { label: 'Trades today', key: 'tradesToday' },
    { label: 'Trades total', key: 'tradesTotal' },
    { label: 'PnL today', key: 'pnlToday', tone: numericTone(performance.pnlToday) },
    { label: 'PnL week', key: 'pnlWeek', tone: numericTone(performance.pnlWeek) },
    { label: 'Expectancy', key: 'expectancy', tone: numericTone(performance.expectancy) },
    { label: 'Net PnL', key: 'netPnl', tone: numericTone(performance.netPnl) },
    { label: 'Gross PnL', key: 'grossPnl', tone: numericTone(performance.grossPnl) },
    { label: 'Commission', key: 'commission' },
    { label: 'Largest win', key: 'largestWin', tone: numericTone(performance.largestWin) },
    { label: 'Largest loss', key: 'largestLoss', tone: numericTone(performance.largestLoss) },
    { label: 'Average win', key: 'averageWin', tone: numericTone(performance.averageWin) },
    { label: 'Average loss', key: 'averageLoss', tone: numericTone(performance.averageLoss) },
    { label: 'Drawdown', key: 'drawdown', tone: numericTone(performance.drawdown) },
    { label: 'Consecutive wins', key: 'consecutiveWins' },
    { label: 'Consecutive losses', key: 'consecutiveLosses' },
    { label: 'Score', key: 'score' },
  ]
    .filter((item) => hasValue(performance[item.key]))
    .map((item) => field(item.label, performance[item.key], {
      format: (value) => formatPerformanceValue(item.key, value),
      tone: item.tone,
    }));
}

function StatusValue({ value }) {
  if (!hasValue(value)) return EMPTY_VALUE;
  return <StatusBadge tone={statusTone(value)} compact>{textOrEmpty(value)}</StatusBadge>;
}

export const StrategyIntelligencePanel = React.memo(function StrategyIntelligencePanel({ strategy }) {
  const sections = useMemo(() => {
    const performance = performanceRows(strategy.performance || {});
    return [
      {
        title: 'What is happening',
        rows: [
          field('Runtime', strategy.runtimeState, { fallback: UNAVAILABLE, tone: statusTone(strategy.runtimeState), format: (value) => <StatusValue value={value} /> }),
          field('Approval', strategy.approvalState, { fallback: UNAVAILABLE, tone: statusTone(strategy.approvalState), format: (value) => <StatusValue value={value} /> }),
          field('Risk', strategy.riskState, { fallback: UNAVAILABLE, tone: statusTone(strategy.riskState), format: (value) => <StatusValue value={value} /> }),
          field('Signal', strategy.signal, { fallback: UNAVAILABLE, tone: statusTone(strategy.signal), format: (value) => <StatusValue value={value} /> }),
          field('Market regime', strategy.marketRegime, { fallback: UNAVAILABLE }),
          field('Current candidate', strategy.currentCandidate, { fallback: UNAVAILABLE, tone: booleanTone(strategy.currentCandidate), format: booleanLabel }),
          field('Entry ready', strategy.entryReady, { fallback: UNAVAILABLE, tone: booleanTone(strategy.entryReady), format: booleanLabel }),
          field('Canonical verdict', strategy.canonicalVerdict, { fallback: UNAVAILABLE, tone: statusTone(strategy.canonicalVerdict), format: (value) => <StatusValue value={value} /> }),
          field('Blocked', strategy.blocked, { fallback: UNAVAILABLE, tone: strategy.blocked === true ? 'danger' : booleanTone(strategy.blocked), format: booleanLabel }),
        ],
      },
      {
        title: 'Why it acted',
        rows: [
          field('Entry reason', strategy.entryReason, { fallback: UNAVAILABLE }),
          field('Exit reason', strategy.exitReason, { fallback: UNAVAILABLE }),
          field('ReasonCode', strategy.reasonCode, { fallback: UNAVAILABLE, tone: strategy.reasonCode ? 'warning' : 'neutral' }),
          field('Blocked reason', strategy.blockedReason, { fallback: UNAVAILABLE, tone: strategy.blockedReason ? 'warning' : 'neutral' }),
          field('Risk source', strategy.riskSource, { fallback: UNAVAILABLE }),
          field('Risk / reward', strategy.riskReward, { fallback: UNAVAILABLE, format: (value) => hasValue(value) ? fmtNumber(value, 2) : UNAVAILABLE }),
        ],
      },
      {
        title: 'Strategy linkage',
        rows: [
          field('Strategy', strategyDisplayName(strategy), { fallback: UNAVAILABLE }),
          field('Strategy ID', strategy.strategyId, { fallback: UNAVAILABLE }),
          field('Family', strategy.strategyFamily, { fallback: UNAVAILABLE }),
          field('Symbol', strategy.symbol, { fallback: UNAVAILABLE }),
          field('Direction', strategy.direction, { fallback: UNAVAILABLE }),
          field('Candidate ID', strategy.candidateId, { fallback: UNAVAILABLE }),
          field('Order ref', strategy.orderRef, { fallback: UNAVAILABLE }),
          field('Intent status', strategy.intentStatus, { fallback: UNAVAILABLE, tone: statusTone(strategy.intentStatus), format: (value) => <StatusValue value={value} /> }),
        ],
      },
      {
        title: 'Performance',
        rows: performance.length ? performance : [field('Performance', null, { fallback: UNAVAILABLE })],
      },
    ];
  }, [strategy]);

  return (
    <OverviewPanel
      eyebrow="Strategy Intelligence"
      title="Operating Unit"
      summary="Read-only explanation built from the shared Strategy View Model."
    >
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
        gap: 12,
      }}>
        {sections.map((section) => (
          <div
            key={section.title}
            style={{
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              borderRadius: 8,
              padding: 12,
              minWidth: 0,
            }}
          >
            <div style={{
              color: 'var(--muted)',
              fontSize: 11,
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 0,
              marginBottom: 10,
            }}>
              {section.title}
            </div>
            <FieldGrid items={section.rows} />
          </div>
        ))}
      </div>
    </OverviewPanel>
  );
});
