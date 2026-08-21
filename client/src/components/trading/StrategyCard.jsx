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
        // Vänsterskena i tillståndsfärg, 2 px som resten av produkten. Den
        // tidigare 4 px-kanten läste som en egen ram runt kortet.
        border: `1px solid ${selected ? tokens.fg : 'var(--border)'}`,
        borderLeft: `2px solid ${tokens.fg}`,
        borderRadius: 'var(--r)',
        // Markerat kort lyfts med yta i stället för med sken. En glow läser som
        // ett larm, och markering är inte ett larm.
        background: selected ? 'var(--surface-2)' : 'var(--surface)',
        color: 'var(--text)',
        padding: 'var(--s5)',
        display: 'grid',
        gap: 'var(--s4)',
        textAlign: 'left',
        cursor: 'pointer',
        minWidth: 0,
        boxShadow: 'var(--elev-0)',
        font: 'inherit',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s3)', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--data)',
            color: 'var(--muted)',
            fontSize: 9.5,
            fontWeight: 400,
            textTransform: 'uppercase',
            letterSpacing: '.16em',
          }}>
            Strategy
          </div>
          <div style={{
            fontFamily: 'var(--display)',
            color: 'var(--text)',
            fontSize: 18,
            fontWeight: 600,
            lineHeight: 1.25,
            letterSpacing: '-.01em',
            marginTop: 'var(--s1)',
            overflowWrap: 'anywhere',
          }}>
            {label}
          </div>
          <div style={{
            fontFamily: 'var(--data)',
            color: 'var(--muted)',
            fontSize: 11,
            marginTop: 'var(--s1)',
            overflowWrap: 'anywhere',
          }}>
            {textOrEmpty(strategy.strategyId)}
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)', justifyContent: 'flex-end' }}>
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
