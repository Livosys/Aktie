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
import { StatusBadge, statusTone, toneTokens } from './StatusBadge.jsx';
import {
  blockedTone,
  booleanLabel,
  booleanTone,
  stateText,
} from './StrategyDashboardUtils.js';

function performanceLine(performance = {}) {
  const parts = [
    hasValue(performance.winRate) ? `WR ${fmtPercent(performance.winRate, 1)}` : null,
    hasValue(performance.profitFactor) ? `PF ${fmtNumber(performance.profitFactor, 2)}` : null,
    hasValue(performance.netPnl) ? `Net ${fmtNumber(performance.netPnl, 2)}` : null,
    hasValue(performance.expectancy) ? `Exp ${fmtNumber(performance.expectancy, 2)}` : null,
    hasValue(performance.tradesTotal) ? `${fmtNumber(performance.tradesTotal)} trades` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : EMPTY_VALUE;
}

export const StrategyCard = React.memo(function StrategyCard({
  strategy,
  selected = false,
  onSelect,
}) {
  const label = strategyDisplayName(strategy, EMPTY_VALUE);
  const runtime = stateText(strategy);
  const runtimeTone = statusTone(strategy.runtimeState || strategy.metadata?.status);
  const tokens = toneTokens(selected ? 'info' : blockedTone(strategy));
  const fields = useMemo(() => [
    { label: 'Family', value: textOrEmpty(strategy.strategyFamily) },
    { label: 'Signal', value: textOrEmpty(strategy.signal), tone: statusTone(strategy.signal) },
    { label: 'Market Regime', value: textOrEmpty(strategy.marketRegime) },
    { label: 'Candidate', value: booleanLabel(strategy.currentCandidate), tone: booleanTone(strategy.currentCandidate) },
    { label: 'Entry Ready', value: booleanLabel(strategy.entryReady), tone: booleanTone(strategy.entryReady) },
    { label: 'Canonical Verdict', value: textOrEmpty(strategy.canonicalVerdict), tone: statusTone(strategy.canonicalVerdict) },
    { label: 'Blocked', value: booleanLabel(strategy.blocked), hint: strategy.blockedReason || null, tone: strategy.blocked === true ? 'danger' : (strategy.blocked === false ? 'success' : 'neutral') },
    { label: 'Performance', value: performanceLine(strategy.performance) },
  ], [
    strategy.blocked,
    strategy.blockedReason,
    strategy.canonicalVerdict,
    strategy.currentCandidate,
    strategy.entryReady,
    strategy.marketRegime,
    strategy.performance,
    strategy.signal,
    strategy.strategyFamily,
  ]);

  return (
    <button
      type="button"
      onClick={() => onSelect(strategy)}
      style={{
        width: '100%',
        border: `1px solid ${selected ? tokens.fg : tokens.border}`,
        borderLeft: `4px solid ${tokens.fg}`,
        borderRadius: 8,
        background: 'var(--surface)',
        color: 'var(--text)',
        padding: 14,
        display: 'grid',
        gap: 12,
        textAlign: 'left',
        cursor: 'pointer',
        minWidth: 0,
        boxShadow: selected ? '0 0 0 2px rgba(59,130,246,0.12)' : 'var(--shadow-1, none)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            color: 'var(--muted)',
            fontSize: 11,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 0,
          }}>
            Strategy
          </div>
          <div style={{
            color: 'var(--text)',
            fontSize: 19,
            fontWeight: 900,
            lineHeight: 1.15,
            marginTop: 4,
            overflowWrap: 'anywhere',
          }}>
            {label}
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4, overflowWrap: 'anywhere' }}>
            {textOrEmpty(strategy.strategyId)}
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
          {/* Visar att strategin körs via sin native futures-implementation. Det
              är den koden som faktiskt fattar beslutet och det id:t som hamnar
              på broker-order och trades. */}
          {strategy.nativeMigrated ? (
            <StatusBadge tone="info" compact>NATIVE</StatusBadge>
          ) : null}
          <StatusBadge tone={runtimeTone} compact>{runtime}</StatusBadge>
          <StatusBadge tone={statusTone(strategy.approvalState)} compact>{textOrEmpty(strategy.approvalState)}</StatusBadge>
          <StatusBadge tone={statusTone(strategy.riskState)} compact>{textOrEmpty(strategy.riskState)}</StatusBadge>
        </div>
      </div>
      <FieldGrid items={fields} />
    </button>
  );
});
